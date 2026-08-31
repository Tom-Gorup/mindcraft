import settings from '../settings.js';
import { SkillStore } from './store.js';
import { cosineSimilarity } from '../../utils/math.js';
import { wordOverlapScore } from '../../utils/text.js';

// Voyager-style learned-skill library: successful !newAction programs are
// persisted with a docstring + embedding, retrieved by task similarity
// (direct re-execution for near-identical tasks, doc injection for related
// ones), and exposed to new generated code as `learned.<name>(bot)` so skills
// compose. Dormant unless settings.use_skill_library.
// Embeddings are computed from the TASK TEXT ONLY, at save and query alike —
// mixing the docstring in deflated identical-task similarity below the
// direct-execution threshold.
// Public methods never throw — callers include the coder hot path.
export class LearnedSkills {
    constructor(agent) {
        this.agent = agent;
        const opts = agent.prompter.profile.skills || {};
        this.direct_execute_cosine = opts.direct_execute_cosine ?? 0.92;
        this.direct_execute_overlap = opts.direct_execute_overlap ?? 0.8;
        this.max_compose_depth = opts.max_compose_depth ?? 3;
        this.max_skills = opts.max_skills ?? 500;
        this.max_docs = opts.max_docs ?? 2; // learned entries allowed into $CODE_DOCS
        this.docstring_timeout_ms = opts.docstring_timeout_ms ?? 30000;
        this.persist_throttle_ms = opts.persist_throttle_ms ?? 5000;

        this.skills = [];              // {name, task, docstring, code, created_at, uses, successes, failures, last_used}
        this.embeddings = new Map();   // name -> vector of the task text
        this.compiled = new Map();     // name -> {code, fn}
        this.active_calls = new Set(); // composition cycle guard
        this.store = null;
        this.last_persist = 0;
        this._persist_timer = null;
        this.backfilling = false;

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
    // existing skill refresh its code instead of bloating the store — unless
    // the new code CALLS that skill (that's a composition; refreshing would
    // write a self-referential skill that cycles forever).
    async saveFromSuccess(task, code, output) {
        if (!this.isEnabled() || !task || !code) return null;
        try {
            const match = await this.findBestMatch(task);
            if (match && this.shouldDirectExecute(match)
                && !code.includes(`learned.${match.skill.name}(`)) {
                const skill = match.skill;
                skill.code = code; // latest working version wins
                skill.last_used = Date.now();
                // no stat changes: the execution that produced this code was
                // already counted where it ran (initial save or wrapper)
                this.compiled.delete(skill.name);
                this._persistNow();
                this._recordMemory(`Refreshed learned skill '${skill.name}' with newer working code.`, skill.name);
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
            this._persistNow();
            this._recordMemory(`Learned new skill '${name}': ${docstring}`, name);
            console.log(`Skills: learned '${name}' — ${docstring}`);
            return skill;
        } catch (err) {
            console.error('Skills: saveFromSuccess failed:', err.message || err);
            return null;
        }
    }

    // Best stored skill for a task: {skill, similarity, method} or null.
    // Never mixes scales: embedding-scored candidates are preferred; skills
    // without a compatible vector fall back to a separate overlap pool with
    // its own (stricter) threshold, so a lenient overlap score can never
    // outrank a cosine score.
    async findBestMatch(task) {
        if (!this.isEnabled() || this.skills.length === 0 || !task) return null;
        try {
            const qvec = await this._tryEmbed(task);
            let best_embed = null, best_overlap = null;
            for (const skill of this.skills) {
                const svec = this.embeddings.get(skill.name);
                if (qvec && svec && svec.length === qvec.length) {
                    const similarity = Math.max(0, cosineSimilarity(qvec, svec));
                    if (!best_embed || similarity > best_embed.similarity)
                        best_embed = { skill, similarity, method: 'embedding' };
                } else {
                    const similarity = this._taskOverlap(task, skill.task);
                    if (!best_overlap || similarity > best_overlap.similarity)
                        best_overlap = { skill, similarity, method: 'overlap' };
                }
            }
            if (qvec)
                this._backfillEmbeddings(); // vector-less skills caught an outage
            if (best_embed && this.shouldDirectExecute(best_embed))
                return best_embed;
            if (best_overlap && this.shouldDirectExecute(best_overlap))
                return best_overlap;
            return best_embed || best_overlap;
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
        this._persistThrottled();
    }

    // Docs formatted like the built-in library's, for unified $CODE_DOCS
    // ranking. The @example teaches the call syntax.
    getDocs() {
        return this.skills.map(s =>
            `learned.${s.name}\n* ${s.docstring}\n* This is one of your own previously saved skills.\n* @example\n* await learned.${s.name}(bot);`);
    }

    // [{doc, score}] ranked against a message — merged by SkillLibrary.
    // opts.force_overlap keeps scores comparable when the built-in doc pool
    // has degraded to word overlap. Snapshots the skill list before awaiting
    // so a concurrent save can't desync docs from scores.
    async getRankedDocs(message, opts = {}) {
        if (!this.isEnabled() || this.skills.length === 0) return [];
        try {
            const snapshot = [...this.skills];
            const qvec = opts.force_overlap ? null : await this._tryEmbed(message.substring(0, 400));
            return snapshot.map(skill => {
                const svec = this.embeddings.get(skill.name);
                const score = (qvec && svec && svec.length === qvec.length)
                    ? Math.max(0, cosineSimilarity(qvec, svec))
                    : this._taskOverlap(message, `${skill.task} ${skill.docstring}`);
                return { doc: this._docFor(skill), score };
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
                        // interrupted runs return "normally" via the injected
                        // interrupt checks — count neither success nor failure
                        if (!bot?.interrupt_code)
                            self.noteResult(name, true);
                    } catch (err) {
                        if (!bot?.interrupt_code)
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
                return [...new Set(self.skills.map(s => s.name))];
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
            total_uses: this.skills.reduce((n, s) => n + (s.uses || 0), 0),
            last_used: last ? { name: last.name, at: last.last_used } : null,
        };
    }

    // ---- internals ----

    _docFor(skill) {
        return `learned.${skill.name}\n* ${skill.docstring}\n* This is one of your own previously saved skills.\n* @example\n* await learned.${skill.name}(bot);`;
    }

    // Overlap with two guards the raw score lacks: texts with no letters must
    // not match everything (digit stripping turns '10' vs '42' into a perfect
    // score), and differing quantities/coordinates must not be "identical"
    // ('mine 5 diamonds' vs 'mine 50 diamonds').
    _taskOverlap(a, b) {
        if (!/[a-zA-Z]/.test(a) || !/[a-zA-Z]/.test(b)) return 0;
        const digitsA = (a.match(/\d+/g) || []).join(',');
        const digitsB = (b.match(/\d+/g) || []).join(',');
        const score = wordOverlapScore(a, b);
        return digitsA === digitsB ? score : Math.min(score, this.direct_execute_overlap - 0.01);
    }

    async _makeDocstring(task, code, output) {
        try {
            const res = await Promise.race([
                this.agent.prompter.promptSkillDocstring(task, code, output),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('docstring generation timed out')), this.docstring_timeout_ms)),
            ]);
            if (typeof res === 'string' && res.trim().length > 0)
                return res.trim().split('\n')[0].substring(0, 200);
        } catch (err) {
            console.warn('Skills: docstring generation failed, using task text.', err.message || err);
        }
        return task.substring(0, 200);
    }

    async _embedSkill(skill) {
        const vec = await this._tryEmbed(skill.task);
        if (vec)
            this.embeddings.set(skill.name, vec);
    }

    // Lazily embed skills that were saved while the embedding model was down.
    _backfillEmbeddings() {
        if (this.backfilling) return;
        const missing = this.skills.filter(s => !this.embeddings.has(s.name));
        if (missing.length === 0) return;
        this.backfilling = true;
        this._backfill_task = (async () => {
            for (const skill of missing) {
                if (this.embeddings.has(skill.name)) continue;
                const vec = await this._tryEmbed(skill.task);
                if (!vec) break; // model down again; retry on a later query
                this.embeddings.set(skill.name, vec);
            }
            this._persistThrottled();
        })()
            .catch(err => console.error('Skills: embedding backfill failed:', err.message || err))
            .finally(() => { this.backfilling = false; });
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

    _recordMemory(content, skill_name) {
        try {
            this.agent.memory?.record('code', content, { skill: skill_name });
        } catch { /* memory guards itself, belt and suspenders */ }
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

    _persistNow() {
        if (!this.store) return;
        this.last_persist = Date.now();
        this.store.persist(this.skills, Object.fromEntries(this.embeddings));
    }

    // Stats updates fire on every learned-skill invocation; a full rewrite of
    // skills.json (embeddings included) each time would stall the event loop.
    _persistThrottled() {
        if (!this.store) return;
        const since = Date.now() - this.last_persist;
        if (since >= this.persist_throttle_ms) {
            this._persistNow();
        } else if (!this._persist_timer) {
            this._persist_timer = setTimeout(() => {
                this._persist_timer = null;
                this._persistNow();
            }, this.persist_throttle_ms - since);
            this._persist_timer.unref?.();
        }
    }
}
