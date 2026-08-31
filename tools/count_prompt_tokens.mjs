// Ask Anthropic exactly how many tokens the cacheable prefix is, instead of
// estimating it from character count.
//
//   node tools/count_prompt_tokens.mjs
//
// Three successive chars-per-token estimates (4.2, 4.6, 5.3) were all
// optimistic, and each one silently disabled prompt caching for a whole run
// before the rejection warning surfaced it. The API will answer the question
// directly for free, so there is no reason to guess.
//
// Uses fetch against /v1/messages/count_tokens — the installed SDK (0.17.2)
// predates client.messages.countTokens(). Needs ANTHROPIC_API_KEY in keys.json
// or the environment. Counting tokens is not billed.
import { readFileSync, existsSync } from 'fs';
import settings from '../settings.js';
import { getCommandDocs } from '../src/agent/commands/index.js';
import { CACHE_BOUNDARY, minCacheableChars } from '../src/models/cache.js';

function key() {
    if (existsSync('./keys.json')) {
        try {
            const k = JSON.parse(readFileSync('./keys.json', 'utf8')).ANTHROPIC_API_KEY;
            if (k) return k;
        } catch { /* fall through to env */ }
    }
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    console.error('No ANTHROPIC_API_KEY in keys.json or the environment.');
    process.exit(1);
}

// Reproduce exactly what the agent will send: settings.blocked_actions plus
// whatever the feature flags block. Getting this wrong is what made the last
// three estimates disagree with reality.
function blockedActions() {
    const blocked = [...(settings.blocked_actions || [])];
    if (!settings.use_social) blocked.push('!offerTrade', '!acceptTrade', '!declineTrade');
    if (!settings.use_cognition) blocked.push('!stepDone', '!stepFailed');
    return blocked;
}

const profilePath = settings.profiles[0];
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const defaults = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
const template = profile.conversing || defaults.conversing;

const filled = template
    .replaceAll('$NAME', profile.name || 'Agent')
    .replaceAll('$COMMAND_DOCS', getCommandDocs({ blocked_actions: blockedActions() }));

const i = filled.indexOf(CACHE_BOUNDARY);
if (i === -1) {
    console.error('The conversing template has no cache boundary — caching is off entirely.');
    process.exit(1);
}
const prefix = filled.substring(0, i);
const model = typeof profile.model === 'string' ? profile.model : profile.model?.model;

async function count(system) {
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
            'x-api-key': key(),
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({ model, system, messages: [{ role: 'user', content: 'x' }] }),
    });
    if (!res.ok) {
        console.error(`count_tokens failed: HTTP ${res.status}\n${await res.text()}`);
        process.exit(1);
    }
    return (await res.json()).input_tokens;
}

// Subtract a baseline so the number is the prefix alone, not the envelope.
const baseline = await count('');
const withPrefix = await count(prefix);
const prefixTokens = withPrefix - baseline;

const floorTokens = 2048;                       // Haiku; 1024 on Sonnet/Opus
const ratio = prefix.length / prefixTokens;
const estimate = Math.round(prefix.length / (minCacheableChars(model) / floorTokens));

console.log(`\nmodel                 ${model}`);
console.log(`profile               ${profilePath}`);
console.log(`blocked commands      ${blockedActions().length}`);
console.log(`\ncacheable prefix      ${prefix.length} chars`);
console.log(`  ACTUAL tokens       ${prefixTokens}   <- from the API`);
console.log(`  our estimate        ${estimate}`);
console.log(`  true chars/token    ${ratio.toFixed(2)}   (src/models/cache.js uses ${(minCacheableChars(model) / floorTokens).toFixed(2)})`);
console.log(`\nfloor for this model  ${floorTokens} tokens`);

if (prefixTokens >= floorTokens) {
    console.log(`RESULT: CACHES, with ${Math.round((prefixTokens / floorTokens - 1) * 100)}% margin.`);
} else {
    const short = floorTokens - prefixTokens;
    console.log(`RESULT: WILL NOT CACHE — ${short} tokens short.`);
    console.log(`        Add roughly ${Math.ceil(short * ratio)} more characters of stable text`);
    console.log(`        ahead of <<<CACHE_BOUNDARY>>> in profiles/defaults/_default.json.`);
}
if (Math.abs(ratio - minCacheableChars(model) / floorTokens) > 0.15)
    console.log(`\nSet CHARS_PER_TOKEN in src/models/cache.js to ${(ratio * 0.95).toFixed(1)} (5% under the measured ratio).`);
console.log();
