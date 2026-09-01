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

// Why goals die.
//
// A run that completes 5 goals and abandons 100 is the normal case for a
// long autonomous run, and counting the two tells you nothing about which
// 100. The events already carry drive, reason and preempted_by; this groups
// them so "the agent got stuck" becomes a specific claim about what stopped it.
//
// Three questions, because they have three different fixes:
//   · which reasons recur          → the execution layer is failing
//   · which drive interrupts which → the arbiter is thrashing
//   · which drives never finish    → those goals are unreachable as written
export function goalOutcomes(events) {
    const out = Object.create(null);
    const agent = (name) => (out[name] ||= {
        completed: 0, abandoned: 0,
        by_reason: {}, by_drive: {}, preemptions: {},
        completed_goals: [], abandoned_goals: [],
    });

    for (const ev of events) {
        if (ev.type !== 'goal_completed' && ev.type !== 'goal_abandoned') continue;
        const a = agent(ev.agent);
        const parsed = parseGoalContent(ev.content);
        const drive = ev.data?.drive ?? parsed.drive ?? 'unknown';
        a.by_drive[drive] ||= { completed: 0, abandoned: 0 };

        if (ev.type === 'goal_completed') {
            a.completed++;
            a.by_drive[drive].completed++;
            a.completed_goals.push({ ts: ev.ts, drive, goal: ev.data?.goal ?? parsed.goal ?? null });
            continue;
        }

        a.abandoned++;
        a.by_drive[drive].abandoned++;
        // A preemption is a distinct outcome from a failure: the goal was not
        // beaten by the world, it was outvoted. Conflating them hides arbiter
        // thrash inside what looks like an execution problem.
        const by = ev.data?.preempted_by ?? parsed.preempted_by;
        const reason = by ? `preempted by ${by}` : normalizeReason(ev.data?.reason ?? parsed.reason);
        a.by_reason[reason] = (a.by_reason[reason] || 0) + 1;
        if (by) {
            a.preemptions[drive] ||= {};
            a.preemptions[drive][by] = (a.preemptions[drive][by] || 0) + 1;
        }
        a.abandoned_goals.push({ ts: ev.ts, drive, goal: ev.data?.goal ?? parsed.goal ?? null, reason });
    }

    for (const a of Object.values(out)) {
        const attempted = a.completed + a.abandoned;
        a.completion_rate = attempted ? Number((a.completed / attempted).toFixed(3)) : 0;
        // Keep the bundle hand-readable; the raw JSONL has every one of them.
        a.completed_goals = a.completed_goals.slice(-25);
        a.abandoned_goals = a.abandoned_goals.slice(-25);
    }
    return out;
}

// Recover drive/goal/reason from the event's prose.
//
// Archives written before the structured fields were allowlisted still carry
// everything in `content` — "Abandoned goal (legacy): build a tower — step
// timeout". Runs are research data that must stay comparable across code
// changes, so old ones are parsed rather than written off.
export function parseGoalContent(content) {
    const text = String(content ?? '');
    const m = /^(?:Completed|Abandoned|Dropped|Set aside) goal(?:\s*\(([^)]{1,40})\))?:\s*([\s\S]*)$/.exec(text);
    if (!m) return {};
    const out = { drive: m[1] || undefined };
    const rest = m[2] ?? '';
    // The goal text itself can contain a dash, so split on the LAST separator.
    const sep = rest.lastIndexOf(' — ');
    if (sep === -1) { out.goal = rest.trim() || undefined; return out; }
    out.goal = rest.slice(0, sep).trim() || undefined;
    const tail = rest.slice(sep + 3).trim();
    const pre = /^(\S{1,24}) became more urgent$/.exec(tail);
    if (pre) out.preempted_by = pre[1];
    else out.reason = tail || undefined;
    return out;
}

// Free-text reasons come from the monitor and the model, so they carry goal
// names and counts that would shatter the grouping into singletons.
export function normalizeReason(reason) {
    const r = String(reason ?? '').toLowerCase().trim();
    if (!r) return 'unspecified';
    if (r.includes('timeout') || r.includes('timed out')) return 'step timeout';
    if (r.includes('no longer') || r.includes('stale') || r.includes('warranted')) return 'no longer warranted';
    if (r.includes('too many') || r.includes('retries') || r.includes('retry')) return 'retries exhausted';
    if (r.includes('replan')) return 'replan failed';
    if (r.includes('died') || r.includes('death')) return 'died';
    if (r.includes('budget') || r.includes('too long')) return 'out of time';
    return r.substring(0, 60);
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
        goal_outcomes: goalOutcomes(events),
    };
}
