import settings from '../settings.js';
import { MemoryStore } from './store.js';
import { makeEvent, shouldEmbed } from './events.js';
import { rankEvents, humanizeAge, DEFAULT_WEIGHTS } from './scoring.js';
import { cosineSimilarity } from '../../utils/math.js';
import { wordOverlapScore } from '../../utils/text.js';
import { parseJsonResponse } from '../cognition/planner.js';

// Generative-Agents-style memory: an append-only event stream with importance,
// retrieval scored by recency x relevance x importance, and a reflection pass
// that synthesizes accumulated events into durable belief entries.
// Dormant unless settings.use_memory. Relevance uses the profile's embedding
// model when available and degrades to word overlap when it isn't — with a
// timed backoff and lazy backfill so a transient embedding outage never
// permanently downgrades the agent's memory.
// record() NEVER throws: it is called from mineflayer event listeners and
// unawaited async paths where an exception would kill the process.
export class AgentMemory {
    constructor(agent) {
        this.agent = agent;
        const opts = agent.prompter.profile.memory || {};
        this.retrieval_k = opts.retrieval_k ?? 5;
        this.half_life_hours = opts.half_life_hours ?? 24;
        this.weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
        this.min_relevance = opts.min_relevance ?? 0.1;
        this.exclude_recent_ms = opts.exclude_recent_ms ?? 2000;
        this.reflection_threshold = opts.reflection_threshold ?? 8;
        this.reflection_min_interval_ms = opts.reflection_min_interval_ms ?? 60000;
        this.max_events_in_ram = opts.max_events_in_ram ?? 5000;
        this.embed_backoff_ms = opts.embed_backoff_ms ?? 5 * 60000;

        this.store = null;
        this.events = [];
        this.embeddings = new Map();
        this.belief_count = 0;
        this.embed_backoff_until = 0;
        this.reflecting = false;
        this.last_reflection_ts = 0;
        this.importance_since_reflection = 0;
        this.backfill_running = false;

        if (settings.use_memory) {
            this.store = new MemoryStore(opts.dir || `./bots/${agent.name}/memory`);
            this._loadFromDisk();
        }
    }

    enabled() {
        return !!settings.use_memory && this.store !== null;
    }

    _loadFromDisk() {
        const { events, embeddings } = this.store.loadAll();
        this.events = events.slice(-this.max_events_in_ram);
        // keep only vectors for events still in RAM — the Map would otherwise
        // leak every evicted event's vector forever on a 24/7 run
        const live_ids = new Set(this.events.map(e => e.id));
        this.embeddings = new Map([...embeddings].filter(([id]) => live_ids.has(id)));
        this.belief_count = this.events.filter(e => e.type === 'belief').length;
        // resume the reflection accumulator: importance since the last belief
        let acc = 0;
        for (const e of this.events) {
            if (e.type === 'belief') acc = 0;
            else acc += e.importance;
        }
        this.importance_since_reflection = acc;
        if (this.events.length > 0)
            console.log(`Memory: loaded ${this.events.length} events (${this.embeddings.size} embedded).`);
        this._backfillEmbeddings();
    }

    // Record an event. Never throws. Embedding is computed asynchronously and
    // never blocks the caller; reflection may fire in the background once
    // enough importance accumulates.
    record(type, content, data = {}, opts = {}) {
        if (!this.enabled() || !content) return null;
        try {
            const event = makeEvent(type, content, data, opts);
            this.events.push(event);
            if (this.events.length > this.max_events_in_ram) {
                const evicted = this.events.splice(0, this.events.length - this.max_events_in_ram);
                for (const e of evicted)
                    this.embeddings.delete(e.id);
            }
            this.store.appendEvent(event);

            if (shouldEmbed(event))
                this._embedInBackground(event);

            if (type === 'belief')
                this.belief_count++;
            else
                this.importance_since_reflection += event.importance;
            return event;
        } catch (err) {
            console.error('Memory: record failed:', err.message || err);
            return null;
        }
    }

    // ---- retrieval ----

    async retrieve(query, k = this.retrieval_k, filter = null) {
        if (!this.enabled() || this.events.length === 0 || !query) return [];
        const now = Date.now();
        // exclude the message currently being answered (recorded moments ago)
        let candidates = this.events.filter(e => e.ts <= now - this.exclude_recent_ms);
        if (filter)
            candidates = candidates.filter(filter);
        if (candidates.length === 0) return [];
        const relevanceFn = await this._relevanceFn(query);
        return rankEvents(candidates, relevanceFn, now, {
            k,
            half_life_hours: this.half_life_hours,
            weights: this.weights,
            min_relevance: this.min_relevance,
        });
    }

    // Formatted for prompt injection. Empty string when nothing relevant.
    async retrieveText(query, k = this.retrieval_k) {
        try {
            const ranked = await this.retrieve(query, k);
            if (ranked.length === 0) return '';
            const now = Date.now();
            let text = 'Relevant memories:\n';
            for (const { event } of ranked)
                text += `- [${humanizeAge(event.ts, now)}] ${event.content}\n`;
            return text.trim();
        } catch (err) {
            console.error('Memory: retrieval failed:', err.message || err);
            return '';
        }
    }

    getBeliefs(limit = 10) {
        return this.events.filter(e => e.type === 'belief').slice(-limit);
    }

    _embeddingAvailable() {
        return this.agent.prompter.embedding_model && Date.now() >= this.embed_backoff_until;
    }

    async _relevanceFn(query) {
        if (this._embeddingAvailable()) {
            try {
                const qvec = await this._embed(query.substring(0, 500));
                if (Array.isArray(qvec)) {
                    return (event) => {
                        const evec = this.embeddings.get(event.id);
                        if (!evec || evec.length !== qvec.length)
                            return this._overlap(query, event);
                        // negative cosine = unrelated; don't let it drag below zero
                        return Math.max(0, cosineSimilarity(qvec, evec));
                    };
                }
            } catch (err) {
                this._embedFailed(err);
            }
        }
        return (event) => this._overlap(query, event);
    }

    _overlap(query, event) {
        return Math.min(1, wordOverlapScore(query, event.content) * 3);
    }

    // Wraps model.embed so synchronous throws (e.g. a provider with no embed
    // method) become rejections, and null results become errors.
    _embed(text) {
        return Promise.resolve()
            .then(() => this.agent.prompter.embedding_model.embed(text))
            .then(vec => {
                if (!Array.isArray(vec))
                    throw new Error('embedding model returned no vector');
                return vec;
            });
    }

    _embedFailed(err) {
        this.embed_backoff_until = Date.now() + this.embed_backoff_ms;
        console.warn(`Memory: embedding failed, word-overlap fallback for ${Math.round(this.embed_backoff_ms / 60000)}m.`, err.message || err);
    }

    _embedInBackground(event) {
        if (!this._embeddingAvailable()) return;
        this._embed_task = this._embed(event.content)
            .then(vec => {
                this.embeddings.set(event.id, vec);
                this.store.appendEmbedding(event.id, vec);
                this._backfillEmbeddings(); // pick up anything missed during an outage
            })
            .catch(err => this._embedFailed(err));
    }

    // Lazily compute vectors for events that should have one but don't —
    // events recorded during an embedding outage, or after embeddings.jsonl
    // was deleted. Sequential, background, self-terminating on failure.
    _backfillEmbeddings() {
        if (this.backfill_running || !this._embeddingAvailable()) return;
        const missing = this.events.filter(e => shouldEmbed(e) && !this.embeddings.has(e.id));
        if (missing.length === 0) return;
        this.backfill_running = true;
        this._backfill_task = (async () => {
            let done = 0;
            for (const event of missing) {
                if (!this._embeddingAvailable()) break;
                if (this.embeddings.has(event.id)) continue;
                try {
                    const vec = await this._embed(event.content);
                    this.embeddings.set(event.id, vec);
                    this.store.appendEmbedding(event.id, vec);
                    done++;
                } catch (err) {
                    this._embedFailed(err);
                    break;
                }
            }
            if (done > 0)
                console.log(`Memory: backfilled ${done} embeddings.`);
        })()
            .catch(err => console.error('Memory: backfill failed:', err.message || err))
            .finally(() => { this.backfill_running = false; });
    }

    // ---- spatial memories (memory_bank durability) ----

    recordPlace(name, x, y, z) {
        this.record('place', `Saved place '${name}' at x:${Math.round(x)}, y:${Math.round(y)}, z:${Math.round(z)}`,
            { name, x, y, z });
    }

    // Latest coordinates for each remembered place, for hydrating memory_bank.
    getPlaces() {
        const places = {};
        for (const e of this.events)
            if (e.type === 'place' && e.data?.name)
                places[e.data.name] = [e.data.x, e.data.y, e.data.z];
        return places;
    }

    // ---- reflection ----

    // The reflect tier's entry point (scheduler-cadenced, ~10s): fires a
    // reflection when enough importance has accumulated. record() only
    // accumulates — triggering lives here so reflection cadence is owned by
    // the tier scheduler, not by whoever happens to record an event.
    reflectTick() {
        if (!this.enabled() || this.reflecting) return;
        if (this.importance_since_reflection >= this.reflection_threshold
            && Date.now() - this.last_reflection_ts >= this.reflection_min_interval_ms)
            this._reflectInBackground();
    }

    _reflectInBackground() {
        this.reflecting = true;
        this.last_reflection_ts = Date.now();
        // consume the budget up front — a failing reflection must not re-fire
        // on the next tick (reflection storm); importance accrued *during*
        // the reflection still counts toward the next one
        this.importance_since_reflection = 0;
        this._reflect_task = this._reflect()
            .catch(err => console.error('Memory: reflection failed:', err.message || err))
            .finally(() => { this.reflecting = false; });
    }

    async _reflect() {
        const recent = this.events
            .filter(e => e.type !== 'belief' && e.importance >= 0.2)
            .slice(-40);
        if (recent.length < 5)
            return;
        const now = Date.now();
        const events_text = recent
            .map(e => `- [${humanizeAge(e.ts, now)}] (${e.type}) ${e.content}`)
            .join('\n');
        const res = await this.agent.prompter.promptReflection(events_text);
        const data = parseJsonResponse(res);
        if (!data || !Array.isArray(data.beliefs)) {
            console.warn('Memory: reflection produced no parseable beliefs.');
            return;
        }
        for (const belief of data.beliefs.slice(0, 3)) {
            if (typeof belief === 'string' && belief.trim().length > 0) {
                this.record('belief', belief.trim());
                console.log('Memory: new belief:', belief.trim());
            }
        }
    }

    // Dashboard surface.
    getStatus() {
        return {
            enabled: this.enabled(),
            events: this.events.length,
            embedded: this.embeddings.size,
            beliefs: this.belief_count,
            until_reflection: Math.max(0, Number((this.reflection_threshold - this.importance_since_reflection).toFixed(1))),
        };
    }
}
