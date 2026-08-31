// Per-agent token and cost accounting. Pure arithmetic + a price table —
// no I/O, no model references — so it is unit-testable.
//
// Token counts are ESTIMATES. The provider interface in this repo returns a
// bare string from sendRequest(), so real usage numbers are not available
// without touching all 20 provider classes. Characters/CHARS_PER_TOKEN is
// accurate to roughly ±15% for English prompts, which is enough to answer
// the questions this exists for: which tier is the traffic on, and what is
// this costing per hour.

export const CHARS_PER_TOKEN = 4.21;

// USD per 1M tokens {in, out}. Local models are free; unknown models are
// counted as free but still tallied so they show up in the distribution.
export const PRICES = {
    'gpt-5.4-mini': { in: 0.25, out: 2.0 },
    'gpt-5.4': { in: 1.25, out: 10.0 },
    'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
    'claude-haiku-4-5': { in: 1.0, out: 5.0 },
    'claude-opus-4-1': { in: 15.0, out: 75.0 },
    'text-embedding-3-small': { in: 0.02, out: 0 },
    'text-embedding-3-large': { in: 0.13, out: 0 },
};

export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

export function priceFor(model_name) {
    if (!model_name) return { in: 0, out: 0 };
    if (Object.hasOwn(PRICES, model_name)) return PRICES[model_name];
    // match on a known prefix so dated model ids still price correctly
    for (const key of Object.keys(PRICES))
        if (model_name.startsWith(key)) return PRICES[key];
    return { in: 0, out: 0 };
}

export function costOf(model_name, in_tokens, out_tokens) {
    const p = priceFor(model_name);
    return (in_tokens / 1e6) * p.in + (out_tokens / 1e6) * p.out;
}

export class Meter {
    constructor(opts = {}) {
        this.started_at = opts.now ?? 0;
        this.calls = [];         // rolling window for rate calculations
        this.window_ms = opts.window_ms ?? 3600000;
        this.totals = { calls: 0, in_tokens: 0, out_tokens: 0, cost: 0, errors: 0 };
        this.by_tier = {};
        this.by_site = {};
    }

    // site: the call site ('conversing', 'goalGeneration', ...). local: was it
    // served by a local provider (ollama/lmstudio/vllm)?
    record({ tier, site, model, local, in_text, out_text, in_tokens, out_tokens, now = 0, error = false }) {
        const it = in_tokens ?? estimateTokens(in_text);
        const ot = out_tokens ?? estimateTokens(out_text);
        const cost = local ? 0 : costOf(model, it, ot);

        this.totals.calls++;
        this.totals.in_tokens += it;
        this.totals.out_tokens += ot;
        this.totals.cost += cost;
        if (error) this.totals.errors++;

        for (const [map, key] of [[this.by_tier, tier || 'untagged'], [this.by_site, site || 'unknown']]) {
            if (!map[key]) map[key] = { calls: 0, in_tokens: 0, out_tokens: 0, cost: 0, local_calls: 0 };
            const e = map[key];
            e.calls++;
            e.in_tokens += it;
            e.out_tokens += ot;
            e.cost += cost;
            if (local) e.local_calls++;
        }

        this.calls.push({ now, local, cost, tokens: it + ot });
        this._trim(now);
        return { in_tokens: it, out_tokens: ot, cost };
    }

    _trim(now) {
        const cutoff = now - this.window_ms;
        let i = 0;
        while (i < this.calls.length && this.calls[i].now < cutoff) i++;
        if (i > 0) this.calls.splice(0, i);
    }

    // Fraction of calls in the rolling window served locally — the Phase 6
    // acceptance metric (>70%).
    localShare(now = 0) {
        this._trim(now);
        if (this.calls.length === 0) return 1;
        return this.calls.filter(c => c.local).length / this.calls.length;
    }

    ratePerHour(now = 0) {
        this._trim(now);
        const span = Math.max(1, Math.min(this.window_ms, now - this.started_at));
        const scale = 3600000 / span;
        return {
            calls: Math.round(this.calls.length * scale),
            tokens: Math.round(this.calls.reduce((n, c) => n + c.tokens, 0) * scale),
            cost: Number((this.calls.reduce((n, c) => n + c.cost, 0) * scale).toFixed(4)),
        };
    }

    summary(now = 0) {
        return {
            totals: {
                ...this.totals,
                cost: Number(this.totals.cost.toFixed(4)),
            },
            local_share: Number(this.localShare(now).toFixed(3)),
            per_hour: this.ratePerHour(now),
            by_tier: Object.fromEntries(Object.entries(this.by_tier).map(([k, v]) => [k, {
                ...v, cost: Number(v.cost.toFixed(4)),
                local_share: v.calls ? Number((v.local_calls / v.calls).toFixed(3)) : 1,
            }])),
            by_site: Object.fromEntries(Object.entries(this.by_site).map(([k, v]) => [k, {
                ...v, cost: Number(v.cost.toFixed(4)),
            }])),
        };
    }
}
