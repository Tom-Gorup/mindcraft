import settings from './settings.js';
import { containsCommand } from './commands/index.js';
import { sendBotChatToServer } from './mindserver_proxy.js';
import { parseOfferMessage, parseAcceptMessage } from './social/trade.js';

let agent;
let agent_names = [];
let agents_in_game = [];

class Conversation {
    constructor(name) {
        this.name = name;
        this.active = false;
        this.ignore_until_start = false;
        this.blocked = false;
        this.in_queue = [];
        this.inMessageTimer = null;
    }

    reset() {
        this.active = false;
        this.ignore_until_start = false;
        this.in_queue = [];
        this.inMessageTimer = null;
    }

    end() {
        this.active = false;
        this.ignore_until_start = true;
        this.inMessageTimer = null;
        const full_message = _compileInMessages(this);
        if (full_message.message.trim().length > 0)
            agent.history.add(this.name, full_message.message);
        // add the full queued messages to history, but don't respond

        if (agent.last_sender === this.name)
            agent.last_sender = null;
    }

    queue(message) {
        this.in_queue.push(message);
    }
}

// isIdle() only reports the ACTION slot. During an act/plan LLM call the
// agent is "idle" by that measure but very much busy, and treating it as free
// made peers interrupt every in-flight prompt.
function _agentBusy() {
    if (!agent) return false;
    if (!agent.isIdle()) return true;          // an action holds the slot
    const b = agent.blackboard?.cognition_busy; // ...or a tier is mid-LLM-call
    return !!(b && (b.plan || b.act));
}

const WAIT_TIME_START = 30000;
// A partner that is in-game but silent (crashed cognition loop, stuck action)
// never trips the disconnect path, so the nudge cadence used to double forever
// — an unbounded series of LLM calls into a conversation that will never
// resume. Give up after a few tries and let the agent get on with its life.
const MAX_UNANSWERED_NUDGES = 3;
class ConversationManager {
    constructor() {
        this.convos = {};
        this.activeConversation = null;
        this.awaiting_response = false;
        this.connection_timeout = null;
        this.wait_time_limit = WAIT_TIME_START;
        this.unanswered_nudges = 0;
    }

    initAgent(a) {
        agent = a;
    }

    _getConvo(name) {
        if (!this.convos[name])
            this.convos[name] = new Conversation(name);
        return this.convos[name];
    }

    _startMonitor() {
        clearInterval(this.connection_monitor);
        // startConversation can replace activeConversation without ending the
        // old one, so a fresh conversation must not inherit the previous
        // partner's doubled timeout or its nudge count.
        this.wait_time_limit = WAIT_TIME_START;
        this.unanswered_nudges = 0;
        let wait_time = 0;
        let last_time = Date.now();
        this.connection_monitor = setInterval(() => {
            if (!this.activeConversation) {
                this._stopMonitor();
                return; // will clean itself up
            }

            let delta = Date.now() - last_time;
            last_time = Date.now();
            let convo_partner = this.activeConversation.name;

            if (this.awaiting_response && !_agentBusy()) {
                wait_time += delta;
                if (wait_time > this.wait_time_limit) {
                    wait_time = 0;
                    this.unanswered_nudges++;
                    if (this.unanswered_nudges > MAX_UNANSWERED_NUDGES) {
                        // Mirror the disconnect path below: when the
                        // self-prompter is paused it resumes on its own a few
                        // seconds later, and prompting here too would drive the
                        // agent from two loops at once.
                        const was_paused = agent.self_prompter.isPaused();
                        this.endConversation(convo_partner);
                        if (!was_paused)
                            agent.handleMessage('system', `${convo_partner} stopped responding, conversation has ended.`);
                        return;
                    }
                    agent.handleMessage('system', `${convo_partner} hasn't responded in ${this.wait_time_limit/1000} seconds, respond with a message to them or your own action.`);
                    this.wait_time_limit*=2;
                }
            }
            else if (!this.awaiting_response){
                this.wait_time_limit = WAIT_TIME_START;
                this.unanswered_nudges = 0;
                wait_time = 0;
            }

            if (!this.otherAgentInGame(convo_partner) && !this.connection_timeout) {
                this.connection_timeout = setTimeout(() => {
                    if (this.otherAgentInGame(convo_partner)){
                        this._clearMonitorTimeouts();
                        return;
                    }
                    if (!agent.self_prompter.isPaused()) {
                        this.endConversation(convo_partner);
                        agent.handleMessage('system', `${convo_partner} disconnected, conversation has ended.`);
                    }
                    else {
                        this.endConversation(convo_partner);
                    }
                }, 10000);
            }
        }, 1000);
    }

    _stopMonitor() {
        clearInterval(this.connection_monitor);
        this.connection_monitor = null;
        this._clearMonitorTimeouts();
    }

    _clearMonitorTimeouts() {
        this.awaiting_response = false;
        this.unanswered_nudges = 0;
        clearTimeout(this.connection_timeout);
        this.connection_timeout = null;
    }

    async startConversation(send_to, message) {
        const convo = this._getConvo(send_to);
        convo.reset();
        
        if (agent.self_prompter.isActive()) {
            await agent.self_prompter.pause();
        }
        if (convo.active)
            return;
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
        this.sendToBot(send_to, message, true, false);
    }

    startConversationFromOtherBot(name) {
        const convo = this._getConvo(name);
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
    }

    sendToBot(send_to, message, start=false, open_chat=true) {
        if (!this.isOtherAgent(send_to)) {
            console.warn(`${agent.name} tried to send bot message to non-bot ${send_to}`);
            return;
        }
        const convo = this._getConvo(send_to);
        
        if (settings.chat_bot_messages && open_chat)
            agent.openChat(`(To ${send_to}) ${message}`);
        
        if (convo.ignore_until_start)
            return;
        convo.active = true;
        
        const end = message.includes('!endConversation');
        const json = {
            'message': message,
            start,
            end,
        };

        this.awaiting_response = true;
        sendBotChatToServer(send_to, json);
    }

    async receiveFromBot(sender, received) {
        const convo = this._getConvo(sender);

        if (convo.ignore_until_start && !received.start)
            return;

        // check if any convo is active besides the sender
        if (this.inConversation() && !this.inConversation(sender)) {
            this.sendToBot(sender, `I'm talking to someone else, try again later. !endConversation("${sender}")`, false, false);
            this.endConversation(sender);
            return;
        }

        if (received.start) {
            convo.reset();
            this.startConversationFromOtherBot(sender);
        }

        this._clearMonitorTimeouts();
        convo.queue(received);
        
        // responding to conversation takes priority over self prompting
        if (agent.self_prompter.isActive()){
            await agent.self_prompter.pause();
        }
    
        _scheduleProcessInMessage(sender, received, convo);
    }

    responseScheduledFor(sender) {
        if (!this.isOtherAgent(sender) || !this.inConversation(sender))
            return false;
        const convo = this._getConvo(sender);
        return !!convo.inMessageTimer;
    }

    isOtherAgent(name) {
        return agent_names.some((n) => n === name);
    }

    otherAgentInGame(name) {
        return agents_in_game.some((n) => n === name);
    }
    
    updateAgents(agents) {
        agent_names = agents.map(a => a.name);
        agents_in_game = agents.filter(a => a.in_game).map(a => a.name);
    }

    getInGameAgents() {
        return agents_in_game;
    }
    
    inConversation(other_agent=null) {
        if (other_agent)
            return this.convos[other_agent]?.active;
        return Object.values(this.convos).some(c => c.active);
    }
    
    endConversation(sender) {
        if (this.convos[sender]) {
            this.convos[sender].end();
            if (this.activeConversation?.name === sender) {
                this._stopMonitor();
                this.activeConversation = null;
            }
            // resume whenever nothing is active — previously this only ran for
            // the active conversation, so ending a non-active one could leave
            // the self-prompter paused forever (which also blocks cognition)
            if (agent.self_prompter.isPaused() && !this.inConversation()) {
                _resumeSelfPrompter();
            }
        }
    }
    
    endAllConversations() {
        for (const sender in this.convos) {
            this.endConversation(sender);
        }
        if (agent.self_prompter.isPaused()) {
            _resumeSelfPrompter();
        }
    }

    forceEndCurrentConversation() {
        if (this.activeConversation) {
            let sender = this.activeConversation.name;
            this.sendToBot(sender, '!endConversation("' + sender + '")', false, false);
            this.endConversation(sender);
        }
    }
}

const convoManager = new ConversationManager();
export default convoManager;

/*
This function controls conversation flow by deciding when the bot responds.
The logic is as follows:
- If neither bot is busy, respond quickly with a small delay.
- If only the other bot is busy, respond with a long delay to allow it to finish short actions (ex check inventory)
- If I'm busy but other bot isn't, let LLM decide whether to respond
- If both bots are busy, don't respond until someone is done, excluding a few actions that allow fast responses
- New messages received during the delay will reset the delay following this logic, and be queued to respond in bulk
*/
const talkOverActions = ['stay', 'followPlayer', 'mode:']; // all mode actions
const fastDelay = 200;
const longDelay = 5000;
async function _scheduleProcessInMessage(sender, received, convo) {
    if (convo.inMessageTimer) {
        clearTimeout(convo.inMessageTimer);
        // must be nulled: responseScheduledFor() reads this field, and a stale
        // truthy handle permanently interrupts every response to this peer
        convo.inMessageTimer = null;
    }
    let otherAgentBusy = containsCommand(received.message);

    const scheduleResponse = (delay) => convo.inMessageTimer = setTimeout(() => _processInMessageQueue(sender), delay);

    if (_agentBusy() && otherAgentBusy) {
        // both are busy
        let canTalkOver = talkOverActions.some(a => agent.actions.currentActionLabel.includes(a));
        if (canTalkOver)
            scheduleResponse(fastDelay);
        // otherwise don't respond
    }
    else if (otherAgentBusy)
        // other bot is busy but I'm not
        scheduleResponse(longDelay);
    else if (_agentBusy()) {
        // I'm busy but other bot isn't
        let canTalkOver = talkOverActions.some(a => agent.actions.currentActionLabel.includes(a));
        if (canTalkOver) {
            scheduleResponse(fastDelay);
        }
        else {
            let shouldRespond = await agent.prompter.promptShouldRespondToBot(received.message);
            console.log(`${agent.name} decided to ${shouldRespond?'respond':'not respond'} to ${sender}`);
            if (shouldRespond)
                scheduleResponse(fastDelay);
        }
    }
    else {
        // neither are busy
        scheduleResponse(fastDelay);
    }
}

function _processInMessageQueue(name) {
    const convo = convoManager._getConvo(name);
    _handleFullInMessage(name, _compileInMessages(convo));
}

function _compileInMessages(convo) {
    let pack = {};
    let full_message = '';
    while (convo.in_queue.length > 0) {
        pack = convo.in_queue.shift();
        full_message += pack.message;
    }
    pack.message = full_message;
    return pack;
}

// Interpersonal verbs only. 'killed'/'attacked' are excluded on purpose: they
// are the most common words in Minecraft chat and almost always refer to mobs
// ("Greta killed the zombie for me"), so they produced constant false grudges.
// Real violence between agents is captured firsthand by !attackPlayer and by
// the death-message hook, which don't need to guess.
const NEGATIVE_GOSSIP = /\b(stole|steals|stealing|lied|lies to|cheated|betrayed|griefed|hoarding|hoards|selfish|greedy|untrustworthy|broke my|took my|refused to (?:share|help))\b/i;
const POSITIVE_GOSSIP = /\b(helped|helps|shared|shares|gave me|saved|generous|trustworthy|looked after|rescued)\b/i;

// Mob nouns near a verb mean the sentence is about combat, not about a person.
const MOB_CONTEXT = /\b(zombie|skeleton|creeper|spider|enderman|witch|slime|drowned|husk|phantom|blaze|piglin|hoglin|ghast|pillager|ravager|guardian|wither|dragon|mob|monster|cow|pig|sheep|chicken)\b/i;

// Detect third-party mentions in an inbound bot message and route them into
// the social module. Cheap string work — no model call. Claims are scoped to
// the sentence naming the subject so one clause can't tar everyone mentioned.
function _absorbGossip(sender, message) {
    try {
        const known = convoManager.getInGameAgents()
            .filter(n => n !== agent.name && n !== sender);
        if (known.length === 0) return;
        for (const sentence of String(message).split(/(?<=[.!?])\s+|\n+/)) {
            if (MOB_CONTEXT.test(sentence)) continue;
            const negative = NEGATIVE_GOSSIP.test(sentence);
            const positive = POSITIVE_GOSSIP.test(sentence);
            if (negative === positive) continue; // neither, or ambiguous
            for (const name of known) {
                const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (!new RegExp(`\\b${escaped}\\b`, 'i').test(sentence)) continue;
                agent.social.receiveGossip(sender, name, sentence.trim(), negative ? 'negative' : 'positive');
            }
        }
    } catch (err) {
        console.error('Social: gossip absorption failed:', err.message || err);
    }
}

function _handleFullInMessage(sender, received) {
    console.log(`${agent.name} responding to "${received.message}" from ${sender}`);
    
    const convo = convoManager._getConvo(sender);
    convo.active = true;

    let message = _tagMessage(received.message);
    if (agent.social?.enabled() && !received.end) {
        // a peer's canonical offer sentence becomes a real entry in our trade
        // book — otherwise !acceptTrade could never find anything to accept
        // messages arrive batched, so a batch can carry both an offer and
        // unrelated talk — handle both rather than either/or
        const offer = parseOfferMessage(received.message);
        if (offer)
            agent.social.receiveTrade(sender, offer.give_item, offer.give_qty, offer.want_item, offer.want_qty);
        const accepted = parseAcceptMessage(received.message);
        if (accepted)
            agent.social.onOfferAccepted(sender, accepted);
        // a peer talking ABOUT a third party is gossip: believe it in proportion
        // to how much we trust the teller, and remember who told us
        _absorbGossip(sender, received.message);
    }
    if (received.end) {
        convoManager.endConversation(sender);
        message = `Conversation with ${sender} ended with message: "${message}"`;
        sender = 'system'; // bot will respond to system instead of the other bot
    }
    else if (received.start)
        agent.shut_up = false;
    convo.inMessageTimer = null;
    agent.handleMessage(sender, message);
}


function _tagMessage(message) {
    return "(FROM OTHER BOT)" + message;
}

async function _resumeSelfPrompter() {
    await new Promise(resolve => setTimeout(resolve, 5000));
    if (agent.self_prompter.isPaused() && !convoManager.inConversation()) {
        agent.self_prompter.start();
    }
}
