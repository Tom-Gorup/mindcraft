import test from 'node:test';
import assert from 'node:assert/strict';
import { TierScheduler } from '../../src/agent/cognition/scheduler.js';
import { Blackboard } from '../../src/agent/cognition/blackboard.js';

function settle() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

test('tiers fire at their own cadences', async () => {
    const sched = new TierScheduler();
    const counts = { fast: 0, slow: 0 };
    sched.addTier('fast', 300, () => { counts.fast++; });
    sched.addTier('slow', 1000, () => { counts.slow++; });
    for (let i = 0; i < 12; i++) sched.tick(300); // 3.6s of ticks
    await settle();
    assert.equal(counts.fast, 12);
    assert.equal(counts.slow, 3); // fires when 1000ms accumulates: ticks 4, 8, 12
});

test('cadence 0 fires every tick (reflex tier)', async () => {
    const sched = new TierScheduler();
    let n = 0;
    sched.addTier('reflex', 0, () => { n++; });
    for (let i = 0; i < 5; i++) sched.tick(300);
    await settle();
    assert.equal(n, 5);
});

test('a busy tier is skipped, not queued, and fires after completion', async () => {
    const sched = new TierScheduler();
    let running = 0, max_concurrent = 0, runs = 0;
    let release;
    const gate = new Promise(r => { release = r; });
    sched.addTier('slowwork', 300, async () => {
        running++; runs++;
        max_concurrent = Math.max(max_concurrent, running);
        await gate;
        running--;
    });
    sched.tick(300); // starts run 1
    sched.tick(300); // skipped — still busy
    sched.tick(300); // skipped
    assert.equal(runs, 1);
    release();
    await settle();
    sched.tick(300); // fires again now that it's free
    assert.equal(runs, 2);
    assert.equal(max_concurrent, 1); // never overlapped itself
});

test('slow tiers never block fast tiers', async () => {
    const sched = new TierScheduler();
    let fast_runs = 0;
    let release;
    sched.addTier('plan', 300, () => new Promise(r => { release = r; })); // hangs
    sched.addTier('reflex', 0, () => { fast_runs++; });
    for (let i = 0; i < 5; i++) sched.tick(300);
    assert.equal(fast_runs, 5); // reflexes kept firing while plan hung
    release();
    await settle();
});

test('errors are isolated: sync and async throws never break siblings', async () => {
    const sched = new TierScheduler(new Blackboard());
    let healthy_runs = 0;
    sched.addTier('sync_thrower', 300, () => { throw new Error('sync boom'); });
    sched.addTier('async_thrower', 300, () => Promise.reject(new Error('async boom')));
    sched.addTier('healthy', 300, () => { healthy_runs++; });
    for (let i = 0; i < 3; i++) {
        sched.tick(300);
        await settle(); // let async rejections settle so the tier isn't busy-skipped
    }
    assert.equal(healthy_runs, 3);
    assert.equal(sched.getTier('sync_thrower').errors, 3);
    assert.equal(sched.getTier('async_thrower').errors, 3);
    assert.equal(sched.getTier('sync_thrower').busy, false); // busy always released
    assert.equal(sched.getTier('async_thrower').busy, false);
});

test('tier status is published to the blackboard', async () => {
    const bb = new Blackboard();
    const sched = new TierScheduler(bb);
    sched.addTier('plan', 300, () => {});
    sched.tick(300);
    await settle();
    assert.equal(bb.tier_status.plan.runs, 1);
    assert.equal(bb.tier_status.plan.errors, 0);
    assert.equal(bb.tier_status.plan.cadence_ms, 300);
});

test('elapsed time is passed to the tier', async () => {
    const sched = new TierScheduler();
    const elapsed_seen = [];
    sched.addTier('plan', 1000, (elapsed) => { elapsed_seen.push(elapsed); });
    sched.tick(300); sched.tick(300); sched.tick(300); sched.tick(300); // fires at 1200
    await settle();
    assert.deepEqual(elapsed_seen, [1200]); // accumulated delta, not cadence
});
