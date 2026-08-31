import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveState, DEFAULT_DRIVES } from '../../src/agent/cognition/drives.js';

test('decay drives decay over time, sensor drives do not', () => {
    const ds = new DriveState({ boredom: { type: 'decay', decay_per_min: 0.06, initial_level: 1.0 } });
    assert.equal(ds.drives.boredom.level, 1.0);
    ds.update(60000, {}); // one minute
    assert.ok(Math.abs(ds.drives.boredom.level - 0.94) < 1e-9);
    assert.equal(ds.drives.safety.level, 1.0); // sensor drive untouched without a reading
});

test('default initial levels: agents spawn curious, not sated', () => {
    const ds = new DriveState();
    assert.equal(ds.drives.curiosity.level, DEFAULT_DRIVES.curiosity.initial_level);
    assert.equal(ds.drives.social.level, DEFAULT_DRIVES.social.initial_level);
    assert.equal(ds.drives.safety.level, 1.0);
    // curiosity is immediately eligible at default min_urgency 0.25
    assert.ok(ds.urgency('curiosity') >= 0.25);
});

test('sensor levels override directly and are clamped', () => {
    const ds = new DriveState();
    ds.update(300, { safety: 0.2 });
    assert.equal(ds.drives.safety.level, 0.2);
    ds.update(300, { safety: 5 });
    assert.equal(ds.drives.safety.level, 1);
    ds.update(300, { safety: -1 });
    assert.equal(ds.drives.safety.level, 0);
});

test('satisfy and deplete clamp to [0,1]', () => {
    const ds = new DriveState();
    ds.satisfy('social', 0.5);
    assert.equal(ds.drives.social.level, 1); // clamped up
    ds.deplete('social', 0.3);
    assert.ok(Math.abs(ds.drives.social.level - 0.7) < 1e-9);
    ds.deplete('social', 5);
    assert.equal(ds.drives.social.level, 0);
    ds.satisfy('nonexistent', 1); // no throw
});

test('urgency is weight * (1 - level)', () => {
    const ds = new DriveState({ safety: { weight: 1.0 } });
    ds.update(300, { safety: 0.25 });
    assert.ok(Math.abs(ds.urgency('safety') - 0.75) < 1e-9);
    assert.equal(ds.urgency('nonexistent'), 0);
});

test('profile config overrides weights and adds custom drives', () => {
    const ds = new DriveState({
        curiosity: { weight: 0.9, decay_per_min: 0.5 },
        mischief: { weight: 0.7, decay_per_min: 0.1, description: 'cause trouble' },
    });
    assert.equal(ds.drives.curiosity.weight, 0.9);
    assert.ok(ds.exists('mischief'));
    assert.equal(ds.drives.mischief.type, 'decay');
    ds.update(60000, {});
    assert.ok(Math.abs(ds.drives.mischief.level - 0.9) < 1e-9);
});

test('getUrgencies sorts descending and flags cooldowns', () => {
    const ds = new DriveState();
    const now = 1000000;
    ds.update(300, { safety: 0.1, food: 0.9, wealth: 0.9 });
    ds.setCooldown('safety', now + 5000);
    const urg = ds.getUrgencies(now);
    assert.equal(urg[0].name, 'safety'); // still highest urgency
    assert.equal(urg[0].on_cooldown, true);
    for (let i = 1; i < urg.length; i++)
        assert.ok(urg[i - 1].urgency >= urg[i].urgency);
});

test('getJson/loadJson round-trips levels and cooldowns', () => {
    const ds = new DriveState();
    ds.update(0, { safety: 0.3 }); // zero elapsed time: sensor applies, no decay
    ds.deplete('curiosity', 0.4); // from initial 0.5 -> 0.1
    ds.setCooldown('wealth', 12345);
    const json = ds.getJson();

    const ds2 = new DriveState();
    ds2.loadJson(json);
    assert.equal(ds2.drives.safety.level, 0.3);
    assert.ok(Math.abs(ds2.drives.curiosity.level - 0.1) < 1e-9);
    assert.equal(ds2.drives.wealth.cooldown_until, 12345);
    ds2.loadJson(null); // no throw
    ds2.loadJson({ unknown_drive: { level: 0.5 } }); // ignored, no throw
});
