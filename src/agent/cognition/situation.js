// Phase 10 — what the agent can see about its predicament, in numbers.
//
// The overnight run of 2026-09-06 killed two agents 65 times in 12 hours. The
// three things the operator watched them fail at were all invisible to the
// system, not merely mishandled:
//
//   · being outnumbered. `safety` capped to 0.4 for ANY hostile within 16
//     blocks, so one zombie and five produced an identical number. Wilbur was
//     surrounded by five mobs and died without the drive system registering
//     anything different from a single skeleton across a clearing.
//   · nightfall. bot.time.timeOfDay has always been there and sensors.js had no
//     time input at all, so night arrived as a surprise 65 times.
//   · shelter. Nothing knew whether the agent had walls, a roof, or light.
//
// Pure-ish: reads the bot, returns numbers. No decisions here — drives.js and
// the prompt decide what to do about them. Split from sensors.js so the
// arithmetic can be unit-tested without a bot.

import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';

// A Minecraft day is 24000 ticks / 20 minutes. Dusk begins at 12000 and mobs
// spawn from about 13000; dawn is 23000.
export const DAY_TICKS = 24000;
export const DUSK_TICK = 12000;
export const NIGHT_TICK = 13000;
export const DAWN_TICK = 23000;
const TICKS_PER_MINUTE = DAY_TICKS / 20;

// ---- pure arithmetic, testable without a bot -------------------------------

// How dark it is about to get, in [0,1]. Rises BEFORE dusk so an agent can act
// on it while there is still time to build something.
export function nightPressure(timeOfDay, lead_ticks = 3000) {
    const t = ((Number(timeOfDay) || 0) % DAY_TICKS + DAY_TICKS) % DAY_TICKS;
    if (t >= NIGHT_TICK && t < DAWN_TICK) return 1;          // it is night now
    if (t >= DUSK_TICK && t < NIGHT_TICK) return 0.8;        // dusk: mobs imminent
    const until = DUSK_TICK - t;
    if (until > 0 && until <= lead_ticks) return 0.3 + 0.5 * (1 - until / lead_ticks);
    return 0;                                                 // broad daylight
}

export function minutesUntilDark(timeOfDay) {
    const t = ((Number(timeOfDay) || 0) % DAY_TICKS + DAY_TICKS) % DAY_TICKS;
    if (t >= DUSK_TICK && t < DAWN_TICK) return 0;
    const until = t < DUSK_TICK ? DUSK_TICK - t : (DAY_TICKS - t) + DUSK_TICK;
    return Math.round(until / TICKS_PER_MINUTE);
}

export function phaseOfDay(timeOfDay) {
    const t = ((Number(timeOfDay) || 0) % DAY_TICKS + DAY_TICKS) % DAY_TICKS;
    if (t < 6000) return 'morning';
    if (t < DUSK_TICK) return 'afternoon';
    if (t < NIGHT_TICK) return 'dusk';
    if (t < DAWN_TICK) return 'night';
    return 'dawn';
}

// Danger from what is actually around you, in [0,1].
//
// Being outnumbered has to be representable: five zombies at 6 blocks is not
// the same predicament as one skeleton at 15, and the old boolean said it was.
// Closer counts for more, and numbers compound.
export function threatLevel(hostiles, { armed = false, armoured = false } = {}) {
    if (!hostiles?.length) return 0;
    let pressure = 0;
    for (const h of hostiles) {
        const d = Math.max(1, Number(h.distance) || 16);
        const near = Math.max(0, 1 - d / 16);        // 1 adjacent, 0 at 16 blocks
        pressure += near * (h.weight ?? 1);
    }
    // Preparedness reduces how bad a given crowd is, but never to nothing.
    const readiness = 1 - (armed ? 0.2 : 0) - (armoured ? 0.2 : 0);
    return Math.min(1, pressure * readiness / 2.5);
}

// How sheltered the agent is, in [0,1]. Roof matters most: almost everything
// that kills an agent at night either flies, shoots from above, or walks in.
export function shelterLevel({ roofed = false, walls = 0, lit = false } = {}) {
    let s = 0;
    if (roofed) s += 0.5;
    s += Math.min(4, Math.max(0, walls)) / 4 * 0.35;
    if (lit) s += 0.15;
    return Math.min(1, s);
}

// ---- reading the world -----------------------------------------------------

// Mobs differ in how much trouble they are at a given range.
const THREAT_WEIGHT = {
    creeper: 2.0,        // ends the run outright
    skeleton: 1.4,       // hits from range, so distance protects you less
    pillager: 1.4,
    witch: 1.3,
    enderman: 1.3,
    zombie: 1.0, husk: 1.0, drowned: 1.1, zombie_villager: 1.0,
    spider: 0.8, cave_spider: 0.9, slime: 0.6, phantom: 1.2,
};

export function readSituation(bot) {
    const out = {
        phase: 'day', night_pressure: 0, minutes_until_dark: 20,
        threat: 0, hostile_count: 0, nearest_hostile: null,
        shelter: 0, roofed: false, walls: 0, lit: false,
    };
    if (!bot) return out;

    try {
        const t = bot.time?.timeOfDay ?? 0;
        out.phase = phaseOfDay(t);
        out.night_pressure = nightPressure(t);
        out.minutes_until_dark = minutesUntilDark(t);
    } catch { /* time is optional; daylight defaults to safe */ }

    try {
        const me = bot.entity.position;
        const hostiles = Object.values(bot.entities || {})
            .filter(e => e && e.position && mc.isHostile(e))
            .map(e => ({ name: e.name, distance: e.position.distanceTo(me),
                weight: THREAT_WEIGHT[e.name] ?? 1 }))
            .filter(h => h.distance <= 16)
            .sort((a, b) => a.distance - b.distance);

        out.hostile_count = hostiles.length;
        out.nearest_hostile = hostiles[0]
            ? { name: hostiles[0].name, distance: Math.round(hostiles[0].distance) } : null;

        const inv = world.getInventoryCounts(bot) || {};
        const armed = Object.keys(inv).some(i => i.endsWith('_sword') || i.endsWith('_axe'));
        const armoured = [5, 6, 7, 8].some(s => bot.inventory?.slots?.[s]);
        out.threat = threatLevel(hostiles, { armed, armoured });
    } catch { /* entity list is optional */ }

    try {
        Object.assign(out, readShelter(bot));
        out.shelter = shelterLevel(out);
    } catch { /* block reads can fail mid-chunk-load */ }

    return out;
}

// Is there something over my head, and anything around me?
// Cheap and approximate on purpose: this runs at 1Hz.
function readShelter(bot) {
    const at = bot.entity.position.floored();
    const solid = (dx, dy, dz) => {
        const b = bot.blockAt(at.offset(dx, dy, dz));
        return !!b && b.boundingBox === 'block';
    };
    let roofed = false;
    for (let dy = 2; dy <= 6; dy++) {
        if (solid(0, dy, 0)) { roofed = true; break; }
    }
    let walls = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
        if (solid(dx, 1, dz)) walls++;
    // light: mineflayer exposes skyLight/blockLight on the block we stand in
    let lit = false;
    try {
        const here = bot.blockAt(at);
        lit = (here?.light ?? 0) >= 8 || (here?.skyLight ?? 0) >= 8;
    } catch { /* light data is not always present */ }
    return { roofed, walls, lit };
}
