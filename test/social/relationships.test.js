import test from 'node:test';
import assert from 'node:assert/strict';
import {
    newRelationship, applyInteraction, decay, disposition, describeRelationship,
    BASELINE, DEFAULT_PERSONALITY,
} from '../../src/agent/social/relationships.js';

const HOUR = 3600000;

test('new relationships start neutral', () => {
    const rel = newRelationship('Wilbur');
    assert.equal(rel.trust, BASELINE.trust);
    assert.equal(rel.affinity, 0);
    assert.equal(rel.grudge, 0);
    assert.equal(disposition(rel), 0);
});

test('help raises and harm lowers disposition', () => {
    const friend = applyInteraction(newRelationship('A'), 'helped');
    const foe = applyInteraction(newRelationship('B'), 'attacked_by');
    assert.ok(disposition(friend) > 0.1);
    assert.ok(disposition(foe) < -0.3);
});

test('trust is lost faster than it is gained', () => {
    const rel = newRelationship('C');
    for (let i = 0; i < 3; i++) applyInteraction(rel, 'gave_item');
    const gained = rel.trust - BASELINE.trust;
    const rel2 = newRelationship('D');
    applyInteraction(rel2, 'attacked_by');
    const lost = BASELINE.trust - rel2.trust;
    assert.ok(lost > gained, 'a single attack should outweigh three gifts');
});

test('values stay clamped under repetition', () => {
    const rel = newRelationship('E');
    for (let i = 0; i < 100; i++) applyInteraction(rel, 'killed_by');
    assert.equal(rel.trust, 0);
    assert.equal(rel.affinity, -1);
    assert.equal(rel.grudge, 1);
    for (let i = 0; i < 200; i++) applyInteraction(rel, 'helped');
    assert.equal(rel.trust, 1);
    assert.equal(rel.affinity, 1);
    assert.equal(rel.grudge, 0);
});

test('personality scales the same event differently', () => {
    const trusting = applyInteraction(newRelationship('F'), 'attacked_by', { trust_loss: 0.3 });
    const paranoid = applyInteraction(newRelationship('F'), 'attacked_by', { trust_loss: 2.0 });
    assert.ok(trusting.trust > paranoid.trust);

    const warm = applyInteraction(newRelationship('G'), 'helped', { warmth: 2 });
    const cold = applyInteraction(newRelationship('G'), 'helped', { warmth: 0.2 });
    assert.ok(warm.affinity > cold.affinity);
});

test('gossip weight damps the effect', () => {
    const firsthand = applyInteraction(newRelationship('H'), 'insulted');
    const hearsay = applyInteraction(newRelationship('H'), 'insulted', DEFAULT_PERSONALITY, { weight: 0.3 });
    assert.ok(hearsay.affinity > firsthand.affinity);
    assert.ok(hearsay.grudge < firsthand.grudge);
});

test('grudges decay and forgiveness sets the pace', () => {
    const slow = applyInteraction(newRelationship('I'), 'killed_by', { forgiveness: 0.2 });
    const fast = applyInteraction(newRelationship('J'), 'killed_by', { forgiveness: 3 });
    const before = slow.grudge;
    decay(slow, 4 * HOUR, { forgiveness: 0.2 });
    decay(fast, 4 * HOUR, { forgiveness: 3 });
    assert.ok(slow.grudge < before);
    assert.ok(fast.grudge < slow.grudge, 'forgiving personalities let go sooner');
});

test('trust drifts back toward baseline but never overshoots', () => {
    const rel = newRelationship('K');
    rel.trust = 1.0;
    decay(rel, 1000 * HOUR, DEFAULT_PERSONALITY);
    assert.ok(Math.abs(rel.trust - BASELINE.trust) < 1e-9, 'drift must stop at baseline');
    const rel2 = newRelationship('L');
    rel2.trust = 0;
    decay(rel2, 1000 * HOUR, DEFAULT_PERSONALITY);
    assert.ok(Math.abs(rel2.trust - BASELINE.trust) < 1e-9);
});

test('zero elapsed time changes nothing', () => {
    const rel = applyInteraction(newRelationship('M'), 'attacked_by');
    const snapshot = { ...rel };
    decay(rel, 0);
    assert.deepEqual({ ...rel }, snapshot);
});

test('descriptions track disposition and surface notes', () => {
    const friend = newRelationship('Wilbur');
    for (let i = 0; i < 5; i++) applyInteraction(friend, 'helped');
    assert.match(describeRelationship(friend), /friend/);

    const foe = applyInteraction(newRelationship('Steve'), 'killed_by');
    assert.match(describeRelationship(foe), /enemy|distrust/);

    foe.notes.push('Andy told me about Steve: he stole from the chest');
    assert.match(describeRelationship(foe), /stole from the chest/);
});
