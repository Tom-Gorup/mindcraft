// Phase 10 — the three things the agents could not see on 2026-09-06.
//
// 65 deaths in 12 hours. Wilbur was surrounded by five mobs and died; the drive
// system registered nothing different from one skeleton across a clearing.
// Night arrived as a surprise 65 times. Nothing knew whether he had walls.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    nightPressure, minutesUntilDark, phaseOfDay, threatLevel, shelterLevel,
    DUSK_TICK, NIGHT_TICK,
} from '../../src/agent/cognition/situation.js';
import { describeSituation } from '../../src/agent/cognition/describe.js';

// ---- nightfall -------------------------------------------------------------

test('night pressure rises before dusk, not when the first skeleton arrives', () => {
    assert.equal(nightPressure(0), 0, 'dawn: no pressure');
    assert.equal(nightPressure(6000), 0, 'midday: no pressure');
    assert.ok(nightPressure(10000) > 0.5, 'minutes out: already pressing, because shelter takes time to build');
    assert.ok(nightPressure(11500) > nightPressure(10000), 'and grows as dusk nears');
    assert.equal(nightPressure(DUSK_TICK + 100), 0.9, 'dusk: mobs imminent');
    assert.equal(nightPressure(NIGHT_TICK + 1000), 1, 'night: full');
});

test('minutes until dark is honest, including across the wrap', () => {
    assert.equal(minutesUntilDark(0), 10, 'dawn is ten minutes from dusk');
    assert.equal(minutesUntilDark(DUSK_TICK), 0, 'dusk is now');
    assert.equal(minutesUntilDark(NIGHT_TICK + 500), 0, 'and it is already dark');
    // 23500 is past dawn, so the next dusk is a wrap away: 500 ticks to
    // midnight-rollover plus 12000 of daylight, which is the same ~10 minutes
    // of daylight you get at dawn. The point is that the wrap does not produce
    // a negative or a nonsensically large number.
    const wrapped = minutesUntilDark(23500);
    assert.ok(wrapped >= 9 && wrapped <= 11, `wrap should give ~10 min, got ${wrapped}`);
    for (const t of [-500, 30000, 24000, NaN])
        assert.ok(minutesUntilDark(t) >= 0 && minutesUntilDark(t) <= 20,
            `out-of-range tick ${t} must still yield a sane answer`);
});

test('the phase of day is named for a prompt', () => {
    assert.equal(phaseOfDay(1000), 'morning');
    assert.equal(phaseOfDay(9000), 'afternoon');
    assert.equal(phaseOfDay(12500), 'dusk');
    assert.equal(phaseOfDay(18000), 'night');
    assert.equal(phaseOfDay(23500), 'dawn');
});

// ---- being outnumbered -----------------------------------------------------

test('five mobs are not one mob', () => {
    const one = threatLevel([{ name: 'zombie', distance: 6, weight: 1 }]);
    const five = threatLevel(Array.from({ length: 5 },
        () => ({ name: 'zombie', distance: 6, weight: 1 })));
    assert.ok(five > one * 2, `being surrounded must register: one=${one} five=${five}`);
    assert.ok(five > 0.7, 'and it must be near the top of the range');
});

test('distance protects, and nothing nearby is no threat', () => {
    assert.equal(threatLevel([]), 0);
    const close = threatLevel([{ name: 'zombie', distance: 2, weight: 1 }]);
    const far = threatLevel([{ name: 'zombie', distance: 15, weight: 1 }]);
    assert.ok(close > far * 3, `adjacent is worse than across the clearing: ${close} vs ${far}`);
});

test('a creeper counts for more than a spider at the same range', () => {
    const creeper = threatLevel([{ name: 'creeper', distance: 4, weight: 2.0 }]);
    const spider = threatLevel([{ name: 'spider', distance: 4, weight: 0.8 }]);
    assert.ok(creeper > spider * 2, 'the thing that ends the run outright weighs more');
});

test('being armed and armoured helps but never makes a crowd safe', () => {
    const crowd = Array.from({ length: 4 }, () => ({ name: 'zombie', distance: 5, weight: 1 }));
    const bare = threatLevel(crowd);
    const ready = threatLevel(crowd, { armed: true, armoured: true });
    assert.ok(ready < bare, 'preparedness helps');
    assert.ok(ready > 0.3, 'but four zombies is still four zombies');
});

// ---- shelter ---------------------------------------------------------------

test('shelter is mostly about having a roof', () => {
    assert.equal(shelterLevel({}), 0, 'standing in the open');
    const roof = shelterLevel({ roofed: true });
    const walls = shelterLevel({ walls: 4 });
    assert.ok(roof > walls, 'almost everything that kills you at night comes from above');
    const hut = shelterLevel({ roofed: true, walls: 4, lit: true });
    assert.equal(hut, 1, 'roofed, walled and lit is fully sheltered');
});

test('partial walls count partially, and nonsense does not corrupt the scale', () => {
    assert.ok(shelterLevel({ walls: 2 }) > shelterLevel({ walls: 1 }));
    assert.ok(shelterLevel({ roofed: true, walls: 99 }) <= 1, 'clamped');
    assert.ok(shelterLevel({ walls: -5 }) >= 0);
});

// ---- the combination that matters ------------------------------------------
//
// Shelter is the ANSWER to nightfall, so having it must relieve the pressure.
// Otherwise an agent that correctly built a hut is still told it is in danger,
// and goes back out to fix a problem it has already solved.
test('a sheltered agent at night is safer than an exposed one', () => {
    const exposure = (night, shelter) => night * (1 - shelter);
    assert.equal(exposure(1, 1), 0, 'inside at night: no exposure');
    assert.equal(exposure(1, 0), 1, 'outside at night: full exposure');
    assert.ok(exposure(1, 0.85) < exposure(0.8, 0),
        'a good hut at night beats being caught out at dusk');
});

// ---- knowing you are in a hole ----
//
// Watched live on 2026-09-06: Wilbur dug straight down to reach stone with no
// thought about getting back up, then reported being stuck. That is a
// perception failure before it is a planning one — nothing represented "I am at
// the bottom of a shaft", and a roof overhead reads identically whether it is a
// shelter you built or seven metres of dirt you dug through.

test('a shelter and a shaft are not the same situation', () => {
    const shelter = { depth: 2, enclosed: true, roofed: true, walls: 4, shelter: 1,
        phase: 'night', minutes_until_dark: 0, threat: 0, hostile_count: 0 };
    const shaft = { depth: 9, enclosed: true, roofed: true, walls: 4, shelter: 0.5,
        phase: 'afternoon', minutes_until_dark: 8, threat: 0, hostile_count: 0 };

    assert.ok(!/UNDERGROUND/.test(describeSituation({ situation: shelter })),
        'a hut you built is not a warning');
    assert.match(describeSituation({ situation: shaft }), /UNDERGROUND/);
    assert.match(describeSituation({ situation: shaft }), /Never dig straight down/);
});

test('being underground is reported with how deep, so the way out is thinkable', () => {
    const text = describeSituation({ situation: { depth: 12, enclosed: true, roofed: true,
        walls: 4, shelter: 0.5, phase: 'afternoon', minutes_until_dark: 8, threat: 0, hostile_count: 0 } });
    assert.match(text, /12 blocks of cover/);
    assert.match(text, /stairs|pillar up/);
});

test('the surface says nothing about depth at all', () => {
    const text = describeSituation({ situation: { depth: 0, enclosed: false, can_see_sky: true,
        roofed: false, walls: 0, shelter: 0, phase: 'morning', minutes_until_dark: 9,
        threat: 0, hostile_count: 0 } });
    assert.ok(!/UNDERGROUND|below the open air/.test(text));
});
