// Phase 10 — knowledge, as distinct from beliefs.
//
// Twelve hours produced 525 beliefs, many near-duplicates of "nighttime is
// dangerous", and none of them changed what the agent did. The two failures
// this file guards against are the ones that produced that: near-duplicates
// accumulating instead of consolidating, and a conclusion that cannot become a
// constraint.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Knowledge, factKey } from '../../src/agent/knowledge/index.js';
import { factFromFailure, factFromSuccess } from '../../src/agent/knowledge/learn.js';

// ---- consolidation ---------------------------------------------------------

test('repeat observations raise confidence instead of adding rows', () => {
    const k = new Knowledge();
    for (let i = 0; i < 6; i++)
        k.observe('avoid', 'unreachable_by_path', 'Pathing fails in this terrain.', { now: i });

    assert.equal(k.size, 1, 'twelve versions of one thing is how the belief stream failed');
    const f = k.get('avoid', 'unreachable_by_path');
    assert.equal(f.support, 6);
    assert.ok(f.confidence > 0.8, `corroboration must build certainty, got ${f.confidence}`);
});

test('one observation is not a rule', () => {
    const k = new Knowledge();
    k.observe('requires', 'stone_pickaxe', 'Mining iron needs a stone pickaxe.', { now: 1 });
    assert.deepEqual(k.constraints(), [], 'a single sighting must not constrain a plan');
    assert.ok(k.get('requires', 'stone_pickaxe').confidence < 0.7);
});

// Without this an agent accumulates permanent superstitions: something that
// failed twice early is avoided forever even after it starts working.
test('contradiction lowers confidence and can retire a constraint', () => {
    const k = new Knowledge();
    for (let i = 0; i < 8; i++) k.observe('avoid', 'reaching_greta', 'Greta is unreachable.', { now: i });
    assert.equal(k.constraints().length, 1, 'established');

    for (let i = 0; i < 5; i++)
        k.observe('avoid', 'reaching_greta', 'Greta is unreachable.', { supports: false, now: i });
    assert.deepEqual(k.constraints(), [], 'disproved beliefs must be abandonable');
});

test('the subject is the identity, so case and spacing do not fork a fact', () => {
    assert.equal(factKey('avoid', 'Unreachable_By_Path'), factKey('avoid', 'unreachable_by_path'));
    const k = new Knowledge();
    k.observe('avoid', 'Path', 'x', { now: 1 });
    k.observe('avoid', 'path', 'x', { now: 2 });
    assert.equal(k.size, 1);
});

// ---- what reaches a prompt -------------------------------------------------

test('only confident claims reach a prompt, and the list is bounded', () => {
    const k = new Knowledge();
    for (let i = 0; i < 30; i++)
        for (let n = 0; n < 8; n++)
            k.observe('note', `fact_${i}`, `Claim number ${i}.`, { now: n });

    const text = k.describe(8);
    assert.ok(text.split('\n').length <= 9, 'a long-running agent must not drown its own context');
    assert.ok(k.constraints().length <= 6);
});

test('an empty store contributes nothing rather than an empty heading', () => {
    assert.equal(new Knowledge().describe(), '');
    assert.deepEqual(new Knowledge().constraints(), []);
});

test('knowledge survives a restart', () => {
    const a = new Knowledge();
    for (let i = 0; i < 6; i++) a.observe('avoid', 'deep_caves', 'Do not go below y=30 alone.', { now: i });
    const b = new Knowledge(JSON.parse(JSON.stringify(a.toJSON())));
    assert.equal(b.size, 1);
    assert.equal(b.constraints().length, 1, 'knowledge that does not survive a restart is not knowledge');
});

test('the store is bounded, dropping the least certain first', () => {
    const k = new Knowledge({}, { max_facts: 10 });
    // Timestamps advance the way Date.now() does, so recency is not inverted.
    let t = 0;
    for (let i = 0; i < 40; i++) k.observe('note', `weak_${i}`, 'weak', { now: t++ });
    for (let n = 0; n < 8; n++) k.observe('avoid', 'strong', 'strong claim', { now: t++ });
    assert.ok(k.size <= 10);
    assert.ok(k.get('avoid', 'strong'), 'the well-supported fact must survive the cull');
});

// ---- learning from real failure text ---------------------------------------

test('the failure strings these agents actually produce become facts', () => {
    const path = factFromFailure('Path not found, but attempting to navigate anyway');
    assert.equal(path.kind, 'avoid');

    const missing = factFromFailure('missing crafting table', { action: 'Craft a wooden pickaxe' });
    assert.equal(missing.kind, 'requires');
    assert.match(missing.subject, /crafting_table/);

    // "Greta not found" occurred 41 times in twelve hours and changed nothing
    const peer = factFromFailure('Greta not found');
    assert.equal(peer.kind, 'avoid');
    assert.match(peer.claim, /meeting point|drop items/i);
});

// A constraint drawn from a misreading is worse than no constraint, so silence
// is the correct and common answer.
test('unrecognised failures produce nothing rather than a guess', () => {
    for (const junk of ['something entirely unparseable happened', '', null, 'x', '???'])
        assert.equal(factFromFailure(junk), null, `must not invent a rule from: ${junk}`);
});

test('success is evidence too, so superstitions can be unlearned', () => {
    const f = factFromSuccess('collectBlocks');
    assert.equal(f.kind, 'note');
    assert.match(f.subject, /^works_/);
    assert.equal(factFromSuccess(''), null);
});
