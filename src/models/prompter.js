import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';
import { ModelRouter } from './router.js';
import { CACHE_BOUNDARY, stripBoundary } from './cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Placeholders that specialized prompt methods substitute AFTER replaceStrings
// (so untrusted/dynamic content is never re-expanded); replaceStrings must not
// warn about them.
const DEFERRED_PLACEHOLDERS = new Set(['$DRIVE', '$DRIVE_STATE', '$RELEVANT_MEMORIES', '$GOAL', '$FAILURE_CONTEXT', '$EVENTS', '$TASK', '$CODE', '$OUTPUT']);

export class Prompter {
    constructor(agent, profile) {
        this.agent = agent;
        this.profile = profile;
        const defaults_dir = path.join(__dirname, '../../profiles/defaults');
        let default_profile = JSON.parse(readFileSync(path.join(defaults_dir, '_default.json'), 'utf8'));
        let base_fp = '';
        if (settings.base_profile.includes('survival')) {
            base_fp = path.join(defaults_dir, 'survival.json');
        } else if (settings.base_profile.includes('assistant')) {
            base_fp = path.join(defaults_dir, 'assistant.json');
        } else if (settings.base_profile.includes('creative')) {
            base_fp = path.join(defaults_dir, 'creative.json');
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = path.join(defaults_dir, 'god_mode.json');
        }
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        // small LRU for query embeddings: consecutive prompts in one loop
        // embed near-identical text, and this path runs thousands of times/hour
        this._embed_cache = new Map();
        this._embed_cache_max = 256;
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;

        // for backwards compatibility, move max_tokens to params
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = selectAPI(this.profile.model);
        this.chat_model = createModel(chat_model_profile);

        if (this.profile.code_model) {
            let code_model_profile = selectAPI(this.profile.code_model);
            this.code_model = createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = selectAPI(this.profile.vision_model);
            this.vision_model = createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        
        let embedding_model_profile = null;
        if (this.profile.embedding) {
            try {
                embedding_model_profile = selectAPI(this.profile.embedding);
            } catch (e) {
                embedding_model_profile = null;
            }
        }
        // createModel calls getKey(), which THROWS for a missing API key. An
        // unguarded embedding model meant an Ollama-only or Groq-only setup
        // could not boot at all, failing with a message naming a provider the
        // user never configured. Retrieval degrades to word overlap instead.
        try {
            this.embedding_model = embedding_model_profile
                ? createModel(embedding_model_profile)
                : createModel({api: chat_model_profile.api});
        } catch (err) {
            this.embedding_model = null;
            console.warn(`Embedding model unavailable (${err.message || err}). `
                + 'Memory, skill, and example retrieval will fall back to word overlap. '
                + 'Set "embedding" in the profile (e.g. "ollama") to fix.');
        }

        // Tiered routing over the roles above. With no "tiers" block in the
        // profile every tier resolves to the same model it used before, so
        // existing profiles are unaffected.
        this.router = new ModelRouter(this.profile, {
            chat: this.chat_model,
            code: this.code_model,
            vision: this.vision_model,
        }, {
            buildModel: (spec) => {
                const resolved = selectAPI(spec);
                return { model: createModel(resolved), api: resolved.api, name: resolved.model };
            },
        });
        this.embedding_api = embedding_model_profile?.api ?? chat_model_profile.api;

        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        mkdirSync(`./bots/${name}`, { recursive: true });
        writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw new Error('Failed to save profile:', err);
            }
            console.log("Copy profile saved.");
        });
    }

    getName() {
        return this.profile.name;
    }

    // Cached embedding for repeated/near-identical retrieval queries.
    // Rejections are not cached — a transient outage must not poison the map.
    async embedCached(text) {
        if (!this.embedding_model) return null;
        const key = String(text);
        if (this._embed_cache.has(key)) {
            const vec = this._embed_cache.get(key);
            this._embed_cache.delete(key);
            this._embed_cache.set(key, vec); // refresh LRU position
            return vec;
        }
        const vec = await this.embedding_model.embed(key);
        this.router?.recordEmbedding(this.embedding_api, this.embedding_model?.model_name, key);
        if (Array.isArray(vec)) {
            this._embed_cache.set(key, vec);
            if (this._embed_cache.size > this._embed_cache_max)
                this._embed_cache.delete(this._embed_cache.keys().next().value);
        }
        return vec;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);
            
            // Wait for both examples to load before proceeding
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null) {
        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent) + '\n';
            stats += await getCommand('!entities').perform(this.agent) + '\n';
            stats += await getCommand('!nearbyBlocks').perform(this.agent);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS'))
            prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs(this.agent));
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        // $STATIC_EXAMPLES: every example, always, in profile order — so the
        // text is byte-identical on every call and can live in the cached
        // prefix. $EXAMPLES picks the most similar few, which is better
        // targeting but varies per call and therefore cannot be cached. At
        // 0.1x for cached tokens, carrying all of them costs less than
        // carrying two uncached, and the model sees more coverage.
        if (prompt.includes('$STATIC_EXAMPLES')) {
            const all = (this.profile.conversation_examples || [])
                .map(convo => convo.map(m => `${m.role}: ${m.content}`).join('\n'))
                .join('\n\n');
            prompt = prompt.replaceAll('$STATIC_EXAMPLES', () => all);
        }
        // NOTE: $MEMORY is handled at the END of this function — memory
        // content includes recorded chat (untrusted) and must not be
        // re-expanded by the placeholder substitutions below.
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            let self_prompt = '';
            if (!this.agent.self_prompter.isStopped())
                self_prompt = `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n`;
            else if (this.agent.cognition?.isPursuing())
                self_prompt = this.agent.cognition.getGoalContext();
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`;
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`;
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        if (prompt.includes('$SOCIAL')) {
            // relationship state + any pending trade + optional gossip cue.
            // Substituted here (late, via function replacer) because it can
            // contain peer names and remembered chat — untrusted text.
            let social_text = '';
            if (this.agent.social?.enabled())
                social_text = this.agent.social.getContext(this.agent.current_source || null);
            prompt = prompt.replaceAll('$SOCIAL', () => social_text);
        }

        if (prompt.includes('$MEMORY')) {
            let memory_text = this.agent.history.memory;
            // augment the lossy summary with retrieved long-term memories,
            // queried by recent conversation (skipped when summarizing).
            // Function replacer: memory content is untrusted (recorded chat)
            // and must not be interpreted as a $-replacement pattern.
            if (this.agent.memory?.enabled() && messages && messages.length > 0) {
                const query = messages.slice(-2).map(m => m?.content || '').join('\n').substring(0, 400);
                const retrieved = await this.agent.memory.retrieveText(query);
                if (retrieved)
                    memory_text += '\n' + retrieved;
            }
            prompt = prompt.replaceAll('$MEMORY', () => memory_text);
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            remaining = remaining.filter(p => !DEFERRED_PLACEHOLDERS.has(p));
            if (remaining.length > 0)
                console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, this.cooldown - elapsed));
        }
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages) {
        this.most_recent_msg_time = Date.now();
        let current_msg_time = this.most_recent_msg_time;

        for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
            await this.checkCooldown();
            if (current_msg_time !== this.most_recent_msg_time) {
                return '';
            }

            let prompt = this.profile.conversing;
            let generation;

            try {
                // inside the try: a throw here (e.g. a blocked query command
                // used by $STATS) would otherwise escape promptConvo entirely
                // and silently kill the calling loop
                prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
                generation = await this.router.run('chat', 'conversing',
                    (model, system) => model.sendRequest(messages, system),
                    { in_text: prompt, system: prompt });
                if (typeof generation !== 'string') {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                console.log("Generated response:", generation);
                await this._saveLog(prompt, messages, generation, 'conversation');

            } catch (error) {
                console.error('Error during message generation or file writing:', error);
                continue;
            }

            // Check for hallucination or invalid output
            if (generation?.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');
                continue;
            }

            if (current_msg_time !== this.most_recent_msg_time) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                return '';
            }

            if (generation?.includes('</think>')) {
                const [_, afterThink] = generation.split('</think>');
                generation = afterThink;
            }

            return generation;
        }

        return '';
    }

    // Sentinel returned when a second coding request overlaps the first.
    // Callers MUST NOT treat it as a successful program (see coder.js).
    static NO_CODE_RESPONSE = '```//no response```';

    async promptCoding(messages) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return Prompter.NO_CODE_RESPONSE;
        }
        this.awaiting_coding = true;
        try {
            await this.checkCooldown();
            let prompt = this.profile.coding;
            prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

            let resp = await this.router.run('code', 'coding',
                (model, system) => model.sendRequest(messages, system),
                { in_text: prompt, system: prompt });
            await this._saveLog(prompt, messages, resp, 'coding');
            return resp;
        } finally {
            // without finally, one provider error latches the flag and every
            // future !newAction silently returns the stub forever
            this.awaiting_coding = false;
        }
    }

    async promptMemSaving(to_summarize) {
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize);
        let resp = await this.router.run('reflex', 'memSaving',
            (model) => model.sendRequest([], stripBoundary(prompt)), { in_text: prompt });
        await this._saveLog(prompt, to_summarize, resp, 'memSaving');
        if (resp?.includes('</think>')) {
            const [_, afterThink] = resp.split('</think>');
            resp = afterThink;
        }
        return resp;
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, null, null, messages);
        let res = await this.router.run('reflex', 'botResponder',
            (model) => model.sendRequest([], stripBoundary(prompt)), { in_text: prompt });
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        return await this.router.run('vision', 'vision',
            (model) => model.sendVisionRequest(messages, prompt, imageBuffer), { in_text: prompt });
    }

    async promptGoalGeneration(drive_name, drive_state_text) {
        await this.checkCooldown();
        let prompt = this.profile.goal_generation;
        prompt = await this.replaceStrings(prompt, []);
        prompt = await this._replaceRelevantMemories(prompt, drive_name + ' ' + drive_state_text);
        // $DRIVE_STATE must go first: $DRIVE is its prefix and would clobber it
        prompt = prompt.replaceAll('$DRIVE_STATE', () => drive_state_text);
        prompt = prompt.replaceAll('$DRIVE', () => drive_name);
        let res = await this.router.run('plan', 'goalGeneration',
            (model) => model.sendRequest([], stripBoundary(prompt)), { in_text: prompt });
        await this._saveLog(prompt, [], res, 'goalGeneration');
        return res;
    }

    async promptTaskPlanning(goal_text, failure_context='') {
        await this.checkCooldown();
        let prompt = this.profile.task_planning;
        prompt = await this.replaceStrings(prompt, []);
        prompt = await this._replaceRelevantMemories(prompt, goal_text);
        prompt = prompt.replaceAll('$GOAL', () => goal_text);
        prompt = prompt.replaceAll('$FAILURE_CONTEXT', () => failure_context);
        let res = await this.router.run('plan', 'taskPlanning',
            (model) => model.sendRequest([], stripBoundary(prompt)), { in_text: prompt });
        await this._saveLog(prompt, [], res, 'taskPlanning');
        return res;
    }

    async promptSkillDocstring(task, code, output) {
        await this.checkCooldown();
        let prompt = this.profile.skill_docstring;
        prompt = await this.replaceStrings(prompt, null);
        prompt = prompt.replaceAll('$TASK', () => task);
        prompt = prompt.replaceAll('$CODE', () => code.substring(0, 2000));
        prompt = prompt.replaceAll('$OUTPUT', () => (output || '').substring(0, 500));
        let res = await this.router.run('reflex', 'skillDocstring',
            (model) => model.sendRequest([], stripBoundary(prompt)), { in_text: prompt });
        await this._saveLog(prompt, [], res, 'skillDocstring');
        if (res?.includes('</think>'))
            res = res.split('</think>').pop();
        return res;
    }

    async promptReflection(events_text) {
        await this.checkCooldown();
        let prompt = this.profile.reflecting;
        prompt = await this.replaceStrings(prompt, null);
        prompt = prompt.replaceAll('$EVENTS', () => events_text);
        let res = await this.router.run('reflect', 'reflection',
            (model) => model.sendRequest([], stripBoundary(prompt)), { in_text: prompt });
        await this._saveLog(prompt, [], res, 'reflection');
        return res;
    }

    async _replaceRelevantMemories(prompt, query) {
        if (!prompt.includes('$RELEVANT_MEMORIES'))
            return prompt;
        let retrieved = '';
        if (this.agent.memory?.enabled())
            retrieved = await this.agent.memory.retrieveText(query.substring(0, 400));
        // function replacer: memory content is untrusted, no $-pattern expansion
        return prompt.replaceAll('$RELEVANT_MEMORIES', () => retrieved);
    }

    async promptGoalSetting(messages, last_goals) {
        // deprecated
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO';
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.router.run('plan', 'goalSetting',
            (model) => model.sendRequest(user_messages, system_message), { in_text: system_message });

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!settings.log_all_prompts)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        let logDir;
        if (task_id == null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}
