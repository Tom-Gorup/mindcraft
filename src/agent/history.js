import { writeFileSync, readFileSync, appendFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 5;
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary

        // add() is called unawaited from many concurrent loops; without a
        // queue two callers can cross the eviction threshold together, both
        // summarize from the same stale memory, and one chunk's summary is
        // silently lost (it survives only in the raw history file)
        this._add_queue = Promise.resolve();
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        this.memory = await this.agent.prompter.promptMemSaving(turns);

        if (this.memory.length > 500) {
            this.memory = this.memory.slice(0, 500);
            this.memory += '...(Memory truncated to 500 chars. Compress it more next time)';
        }

        console.log("Memory updated to: ", this.memory);
    }

    // Append-only JSONL: the previous format re-read, parsed, and rewrote the
    // entire array on every eviction, which is O(n^2) writes over a long run
    // (gigabytes/day, and a parse that eventually blocks the update pump).
    appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.jsonl`;
        }
        try {
            appendFileSync(this.full_history_fp, to_store.map(t => JSON.stringify(t)).join('\n') + '\n', 'utf8');
        } catch (err) {
            console.error(`Error writing ${this.name}'s full history file: ${err.message}`);
        }
    }

    add(name, content) {
        // serialized: see _add_queue. Returns a promise callers may await.
        this._add_queue = this._add_queue
            .then(() => this._add(name, content))
            .catch(err => console.error('History add failed:', err));
        return this._add_queue;
    }

    async _add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            this.appendFullHistory(chunk);
            // when the memory subsystem is on it already holds a richer,
            // retrievable record of these turns — paying for an LLM call to
            // maintain a lossy 500-char duplicate is pure overhead
            if (!settings.use_memory)
                await this.summarizeMemories(chunk);
        }
    }

    async save() {
        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender
            };
            // atomic: a torn write here used to brick the agent on next boot
            const tmp = this.memory_fp + '.tmp';
            writeFileSync(tmp, JSON.stringify(data, null, 2));
            renameSync(tmp, this.memory_fp);
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = data.turns || [];
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            // degrade like every other store rather than killing the agent:
            // throwing here exits before the 10s mark, so agent_process
            // refuses to restart and the bot stays dead until a human intervenes
            console.error('Failed to load history, starting fresh:', error.message || error);
            return null;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}