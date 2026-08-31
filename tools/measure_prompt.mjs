// Measure the conversing system prompt: how big is it, and how much of it sits
// in the cacheable prefix? Prompt caching only engages above a per-model token
// floor (1024 on Sonnet/Opus, 2048 on Haiku), so a prefix that clears the bar
// with every feature flag on can silently fall under it with the flags off —
// no error, no cache hit, and the cache-write premium charged anyway.
//
//   node tools/measure_prompt.mjs                 # all flags off (first run)
//   node tools/measure_prompt.mjs --all-flags     # cognition + memory + social + skills
//
// Run from the repo root.
import { readFileSync } from 'fs';
import { getCommandDocs } from '../src/agent/commands/index.js';
import { CACHE_BOUNDARY, minCacheableChars } from '../src/models/cache.js';

const CHARS_PER_TOKEN = 5.3;   // must match src/models/cache.js or the two disagree
const tok = (s) => Math.round(String(s).length / CHARS_PER_TOKEN);

// Which commands the agent blocks is the single biggest lever on prompt size,
// and it is driven entirely by the feature flags.
const args = process.argv.slice(2);
const allFlags = args.includes('--all-flags');
const on = new Set(allFlags ? ['cognition', 'social'] : []);
for (const a of args)
    if (a.startsWith('--use-')) on.add(a.replace('--use-', ''));

const blocked = [];
if (!on.has('social')) blocked.push('!offerTrade', '!acceptTrade', '!declineTrade');
if (!on.has('cognition')) blocked.push('!stepDone', '!stepFailed');
const fakeAgent = { blocked_actions: blocked };
const label = on.size ? `flags: ${[...on].sort().join(' + ')}` : 'default flags (all OFF)';

const profile = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
const template = profile.conversing;
if (!template) {
    console.error('No "conversing" template in profiles/defaults/_default.json');
    process.exit(1);
}

// Substitute the parts that are static per-run; leave the volatile ones as
// representative placeholders so the tail is not artificially tiny.
const filled = template
    .replaceAll('$NAME', 'Wilbur')
    .replaceAll('$COMMAND_DOCS', getCommandDocs(fakeAgent))
    .replaceAll('$EXAMPLES', '(example conversations omitted — measured separately)')
    .replaceAll('$STATS', 'x'.repeat(700))
    .replaceAll('$INVENTORY', 'x'.repeat(300))
    .replaceAll('$MEMORY', on.has('memory') || allFlags ? 'x'.repeat(900) : '')
    .replaceAll('$SOCIAL', on.has('social') ? 'x'.repeat(300) : '')
    .replaceAll('$SELF_PROMPT', '');

const i = filled.indexOf(CACHE_BOUNDARY);
if (i === -1) {
    console.error('FAIL: the conversing template has no cache boundary. '
        + 'Prompt caching is off and every call pays full price.');
    process.exit(1);
}
const prefix = filled.substring(0, i);
const rest = filled.substring(i + CACHE_BOUNDARY.length);

const total = tok(prefix) + tok(rest);
console.log(`\nconversing prompt — ${label}`);
console.log(`  total          ${total} tok`);
console.log(`  cacheable      ${tok(prefix)} tok  (${Math.round(tok(prefix) / total * 100)}%)`);
console.log(`  volatile tail  ${tok(rest)} tok\n`);

let bad = 0;
for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5']) {
    const floor = minCacheableChars(model);
    const ok = prefix.length >= floor;
    if (!ok) bad++;
    console.log(`  ${ok ? 'CACHES ' : 'NO CACHE'}  ${model}  (needs ${Math.round(floor / CHARS_PER_TOKEN)} tok, prefix is ${tok(prefix)})`);
}
// Margin matters: the prefix shrinks when commands are blocked, so a prompt
// that only just clears the bar is one feature flag away from silently
// dropping under it.
const haikuFloor = minCacheableChars('claude-haiku-4-5-20251001') / CHARS_PER_TOKEN;
const margin = Math.round((tok(prefix) - haikuFloor) / haikuFloor * 100);
console.log(`\n  margin over the Haiku floor: ${margin > 0 ? '+' : ''}${margin}%`);
if (margin < 15 && margin >= 0)
    console.log('  WARNING: thin margin — blocking a few more commands would drop it under the bar.');
process.exit(bad > 0 ? 1 : 0);
