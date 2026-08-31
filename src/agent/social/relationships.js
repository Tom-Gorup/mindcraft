// Pure relationship logic: per-pair trust / affinity / grudge, updated by
// typed interaction events and decayed toward baseline over time.
// No agent references, no I/O — unit-testable.
//
// trust    [0,1]  willingness to believe and cooperate. Starts neutral (0.5).
// affinity [-1,1] like/dislike. Starts 0.
// grudge   [0,1]  active resentment. Spikes on harm, decays with forgiveness.

export const BASELINE = { trust: 0.5, affinity: 0, grudge: 0 };

// Base deltas per interaction. Personality scales these (see DEFAULT_PERSONALITY).
// Harm is deliberately larger than help: trust is lost faster than it's earned.
export const INTERACTIONS = {
    greeted:        { trust: 0.01, affinity: 0.03, grudge: 0 },
    conversed:      { trust: 0.02, affinity: 0.03, grudge: 0 },
    praised:        { trust: 0.04, affinity: 0.10, grudge: -0.05 },
    insulted:       { trust: -0.05, affinity: -0.12, grudge: 0.08 },
    gave_item:      { trust: 0.06, affinity: 0.12, grudge: -0.08 },
    received_item:  { trust: 0.08, affinity: 0.15, grudge: -0.10 },
    traded_fairly:  { trust: 0.10, affinity: 0.10, grudge: -0.05 },
    trade_refused:  { trust: -0.02, affinity: -0.04, grudge: 0.02 },
    trade_reneged:  { trust: -0.25, affinity: -0.20, grudge: 0.30 },
    helped:         { trust: 0.10, affinity: 0.15, grudge: -0.10 },
    attacked_by:    { trust: -0.30, affinity: -0.35, grudge: 0.50 },
    killed_by:      { trust: -0.40, affinity: -0.45, grudge: 0.80 },
    ignored:        { trust: -0.01, affinity: -0.03, grudge: 0.02 },
    lied_to:        { trust: -0.20, affinity: -0.15, grudge: 0.20 },
    // Aggressor's own view of someone they attacked: you don't attack people
    // you like, but being the aggressor earns you no grudge and costs little
    // trust — that asymmetry vs attacked_by/killed_by is the point.
    attacked:       { trust: -0.05, affinity: -0.20, grudge: 0 },
    // Hearsay about a third party. Moves opinion but manufactures NO grudge —
    // resentment should require something happening to you, not a rumor.
    heard_ill_of:   { trust: -0.06, affinity: -0.10, grudge: 0 },
    heard_well_of:  { trust: 0.05, affinity: 0.09, grudge: 0 },
};

export const DEFAULT_PERSONALITY = {
    trust_gain: 1.0,       // scales positive trust deltas
    trust_loss: 1.0,       // scales negative trust deltas
    forgiveness: 1.0,      // scales grudge decay
    warmth: 1.0,           // scales affinity deltas
    gossip_propensity: 0.5,// 0..1 likelihood of sharing secondhand news
    generosity: 0.5,       // 0..1 willingness to give / accept lopsided trades
    grudge_decay_per_hour: 0.08,
    trust_drift_per_hour: 0.01, // drift back toward baseline when nothing happens
};

function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
}

export function newRelationship(name, now = 0) {
    return {
        name,
        trust: BASELINE.trust,
        affinity: BASELINE.affinity,
        grudge: BASELINE.grudge,
        interactions: 0,
        first_seen: now,
        last_interaction: now,
        notes: [],   // short attributed facts, e.g. gossip received
    };
}

// Apply one interaction. weight scales the whole delta (e.g. secondhand gossip
// is believed only in proportion to trust in the teller).
export function applyInteraction(rel, type, personality = DEFAULT_PERSONALITY, opts = {}) {
    const base = INTERACTIONS[type];
    if (!base) return rel;
    const weight = opts.weight ?? 1;
    const p = { ...DEFAULT_PERSONALITY, ...personality };

    const trust_scale = base.trust >= 0 ? p.trust_gain : p.trust_loss;
    rel.trust = clamp(rel.trust + base.trust * trust_scale * weight, 0, 1);
    rel.affinity = clamp(rel.affinity + base.affinity * p.warmth * weight, -1, 1);
    // forgiveness speeds decay but must not amplify fresh harm
    const grudge_scale = base.grudge >= 0 ? 1 : p.forgiveness;
    rel.grudge = clamp(rel.grudge + base.grudge * grudge_scale * weight, 0, 1);

    rel.interactions++;
    rel.last_interaction = opts.now ?? rel.last_interaction;
    return rel;
}

// Time-based decay: grudges fade, trust/affinity drift toward baseline.
export function decay(rel, elapsed_ms, personality = DEFAULT_PERSONALITY) {
    const p = { ...DEFAULT_PERSONALITY, ...personality };
    const hours = Math.max(0, elapsed_ms) / 3600000;
    if (hours === 0) return rel;

    rel.grudge = clamp(rel.grudge - p.grudge_decay_per_hour * p.forgiveness * hours, 0, 1);
    const drift = p.trust_drift_per_hour * hours;
    rel.trust += clamp(BASELINE.trust - rel.trust, -drift, drift);
    rel.affinity += clamp(BASELINE.affinity - rel.affinity, -drift, drift);
    rel.trust = clamp(rel.trust, 0, 1);
    rel.affinity = clamp(rel.affinity, -1, 1);
    return rel;
}

// Overall disposition in [-1,1]: what the agent feels about this peer.
export function disposition(rel) {
    return clamp(rel.affinity * 0.5 + (rel.trust - 0.5) * 0.6 - rel.grudge * 0.8, -1, 1);
}

export function describeRelationship(rel) {
    const d = disposition(rel);
    let label;
    if (d > 0.55) label = 'a close friend you trust deeply';
    else if (d > 0.25) label = 'a friend';
    else if (d > 0.08) label = 'someone you like';
    else if (d < -0.55) label = 'an enemy you resent';
    else if (d < -0.25) label = 'someone you distrust';
    else if (d < -0.08) label = 'someone you are wary of';
    else label = 'a neutral acquaintance';

    let text = `${rel.name}: ${label} (trust ${rel.trust.toFixed(2)}, affinity ${rel.affinity.toFixed(2)}`;
    if (rel.grudge > 0.15) text += `, grudge ${rel.grudge.toFixed(2)}`;
    text += ')';
    if (rel.notes.length > 0)
        text += ` — ${rel.notes.slice(-2).join('; ')}`;
    return text;
}
