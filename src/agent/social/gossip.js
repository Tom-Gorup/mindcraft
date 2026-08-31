// Pure gossip logic: choosing what secondhand news to share, and how much to
// believe what you're told. No LLM calls — gossip is selected from memories
// the agent already has, so the social tier costs nothing per tick.

// Event types worth repeating out loud. A whitelist, not a blacklist: it must
// never include 'social' (the agent's own trust/grudge numbers) or 'gossip'
// (already-secondhand — relaying it launders hearsay into fresh "evidence").
export const SHAREABLE_TYPES = new Set(['speech', 'chat_received', 'death', 'goal_completed', 'goal_abandoned', 'discovery', 'place']);

// Chat relayed BY another bot is already secondhand. Excluding 'gossip' alone
// was not enough: A tells B about C, B stores it as a firsthand-looking
// chat_received, B retells D, D retells A — the rumor launders itself into new
// "evidence" on every hop and the network converges on mutual hostility.
function isSecondhand(event, known_names) {
    const src = event.data?.source;
    return event.type === 'chat_received' && src && known_names.includes(src);
}

// "Bob said: <text>" -> "<text>", so the speaker's name is not mistaken for
// the subject of what they said.
export function stripSpeakerPrefix(content) {
    return String(content ?? '').replace(/^[A-Za-z0-9_]{1,32} said:\s*/, '');
}

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
    // events are append-ordered: walk backwards and stop at the age cutoff
    // instead of scanning the whole (up to 5000-event) buffer on a prompt path
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (now - event.ts > max_age_ms) break;
        // only firsthand, sayable observations — never the agent's own
        // internal telemetry ('social' disposition dumps) or relayed hearsay,
        // which would otherwise echo between two bots forever
        if (!SHAREABLE_TYPES.has(event.type)) continue;
        if (isSecondhand(event, known_names)) continue;
        if (event.importance < min_importance) continue;
        if (already_told.has(event.id)) continue;
        // don't retell what the listener told us, or what is about them
        if (event.data?.source === listener || event.data?.teller === listener) continue;
        // The speaker's own name is inside the content of a chat_received
        // ("Bob said: ..."), so without excluding them the TELLER is often
        // picked as the subject instead of the third party being discussed.
        const exclude = [listener, event.data?.source, event.data?.teller, event.data?.subject].filter(Boolean);
        const subjects = extractSubjects(stripSpeakerPrefix(event.content), known_names, exclude);
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
