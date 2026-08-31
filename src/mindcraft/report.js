// Behavioral report aggregation. Pure functions over the agent event stream —
// no I/O, no sockets — so it is unit-testable and can be run over a live run,
// an archived run, or an exported JSONL file.
//
// The taxonomy mirrors tools/trace.py so the two agree on the same window:
// deliberate speech vs auto-narration vs commands-by-kind vs deaths vs
// sessions, plus the inner life (goals, plans, beliefs, social) that a server
// log physically cannot see.

// Event type -> report category. Keep in step with tools/trace.py's CMD_KIND
// and with src/agent/memory/events.js.
export const CATEGORY = {
    speech: 'speech',
    chat_received: 'speech',
    narration: 'narration',
    command: 'command',
    code: 'command',
    death: 'death',
    damage: 'combat',
    session: 'session',
    goal_started: 'goal',
    goal_completed: 'goal',
    goal_abandoned: 'goal',
    plan_revised: 'goal',
    interruption: 'interruption',
    belief: 'belief',
    social: 'social',
    gossip: 'social',
    place: 'discovery',
    discovery: 'discovery',
    other: 'other',
};

export function categoryOf(type) {
    return Object.hasOwn(CATEGORY, type) ? CATEGORY[type] : 'other';
}

// Which command a `command` event ran, if recorded.
function commandOf(ev) {
    return ev.data?.command || null;
}

// Buckets a !command into an activity kind, matching trace.py's CMD_KIND.
export const COMMAND_KIND = {
    '!collectBlocks': 'gather', '!searchForBlock': 'gather', '!digDown': 'gather',
    '!goToCoordinates': 'move', '!goToPlayer': 'move', '!followPlayer': 'move',
    '!moveAway': 'move', '!searchForEntity': 'move', '!goToSurface': 'move',
    '!goToBed': 'move', '!goToRememberedPlace': 'move', '!stay': 'move',
    '!craftRecipe': 'craft', '!smeltItem': 'craft', '!clearFurnace': 'craft',
    '!placeHere': 'build', '!newAction': 'build',
    '!attack': 'combat', '!attackPlayer': 'combat', '!equip': 'combat',
    '!startConversation': 'social', '!endConversation': 'social',
    '!givePlayer': 'social', '!lookAtPlayer': 'social',
    '!offerTrade': 'social', '!acceptTrade': 'social', '!declineTrade': 'social',
    '!viewChest': 'inventory', '!inventory': 'inventory', '!putInChest': 'inventory',
    '!takeFromChest': 'inventory', '!discard': 'inventory', '!consume': 'inventory',
    '!stats': 'introspect', '!stop': 'introspect', '!setMode': 'introspect',
    '!searchWiki': 'introspect', '!rememberHere': 'introspect', '!goal': 'introspect',
    '!stepDone': 'introspect', '!stepFailed': 'introspect',
};

export function commandKind(name) {
    return Object.hasOwn(COMMAND_KIND, name) ? COMMAND_KIND[name] : 'other';
}

function inWindow(ev, from, to) {
    return (from == null || ev.ts >= from) && (to == null || ev.ts <= to);
}

// events: [{agent, ts, type, content, data, importance, world, run}]
// scope: {agents?: string[], world?: string, run?: string, from?: number, to?: number}
const RESERVED = /^(__proto__|constructor|prototype)$/;

export function filterEvents(events, scope = {}) {
    const agents = Array.isArray(scope.agents) && scope.agents.length ? new Set(scope.agents) : null;
    return events.filter(ev =>
        ev && typeof ev.ts === 'number' && Number.isFinite(ev.ts)
        && typeof ev.agent === 'string' && !RESERVED.test(ev.agent)
        && (!agents || agents.has(ev.agent))
        && (!scope.world || ev.world === scope.world)
        && (!scope.run || ev.run === scope.run)
        && inWindow(ev, scope.from, scope.to));
}

// Who addressed whom, from the events that name a counterpart.
export function interactionMatrix(events) {
    // null-prototype: `agent` is untrusted and is used as a KEY here, so a
    // plain object lets '__proto__' mutate Object.prototype process-wide
    const edges = Object.create(null);
    for (const ev of events) {
        const to = ev.data?.to || ev.data?.peer || ev.data?.source || ev.data?.teller;
        if (!to || !ev.agent || to === ev.agent || to === 'system') continue;
        edges[ev.agent] ||= Object.create(null);
        edges[ev.agent][to] = (edges[ev.agent][to] || 0) + 1;
    }
    return edges;
}

// Item movement, from command events that carry item/qty.
export function resourceFlow(events) {
    const flow = Object.create(null);
    for (const ev of events) {
        const item = ev.data?.item;
        if (!item) continue;
        const key = `${ev.data?.command || ev.type}:${item}`;
        flow[ev.agent] ||= Object.create(null);
        flow[ev.agent][key] = (flow[ev.agent][key] || 0) + (ev.data?.qty || 1);
    }
    return flow;
}

// Connected/disconnected spans per agent, so downtime is visible.
export function sessions(events, from, to) {
    const out = Object.create(null);
    for (const ev of events) {
        if (ev.type !== 'session') continue;
        out[ev.agent] ||= [];
        out[ev.agent].push({ ts: ev.ts, content: ev.content });
    }
    for (const agent of Object.keys(out))
        out[agent].sort((a, b) => a.ts - b.ts);
    return out;
}

// Activity over time, bucketed — the timeline's raw material.
export function timeline(events, buckets = 60, from = null, to = null) {
    // clamped: buckets arrives from the client, and a huge Array.from is a
    // FATAL OOM that no try/catch can contain
    buckets = Math.min(500, Math.max(1, Math.floor(Number(buckets)) || 60));
    if (events.length === 0) return { from: 0, to: 0, buckets: [] };
    const t0 = from ?? Math.min(...events.map(e => e.ts));
    const t1 = to ?? Math.max(...events.map(e => e.ts));
    const span = Math.max(1, t1 - t0);
    const rows = Array.from({ length: buckets }, () => ({}));
    for (const ev of events) {
        const i = Math.min(buckets - 1, Math.floor(buckets * ((ev.ts - t0) / span)));
        const cat = categoryOf(ev.type);
        rows[i][cat] = (rows[i][cat] || 0) + 1;
    }
    return { from: t0, to: t1, buckets: rows };
}

// The "believed vs observed" pairing: what the agent concluded, next to what
// actually happened around it. This is the view a server log cannot produce.
export function believedVsObserved(events) {
    const out = Object.create(null);
    for (const ev of events) {
        out[ev.agent] ||= { beliefs: [], goals_completed: 0, goals_abandoned: 0, deaths: 0, observed: 0 };
        const rec = out[ev.agent];
        rec.observed++;
        if (ev.type === 'belief') rec.beliefs.push({ ts: ev.ts, content: ev.content });
        else if (ev.type === 'goal_completed') rec.goals_completed++;
        else if (ev.type === 'goal_abandoned') rec.goals_abandoned++;
        else if (ev.type === 'death') rec.deaths++;
    }
    return out;
}

// The full report.
export function buildReport(all_events, scope = {}) {
    const events = filterEvents(all_events, scope).sort((a, b) => a.ts - b.ts);
    const agents = [...new Set(events.map(e => e.agent))].sort();
    const worlds = [...new Set(events.map(e => e.world).filter(Boolean))].sort();

    const per_agent = Object.create(null);
    for (const agent of agents)
        per_agent[agent] = {
            total: 0, by_category: {}, by_command_kind: {},
            deaths: 0, speech: 0, narration: 0, beliefs: 0,
            first_seen: null, last_seen: null,
        };

    for (const ev of events) {
        const a = per_agent[ev.agent];
        if (!a) continue;
        a.total++;
        a.first_seen ??= ev.ts;
        a.last_seen = ev.ts;
        const cat = categoryOf(ev.type);
        a.by_category[cat] = (a.by_category[cat] || 0) + 1;
        if (cat === 'death') a.deaths++;
        if (ev.type === 'speech') a.speech++;
        if (ev.type === 'narration') a.narration++;
        if (ev.type === 'belief') a.beliefs++;
        const cmd = commandOf(ev);
        if (cmd) {
            const kind = commandKind(cmd);
            a.by_command_kind[kind] = (a.by_command_kind[kind] || 0) + 1;
        }
    }

    const span_from = events.length ? events[0].ts : null;
    const span_to = events.length ? events[events.length - 1].ts : null;
    const hours = (span_from != null) ? Math.max(1e-9, (span_to - span_from) / 3600000) : 0;

    return {
        scope,
        span: { from: span_from, to: span_to, hours: Number(hours.toFixed(3)) },
        totals: {
            events: events.length,
            agents: agents.length,
            worlds: worlds.length,
            deaths: events.filter(e => e.type === 'death').length,
            // deliberate speech ONLY — what the agent chose to say. Inbound
            // chat shares the 'speech' *category* (and so matches trace.py's
            // category count) but is not the agent's own utterance.
            speech: events.filter(e => e.type === 'speech').length,
            narration: events.filter(e => e.type === 'narration').length,
            beliefs: events.filter(e => e.type === 'belief').length,
            // per-category totals, directly comparable with tools/trace.py's
            // "by kind" table on the same input
            by_category: events.reduce((acc, e) => {
                const c = categoryOf(e.type);
                acc[c] = (acc[c] || 0) + 1;
                return acc;
            }, {}),
        },
        agents,
        worlds,
        per_agent,
        interactions: interactionMatrix(events),
        resources: resourceFlow(events),
        sessions: sessions(events),
        timeline: timeline(events, scope.buckets ?? 60, span_from, span_to),
        believed_vs_observed: believedVsObserved(events),
    };
}
