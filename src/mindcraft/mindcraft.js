import { createMindServer, registerAgent, numStateListeners } from './mindserver.js';
import { AgentProcess } from '../process/agent_process.js';
import { getServer } from './mcserver.js';
import { validateNameFormat } from '../agent/connection_handler.js';
import open from 'open';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

let mindserver;
let connected = false;
let agent_processes = {};
let agent_count = 0;
let mindserver_port = 8080;

export async function init(host_public=false, port=8080, auto_open_ui=true) {
    if (connected) {
        console.error('Already initiliazed!');
        return;
    }
    mindserver = createMindServer(host_public, port);
    mindserver_port = port;
    connected = true;
    if (auto_open_ui) {
        setTimeout(() => {
            // check if browser listener is already open
            if (numStateListeners() === 0) {
                // headless hosts have no browser to open; an unhandled
                // rejection here would take the whole mindserver down
                open('http://localhost:' + port)
                    .catch(err => console.warn('Could not open a browser automatically:', err.message || err));
            }
        }, 3000);
    }
}


// Which agents the operator actually wants running.
//
// Auto-restart is right for a crash and wrong for a deliberate restart: after
// `systemctl restart` every agent rejoins the world whether or not you wanted
// it to. The distinction that matters is INTENT, not process state, so it is
// recorded when you stop an agent and consulted on boot. A crashed agent is
// still "running" and comes back; one you stopped stays stopped.
const INTENT_FILE = './bots/.agent_intent.json';

function loadIntent() {
    try {
        return JSON.parse(readFileSync(INTENT_FILE, 'utf8'));
    } catch {
        return {};                     // absent or unreadable: default to running
    }
}

function setIntent(agentName, state) {
    try {
        const all = loadIntent();
        all[agentName] = state;
        mkdirSync('./bots', { recursive: true });
        writeFileSync(INTENT_FILE, JSON.stringify(all, null, 2));
    } catch (err) {
        // Never let bookkeeping stop an agent from starting or stopping.
        console.warn(`Could not record intent for ${agentName}:`, err.message || err);
    }
}

// Exported so main.js can report what it is deliberately skipping.
export function wantsToRun(agentName) {
    return loadIntent()[agentName] !== 'stopped';
}

export async function createAgent(settings) {
    if (!settings.profile.name) {
        console.error('Agent name is required in profile');
        return {
            success: false,
            error: 'Agent name is required in profile'
        };
    }
    // the name becomes a filesystem path in the child process; validate here
    // so an unvalidated name never reaches a mkdir/write
    const nameCheck = validateNameFormat(String(settings.profile.name).trim());
    if (!nameCheck.success) {
        console.error(nameCheck.msg);
        return { success: false, error: nameCheck.msg };
    }
    settings.profile.name = String(settings.profile.name).trim();
    // Two agents with one name share bots/<name>/ — the same memory stream,
    // history and cognition file, written by two processes. Refuse instead.
    if (agent_processes[settings.profile.name]) {
        const msg = `An agent named '${settings.profile.name}' is already running. Names must be unique — they are the agent's storage directory.`;
        console.error(msg);
        return { success: false, error: msg };
    }
    settings = JSON.parse(JSON.stringify(settings));
    let agent_name = settings.profile.name;
    const agentIndex = agent_count++;
    const viewer_port = 3000 + agentIndex;
    registerAgent(settings, viewer_port);
    let load_memory = settings.load_memory || false;
    let init_message = settings.init_message || null;

    try {
        try {
            const server = await getServer(settings.host, settings.port, settings.minecraft_version);
            settings.host = server.host;
            settings.port = server.port;
            settings.minecraft_version = server.version;
        } catch (error) {
            console.warn(`Error getting server:`, error);
            if (settings.minecraft_version === "auto") {
                settings.minecraft_version = null;
            }
            console.warn(`Attempting to connect anyway...`);
        }

        const agentProcess = new AgentProcess(agent_name, mindserver_port);
        agent_processes[settings.profile.name] = agentProcess;
        // Registered either way, so it appears in the dashboard with a Start
        // button rather than vanishing.
        const autostart = settings.autostart_agents !== false;
        if (autostart && wantsToRun(agent_name)) {
            agentProcess.start(load_memory, init_message, agentIndex);
        } else {
            agentProcess.pending_start = { load_memory, init_message, agentIndex };
            console.log(`${agent_name}: registered but not started `
                + `(${autostart ? 'stopped by you previously' : 'autostart_agents is off'}). `
                + `Start it from the dashboard.`);
        }
    } catch (error) {
        console.error(`Error creating agent ${agent_name}:`, error);
        destroyAgent(agent_name);
        return {
            success: false,
            error: error.message
        };
    }
    return {
        success: true,
        error: null
    };
}

export function getAgentProcess(agentName) {
    return agent_processes[agentName];
}

export function startAgent(agentName) {
    if (agent_processes[agentName]) {
        setIntent(agentName, 'running');
        const p = agent_processes[agentName];
        // First start after boot-with-autostart-off: the process was never
        // spawned, so there is nothing to restart.
        if (p.pending_start) {
            const { load_memory, init_message, agentIndex } = p.pending_start;
            p.pending_start = null;
            p.start(load_memory, init_message, agentIndex);
        } else {
            p.forceRestart();
        }
    }
    else {
        console.error(`Cannot start agent ${agentName}; not found`);
    }
}

export function stopAgent(agentName) {
    if (agent_processes[agentName]) {
        setIntent(agentName, 'stopped');
        agent_processes[agentName].stop();
    }
}

export function destroyAgent(agentName) {
    if (agent_processes[agentName]) {
        agent_processes[agentName].stop();
        delete agent_processes[agentName];
    }
}

export function shutdown() {
    console.log('Shutting down');
    for (let agentName in agent_processes) {
        agent_processes[agentName].stop();
    }
    setTimeout(() => {
        process.exit(0);
    }, 2000);
}
