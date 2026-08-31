// Pure retrieval scoring: recency x relevance x importance, Generative-Agents
// style. Relevance is computed by the caller (cosine over embeddings, or word
// overlap as fallback) and passed in as a function — this module stays pure.

// Exponential decay: 1.0 now, 0.5 after one half-life, etc.
export function recencyScore(event_ts, now, half_life_hours = 24) {
    const age_hours = Math.max(0, (now - event_ts) / 3600000);
    return Math.pow(0.5, age_hours / half_life_hours);
}

// Relevance is weighted double: retrieval exists to surface *related* memories;
// recency and importance break ties among the related.
export const DEFAULT_WEIGHTS = { recency: 1, relevance: 2, importance: 1 };

export function scoreEvent(recency, relevance, importance, weights = DEFAULT_WEIGHTS) {
    const total = weights.recency + weights.relevance + weights.importance;
    return (weights.recency * recency
        + weights.relevance * relevance
        + weights.importance * importance) / total;
}

// events: memory events. relevanceFn(event) -> [0,1].
// Returns top-k [{event, score}] sorted descending.
export function rankEvents(events, relevanceFn, now, opts = {}) {
    const {
        k = 5,
        half_life_hours = 24,
        weights = DEFAULT_WEIGHTS,
        min_score = 0,
    } = opts;
    const scored = [];
    for (const event of events) {
        const score = scoreEvent(
            recencyScore(event.ts, now, half_life_hours),
            relevanceFn(event),
            event.importance,
            weights,
        );
        if (score >= min_score)
            scored.push({ event, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}

export function humanizeAge(event_ts, now) {
    const mins = Math.round((now - event_ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}
