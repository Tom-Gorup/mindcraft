// Reads bot state into sensor levels [0,1] for the sensor-type drives.
// Thin adapter over the world library — keep logic minimal here so the
// interesting math stays in drives.js where it's unit-tested.
import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { readSituation } from './situation.js';

const FOOD_ITEMS = [
    'bread', 'apple', 'golden_apple', 'carrot', 'potato', 'baked_potato', 'beetroot',
    'melon_slice', 'sweet_berries', 'glow_berries', 'dried_kelp', 'cookie', 'pumpkin_pie',
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
    'cooked_cod', 'cooked_salmon', 'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon',
    'mushroom_stew', 'beetroot_soup', 'rabbit_stew', 'suspicious_stew', 'honey_bottle',
];

// Rough item worth for the wealth drive. Not a real economy — just enough
// signal that "get better gear" competes with other drives.
const ITEM_VALUES = {
    diamond: 16, diamond_block: 150, emerald: 12, gold_ingot: 6, iron_ingot: 4,
    diamond_pickaxe: 60, diamond_sword: 40, diamond_axe: 50, diamond_shovel: 20,
    diamond_helmet: 90, diamond_chestplate: 140, diamond_leggings: 120, diamond_boots: 70,
    iron_pickaxe: 15, iron_sword: 10, iron_axe: 13, iron_shovel: 5,
    iron_helmet: 22, iron_chestplate: 34, iron_leggings: 30, iron_boots: 18,
    stone_pickaxe: 4, stone_sword: 3, stone_axe: 4, wooden_pickaxe: 1, wooden_sword: 1,
    crafting_table: 2, furnace: 4, chest: 3, bed: 5, torch: 1, shield: 8, bow: 8, arrow: 1,
    coal: 1, raw_iron: 3, raw_gold: 5, redstone: 1, lapis_lazuli: 1,
};

export function readSensors(agent) {
    const bot = agent.bot;
    const sensors = {};
    // Shared with the prompt and the dashboard: read once per tick.
    const situation = readSituation(bot);
    agent.situation = situation;

    // safety: health, what is around you, and how close nightfall is.
    //
    // The old version capped to 0.4 for ANY hostile within 16 blocks, so one
    // zombie and five were the same number, and had no time input at all — so
    // night arrived as a surprise every time. Being outnumbered and being about
    // to be caught in the dark are now both representable.
    let safety = (bot.health ?? 20) / 20;
    safety = Math.min(safety, 1 - situation.threat);
    if (bot.lastDamageTime && Date.now() - bot.lastDamageTime < 10000)
        safety = Math.min(safety, 0.3);
    // Darkness only threatens you if you are out in it. Shelter is the answer
    // to nightfall, so having it should relieve the pressure rather than the
    // clock alone deciding.
    const exposure = situation.night_pressure * (1 - situation.shelter);
    safety = Math.min(safety, 1 - exposure * 0.75);
    sensors.safety = safety;

    // food: mostly current hunger, partly whether we carry spare food
    const inventory = world.getInventoryCounts(bot);
    const has_food = FOOD_ITEMS.some(item => inventory[item] > 0);
    sensors.food = ((bot.food ?? 20) / 20) * 0.75 + (has_food ? 0.25 : 0);

    // wealth: diminishing-returns curve over total inventory value
    let value = 0;
    for (const item in inventory)
        value += (ITEM_VALUES[item] || 0) * inventory[item];
    // armor/tools currently equipped count too
    for (const slot of [5, 6, 7, 8]) {
        const equipped = bot.inventory.slots[slot];
        if (equipped) value += ITEM_VALUES[equipped.name] || 0;
    }
    sensors.wealth = 1 - Math.exp(-value / 60);

    return sensors;
}
