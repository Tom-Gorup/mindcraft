// Make two identical real calls with a cache breakpoint and print the raw
// usage object from each. Answers, with no inference, whether Anthropic caches
// this exact payload — and if it does not, whether the fields are simply
// missing from the response.
//
//   node tools/check_cache_live.mjs
//
// Costs two small Haiku calls (a few hundredths of a cent). Sends the real
// system prefix but a one-word user message, so output is minimal.
import { readFileSync, existsSync } from 'fs';
import settings from '../settings.js';
import { getCommandDocs } from '../src/agent/commands/index.js';
import { CACHE_BOUNDARY, splitCachePrefix } from '../src/models/cache.js';

function key() {
    if (existsSync('./keys.json')) {
        try {
            const k = JSON.parse(readFileSync('./keys.json', 'utf8')).ANTHROPIC_API_KEY;
            if (k) return k;
        } catch { /* fall through */ }
    }
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    console.error('No ANTHROPIC_API_KEY found.');
    process.exit(1);
}

function blockedActions() {
    const blocked = [...(settings.blocked_actions || [])];
    if (!settings.use_social) blocked.push('!offerTrade', '!acceptTrade', '!declineTrade');
    if (!settings.use_cognition) blocked.push('!stepDone', '!stepFailed');
    return blocked;
}

const profile = JSON.parse(readFileSync(settings.profiles[0], 'utf8'));
const defaults = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
const template = profile.conversing || defaults.conversing;
const model = typeof profile.model === 'string' ? profile.model : profile.model?.model;

const filled = template
    .replaceAll('$NAME', profile.name || 'Agent')
    .replaceAll('$COMMAND_DOCS', getCommandDocs({ blocked_actions: blockedActions() }))
    .replaceAll('$EXAMPLES', '').replaceAll('$SELF_PROMPT', '').replaceAll('$MEMORY', '')
    .replaceAll('$SOCIAL', '').replaceAll('$STATS', 'stats').replaceAll('$INVENTORY', 'inventory');

const { prefix, rest, cacheable } = splitCachePrefix(filled, model);
console.log(`\nmodel            ${model}`);
console.log(`prefix chars     ${prefix.length}`);
console.log(`our 'cacheable'  ${cacheable}`);
if (!cacheable) {
    console.log('\nOur own threshold says not cacheable, so no breakpoint would be sent.');
    console.log('Run tools/count_prompt_tokens.mjs — this is a local estimate problem, not an API one.\n');
    process.exit(1);
}

const system = [
    { type: 'text', text: prefix, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: rest },
];

async function call(label) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': key(),
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model, system, max_tokens: 16,
            messages: [{ role: 'user', content: 'Say ok.' }],
        }),
    });
    const body = await res.json();
    if (!res.ok) {
        console.error(`\n${label}: HTTP ${res.status}`);
        console.error(JSON.stringify(body, null, 2));
        process.exit(1);
    }
    console.log(`\n${label} usage:`);
    console.log(JSON.stringify(body.usage, null, 2));
    return body.usage;
}

const a = await call('call 1 (cold — expect a cache WRITE)');
await new Promise(r => setTimeout(r, 1500));
const b = await call('call 2 (warm — expect a cache READ)');

const wrote = (a.cache_creation_input_tokens ?? 0) > 0;
const read = (b.cache_read_input_tokens ?? 0) > 0;
const fieldsPresent = 'cache_creation_input_tokens' in a || 'cache_read_input_tokens' in a;

console.log('\n---');
if (!fieldsPresent)
    console.log('VERDICT: the API response has no cache_* fields at all.');
else if (wrote && read)
    console.log('VERDICT: caching WORKS on this payload. If the agent still reports 0%,\n'
        + '         the bug is in how the agent builds or meters the request, not here.');
else if (wrote && !read)
    console.log('VERDICT: the cache is written but never read — the prefix differs between\n'
        + '         calls, or the entries expire faster than they are reused.');
else
    console.log(`VERDICT: Anthropic declined to cache this prefix (${a.input_tokens} prompt tokens).\n`
        + '         It is below the model floor, or the payload is not eligible.');
console.log();
