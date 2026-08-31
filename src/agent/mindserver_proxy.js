import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import { setSettings } from './settings.js';
import { getFullState } from './library/full_state.js';

// agent's individual connection to the mindserver
// always connect to localhost

class MindServerProxy {
    constructor() {
        if (MindServerProxy.instance) {
            return MindServerProxy.instance;
        }
        
        this.socket = null;
        this.connected = false;
        this.agents = [];
        MindServerProxy.instance = this;
    }

    async connect(name, port) {
        if (this.connected) return;
        
        this.name = name;
        this.socket = io(`http://localhost:${port}`);

        await new Promise((resolve, reject) => {
            this.socket.on('connect', resolve);
            this.socket.on('connect_error', (err) => {
                console.error('Connection failed:', err);
                reject(err);
            });
        });

        this.connected = true;
        console.log(name, 'connected to MindServer');

        this.socket.on('disconnect', () => {
            console.log('Disconnected from MindServer');
            this.connected = false;
            if (this.agent) {
                this.agent.cleanKill('Disconnected from MindServer. Killing agent process.');
            }
        });

        this.socket.on('chat-message', (agentName, json) => {
            convoManager.receiveFromBot(agentName, json);
        });

        this.socket.on('agents-status', (agents) => {
            this.agents = agents;
            convoManager.updateAgents(agents);
            if (this.agent?.task) {
                console.log(this.agent.name, 'updating available agents');
                this.agent.task.updateAvailableAgents(agents);
            }
        });

        this.socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });
		
        this.socket.on('send-message', (data) => {
            try {
                this.agent.respondFunc(data.from, data.message);
            } catch (error) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });

        this.socket.on('get-full-state', (callback) => {
            try {
                const state = getFullState(this.agent);
                callback(state);
            } catch (error) {
                console.error('Error getting full state:', error);
                callback(null);
            }
        });

        // Request settings and wait for response
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Settings request timed out after 5 seconds'));
            }, 5000);

            this.socket.emit('get-settings', name, (response) => {
                clearTimeout(timeout);
                if (response.error) {
                    return reject(new Error(response.error));
                }
                setSettings(response.settings);
                this.socket.emit('connect-agent-process', name);
                resolve();
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
    }

    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    login() {
        this.socket.emit('login-agent', this.agent.name);
    }

    shutdown() {
        this.socket.emit('shutdown');
    }

    getSocket() {
        return this.socket;
    }
}

// Create and export a singleton instance
export const serverProxy = new MindServerProxy();

// for chatting with other bots
export function sendBotChatToServer(agentName, json) {
    serverProxy.getSocket().emit('chat-message', agentName, json);
}

// for sending general output to server for display
// Push a notable memory event to the dashboard feed. Fire-and-forget: the
// feed is an observability nicety and must never affect agent behavior.
export function sendEventToServer(agentName, event) {
    try {
        // `data` carries the fields the research report is built from —
        // command name, counterpart, item/qty. Dropping it made the
        // interaction matrix and resource flow permanently empty. Whitelisted
        // and size-capped: it reaches the run archive and the report.
        const d = event.data && typeof event.data === 'object' ? event.data : null;
        const data = d ? {
            command: typeof d.command === 'string' ? d.command.substring(0, 40) : undefined,
            to: typeof d.to === 'string' ? d.to.substring(0, 32) : undefined,
            peer: typeof d.peer === 'string' ? d.peer.substring(0, 32) : undefined,
            source: typeof d.source === 'string' ? d.source.substring(0, 32) : undefined,
            teller: typeof d.teller === 'string' ? d.teller.substring(0, 32) : undefined,
            subject: typeof d.subject === 'string' ? d.subject.substring(0, 32) : undefined,
            item: typeof d.item === 'string' ? d.item.substring(0, 40) : undefined,
            qty: Number.isFinite(d.qty) ? d.qty : undefined,
            drive: typeof d.drive === 'string' ? d.drive.substring(0, 24) : undefined,
        } : undefined;
        serverProxy.getSocket()?.emit('agent-event', {
            agent: agentName,
            ts: event.ts,
            type: event.type,
            content: event.content,
            data,
        });
    } catch { /* dashboard is optional */ }
}

export function sendOutputToServer(agentName, message) {
    serverProxy.getSocket().emit('bot-output', agentName, message);
}
