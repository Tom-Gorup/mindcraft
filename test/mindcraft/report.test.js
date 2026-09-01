import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, filterEvents, categoryOf, commandKind, interactionMatrix, timeline, parseGoalContent, goalOutcomes } from '../../src/mindcraft/report.js';

const T0 = 1_700_000_000_000;
function ev(agent, type, dt, extra = {}) {
    return { agent, type, ts: T0 + dt, content: `${type} by ${agent}`, world: 'w1', run: 'r1', ...extra };
}

const SAMPLE = [
    ev('Wilbur', 'session', 0),
    ev('Wilbur', 'goal_started', 1000),
    ev('Wilbur', 'command', 2000, { data: { command: '!collectBlocks', item: 'oak_log', qty: 10 } }),
    ev('Wilbur', 'speech', 3000, { data: { to: 'Greta' } }),
    ev('Wilbur', 'narration', 4000),
    ev('Greta', 'chat_received', 5000, { data: { source: 'Wilbur' } }),
    ev('Greta', 'social', 6000, { data: { peer: 'Wilbur' } }),
    ev('Wilbur', 'death', 7000),
    ev('Wilbur', 'belief', 8000),
    ev('Ada', 'goal_completed', 9000, { world: 'w2' }),
];

test('the taxonomy separates deliberate speech from auto-narration', () => {
    // this distinction is the whole reason the trace exists
    assert.equal(categoryOf('speech'), 'speech');
    assert.equal(categoryOf('narration'), 'narration');
    assert.notEqual(categoryOf('speech'), categoryOf('narration'));
    assert.equal(categoryOf('nonsense_type'), 'other');
    assert.equal(categoryOf('constructor'), 'other'); // no prototype leakage
});

test('commands are bucketed by activity kind', () => {
    assert.equal(commandKind('!collectBlocks'), 'gather');
    assert.equal(commandKind('!craftRecipe'), 'craft');
    assert.equal(commandKind('!attackPlayer'), 'combat');
    assert.equal(commandKind('!offerTrade'), 'social');
    assert.equal(commandKind('!unknownCommand'), 'other');
    assert.equal(commandKind('toString'), 'other');
});

test('headline totals count what they claim', () => {
    const r = buildReport(SAMPLE);
    assert.equal(r.totals.events, 10);
    assert.equal(r.totals.agents, 3);
    assert.equal(r.totals.worlds, 2);
    assert.equal(r.totals.deaths, 1);
    assert.equal(r.totals.speech, 1);       // Wilbur's utterance only
    assert.equal(r.totals.narration, 1);
    assert.equal(r.totals.beliefs, 1);
    // the category count includes inbound chat, matching trace.py's "by kind"
    assert.equal(r.totals.by_category.speech, 2);
    assert.equal(r.totals.by_category.narration, 1);
});

test('scoping by agent, world, run, and time window', () => {
    assert.equal(filterEvents(SAMPLE, { agents: ['Greta'] }).length, 2);
    assert.equal(filterEvents(SAMPLE, { world: 'w2' }).length, 1);
    assert.equal(filterEvents(SAMPLE, { run: 'r1' }).length, 10); // all of them, incl. Ada in w2
    assert.equal(filterEvents(SAMPLE, { run: 'nope' }).length, 0);
    assert.equal(filterEvents(SAMPLE, { from: T0 + 5000 }).length, 5);
    assert.equal(filterEvents(SAMPLE, { to: T0 + 2000 }).length, 3);
    assert.equal(filterEvents(SAMPLE, { agents: ['Wilbur'], from: T0 + 7000 }).length, 2);
    // a scoped report reports only its scope
    const r = buildReport(SAMPLE, { world: 'w1' });
    assert.deepEqual(r.agents, ['Greta', 'Wilbur']);
    assert.equal(r.totals.worlds, 1);
});

test('who addressed whom is derived from counterpart fields', () => {
    const m = interactionMatrix(SAMPLE);
    assert.equal(m.Wilbur.Greta, 1);   // speech to Greta
    assert.equal(m.Greta.Wilbur, 2);   // chat from Wilbur + social about Wilbur
    // self-references and system are never edges
    const self = interactionMatrix([ev('Wilbur', 'speech', 0, { data: { to: 'Wilbur' } }),
        ev('Wilbur', 'speech', 1, { data: { to: 'system' } })]);
    assert.equal(Object.keys(self).length, 0);
});

test('untrusted agent names cannot pollute Object.prototype', () => {
    // agent names are used as object KEYS throughout the report
    const hostile = [
        { agent: '__proto__', ts: T0, type: 'speech', content: 'x', data: { to: 'POLLUTED' } },
        { agent: 'constructor', ts: T0, type: 'command', content: 'x', data: { item: 'y', qty: 1 } },
    ];
    interactionMatrix(hostile);
    buildReport(hostile);
    assert.equal({}.POLLUTED, undefined, 'Object.prototype was mutated');
    assert.equal(buildReport(hostile).agents.length, 0, 'reserved names must be filtered out');
});

test('a client-supplied bucket count cannot exhaust memory', () => {
    // Array.from({length:N}) with a huge N is a FATAL OOM no try/catch can hold
    const r = buildReport(SAMPLE, { buckets: 50_000_000 });
    assert.ok(r.timeline.buckets.length <= 500);
    assert.equal(buildReport(SAMPLE, { buckets: -1 }).timeline.buckets.length, 1);
    assert.equal(buildReport(SAMPLE, { buckets: 'abc' }).timeline.buckets.length, 60);
});

test('resource flow accumulates quantities per item', () => {
    const r = buildReport([...SAMPLE,
        ev('Wilbur', 'command', 10000, { data: { command: '!collectBlocks', item: 'oak_log', qty: 5 } })]);
    assert.equal(r.resources.Wilbur['!collectBlocks:oak_log'], 15);
});

test('believed vs observed pairs conclusions with what happened', () => {
    const r = buildReport(SAMPLE);
    const w = r.believed_vs_observed.Wilbur;
    assert.equal(w.beliefs.length, 1);
    assert.equal(w.deaths, 1);
    assert.equal(r.believed_vs_observed.Ada.goals_completed, 1);
});

test('timeline buckets activity across the span', () => {
    const t = timeline(SAMPLE, 10);
    assert.equal(t.buckets.length, 10);
    assert.equal(t.from, T0);
    assert.equal(t.to, T0 + 9000);
    const counted = t.buckets.reduce((n, b) => n + Object.values(b).reduce((x, y) => x + y, 0), 0);
    assert.equal(counted, SAMPLE.length); // every event lands in exactly one bucket
});

test('an empty or fully-filtered-out set produces a valid empty report', () => {
    for (const r of [buildReport([]), buildReport(SAMPLE, { agents: ['Nobody'] })]) {
        assert.equal(r.totals.events, 0);
        assert.deepEqual(r.agents, []);
        assert.equal(r.span.from, null);
        assert.ok(JSON.stringify(r)); // JSON-safe for the socket
    }
});

test('malformed events are filtered rather than crashing the report', () => {
    const r = buildReport([...SAMPLE, null, {}, { agent: 'X' }, { ts: 'nope', agent: 'Y' }]);
    assert.equal(r.totals.events, 10);
});

// ---- why goals ended ----
//
// A long autonomous run abandons far more goals than it completes; that is
// expected. Which ones, and why, is the actual finding.

const goalEv = (agent, type, content, data) => ({ agent, type, content, ts: 1, data });

test('goal outcomes separate preemption from failure', () => {
    const { goal_outcomes } = buildReport([
        goalEv('Wilbur', 'goal_completed', 'Completed goal (food): eat', { drive: 'food', goal: 'eat' }),
        goalEv('Wilbur', 'goal_abandoned', 'Abandoned goal (legacy): tower',
            { drive: 'legacy', goal: 'tower', reason: 'step timed out after 3 retries' }),
        goalEv('Wilbur', 'goal_abandoned', 'Set aside goal (legacy): tower',
            { drive: 'legacy', goal: 'tower', preempted_by: 'food' }),
    ]);
    const w = goal_outcomes.Wilbur;
    assert.equal(w.completed, 1);
    assert.equal(w.abandoned, 2);
    assert.ok(Math.abs(w.completion_rate - 1 / 3) < 0.01);
    assert.equal(w.by_reason['step timeout'], 1, 'free-text reasons are normalized so they group');
    assert.equal(w.by_reason['preempted by food'], 1, 'preemption is its own outcome, not a failure');
    assert.deepEqual(w.preemptions, { legacy: { food: 1 } });
    assert.deepEqual(w.by_drive.legacy, { completed: 0, abandoned: 2 });
});

// Archives written before the structured fields were allowlisted carry
// everything in the prose. Runs are research data — old ones must stay readable.
test('outcomes are recovered from content when no structured data exists', () => {
    const { goal_outcomes } = buildReport([
        goalEv('Greta', 'goal_abandoned', 'Abandoned goal (legacy): build a watchtower — step timed out'),
        goalEv('Greta', 'goal_abandoned', 'Set aside goal (legacy): build a watchtower — food became more urgent'),
        goalEv('Greta', 'goal_completed', 'Completed goal (food): eat cooked mutton'),
    ]);
    const g = goal_outcomes.Greta;
    assert.deepEqual(g.by_drive.legacy, { completed: 0, abandoned: 2 });
    assert.deepEqual(g.by_drive.food, { completed: 1, abandoned: 0 });
    assert.equal(g.by_reason['step timeout'], 1);
    assert.deepEqual(g.preemptions, { legacy: { food: 1 } });
});

test('a goal containing a dash is not mistaken for a reason', () => {
    const p = parseGoalContent('Abandoned goal (legacy): build a tower — tall — step timed out');
    assert.equal(p.goal, 'build a tower — tall', 'splits on the LAST separator');
    assert.equal(p.reason, 'step timed out');
});

test('unparseable content degrades to unspecified rather than inventing a reason', () => {
    assert.deepEqual(parseGoalContent('something else entirely'), {});
    const { goal_outcomes } = buildReport([goalEv('X', 'goal_abandoned', 'something else entirely')]);
    assert.equal(goal_outcomes.X.by_reason.unspecified, 1);
    assert.deepEqual(goal_outcomes.X.by_drive, { unknown: { completed: 0, abandoned: 1 } });
});
