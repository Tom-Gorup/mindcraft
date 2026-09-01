import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPlan, parseGoalResponse, parsePlanResponse, parseProjectResponse } from '../../src/agent/cognition/planner.js';

test('parses a clean json codeblock goal', () => {
    const res = '```json\n{"goal": "Craft an iron pickaxe", "reason": "Time to upgrade!"}\n```';
    assert.deepEqual(parseGoalResponse(res), { goal: 'Craft an iron pickaxe', reason: 'Time to upgrade!' });
});

test('parses goal with prose, think blocks, and no codeblock', () => {
    const res = '<think>hmm what to do</think>Here is my goal:\n{"goal": "Explore the cave to the north", "reason": "I want to see it"} hope that works';
    const goal = parseGoalResponse(res);
    assert.equal(goal.goal, 'Explore the cave to the north');
});

test('rejects malformed goal responses', () => {
    assert.equal(parseGoalResponse('no json here'), null);
    assert.equal(parseGoalResponse('{"reason": "missing goal"}'), null);
    assert.equal(parseGoalResponse('{"goal": ""}'), null);
    assert.equal(parseGoalResponse(null), null);
});

test('parses plan steps and drops empty entries', () => {
    const res = '```json\n{"steps": ["Collect 10 oak logs", "  ", "Craft a crafting table", 42]}\n```';
    assert.deepEqual(parsePlanResponse(res), ['Collect 10 oak logs', 'Craft a crafting table']);
});

test('rejects plans with no usable steps', () => {
    assert.equal(parsePlanResponse('{"steps": []}'), null);
    assert.equal(parsePlanResponse('{"steps": "not an array"}'), null);
    assert.equal(parsePlanResponse('garbage'), null);
});

test('formatPlan marks progress', () => {
    const text = formatPlan(['gather wood', 'make planks', 'build hut'], 1);
    assert.ok(text.includes('1. [done] gather wood'));
    assert.ok(text.includes('2. [CURRENT] make planks'));
    assert.ok(text.includes('3. [ ] build hut'));
});

// Smaller models (Haiku and below) wrap JSON in prose far more often than
// larger ones. first-brace..last-brace over-reaches on all of these.
test('goal parsing survives the shapes small models actually emit', () => {
    const good = '{"goal":"mine iron","reason":"wealth"}';
    const cases = {
        'trailing prose containing a brace': good + '\nHope that helps! :} ',
        'a second object': good + '\n{"goal":"something else"}',
        'a preamble': 'Sure, here is the goal:\n' + good,
        'a fenced block': '```json\n' + good + '\n```',
        'a think block': '<think>weighing options</think>' + good,
        'a brace inside a string': '{"goal":"mine iron }","reason":"wealth"} trailing }',
    };
    for (const [name, text] of Object.entries(cases)) {
        const parsed = parseGoalResponse(text);
        assert.ok(parsed, `failed to parse when there was ${name}`);
        assert.match(parsed.goal, /^mine iron/, `wrong goal when there was ${name}`);
    }
});

test('plan parsing survives trailing prose', () => {
    const steps = parsePlanResponse('{"steps":["find a vein","mine it"]}\nLet me know if that works }');
    assert.deepEqual(steps, ['find a vein', 'mine it']);
});

test('genuinely unparseable output still returns null rather than throwing', () => {
    assert.equal(parseGoalResponse('I would rather not.'), null);
    assert.equal(parseGoalResponse('{"goal":'), null);
    assert.equal(parsePlanResponse('{"steps":"not an array"}'), null);
});

test('a project proposal parses, and salvages a partial one', () => {
    const good = parseProjectResponse('{"intent":"A watchtower on the ridge, so travellers can see the way home",'
        + '"milestones":["quarry 64 stone","raise the base","build the beacon room"],'
        + '"materials":{"stone":64,"torch":8}}');
    assert.equal(good.milestones.length, 3);
    assert.deepEqual(good.materials, { stone: 64, torch: 8 });
    assert.match(good.intent, /watchtower/);

    // materials missing entirely is still worth keeping
    const partial = parseProjectResponse('{"intent":"a bridge","milestones":["gather wood"]}');
    assert.deepEqual(partial.materials, {});
    assert.equal(partial.milestones.length, 1);

    // junk counts are dropped rather than poisoning the ledger
    const messy = parseProjectResponse('{"intent":"x","milestones":["a"],"materials":{"stone":"lots","wood":-4,"clay":12}}');
    assert.deepEqual(messy.materials, { clay: 12 });
});

test('a proposal with no usable milestones is rejected', () => {
    assert.equal(parseProjectResponse('{"intent":"a castle","milestones":[]}'), null);
    assert.equal(parseProjectResponse('{"intent":"","milestones":["a"]}'), null);
    assert.equal(parseProjectResponse('not json at all'), null);
});
