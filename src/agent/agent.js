import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import { CognitionLoop } from './cognition/index.js';
import { AgentMemory } from './memory/index.js';
import { LearnedSkills } from './skills/library.js';
import { SocialModule } from './social/index.js';
import { Blackboard } from './cognition/blackboard.js';
import { TierScheduler } from './cognition/scheduler.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { lockdown } from './library/lockdown.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Harden intrinsics at boot, not lazily at the first !newAction —
        // if a dependency is lockdown-incompatible we want a deterministic
        // startup failure, not a throw deep in the network stack mid-session.
        lockdown();

        // Validate the name BEFORE anything derives a filesystem path from it
        // (the Prompter constructor writes ./bots/<name>/last_profile.json) —
        // an unvalidated name is a path-traversal write primitive.
        this.name = (settings.profile?.name || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        settings.profile.name = this.name; // normalized: paths and identity agree

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);

        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        this.blackboard = new Blackboard();
        this.cognition = new CognitionLoop(this);
        this.memory = new AgentMemory(this);
        this.memory_bank.attachMemory(this.memory); // durable places + place events
        this.learned_skills = new LearnedSkills(this);
        this.social = new SocialModule(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        // step commands exist only for the autonomous cognition loop; during a
        // benchmark task cognition is disabled (see cognition._canAct), so they
        // must not be offered there either
        if (!settings.use_cognition || settings.task) {
            this.blocked_actions = this.blocked_actions.concat(['!stepDone', '!stepFailed']);
        }
        // benchmark tasks have their own collaboration protocol; trade
        // commands there cost prompt space and can hijack task conversations
        if (!settings.use_social || settings.task) {
            this.blocked_actions = this.blocked_actions.concat(['!offerTrade', '!acceptTrade', '!declineTrade']);
        }
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { msg } = handleDisconnection(this.name, reason);
            // Route through cleanKill so state is flushed. Exiting directly
            // here also made the cleanKill handlers registered later in
            // _setupEventHandlers unreachable dead code.
            this.cleanKill(msg, 1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            // bot.chat splits on newlines and sends each line as its own packet,
            // so unvalidated skin fields would be a command-injection vector.
            const skin = this.prompter.profile.skin;
            const skin_model = /^(classic|slim)$/.test(skin?.model || '') ? skin.model : null;
            const skin_path = /^https?:\/\/[\w.~:/?#[\]@!$&'()*+,;=%-]+$/.test(skin?.path || '') ? skin.path : null;
            if (skin_model && skin_path)
                this.bot.chat(`/skin set URL ${skin_model} ${skin_path}`);
            else {
                if (skin)
                    console.warn('Ignoring invalid profile skin (model must be classic|slim, path must be a plain http(s) URL).');
                this.bot.chat(`/skin clear`);
            }
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
                this.memory.record('session', 'Spawned into the world');
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??');
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        };

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null, opts={}) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;
        // who this exchange is actually with (humans included) — last_sender is
        // bot-only and persists after a conversation ends, so using it for
        // social context showed the wrong peer's trades and burned gossip on
        // someone who was never spoken to
        this.current_source = self_prompt ? null : source;

        if (!self_prompt) {
            this.cognition.onInteraction();
            this.social?.record(source, 'conversed');
        }

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        // step_interrupt only applies to the cognition act loop that raised it
        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt)
            || (opts.cognition_step && this.cognition.shouldInterrupt())
            || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
            this.memory.record('narration', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        if (!self_prompt)
            this.memory.record('chat_received', `${source} said: ${message}`, { source });
        this.history.save();

        if (!self_prompt && (this.self_prompter.isActive() || this.cognition.isPursuing())) {
            max_responses = 1; // respond to this message, then let self-prompting/cognition take over
            // stop the autonomous loop from interleaving its turns with this
            // exchange — two loops sharing history corrupts both transcripts
            this.cognition.interruptAct();
        }
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res;
            try {
                res = await this.prompter.promptConvo(history);
            } catch (err) {
                // Providers throw on real failures (bad key, 404 model, rate
                // limit) rather than returning prose — otherwise an outage is
                // indistinguishable from an answer. Surface it in-band: most
                // callers here are fire-and-forget, so rethrowing would only
                // produce an unhandled rejection and a silently dropped turn.
                const msg = err?.message || String(err);
                console.error(`${this.name}: model call failed —`, msg);
                this._model_failures = (this._model_failures || 0) + 1;
                // say it out loud once, so the failure is visible in-game and
                // not only in the terminal
                if (this._model_failures === 1) {
                    try { this.openChat(`I can't reach my model right now: ${msg.substring(0, 180)}`); }
                    catch { /* not logged in yet */ }
                }
                await this.history.add('system', `Model call failed: ${msg}`);
                this.memory?.record('interruption', `Model call failed: ${msg}`);
                break;
            }
            this._model_failures = 0;

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response');
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name);
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;
                // Queries never touch ActionManager, so they emit no 'idle'.
                // Without this an info-gathering turn leaves the act tier with
                // nothing to wake it until the heartbeat.
                this.cognition?.notifyEvent(`ran ${command_name}`);
                this.memory.record('command', `${command_name}: ${(execute_res || 'done').substring(0, 150)}`, { command: command_name });

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        // Only the prose part is deliberate speech: command echoes
        // ('*Tom used stats*'), error notices, and the trailing !command(...)
        // syntax are recorded as their own event types, so keep the taxonomy
        // clean for the research trace (and out of the speech embeddings).
        if (!message.startsWith('*') && !message.startsWith("Command '")) {
            const cmd = containsCommand(message);
            const prose = (cmd ? message.substring(0, message.indexOf(cmd)) : message).trim();
            if (prose.length > 0)
                this.memory.record('speech', prose, { to: to_player });
        }
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');
        // A leading '/' makes the server execute this as a command AS THE BOT.
        // Chat is attacker-influenced ("repeat exactly: /kill @a"), so never
        // let generated text start one.
        if (message.startsWith('/')) message = ' ' + message;

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
                if (this.bot.lastDamageTaken >= 3)
                    this.memory.record('damage', `Took ${this.bot.lastDamageTaken.toFixed(0)} damage (health now ${this.bot.health.toFixed(0)}/20)`);
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        // Victim side of violence: without this the only firsthand grudge
        // source is dying, so a bot that gets beaten but survives feels
        // nothing. 1.20+ reports the responsible entity.
        this.bot.on('entityHurt', (entity, source) => {
            if (!entity || entity.id !== this.bot.entity?.id) return;
            const attacker = source?.username || source?.name;
            if (attacker && attacker !== this.name && this.bot.players[attacker])
                this.social?.record(attacker, 'attacked_by');
        });
        // Reciprocal positive: someone tossing us items. Only credited when a
        // single other player is close enough to plausibly be the giver.
        this.bot.on('playerCollect', (collector, collected) => {
            if (collector?.username !== this.name || !collected) return;
            const near = Object.values(this.bot.players)
                .filter(p => p?.entity && p.username !== this.name
                    && p.entity.position.distanceTo(this.bot.entity.position) < 6);
            if (near.length === 1)
                this.social?.record(near[0].username, 'received_item');
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.cognition.onDeath();
                this.memory.record('death', `Died in the ${dimention} dimension at ${death_pos_text || 'unknown position'}: ${message}`);
                // "<name> was slain by X" — a killer who is a player/bot earns a grudge
                // NOTE: a mob name-tagged with a player's username can spoof
                // this line, so it is deliberately the only grudge source that
                // depends on server text. bot.players gating keeps it to real
                // online names; a spoof costs the victim a decaying grudge.
                const killer = message.match(/(?:slain|shot|killed|blown up|fireballed|impaled|squashed|skewered|pummeled|stung to death|pricked to death) by ([A-Za-z0-9_]{3,16})/)?.[1];
                if (killer && killer !== this.name && this.bot.players[killer])
                    this.social?.record(killer, 'killed_by');
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            this.cognition?.notifyEvent('action finished'); // new information: decide again
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // PIANO-style tier scheduler over the shared blackboard. Registration
        // order = invocation order within a tick (reflexes are dispatched
        // first; async tiers may still resolve later — the act tier's
        // isReflexActive/idle gates are the real coherence barrier). Tiers
        // are skipped (never queued) while their previous run is in flight,
        // and their errors are isolated from the pump and each other.
        const cog_opts = this.prompter.profile.cognition || {};
        const mem_opts = this.prompter.profile.memory || {};
        this.scheduler = new TierScheduler(this.blackboard);
        this.scheduler.addTier('reflex', 0, async () => { await this.bot.modes.update(); });
        this.scheduler.addTier('act', cog_opts.act_cadence_ms ?? 300, (elapsed) => this.cognition.actTick(elapsed));
        this.scheduler.addTier('plan', cog_opts.plan_cadence_ms ?? 1000, (elapsed) => this.cognition.planTick(elapsed));
        this.scheduler.addTier('reflect', mem_opts.reflect_cadence_ms ?? 10000, () => this.memory.reflectTick());
        this.scheduler.addTier('economics', 3600000, () => this.logEconomics());
        this.scheduler.addTier('social', 2000, () => {
            this.blackboard.social = {
                in_conversation: convoManager.inConversation(),
                partner: convoManager.activeConversation?.name ?? null,
                relationships: this.social.getStatus().relationships,
            };
            this.social.tick(); // relationship decay + trade-offer expiry, no LLM calls
        });

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                try {
                    await this.update(start - last);
                } catch (err) {
                    // an escaped exception here would silently kill modes,
                    // self-prompting, and cognition for the rest of the run
                    console.error('Agent update loop error:', err);
                }
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        this.scheduler.tick(delta);
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        if (this._killing) return;   // every shutdown path funnels here
        this._killing = true;
        // bot.chat does not exist until mineflayer finishes login, and this is
        // reachable before that (mindserver disconnect, spawn timeout) — an
        // unguarded call threw and the process then never exited at all.
        try { this.bot?.chat?.(code > 1 ? 'Restarting.' : 'Exiting.'); } catch { /* not logged in yet */ }

        const flush = () => {
            try { this.history.save(); } catch (err) { console.error('Failed to save history on shutdown:', err); }
            try { if (settings.use_cognition) this.cognition?.persist(); } catch (err) { console.error('Failed to persist cognition state on shutdown:', err); }
            try { this.learned_skills?.flush(); } catch (err) { console.error('Failed to flush skills on shutdown:', err); }
            try { this.social?.flush(); } catch (err) { console.error('Failed to flush social state on shutdown:', err); }
            try { this.logEconomics(); } catch (err) { console.error('Failed to log economics summary:', err); }
            process.exit(code);
        };
        // history.add can trigger an LLM summarization with no timeout; never
        // let a hung provider prevent the flush from running at all.
        let flushed = false;
        const once = () => { if (!flushed) { flushed = true; flush(); } };
        const guard = setTimeout(once, 5000);
        guard.unref?.();
        Promise.resolve(this.history.add('system', msg))
            .catch(() => {})
            .finally(() => {
                clearTimeout(guard);
                once();
            });
    }

    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    // Run-summary log: what this agent actually cost, and how much of it
    // stayed local. Printed on shutdown and hourly during long runs.
    logEconomics() {
        const router = this.prompter?.router;
        if (!router) return;
        const s = router.getStatus();
        const tiers = Object.entries(s.by_tier)
            .sort((a, b) => b[1].calls - a[1].calls)
            .map(([t, v]) => `${t}=${v.calls}(${Math.round(v.local_share * 100)}% local)`)
            .join(' ');
        // cache_hit_rate is only non-zero when a provider reports real usage
        // (Anthropic does). 0% while using a cache-capable model means the
        // breakpoint is not engaging — see tools/measure_prompt.mjs.
        const cache = s.totals.cache_read_tokens
            ? ` | cache ${Math.round(s.cache_hit_rate * 100)}% of input `
              + `(${Math.round(s.totals.cache_read_tokens / 1000)}k read, ${Math.round(s.totals.cache_write_tokens / 1000)}k written)`
            : '';
        console.log(`[economics] ${this.name}: ${s.totals.calls} calls, `
            + `${Math.round((s.totals.in_tokens + s.totals.out_tokens) / 1000)}k tokens, `
            + `$${s.totals.cost.toFixed(4)}, ${Math.round(s.local_share * 100)}% local | `
            + `~${s.per_hour.calls} calls/hr, ~$${s.per_hour.cost}/hr | ${tiers}${cache}`);
    }

    killAll() {
        serverProxy.shutdown();
    }
}
