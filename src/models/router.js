import { Meter, estimateTokens } from './metering.js';
import settings from '../agent/settings.js';

// NOTE: this module deliberately does NOT import ./_model_map.js. That module
// dynamically imports all ~20 provider classes behind a top-level await, so
// importing it eagerly drags the whole provider surface (and its native deps)
// into anything that touches routing. The caller injects a factory instead.

// Tiered model routing. Every prompt call site declares a tier; the router
// resolves the tier to a model, meters the call, and falls back if the
// provider fails.
//
// Tiers, cheapest first:
//   reflex   trivial/frequent decisions (bot_responder, docstrings)
//   chat     ordinary conversation and step prompting — the bulk of traffic
//   plan     goal generation and task planning
//   reflect  reflection and pivotal judgements; the only frontier-worthy tier
//   code     program synthesis
//   vision   image analysis
//
// Resolution order for tier T: profile.tiers[T] -> a sensible default role
// (so existing profiles keep working untouched) -> the chat model.
// This means a profile with no "tiers" block behaves exactly as before, which
// is the compatibility guarantee the roadmap requires.

export const TIERS = ['reflex', 'chat', 'plan', 'reflect', 'code', 'vision'];

// Providers that run on the user's own hardware — calls to these are free and
// count toward the local-tier share.
const LOCAL_APIS = new Set(['ollama', 'lmstudio', 'vllm']);

export function isLocalApi(api) {
    return LOCAL_APIS.has(String(api || '').toLowerCase());
}

export class ModelRouter {
    // roles: the already-constructed default models {chat, code, vision}.
    // opts.buildModel(spec) -> {model, api, name}; omit it and profile "tiers"
    // entries are ignored (every tier falls back to its default role).
    constructor(profile, roles, opts = {}) {
        this.profile = profile || {};
        this.roles = roles;
        this.buildModel = opts.buildModel || null;
        this.meter = new Meter({ now: opts.now ?? Date.now() });
        this.models = new Map();   // tier -> {model, api, name}
        this.warned = new Set();
        this._resolveTiers();
    }

    _resolveTiers() {
        const configured = this.profile.tiers || {};
        for (const tier of TIERS) {
            let entry = null;
            if (configured[tier] && this.buildModel) {
                try {
                    entry = this.buildModel(configured[tier]);
                } catch (err) {
                    console.warn(`Router: could not build tier '${tier}' from profile, falling back.`, err.message || err);
                }
            }
            if (!entry)
                entry = this._defaultFor(tier);
            this.models.set(tier, entry);
        }
    }

    _defaultFor(tier) {
        const role = tier === 'code' ? this.roles.code
            : tier === 'vision' ? this.roles.vision
                : this.roles.chat;
        return { model: role, api: this._apiOf(role), name: role?.model_name ?? null };
    }

    _apiOf(model) {
        return model?.constructor?.prefix ?? null;
    }

    getModel(tier) {
        return (this.models.get(tier) || this._defaultFor('chat')).model;
    }

    describe() {
        const out = {};
        for (const tier of TIERS) {
            const e = this.models.get(tier);
            out[tier] = { api: e?.api ?? null, model: e?.name ?? null, local: isLocalApi(e?.api) };
        }
        return out;
    }

    // The single funnel every chat-style call goes through.
    // fn(model) performs the actual request so callers keep full control of
    // provider-specific arguments.
    async run(tier, site, fn, opts = {}) {
        const entry = opts._entry || this.models.get(tier) || this._defaultFor('chat');
        const started = Date.now();
        let result;
        try {
            result = await fn(entry.model);
        } catch (err) {
            this.meter.record({ tier, site, model: entry.name, local: isLocalApi(entry.api), in_text: opts.in_text, out_text: '', now: started, error: true });
            // one retry on a genuinely different model, if there is one
            const fallback = this._fallbackFor(tier, entry);
            if (fallback && !opts.no_fallback) {
                console.warn(`Router: tier '${tier}' (${entry.api}) failed at ${site}, retrying on ${fallback.api}.`, err.message || err);
                return this.run(tier, site, fn, { ...opts, no_fallback: true, _entry: fallback });
            }
            throw err;
        }
        this.meter.record({
            tier, site,
            model: entry.name,
            local: isLocalApi(entry.api),
            in_text: opts.in_text,
            out_text: typeof result === 'string' ? result : '',
            now: started,
        });
        if (settings.log_routing)
            console.log(`[route] ${site} tier=${tier} api=${entry.api} model=${entry.name} in≈${estimateTokens(opts.in_text)}tok`);
        return result;
    }

    _fallbackFor(tier, failed) {
        for (const candidate of ['chat', 'plan', 'reflect']) {
            const e = this.models.get(candidate);
            if (e && e.model && e.model !== failed.model) return e;
        }
        return null;
    }

    // Embeddings are metered separately: they are the highest-count calls and
    // their tier is always whatever the embedding model is.
    recordEmbedding(api, model_name, text) {
        this.meter.record({
            tier: 'embed', site: 'embedding', model: model_name,
            local: isLocalApi(api), in_text: text, out_text: '', now: Date.now(),
        });
    }

    getStatus() {
        return { tiers: this.describe(), ...this.meter.summary(Date.now()) };
    }
}
