import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../../src/agent/cognition/blackboard.js';

test('interruptions are consumed exactly once', () => {
    const bb = new Blackboard();
    assert.equal(bb.takeInterruption(), null);
    bb.noteInterruption('self_defense', 'action:collectBlocks');
    assert.equal(bb.hasUnhandledInterruption(), true);
    const intr = bb.takeInterruption();
    assert.equal(intr.by, 'self_defense');
    assert.equal(intr.interrupted, 'action:collectBlocks');
    assert.equal(bb.takeInterruption(), null); // consumed
    assert.equal(bb.hasUnhandledInterruption(), false);
});

test('a newer interruption replaces an unhandled older one', () => {
    const bb = new Blackboard();
    bb.noteInterruption('self_defense', 'action:collectBlocks');
    bb.noteInterruption('unstuck', 'action:goToCoordinates');
    const intr = bb.takeInterruption();
    assert.equal(intr.by, 'unstuck');
    assert.equal(bb.takeInterruption(), null);
});

test('snapshot is a deep-enough copy for the dashboard', () => {
    const bb = new Blackboard();
    bb.percepts = { safety: 0.9 };
    bb.drives = [{ name: 'curiosity', urgency: 0.4 }];
    bb.goal = { drive: 'wealth', goal: 'get iron', step_index: 1, steps_total: 3, step: 'mine' };
    bb.social.partner = 'Wilbur';
    bb.tier_status.plan = { runs: 5, errors: 0, busy: false, last_run: 1 };

    const snap = bb.snapshot();
    snap.percepts.safety = 0;
    snap.drives[0].urgency = 0;
    snap.goal.goal = 'tampered';
    snap.social.partner = 'nobody';
    snap.tiers.plan.runs = 999;

    assert.equal(bb.percepts.safety, 0.9);
    assert.equal(bb.drives[0].urgency, 0.4);
    assert.equal(bb.goal.goal, 'get iron');
    assert.equal(bb.social.partner, 'Wilbur');
    assert.equal(bb.tier_status.plan.runs, 5);
    assert.ok(JSON.stringify(snap)); // JSON-safe
});
