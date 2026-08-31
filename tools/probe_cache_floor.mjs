// Find a model's real minimum cacheable prefix by bisection against the API.
//
//   node tools/probe_cache_floor.mjs [model]
//
// The documented minimum (1024 tokens for Sonnet/Opus, 2048 for Haiku) is
// published for earlier model generations. Rather than assume it carries
// forward — which is exactly the assumption that cost several debugging
// rounds — this asks the API where the cliff actually is.
//
// Each probe is one small call with max_tokens 1. A run is ~8 calls.
import { readFileSync, existsSync } from 'fs';
import settings from '../settings.js';

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

const profile = JSON.parse(readFileSync(settings.profiles[0], 'utf8'));
const model = process.argv[2]
    || (typeof profile.model === 'string' ? profile.model : profile.model?.model);

// Prose-like filler so the tokenizer behaves similarly to a real prompt. Each
// probe gets DIFFERENT filler, otherwise probe N would read the cache probe
// N-1 wrote and every size would look cacheable.
function filler(words, salt) {
    const bank = ('the quick brown fox jumps over a lazy dog while mining stone and crafting '
        + 'wooden tools near a spruce forest at dusk with a stone pickaxe in hand ').split(' ');
    const out = [`Session ${salt}.`];
    for (let i = 0; i < words; i++) out.push(bank[(i * 7 + salt * 13) % bank.length]);
    return out.join(' ');
}

async function api(path, body) {
    const res = await fetch(`https://api.anthropic.com/v1/${path}`, {
        method: 'POST',
        headers: {
            'x-api-key': key(),
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
        console.error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
        process.exit(1);
    }
    return json;
}

// Returns { tokens, cached } for a prefix of roughly `words` words.
async function probe(words, salt) {
    const text = filler(words, salt);
    const counted = await api('messages/count_tokens', {
        model, system: [{ type: 'text', text }], messages: [{ role: 'user', content: 'x' }],
    });
    const r = await api('messages', {
        model, max_tokens: 1,
        system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'x' }],
    });
    const wrote = (r.usage.cache_creation_input_tokens ?? 0) > 0;
    return { tokens: counted.input_tokens, cached: wrote };
}

console.log(`\nProbing the real minimum cacheable prefix for ${model}`);
console.log('(each row is one API call; "cached" means the API wrote a cache entry)\n');

let salt = 1;
const results = [];
for (const words of [1200, 1800, 2600, 3400, 4200, 5200]) {
    const r = await probe(words, salt++);
    results.push(r);
    console.log(`  ${String(r.tokens).padStart(5)} tokens   ${r.cached ? 'CACHED' : 'not cached'}`);
    if (r.cached) break;
}

const firstHit = results.find(r => r.cached);
const lastMiss = [...results].reverse().find(r => !r.cached);
console.log('\n---');
if (!firstHit) {
    console.log(`No size up to ${results[results.length - 1].tokens} tokens was cached.`);
    console.log('Either this model does not support prompt caching, or the floor is higher still.');
} else {
    console.log(`Caching begins somewhere in ${lastMiss ? lastMiss.tokens + 1 : 0}..${firstHit.tokens} tokens.`);
    console.log(`Set the floor for this model to ${firstHit.tokens} in src/models/cache.js.`);
}
console.log();
