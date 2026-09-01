import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { readFileSync, createReadStream } from 'fs';
import { RunRegistry } from './runs.js';
import { buildReport } from './report.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
const agent_connections = {};
const agent_listeners = [];

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));
const profile_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/profile_spec.json'), 'utf8'));

// Research runs capture the agent event stream so experiments are comparable.
const runs = new RunRegistry();

// Economics history for the Sim trends chart. Kept server-side because the
// browser's buffer resets on refresh, which would make "last 24 hours" a lie.
// 30s resolution for 7 days is 20,160 points — a few MB, and the chart
// downsamples to ~200 for drawing regardless of range.
const TREND_SAMPLE_MS = 30000;
const TREND_MAX = Math.ceil((7 * 24 * 3600 * 1000) / TREND_SAMPLE_MS);
const trend_history = [];      // [{ t, v: { agent: {calls, cost, cache} } }]
let last_trend_sample = 0;

function sampleTrends(states) {
    const now = Date.now();
    if (now - last_trend_sample < TREND_SAMPLE_MS) return;
    last_trend_sample = now;
    const v = {};
    let any = false;
    for (const [name, s] of Object.entries(states || {})) {
        const e = s && !s.error ? s.economics : null;
        if (!e?.per_hour) continue;
        v[name] = {
            calls: e.per_hour.calls || 0,
            cost: e.per_hour.cost || 0,
            cache: e.cache_hit_rate ?? 0,
        };
        any = true;
    }
    if (!any) return;
    trend_history.push({ t: now, v });
    if (trend_history.length > TREND_MAX)
        trend_history.splice(0, trend_history.length - TREND_MAX);
}

// Evenly thin to at most `max` points. Always keeps the newest sample, so the
// right edge of the chart is the live value rather than whatever the stride
// happened to land on.
function thin(rows, max) {
    if (rows.length <= max) return rows;
    const step = rows.length / max;
    const out = [];
    for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]);
    if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
    return out;
}

// Shared profile sanitizer. set-profile, set-agent-settings and create-agent
// all reach the same sinks in the child process, so the filtering has to live
// in one place — several of these nested blocks carry filesystem paths that
// are internal test seams, not user config.
function sanitizeProfile(profile, pinned_name) {
    if (!profile || typeof profile !== 'object') return profile;
    if (pinned_name) profile.name = pinned_name;
    const passthrough = new Set(['conversation_examples', 'coding_examples', 'npc', 'max_tokens']);
    const reserved = new Set(['__proto__', 'constructor', 'prototype']);
    for (const key of Object.keys(profile)) {
        if (reserved.has(key)
            || (!Object.hasOwn(profile_spec, key) && !passthrough.has(key) && !key.startsWith('_')))
            delete profile[key];
    }
    for (const [block, fields] of Object.entries(profile)) {
        if (!fields || typeof fields !== 'object') continue;
        for (const f of Object.keys(fields)) {
            if (f === 'dir' || f.endsWith('_fp') || f.endsWith('_path') || reserved.has(f)) {
                console.warn(`sanitizeProfile: ignoring ${block}.${f}`);
                delete fields[f];
            }
        }
    }
    // clamp declared numeric ranges
    for (const [block, def] of Object.entries(profile_spec)) {
        if (def?.type !== 'object' || !def.fields || !profile[block]) continue;
        const clampInto = (obj) => {
            for (const [f, fd] of Object.entries(def.fields)) {
                if (fd.type !== 'number' || typeof obj[f] !== 'number' || !Number.isFinite(obj[f])) continue;
                if (fd.min !== undefined) obj[f] = Math.max(fd.min, obj[f]);
                if (fd.max !== undefined) obj[f] = Math.min(fd.max, obj[f]);
            }
        };
        if (def.keys) Object.values(profile[block]).forEach(v => v && typeof v === 'object' && clampInto(v));
        else clampInto(profile[block]);
    }
    return profile;
}

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
        // When this agent last changed connection state. An agent that has sat
        // "joining" for hours is not joining; without a timestamp the dashboard
        // cannot tell the two apart and shows the same placeholder either way.
        this.since = Date.now();
    }
    setSettings(settings) {
        this.settings = settings;
    }
    // Which Minecraft world this agent plays in. Agents already carry their
    // own host/port, so several worlds can run under one mindserver; this is
    // the grouping key for the dashboard and for reports.
    get world() {
        const s = this.settings || {};
        return s.world || `${s.host || 'localhost'}:${s.port ?? ''}`;
    }
}

export function registerAgent(settings, viewer_port) {
    let agentConnection = new AgentConnection(settings, viewer_port);
    agent_connections[settings.profile.name] = agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

// Initialize the server
export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);
    // The control surface is unauthenticated by design (localhost-only), so
    // reject cross-origin sockets: without this any web page the user visits
    // can drive agent creation, settings, and chat injection via DNS rebinding
    // or a plain cross-origin socket.io handshake.
    io = new Server(server, { cors: { origin: false } });
    io.use((socket, next) => {
        const origin = socket.handshake.headers.origin;
        if (!origin || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`)
            return next();
        console.warn(`Rejected socket connection from disallowed origin: ${origin}`);
        next(new Error('origin not allowed'));
    });

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // ---- run downloads ----
    //
    // A report you can only look at is a report you cannot share or diff. These
    // give a file: a self-contained JSON bundle for reading and comparing, and
    // the raw JSONL that tools/trace.py consumes.
    //
    // Express percent-decodes route params AFTER matching, so the id must be
    // validated in its DECODED form — this is exactly how ..%2F got through the
    // asset route. Run ids come from slugify(): lowercase, digits, dashes.
    const validRunId = (id) => /^[a-z0-9-]{1,80}$/.test(String(id ?? ''));

    // A run the registry does not know is not a run, whatever is on disk.
    const resolveRun = (req, res) => {
        const id = String(req.params.id ?? '');
        if (!validRunId(id)) { res.status(400).json({ error: 'invalid run id' }); return null; }
        const run = runs.get(id);
        if (!run) { res.status(404).json({ error: 'no such run' }); return null; }
        return run;
    };

    app.get('/run/:id/report.json', (req, res) => {
        const run = resolveRun(req, res);
        if (!run) return;
        try {
            const events = runs.events(run.id);
            const report = buildReport(events, { run: run.id });
            // Beliefs in full: they are the reason to read the file at all, and
            // buildReport keeps only counts.
            const beliefs = events.filter(e => e.type === 'belief')
                .map(e => ({ ts: e.ts, agent: e.agent, content: e.content }));
            const bundle = {
                format: 'mindcraft-run-report',
                version: 1,
                exported_at: Date.now(),
                run,
                report,
                beliefs,
                // Naming what is NOT here beats a reader inferring it is complete.
                note: 'Aggregated view. The full event stream is at /run/<id>/events.jsonl.',
            };
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${run.id}-report.json"`);
            res.send(JSON.stringify(bundle, null, 2));
        } catch (err) {
            console.error('Report export failed:', err);
            res.status(500).json({ error: String(err.message || err) });
        }
    });

    app.get('/run/:id/events.jsonl', (req, res) => {
        const run = resolveRun(req, res);
        if (!run) return;
        const fp = runs.exportPath(run.id);
        if (!fp) { res.status(404).json({ error: 'no events file' }); return; }
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${run.id}-events.jsonl"`);
        // Streamed: a long run's archive is far too big to hold in memory twice.
        const stream = createReadStream(fp, { encoding: 'utf-8' });
        stream.on('error', (err) => {
            console.error('Event export failed:', err.message || err);
            if (!res.headersSent) res.status(500).json({ error: 'could not read events' });
            else res.end();
        });
        stream.pipe(res);
    });

    // Texture proxy: resolve item/block textures using minecraft-assets with version fallback
    app.get('/assets/item/:agent/:name.png', async (req, res) => {
        try {
            const agentName = req.params.agent;
            const rawName = req.params.name;
            const itemName = String(rawName).toLowerCase();
            // Minecraft item ids are [a-z0-9_] and nothing else. Anything else
            // is an attempt to walk out of the assets directory.
            if (!/^[a-z0-9_]{1,64}$/.test(itemName)) {
                res.setHeader('Content-Type', 'image/svg+xml');
                return res.status(400).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/></svg>');
            }
            const conn = agent_connections[agentName];
            const preferred = conn?.settings?.minecraft_version;
            const candidates = [];
            if (preferred && preferred !== 'auto') candidates.push(preferred);
            candidates.push('1.21.8');

            // Lazy import to avoid ESM/CJS conflicts
            const mod = await import('minecraft-assets');
            const mcAssetsFactory = mod.default || mod;

            for (const ver of candidates) {
                try {
                    const assets = mcAssetsFactory(ver);
                    // Prefer items path first, then blocks
                    const item = assets.items[itemName];
                    const block = assets.blocks[itemName];
                    const tex = assets.textureContent?.[itemName]?.texture
                        || (item ? assets.textureContent?.[itemName]?.texture : null)
                        || (block ? assets.textureContent?.[itemName]?.texture : null);
                    if (tex) {
                        // textureContent already provides a data URL in many versions
                        if (tex.startsWith('data:image')) {
                            const base64 = tex.split(',')[1];
                            const img = globalThis.Buffer.from(base64, 'base64');
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(img);
                        }
                    }
                    // If textureContent missing, try static path resolution inside package
                    // Helps with some strange blocks like Leaf Litter
                    const guessPaths = [];
                    const base = assets.directory;
                    guessPaths.push(path.join(base, 'items', `${itemName}.png`));
                    guessPaths.push(path.join(base, 'blocks', `${itemName}.png`));
                    for (const p of guessPaths) {
                        try {
                            const fsMod = await import('fs');
                            const buf = fsMod.readFileSync(p);
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(buf);
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            // Not found, fallback svg
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">?</text></svg>');
        } catch (e) {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">!</text></svg>');
        }
    });

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        agentsStatusUpdate(socket);

        socket.on('create-agent', async (settings, callback) => {
            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    }
                    else {
                        settings[key] = settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!Object.hasOwn(settings_spec, key)) {
                    delete settings[key];
                }
            }
            sanitizeProfile(settings.profile, null);
            if (settings.profile?.name) {
                if (Object.hasOwn(agent_connections, settings.profile.name)) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                let name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        // Profile editing: the dashboard generates its form from
        // public/profile_spec.json, so a new profile key gets UI by adding a
        // row there rather than by writing more form code.
        socket.on('get-profile-spec', (callback) => {
            if (typeof callback === 'function') callback({ spec: profile_spec });
        });

        socket.on('get-profile', (agentName, callback) => {
            const agent = agent_connections[agentName];
            if (typeof callback !== 'function') return;
            if (!agent) return callback({ success: false, error: 'Agent not found' });
            callback({ success: true, profile: agent.settings?.profile ?? {} });
        });

        socket.on('set-profile', (agentName, profile, callback) => {
            const agent = agent_connections[agentName];
            const done = typeof callback === 'function' ? callback : () => {};
            if (!agent) return done({ success: false, error: 'Agent not found' });
            if (!profile || typeof profile !== 'object') return done({ success: false, error: 'Invalid profile' });
            // the name is a filesystem path in the child process — never let
            // the editor change it out from under a running agent
            sanitizeProfile(profile, agent.settings.profile.name);
            agent.setSettings({ ...agent.settings, profile });
            agent.socket?.emit('restart-agent');
            done({ success: true });
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                callback({ settings: agent_connections[agentName].settings });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                agent_connections[agentName].since = Date.now();
                curAgentName = agentName;
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('disconnect', () => {
            if (agent_connections[curAgentName]) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].socket = null;
                agent_connections[curAgentName].since = Date.now();
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            const target = agent_connections[agentName].socket;
            if (!target) {
                console.warn(`Agent ${agentName} is registered but not connected yet; dropping message.`);
                return;
            }
            target.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', (agentName, new_settings) => {
            const agent = agent_connections[agentName];
            if (!agent) return;
            // apply the same key filtering create-agent uses — otherwise this
            // handler is a strictly more powerful way to set arbitrary settings
            for (let key in new_settings) {
                if (!Object.hasOwn(settings_spec, key))
                    delete new_settings[key];
            }
            if (new_settings.profile)
                sanitizeProfile(new_settings.profile, agent.settings?.profile?.name);
            agent.setSettings(new_settings);
            agent.socket?.emit('restart-agent');
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            agent_connections[agentName]?.socket?.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName) => {
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                globalThis.process.exit(0);
            }, 2000);
            
        });

		socket.on('send-message', (agentName, data) => {
			if (!agent_connections[agentName]) {
				console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
                return;
			}
			try {
                agent_connections[agentName].socket?.emit('send-message', data);
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        // relay an agent's notable memory events to dashboard listeners, and
        // capture them into the active research run
        socket.on('agent-event', (event) => {
            if (!event || typeof event !== 'object') return;
            // stamp the world server-side: the agent doesn't know its label,
            // and a client-supplied one could not be trusted anyway
            const conn = agent_connections[event.agent];
            if (conn) event.world = conn.world;
            runs.record(event);
            for (let listener of agent_listeners)
                listener.emit('agent-event', event);
        });

        // ---- research runs ----
        socket.on('list-runs', (callback) => {
            if (typeof callback === 'function')
                callback({ runs: runs.list(), active: runs.active });
        });

        socket.on('start-run', (name, callback) => {
            const run = runs.start(typeof name === 'string' ? name : 'run');
            if (typeof callback === 'function')
                callback(run ? { success: true, run } : { success: false, error: 'Could not start run' });
        });

        socket.on('stop-run', (callback) => {
            const run = runs.stop();
            if (typeof callback === 'function')
                callback({ success: !!run, run });
        });

        socket.on('get-report', (scope, callback) => {
            if (typeof callback !== 'function') return;
            try {
                const s = (scope && typeof scope === 'object') ? scope : {};
                const events = s.run ? runs.events(s.run) : runs.events(runs.active);
                callback({ success: true, report: buildReport(events, s), export_path: s.run ? runs.exportPath(s.run) : null });
            } catch (err) {
                console.error('Report generation failed:', err);
                callback({ success: false, error: String(err.message || err) });
            }
        });

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('get-trends', (opts, callback) => {
            if (typeof callback !== 'function') return;
            const window_ms = Number(opts?.window_ms) || 3600000;
            const cutoff = Date.now() - window_ms;
            const rows = trend_history.filter(r => r.t >= cutoff);
            callback({
                samples: thin(rows, 240),
                // so the client can say "only 20 min of history yet" rather
                // than drawing a 7-day axis with two points on it
                oldest: trend_history.length ? trend_history[0].t : null,
                resolution_ms: TREND_SAMPLE_MS,
            });
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = 'localhost';
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE')
            console.error(`MindServer cannot start: port ${port} is already in use. `
                + 'Change "mindserver_port" in settings.js, or stop whatever is using it.');
        else
            console.error('MindServer failed to start:', err.message || err);
        process.exit(1);
    });
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
        // independent of any browser being connected
        startTrendSampling();
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName,
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket,
            since: conn.since,
            world: conn.world
        });
    };
    socket.emit('agents-status', agents);
}


// Poll every in-game agent for its full state, concurrently.
function pollAgentStates() {
    const names = Object.keys(agent_connections)
        .filter(n => agent_connections[n].in_game && agent_connections[n].socket);
    return Promise.all(names.map(agentName => {
        const agent = agent_connections[agentName];
        // .timeout() lets socket.io release the ack callback itself; a bare
        // emit with a callback retains it forever when the agent never answers.
        return new Promise((resolve) => {
            try {
                agent.socket.timeout(800).emit('get-full-state', (err, s) => resolve(err ? null : s));
            } catch (e) {
                resolve({ error: String(e) });
            }
        }).then(state => [agentName, state]);
    })).then(entries => {
        const states = {};
        for (const [name, state] of entries)
            if (state) states[name] = state;
        return states;
    });
}

// Trend history must accrue whether or not anyone is watching. It used to be
// sampled inside the dashboard's 1Hz poll, which only exists while a browser
// has the page open — so closing the tab silently stopped recording, and
// "last 24 hours" showed only the minutes you happened to be looking.
let trendInterval = null;
let trend_polling = false;
export function startTrendSampling() {
    if (trendInterval) return;
    trendInterval = setInterval(() => {
        if (trend_polling) return;
        trend_polling = true;
        pollAgentStates()
            .then(sampleTrends)
            .catch(err => console.error('Trend poll failed:', err?.message || err))
            .finally(() => { trend_polling = false; });
    }, TREND_SAMPLE_MS);
    trendInterval.unref?.();
}

let listenerInterval = null;
function addListener(listener_socket) {
    if (agent_listeners.includes(listener_socket)) return;   // idempotent
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        let polling = false;
        listenerInterval = setInterval(() => {
            // Skip rather than queue: a slow round must not let ticks overlap
            // and pile up.
            if (polling) return;
            polling = true;
            pollAgentStates().then(states => {
                // sampleTrends throttles on TREND_SAMPLE_MS, so sharing this
                // faster poll with the independent one costs nothing.
                sampleTrends(states);
                for (let listener of agent_listeners)
                    listener.emit('state-update', states);
            }).catch(err => {
                console.error('State poll failed:', err?.message || err);
            }).finally(() => { polling = false; });
        }, 1000);
    }
}

function removeListener(listener_socket) {
    const i = agent_listeners.indexOf(listener_socket);
    if (i === -1) return;   // splice(-1) would drop an innocent listener
    agent_listeners.splice(i, 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;