// Phase 10 — the agent's predicament, in words, for the prompt.
//
// The situation numbers exist so drives can respond to them; this is how the
// MODEL gets to respond too. Both matter: the drive system decides what to
// want, and the model decides what to do about it, and on 2026-09-06 neither
// knew that night was coming or that five zombies had gathered.
//
// Written to be read under pressure: what is true, how long you have, and what
// you could do about it. No numbers the model cannot act on.

import * as mc from '../../utils/mcdata.js';

export function describeSituation(agent) {
    const s = agent?.situation;
    if (!s) return '';
    const lines = [];

    // Time, and how long is left — the thing that was missing entirely.
    if (s.phase === 'night' || s.phase === 'dusk') {
        lines.push(s.shelter >= 0.6
            ? `It is ${s.phase}. You are sheltered — staying put until dawn is the cheap, safe choice.`
            : `It is ${s.phase} and you are EXPOSED. Mobs are spawning. Get inside or wall yourself in now; `
              + 'building can wait for daylight.');
    } else if (s.minutes_until_dark <= 4) {
        lines.push(`Dusk is about ${s.minutes_until_dark} minutes away and you are `
            + `${s.shelter >= 0.6 ? 'sheltered' : 'in the open'}. `
            + (s.shelter >= 0.6 ? 'Good.' : 'Start shelter NOW — a 3x3 hole with a roof and a torch is enough.'));
    } else {
        lines.push(`It is ${s.phase}, about ${s.minutes_until_dark} minutes of daylight left. `
            + 'This is the time for work that needs to be outdoors.');
    }

    // What is around you, and whether it is winnable.
    if (s.hostile_count > 0) {
        const near = s.nearest_hostile;
        lines.push(`${s.hostile_count} hostile${s.hostile_count === 1 ? '' : 's'} within 16 blocks`
            + (near ? ` (nearest: ${near.name} at ${near.distance} blocks)` : '') + '.');
        if (s.threat >= 0.6)
            lines.push('You are OUTNUMBERED. Do not fight this. Break line of sight, pillar up, '
                + 'or seal yourself in — you lose everything you are carrying if you die.');
        else if (s.threat >= 0.3)
            lines.push('Manageable, but do not let more gather. Deal with it or leave.');
    }

    // Where you are vertically, so "I am in a hole" is representable at all.
    // A roof overhead reads identically whether it is a shelter you built or
    // seven metres of dirt you dug through, and the difference matters.
    if (s.depth >= 3) {
        lines.push(`You are UNDERGROUND — roughly ${s.depth} blocks of cover above you`
            + `${s.enclosed ? ', walled in on all sides' : ''}. `
            + 'You cannot see the sky. Before you dig further, know how you are getting back up: '
            + 'cut stairs as you go, or pillar up. Never dig straight down.');
    } else if (s.depth > 0 && !s.roofed) {
        lines.push(`You are ${s.depth} blocks below the open air.`);
    }

    // Shelter, stated plainly so "do I have walls" is answerable.
    if (s.shelter > 0 && s.shelter < 0.6)
        lines.push(`Partial shelter only (${s.roofed ? 'roof' : 'no roof'}, ${s.walls}/4 walls`
            + `${s.lit ? ', lit' : ', unlit'}). A roof matters most.`);

    return lines.join('\n');
}

// What the world already knows, so the agent stops rediscovering it by dying.
//
// mcdata has had getBlockTool() all along and nothing asked it. Making an agent
// learn from repeated failure that iron needs a stone pickaxe is not emergence,
// it is waste — a human reads this once. Give the facts; earn the strategy.
export function describeRequirements(goalText) {
    const text = String(goalText ?? '').toLowerCase();
    const notes = [];
    const seen = new Set();

    for (const block of ORE_HINTS) {
        if (!text.includes(block.word) || seen.has(block.block)) continue;
        seen.add(block.block);
        let tool = null;
        try { tool = mc.getBlockTool(block.block); } catch { /* unknown block */ }
        if (tool) notes.push(`${block.block} needs a ${tool} or better — mining it without one drops nothing.`);
    }
    return notes.length ? `Known requirements:\n${notes.map(n => `- ${n}`).join('\n')}` : '';
}

// Words a goal is likely to use, mapped to the block mcdata can answer for.
const ORE_HINTS = [
    { word: 'iron', block: 'iron_ore' },
    { word: 'coal', block: 'coal_ore' },
    { word: 'gold', block: 'gold_ore' },
    { word: 'diamond', block: 'diamond_ore' },
    { word: 'redstone', block: 'redstone_ore' },
    { word: 'lapis', block: 'lapis_ore' },
    { word: 'copper', block: 'copper_ore' },
    { word: 'obsidian', block: 'obsidian' },
    { word: 'stone', block: 'stone' },
    { word: 'cobblestone', block: 'stone' },
];
