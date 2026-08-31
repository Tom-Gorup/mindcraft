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
// model when available and degrades to word overlap when it isn't — same
// contract as the examples/skill-library retrieval.
export class AgentMemory {
    constructor(agent) {
        this.agent = agent;
        const opts = agent.prompter.profile.memory || {};
        this.retrieval_k = opts.retrieval_k ?? 5;
        this.half_life_hours = opts.half_life_hours ?? 24;
        this.weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
        this.reflection_threshold = opts.reflection_threshold ?? 8;
        this.max_events_in_ram = opts.max_events_in_ram ?? 5000;

        this.store = null;
        this.events = [];
        this.embeddings = new Map();
        this.embedding_broken = false;
        this.reflecting = false;
        this.importance_since_reflection = 0;

        if (this.enabled()) {
            this.store = new MemoryStore(opts.dir || `./bots/${agent.name}/memory`);
            this._loadFromDisk();
        }
    }

    enabled() {
        return !!settings.use_memory;
    }

    _loadFromDisk() {
        const { events, embeddings } = this.store.loadAll();
        this.events = events;
        this.embeddings = embeddings;
        // resume the reflection accumulator: importance since the last belief
        let acc = 0;
        for (const e of events) {
            if (e.type === 'belief') acc = 0;
            else acc += e.importance;
        }
        this.importance_since_reflection = acc;
        if (events.length > 0)
            console.log(`Memory: loaded ${events.length} events (${this.embeddings.size} embedded).`);
    }

    // Record an event. Embedding is computed asynchronously and never blocks
    // the caller; reflection may fire in the background once enough
    // importance accumulates.
    record(type, content, data = {}, opts = {}) {
        if (!this.enabled() || !content) return null;
        const event = makeEvent(type, content, data, opts);
        this.events.push(event);
        if (this.events.length > this.max_events_in_ram)
            this.events = this.events.slice(-this.max_events_in_ram);
        this.store.appendEvent(event);

        if (shouldEmbed(event))
            this._embedInBackground(event);

        if (type !== 'belief') {
            this.importance_since_reflection += event.importance;
            if (this.importance_since_reflection >= this.reflection_threshold && !this.reflecting)
                this._reflectInBackground();
        }
        return event;
    }

    // ---- retrieval ----

    async retrieve(query, k = this.retrieval_k, filter = null) {
        if (!this.enabled() || this.events.length === 0 || !query) return [];
        const candidates = filter ? this.events.filter(filter) : this.events;
        const relevanceFn = await this._relevanceFn(query);
        return rankEvents(candidates, relevanceFn, Date.now(), {
            k,
            half_life_hours: this.half_life_hours,
            weights: this.weights,
        });
    }

    // Formatted for prompt injection. Empty string when nothing relevant.
    async retrieveText(query, k = this.retrieval_k) {
        const ranked = await this.retrieve(query, k);
        if (ranked.length === 0) return '';
        const now = Date.now();
        let text = 'Relevant memories:\n';
        for (const { event } of ranked)
            text += `- [${humanizeAge(event.ts, now)}] ${event.content}\n`;
        return text.trim();
    }

    getBeliefs(limit = 10) {
        return this.events.filter(e => e.type === 'belief').slice(-limit);
    }

    async _relevanceFn(query) {
        const model = this.agent.prompter.embedding_model;
        if (model && !this.embedding_broken) {
            try {
                const qvec = await model.embed(query.substring(0, 500));
                if (Array.isArray(qvec)) {
                    return (event) => {
                        const evec = this.embeddings.get(event.id);
                        if (!evec) return this._overlap(query, event);
                        // negative cosine = unrelated; don't let it drag below zero
                        return Math.max(0, cosineSimilarity(qvec, evec));
                    };
                }
            } catch (err) {
                console.warn('Memory: embedding failed, using word overlap.', err.message || err);
                this.embedding_broken = true;
            }
        }
        return (event) => this._overlap(query, event);
    }

    _overlap(query, event) {
        return Math.min(1, wordOverlapScore(query, event.content) * 3);
    }

    _embedInBackground(event) {
        const model = this.agent.prompter.embedding_model;
        if (!model || this.embedding_broken) return;
        this._embed_task = model.embed(event.content)
            .then(vec => {
                if (Array.isArray(vec)) {
                    this.embeddings.set(event.id, vec);
                    this.store.appendEmbedding(event.id, vec);
                }
            })
            .catch(err => {
                console.warn('Memory: embedding failed, using word overlap.', err.message || err);
                this.embedding_broken = true;
            });
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

    _reflectInBackground() {
        this.reflecting = true;
        this._reflect_task = this._reflect()
            .catch(err => console.error('Memory: reflection failed:', err))
            .finally(() => { this.reflecting = false; });
    }

    async _reflect() {
        const recent = this.events
            .filter(e => e.type !== 'belief' && e.importance >= 0.2)
            .slice(-40);
        if (recent.length < 5) {
            this.importance_since_reflection = 0;
            return;
        }
        const now = Date.now();
        const events_text = recent
            .map(e => `- [${humanizeAge(e.ts, now)}] (${e.type}) ${e.content}`)
            .join('\n');
        const res = await this.agent.prompter.promptReflection(events_text);
        const data = parseJsonResponse(res);
        this.importance_since_reflection = 0;
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
            beliefs: this.events.filter(e => e.type === 'belief').length,
            until_reflection: Math.max(0, Number((this.reflection_threshold - this.importance_since_reflection).toFixed(1))),
        };
    }
}
