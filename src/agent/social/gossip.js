// Pure gossip logic: choosing what secondhand news to share, and how much to
// believe what you're told. No LLM calls — gossip is selected from memories
// the agent already has, so the social tier costs nothing per tick.

// Subjects mentioned in a memory, excluding the speaker and the listener.
export function extractSubjects(content, known_names, exclude = []) {
    const subjects = [];
    for (const name of known_names) {
        if (exclude.includes(name)) continue;
        // word-boundary match so 'Andy' doesn't match 'Andyson'
        if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(content))
            subjects.push(name);
    }
    return subjects;
}

// Pick one memory worth retelling to `listener`.
// events: memory events (newest last). Returns {event, subject} or null.
export function selectGossip(events, listener, known_names, opts = {}) {
    const {
        min_importance = 0.5,
        max_age_ms = 6 * 3600000,
        now = Date.now(),
        already_told = new Set(),
    } = opts;

    let best = null;
    for (const event of events) {
        if (event.type === 'narration' || event.type === 'command') continue;
        if (event.importance < min_importance) continue;
        if (now - event.ts > max_age_ms) continue;
        if (already_told.has(event.id)) continue;
        // don't retell what the listener told us, or what is about them
        if (event.data?.source === listener) continue;
        const subjects = extractSubjects(event.content, known_names, [listener]);
        if (subjects.length === 0) continue;
        // freshest, most important wins
        const score = event.importance + (1 - (now - event.ts) / max_age_ms) * 0.5;
        if (!best || score > best.score)
            best = { event, subject: subjects[0], score };
    }
    return best ? { event: best.event, subject: best.subject } : null;
}

// Should this agent share gossip right now? Propensity is personality; being
// closer to the listener makes sharing more likely.
export function shouldGossip(propensity, listener_disposition, roll) {
    const chance = Math.max(0, Math.min(1, propensity * (0.5 + listener_disposition * 0.5)));
    return roll < chance;
}

// How much to believe secondhand news: trust in the teller, damped because
// hearsay is hearsay. Returns a weight in [0, 0.6].
export function credibility(teller_trust) {
    return Math.max(0, Math.min(0.6, teller_trust * 0.6));
}

// Attributed line the hearer stores, so beliefs keep their provenance.
export function attributedNote(teller, subject, claim) {
    const clean = String(claim).replace(/[\r\n]+/g, ' ').trim().substring(0, 160);
    return `${teller} told me about ${subject}: ${clean}`;
}
