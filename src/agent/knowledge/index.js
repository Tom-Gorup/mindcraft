// Phase 10 — knowledge: what the agent has worked out and is willing to act on.
//
// This is deliberately NOT the belief stream. A belief is prose written by
// reflection for a prompt to read; there were 525 of them in twelve hours, many
// near-duplicates of "nighttime is dangerous", and none of them changed what the
// agent did. Knowledge is a claim with a subject, a count behind it, and a
// confidence that moves — something the planner can be handed as a constraint.
//
// The distinction that shapes this file: some things should be GIVEN and some
// must be EARNED. Tool tiers and crafting trees are fixed rules already in
// mcdata; rediscovering them by dying is waste, and they are injected directly
// rather than learned. What lives here is what no wiki can supply — this
// terrain, this seed, these neighbours, what has actually worked here.
//
// Pure: no agent references, no I/O. Unit-testable.

const MAX_FACTS = 400;

function clampStr(v, n) {
    return String(v ?? '').trim().substring(0, n);
}

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

// A fact is identified by (kind, subject) so corroboration lands on the same
// row rather than creating a near-duplicate — which is exactly how the belief
// stream reached 525 entries saying twelve versions of one thing.
export function factKey(kind, subject) {
    return `${clampStr(kind, 32)}::${clampStr(subject, 64).toLowerCase()}`;
}

export class Knowledge {
    constructor(data = {}, opts = {}) {
        this.max_facts = opts.max_facts ?? MAX_FACTS;
        // How much one observation moves confidence. Deliberately slow: a
        // single success does not make a rule, and a single failure should not
        // erase one either.
        this.step = opts.step ?? 0.18;
        this.facts = new Map();
        for (const f of data.facts ?? []) {
            const key = factKey(f.kind, f.subject);
            this.facts.set(key, {
                kind: clampStr(f.kind, 32),
                subject: clampStr(f.subject, 64),
                claim: clampStr(f.claim, 200),
                confidence: clamp01(f.confidence ?? 0.5),
                support: Math.max(0, f.support | 0),
                contradiction: Math.max(0, f.contradiction | 0),
                first_seen: f.first_seen ?? 0,
                last_seen: f.last_seen ?? 0,
            });
        }
    }

    get size() {
        return this.facts.size;
    }

    // Record an observation. Repeat observations of the same claim raise
    // confidence rather than adding a row — this is the consolidation the
    // belief stream never did.
    observe(kind, subject, claim, { supports = true, now = 0 } = {}) {
        if (!kind || !subject) return null;
        const key = factKey(kind, subject);
        let f = this.facts.get(key);
        if (!f) {
            f = {
                kind: clampStr(kind, 32), subject: clampStr(subject, 64),
                claim: clampStr(claim, 200), confidence: 0.5,
                support: 0, contradiction: 0, first_seen: now, last_seen: now,
            };
            this.facts.set(key, f);
        }
        if (claim) f.claim = clampStr(claim, 200);
        f.last_seen = now;
        if (supports) {
            f.support++;
            f.confidence = clamp01(f.confidence + this.step * (1 - f.confidence));
        } else {
            f.contradiction++;
            f.confidence = clamp01(f.confidence - this.step);
        }
        this._trim();
        return f;
    }

    get(kind, subject) {
        return this.facts.get(factKey(kind, subject)) ?? null;
    }

    // Only what the agent is actually confident of. A planner acting on a
    // coin-flip is worse than a planner acting on nothing.
    confident(threshold = 0.7) {
        return [...this.facts.values()]
            .filter(f => f.confidence >= threshold)
            .sort((a, b) => b.confidence - a.confidence);
    }

    byKind(kind, threshold = 0) {
        return [...this.facts.values()]
            .filter(f => f.kind === kind && f.confidence >= threshold)
            .sort((a, b) => b.confidence - a.confidence);
    }

    // Compact enough to sit in a prompt. Confident claims only, most certain
    // first, so a long-running agent does not drown its own context.
    describe(limit = 8, threshold = 0.7) {
        const facts = this.confident(threshold).slice(0, limit);
        if (!facts.length) return '';
        return 'What you have learned here:\n'
            + facts.map(f => `- ${f.claim} (seen ${f.support}x)`).join('\n');
    }

    // Facts a plan must not violate. This is the piece the belief stream could
    // never provide: the agents correctly concluded "pathfinding fails in this
    // terrain, build near my current position" and then had no way to act on
    // their own conclusion.
    constraints(threshold = 0.75) {
        return this.confident(threshold)
            .filter(f => f.kind === 'avoid' || f.kind === 'requires')
            .slice(0, 6)
            .map(f => f.claim);
    }

    // Drop the least useful when full: least confident first, then least
    // corroborated, then stalest. Support is in there because confidence alone
    // lets a fact that is still being established be culled mid-build — it and
    // a one-off sighting look identical after a single observation.
    _trim() {
        if (this.facts.size <= this.max_facts) return;
        const ranked = [...this.facts.entries()]
            .sort((a, b) => (a[1].confidence - b[1].confidence)
                || (a[1].support - b[1].support)
                || (a[1].last_seen - b[1].last_seen));
        const drop = ranked.slice(0, this.facts.size - this.max_facts);
        for (const [key] of drop) this.facts.delete(key);
    }

    toJSON() {
        return { facts: [...this.facts.values()] };
    }
}
