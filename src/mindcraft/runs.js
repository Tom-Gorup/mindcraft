import { appendFileSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync } from 'fs';
import path from 'path';

// Named research runs. A run captures the agent event stream for a window of
// time so experiments are comparable: start a run, let the sim play, stop it,
// then report on or export exactly those events.
//
// Events are appended to runs/<id>/events.jsonl as they arrive — the same
// format tools/trace.py consumes with --events, so the in-app report and the
// offline analyzer read identical input. A crash loses at most the last write,
// never the run.
export class RunRegistry {
    constructor(dir = './runs', opts = {}) {
        this.dir = dir;
        this.max_events_in_ram = opts.max_events_in_ram ?? 20000;
        this.runs = new Map();     // id -> {id, name, started_at, ended_at, worlds, agents, event_count}
        this.active = null;        // id of the run currently capturing
        this.buffer = [];          // in-RAM events of the active run, for live reports
        try {
            mkdirSync(this.dir, { recursive: true });
            this._loadIndex();
        } catch (err) {
            console.error('Runs: could not initialize run directory:', err.message || err);
        }
    }

    _indexPath() { return path.join(this.dir, 'index.json'); }
    _runDir(id) { return path.join(this.dir, id); }
    _eventsPath(id) { return path.join(this._runDir(id), 'events.jsonl'); }

    _loadIndex() {
        if (!existsSync(this._indexPath())) return;
        try {
            const data = JSON.parse(readFileSync(this._indexPath(), 'utf8'));
            for (const r of (Array.isArray(data.runs) ? data.runs : [])) {
                if (r && typeof r.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(r.id))
                    this.runs.set(r.id, r);
            }
        } catch (err) {
            console.error('Runs: index unreadable, starting fresh:', err.message || err);
        }
    }

    _saveIndex() {
        try {
            const tmp = this._indexPath() + '.tmp';
            writeFileSync(tmp, JSON.stringify({ runs: [...this.runs.values()] }, null, 2));
            renameSync(tmp, this._indexPath());
        } catch (err) {
            console.error('Runs: could not save index:', err.message || err);
        }
    }

    // Run ids are used as directory names — keep them strictly safe.
    static slugify(name, now) {
        const base = String(name || 'run').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 40) || 'run';
        return `${base}-${now}`;
    }

    start(name, now = Date.now()) {
        if (this.active) this.stop(now);
        const id = RunRegistry.slugify(name, now);
        const run = {
            id,
            name: String(name || 'run').substring(0, 100),
            started_at: now,
            ended_at: null,
            agents: [],
            worlds: [],
            event_count: 0,
        };
        try {
            mkdirSync(this._runDir(id), { recursive: true });
        } catch (err) {
            console.error('Runs: could not create run directory:', err.message || err);
            return null;
        }
        this.runs.set(id, run);
        this.active = id;
        this.buffer = [];
        this._saveIndex();
        console.log(`Runs: started '${run.name}' (${id})`);
        return run;
    }

    stop(now = Date.now()) {
        if (!this.active) return null;
        const run = this.runs.get(this.active);
        if (run) {
            run.ended_at = now;
            this._saveIndex();
            console.log(`Runs: stopped '${run.name}' (${run.event_count} events)`);
        }
        this.active = null;
        this.buffer = [];
        return run;
    }

    // Capture one event into the active run. Never throws — this is on the
    // dashboard relay path.
    record(event) {
        if (!this.active) return;
        try {
            const run = this.runs.get(this.active);
            if (!run) return;
            const rec = {
                ts: Number(event.ts) || Date.now(),
                agent: String(event.agent || 'unknown').substring(0, 32),
                type: String(event.type || 'other').substring(0, 40),
                content: String(event.content || '').substring(0, 1000),
                data: (event.data && typeof event.data === 'object') ? event.data : undefined,
                world: event.world ? String(event.world).substring(0, 64) : undefined,
                run: run.id,
            };
            this.buffer.push(rec);
            if (this.buffer.length > this.max_events_in_ram)
                this.buffer.splice(0, this.buffer.length - this.max_events_in_ram);
            appendFileSync(this._eventsPath(run.id), JSON.stringify(rec) + '\n');
            run.event_count++;
            if (rec.agent && !run.agents.includes(rec.agent)) run.agents.push(rec.agent);
            if (rec.world && !run.worlds.includes(rec.world)) run.worlds.push(rec.world);
        } catch (err) {
            console.error('Runs: failed to record event:', err.message || err);
        }
    }

    list() {
        return [...this.runs.values()].sort((a, b) => b.started_at - a.started_at);
    }

    get(id) {
        return this.runs.get(id) || null;
    }

    // Events for a run: the live buffer for the active run, otherwise read
    // back from disk.
    events(id) {
        if (id === this.active) return [...this.buffer];
        if (!this.runs.has(id)) return [];
        try {
            const fp = this._eventsPath(id);
            if (!existsSync(fp)) return [];
            const out = [];
            for (const line of readFileSync(fp, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
            }
            return out;
        } catch (err) {
            console.error('Runs: could not read events:', err.message || err);
            return [];
        }
    }

    // Absolute path of the JSONL a user can hand to tools/trace.py.
    exportPath(id) {
        return this.runs.has(id) ? path.resolve(this._eventsPath(id)) : null;
    }

    // Delete is deliberately not exposed over the socket API — archives are
    // research data. Removing a run means removing its directory by hand.
    static listOnDisk(dir = './runs') {
        try {
            return existsSync(dir) ? readdirSync(dir).filter(f => !f.startsWith('.') && f !== 'index.json') : [];
        } catch {
            return [];
        }
    }
}
