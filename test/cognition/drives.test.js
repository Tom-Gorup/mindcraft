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

// An aspiration must be able to win eventually. Without a neglect term a
// slow-decaying drive sitting at 0.3 is starved forever by hunger and safety
// churning between 0.4 and 0.9 — which is the difference between "a need I
// have" and "a thing I keep meaning to do".
test('a neglected aspiration earns urgency; a need does not', () => {
    const d = new DriveState({}, { neglect_bonus_max: 0.45, neglect_full_ms: 60000 });
    const rawLegacy = d.urgency('legacy');
    const rawFood = d.urgency('food');

    d.noteAttention(60000, 'food');   // a full period of being passed over

    assert.ok(d.effectiveUrgency('legacy') > rawLegacy, 'the aspiration gained a claim');
    assert.ok(Math.abs(d.effectiveUrgency('legacy') - (rawLegacy + 0.45)) < 1e-6);
    assert.equal(d.effectiveUrgency('food'), rawFood, 'a need accrues nothing from being ignored');
});

test('acting on an aspiration clears its accumulated claim', () => {
    const d = new DriveState({}, { neglect_bonus_max: 0.45, neglect_full_ms: 60000 });
    d.noteAttention(60000, 'food');
    assert.ok(d.effectiveUrgency('legacy') > d.urgency('legacy'));
    d.noteAttention(1000, 'legacy');
    assert.equal(d.effectiveUrgency('legacy'), d.urgency('legacy'), 'claim reset once addressed');
});

test('legacy decays slowly enough to be an ambition rather than a need', () => {
    const d = new DriveState();
    const legacy = d.drives.legacy;
    const food = d.drives.food;
    assert.ok(legacy.aspiration, 'legacy is flagged as an aspiration');
    assert.ok(legacy.decay_per_min < 0.005, 'presses over hours, not minutes');
    assert.ok(!food.aspiration, 'a need is not an aspiration');
});

test('getUrgencies exposes both raw and effective, so the dashboard can explain itself', () => {
    const d = new DriveState({}, { neglect_bonus_max: 0.4, neglect_full_ms: 60000 });
    d.noteAttention(60000, 'food');
    const legacy = d.getUrgencies().find(u => u.name === 'legacy');
    assert.ok(legacy.aspiration);
    assert.ok(legacy.urgency > legacy.raw_urgency, 'effective is boosted');
    assert.equal(legacy.neglect_ms, 60000);
});

// ---- the overnight-run failures, as tests ----
//
// Run of 2026-08-31: 36 deaths in 9.3h, zero food goals generated, safety
// completed 0 of 10 goals. Both regressions below are that run.

// safety's level is health/20, and respawn restores health to 20/20 — so the
// sensor reported perfect safety moments after each death and urgency fell to
// zero. The agent then went straight back to its watchtower. 36 times.
test('dying keeps safety urgent even though respawn restores full health', () => {
    const d = new DriveState({}, { neglect_bonus_max: 0 });

    d.update(1000, { safety: 1.0 });
    assert.equal(d.urgency('safety'), 0, 'full health at rest is not urgent');

    d.raiseAlarm('safety', 0.9);
    d.update(1000, { safety: 1.0 });   // respawn: sensor still says 20/20
    assert.ok(d.urgency('safety') > 0.85,
        `death must survive the respawn, got ${d.urgency('safety')}`);
});

test('an alarm fades rather than switching off', () => {
    const d = new DriveState({}, { alarm_half_life_ms: 60000 });
    d.raiseAlarm('safety', 0.8);
    d.update(60000, { safety: 1.0 });
    const half = d.urgency('safety');
    assert.ok(half > 0.3 && half < 0.55, `one half-life should roughly halve it, got ${half}`);

    for (let i = 0; i < 8; i++) d.update(60000, { safety: 1.0 });
    assert.ok(d.urgency('safety') < 0.05, 'and eventually clear entirely');
});

test('an alarm survives a restart', () => {
    const a = new DriveState();
    a.raiseAlarm('safety', 0.9);
    const b = new DriveState();
    b.loadJson(a.getJson());
    b.update(1000, { safety: 1.0 });
    assert.ok(b.urgency('safety') > 0.85, 'a crash-restart must not forget the death');
});

// Greta, at 1 HP and zero hunger, kept choosing her watchtower. She wrote the
// finding herself: "Don't abandon urgent needs for legacy goals when starving."
test('a neglected aspiration yields while a real need is pressing', () => {
    const d = new DriveState({ legacy: { weight: 0.9 } });
    d.noteAttention(60 * 60000, 'wealth');   // an hour of neglect: full claim

    d.update(1000, { safety: 1.0, food: 1.0, wealth: 1.0 });
    const calm = d.effectiveUrgency('legacy');
    assert.ok(calm > d.urgency('legacy'), 'when all is well, neglect still earns its claim');

    // 0.4 is what sensors.js reports with a hostile within 16 blocks.
    d.update(1000, { safety: 0.4, food: 1.0, wealth: 1.0 });
    assert.equal(d.effectiveUrgency('legacy'), d.urgency('legacy'),
        'but a pressing need suspends the claim entirely');
    assert.ok(d.effectiveUrgency('safety') > d.effectiveUrgency('legacy'),
        'so safety outranks ambition with a hostile nearby — the run had this backwards');
});

// Where the gate sits is a design decision, not an accident, so it is pinned.
// These are the actual outputs of sensors.js, and the boundary is deliberate:
// half health with nothing attacking you is a fine time to build.
test('the needs gate fires on real danger, not on any imperfection', () => {
    const d = new DriveState();
    const gated = (levels) => {
        d.update(1000, { safety: 1, food: 1, wealth: 1, ...levels });
        return d.needsArePressing();
    };
    assert.equal(gated({ safety: 0.3 }), true, 'damaged in the last 10s');
    assert.equal(gated({ safety: 0.4 }), true, 'hostile within 16 blocks');
    assert.equal(gated({ safety: 0.05 }), true, 'at 1 HP, as Greta was');
    assert.equal(gated({ food: 0.34 }), true, 'hunger at 9/20');
    assert.equal(gated({ safety: 0.5 }), false, 'half health, nothing attacking');
    assert.equal(gated({ wealth: 0 }), false, 'owning nothing is not an emergency');
});

test('one aspiration cannot suppress another', () => {
    const d = new DriveState({ legacy: { weight: 0.9 }, glory: { weight: 0.9, aspiration: true, initial_level: 0 } });
    d.noteAttention(60 * 60000, 'wealth');
    d.update(1000, { safety: 1.0, food: 1.0, wealth: 1.0 });
    assert.ok(d.effectiveUrgency('legacy') > d.urgency('legacy'),
        'an urgent aspiration is not a "need" and must not gate other aspirations');
});

// An aspiration only satisfied by whole-goal completion decays to zero and sits
// at maximum urgency forever. A drive pinned at its ceiling carries no
// information — it wins every arbitration regardless of context.
test('project progress relieves an aspiration short of finishing it', () => {
    const d = new DriveState({ legacy: { weight: 0.7 } });
    d.update(60 * 60000 * 12, {});           // twelve hours: fully decayed
    assert.ok(d.urgency('legacy') > 0.65, 'pinned near its ceiling');
    assert.ok(d.urgency('legacy') >= d.urgency('safety'),
        'and outranking safety, which is the problem');

    d.satisfy('legacy', 0.25);               // one milestone's worth of progress
    assert.ok(d.urgency('legacy') < 0.55, `progress must ease it, got ${d.urgency('legacy')}`);
});
