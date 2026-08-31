// Event taxonomy for the append-only memory stream. Pure — no agent refs.
// The taxonomy deliberately covers what tools/trace.py distinguishes from the
// outside (speech / narration / command-by-kind / death / session) plus the
// inner life the server log can never see (goals, plans, beliefs), so Phase 8
// research reports can read straight from this stream.

export const EVENT_TYPES = {
    speech:         { importance: 0.4,  embed: true },   // agent chose to say this
    chat_received:  { importance: 0.5,  embed: true },   // player or bot spoke to agent
    narration:      { importance: 0.05, embed: false },  // narrate_behavior auto-emission
    command:        { importance: 0.15, embed: false },  // a !command was executed
    death:          { importance: 0.9,  embed: true },
    damage:         { importance: 0.4,  embed: false },
    session:        { importance: 0.3,  embed: false },  // spawned / disconnected
    interruption:   { importance: 0.3,  embed: false }, // reflex seized the action slot
    goal_started:   { importance: 0.6,  embed: true },
    goal_completed: { importance: 0.7,  embed: true },
    goal_abandoned: { importance: 0.7,  embed: true },
    plan_revised:   { importance: 0.5,  embed: true },
    place:          { importance: 0.6,  embed: true },   // remembered location
    discovery:      { importance: 0.6,  embed: true },
    code:           { importance: 0.5,  embed: true },   // successful generated program
    belief:         { importance: 0.85, embed: true },   // reflection output
    other:          { importance: 0.3,  embed: true },
};

let _seq = 0;

// content: short natural-language description (what gets embedded and shown in
// prompts). data: small structured payload for reports (never embedded).
export function makeEvent(type, content, data = {}, opts = {}) {
    const spec = EVENT_TYPES[type] || EVENT_TYPES.other;
    const ts = opts.ts ?? Date.now();
    _seq++;
    return {
        id: `${ts}-${_seq}`,
        ts,
        type: EVENT_TYPES[type] ? type : 'other',
        content: String(content).substring(0, 500),
        data,
        importance: clamp01(opts.importance ?? spec.importance),
    };
}

export function shouldEmbed(event) {
    return (EVENT_TYPES[event.type] || EVENT_TYPES.other).embed && event.importance >= 0.1;
}

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}
