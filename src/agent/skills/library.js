import settings from '../settings.js';
import { SkillStore } from './store.js';
import { cosineSimilarity } from '../../utils/math.js';
import { wordOverlapScore } from '../../utils/text.js';

// Voyager-style learned-skill library: successful !newAction programs are
// persisted with a docstring + embedding, retrieved by task similarity
// (direct re-execution for near-identical tasks, doc injection for related
// ones), and exposed to new generated code as `learned.<name>(bot)` so skills
// compose. Dormant unless settings.use_skill_library.
// Public methods never throw — callers include the coder hot path.
export class LearnedSkills {
    constructor(agent) {
        this.agent = agent;
        const opts = agent.prompter.profile.skills || {};
        this.direct_execute_cosine = opts.direct_execute_cosine ?? 0.92;
        this.direct_execute_overlap = opts.direct_execute_overlap ?? 0.6;
        this.max_compose_depth = opts.max_compose_depth ?? 3;
        this.max_skills = opts.max_skills ?? 500;

        this.skills = [];              // {name, task, docstring, code, created_at, uses, successes, failures, last_used}
        this.embeddings = new Map();   // name -> vector (of task + docstring)
        this.compiled = new Map();     // name -> {code, fn}
        this.active_calls = new Set(); // composition cycle guard
        this.store = null;

        if (settings.use_skill_library) {
            this.store = new SkillStore(opts.dir || `./bots/${agent.name}/skills`);
            const { skills, embeddings } = this.store.load();
            this.skills = skills;
            this.embeddings = new Map(Object.entries(embeddings).filter(([, v]) => Array.isArray(v)));
            if (this.skills.length > 0)
                console.log(`Skills: loaded ${this.skills.length} learned skills.`);
        }
    }

    isEnabled() {
        return !!settings.use_skill_library && this.store !== null;
    }

    count() {
        return this.skills.length;
    }

    names() {
        return new Set(this.skills.map(s => s.name));
    }

    getSkill(name) {
        return this.skills.find(s => s.name === name) || null;
    }

    // Persist a program that just executed successfully. Near-duplicates of an
    // existing skill refresh its code and stats instead of bloating the store.
    async saveFromSuccess(task, code, output) {
        if (!this.isEnabled() || !task || !code) return null;
        try {
            const match = await this.findBestMatch(task);
            if (match && this.shouldDirectExecute(match)) {
                const skill = match.skill;
                skill.code = code; // latest working version wins
                skill.successes++;
                skill.last_used = Date.now();
                this.compiled.delete(skill.name);
                this._persist();
                console.log(`Skills: refreshed existing skill '${skill.name}'.`);
                return skill;
            }
            if (this.skills.length >= this.max_skills) {
                console.warn(`Skills: store full (${this.max_skills}), not saving new skill.`);
                return null;
            }
            const name = this._uniqueName(this._slugify(task));
            const docstring = await this._makeDocstring(task, code, output);
            const skill = {
                name, task, docstring, code,
                created_at: Date.now(),
                uses: 0, successes: 1, failures: 0,
                last_used: Date.now(),
            };
            this.skills.push(skill);
            await this._embedSkill(skill);
            this._persist();
            try {
                this.agent.memory?.record('code', `Learned new skill '${name}': ${docstring}`, { skill: name });
            } catch { /* memory guards itself, belt and suspenders */ }
            console.log(`Skills: learned '${name}' — ${docstring}`);
            return skill;
        } catch (err) {
            console.error('Skills: saveFromSuccess failed:', err.message || err);
            return null;
        }
    }

    // Best stored skill for a task: {skill, similarity, method} or null.
    async findBestMatch(task) {
        if (!this.isEnabled() || this.skills.length === 0 || !task) return null;
        try {
            const qvec = await this._tryEmbed(this._skillText({ task, docstring: '' }));
            let best = null;
            for (const skill of this.skills) {
                const svec = this.embeddings.get(skill.name);
                let similarity, method;
                if (qvec && svec && svec.length === qvec.length) {
                    similarity = Math.max(0, cosineSimilarity(qvec, svec));
                    method = 'embedding';
                } else {
                    // task-vs-task: for direct re-execution the task wording is
                    // the signal; mixing in the docstring dilutes exact matches
                    similarity = wordOverlapScore(task, skill.task);
                    method = 'overlap';
                }
                if (!best || similarity > best.similarity)
                    best = { skill, similarity, method };
            }
            return best;
        } catch (err) {
            console.error('Skills: findBestMatch failed:', err.message || err);
            return null;
        }
    }

    // Is a match close enough (and reliable enough) to run without codegen?
    shouldDirectExecute(match) {
        if (!match) return false;
        const threshold = match.method === 'embedding'
            ? this.direct_execute_cosine
            : this.direct_execute_overlap;
        return match.similarity >= threshold && match.skill.failures <= match.skill.successes;
    }

    noteResult(name, success) {
        const skill = this.getSkill(name);
        if (!skill) return;
        skill.uses++;
        skill.last_used = Date.now();
        if (success) skill.successes++;
        else skill.failures++;
        this._persist();
    }

    // Docs formatted like the built-in library's, for unified $CODE_DOCS
    // ranking. The @example teaches the call syntax.
    getDocs() {
        return this.skills.map(s =>
            `learned.${s.name}\n* ${s.docstring}\n* This is one of your own previously saved skills.\n* @example\n* await learned.${s.name}(bot);`);
    }

    // [{doc, score}] ranked against a message — merged by SkillLibrary.
    async getRankedDocs(message) {
        if (!this.isEnabled() || this.skills.length === 0) return [];
        try {
            const docs = this.getDocs();
            const qvec = await this._tryEmbed(message.substring(0, 400));
            return this.skills.map((skill, i) => {
                const svec = this.embeddings.get(skill.name);
                const score = (qvec && svec && svec.length === qvec.length)
                    ? Math.max(0, cosineSimilarity(qvec, svec))
                    : wordOverlapScore(message, `${skill.task} ${skill.docstring}`);
                return { doc: docs[i], score };
            });
        } catch (err) {
            console.error('Skills: getRankedDocs failed:', err.message || err);
            return [];
        }
    }

    // The `learned` namespace endowed to generated code. compileFn(code) must
    // return an async main(bot) — the coder provides it so learned code runs
    // through the exact same template/compartment pipeline as fresh code.
    // A Proxy so skills learned later in the session are callable immediately.
    buildNamespace(compileFn) {
        const self = this;
        return new Proxy({}, {
            get(_target, name) {
                if (typeof name !== 'string') return undefined;
                const skill = self.getSkill(name);
                if (!skill) return undefined;
                return async (bot) => {
                    if (self.active_calls.has(name))
                        throw new Error(`Learned skill '${name}' called itself (composition cycle).`);
                    if (self.active_calls.size >= self.max_compose_depth)
                        throw new Error(`Learned skill composition too deep (max ${self.max_compose_depth}).`);
                    self.active_calls.add(name);
                    try {
                        let entry = self.compiled.get(name);
                        if (!entry || entry.code !== skill.code) {
                            entry = { code: skill.code, fn: compileFn(skill.code) };
                            self.compiled.set(name, entry);
                        }
                        await entry.fn(bot);
                        self.noteResult(name, true);
                    } catch (err) {
                        self.noteResult(name, false);
                        throw err;
                    } finally {
                        self.active_calls.delete(name);
                    }
                };
            },
            has(_target, name) {
                return typeof name === 'string' && self.getSkill(name) !== null;
            },
            ownKeys() {
                return self.skills.map(s => s.name);
            },
            getOwnPropertyDescriptor(_target, name) {
                if (typeof name === 'string' && self.getSkill(name))
                    return { configurable: true, enumerable: true, value: undefined };
                return undefined;
            },
        });
    }

    // Dashboard surface.
    getStatus() {
        const last = this.skills.reduce((a, s) => (!a || s.last_used > a.last_used) ? s : a, null);
        return {
            enabled: this.isEnabled(),
            count: this.skills.length,
            total_uses: this.skills.reduce((n, s) => n + s.uses, 0),
            last_used: last ? { name: last.name, at: last.last_used } : null,
        };
    }

    // ---- internals ----

    _skillText(skill) {
        return `${skill.task}\n${skill.docstring}`.trim();
    }

    async _makeDocstring(task, code, output) {
        try {
            const res = await this.agent.prompter.promptSkillDocstring(task, code, output);
            if (typeof res === 'string' && res.trim().length > 0)
                return res.trim().split('\n')[0].substring(0, 200);
        } catch (err) {
            console.warn('Skills: docstring generation failed, using task text.', err.message || err);
        }
        return task.substring(0, 200);
    }

    async _embedSkill(skill) {
        const vec = await this._tryEmbed(this._skillText(skill));
        if (vec)
            this.embeddings.set(skill.name, vec);
    }

    async _tryEmbed(text) {
        const model = this.agent.prompter.embedding_model;
        if (!model) return null;
        try {
            const vec = await Promise.resolve().then(() => model.embed(text));
            return Array.isArray(vec) ? vec : null;
        } catch {
            return null;
        }
    }

    _slugify(task) {
        const slug = task.toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .substring(0, 40)
            .replace(/_+$/, '');
        return slug || 'skill';
    }

    _uniqueName(base) {
        if (!this.getSkill(base)) return base;
        let i = 2;
        while (this.getSkill(`${base}_${i}`)) i++;
        return `${base}_${i}`;
    }

    _persist() {
        if (!this.store) return;
        this.store.persist(this.skills, Object.fromEntries(this.embeddings));
    }
}
