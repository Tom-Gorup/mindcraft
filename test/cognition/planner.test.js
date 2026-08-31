import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoalResponse, parsePlanResponse, formatPlan } from '../../src/agent/cognition/planner.js';

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
