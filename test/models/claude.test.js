import test from 'node:test';
import assert from 'node:assert/strict';

// The Anthropic path is the one being exercised first in live testing, so it
// gets an integration test rather than only unit coverage of its helpers.
// The SDK is stubbed: no network, no key required beyond this placeholder.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';

const { Claude } = await import('../../src/models/claude.js');
const { CACHE_BOUNDARY, minCacheableChars } = await import('../../src/models/cache.js');

// Build a system prompt whose cacheable prefix clears `model`'s floor.
function promptFor(model, over = 1.2) {
    const prefix = 'P'.repeat(Math.ceil(minCacheableChars(model) * over));
    return { prompt: prefix + CACHE_BOUNDARY + 'volatile tail', prefix };
}

function stub(claude, impl) {
    claude.anthropic = { messages: { create: impl } };
    return claude;
}

const OK = (usage) => async () => ({
    content: [{ type: 'text', text: 'hello there' }],
    usage: usage ?? { input_tokens: 100, output_tokens: 20 },
});

test('a prefix over the floor is sent as two blocks with a cache breakpoint', async () => {
    const model = 'claude-haiku-4-5-20251001';
    const c = new Claude(model);
    let seen = null;
    stub(c, async (req) => { seen = req; return (await OK()()); });

    const { prompt, prefix } = promptFor(model);
    await c.sendRequest([{ role: 'user', content: 'hi' }], prompt);

    assert.ok(Array.isArray(seen.system), 'system should be a block array when cacheable');
    assert.equal(seen.system.length, 2);
    assert.deepEqual(seen.system[0].cache_control, { type: 'ephemeral' });
    assert.equal(seen.system[0].text, prefix);
    assert.equal(seen.system[1].cache_control, undefined, 'only the prefix is marked');
    assert.ok(!JSON.stringify(seen.system).includes('CACHE_BOUNDARY'), 'the marker must never be sent');
});

test('a prefix under the model floor is sent as a plain string, not a wasted breakpoint', async () => {
    // >1024 tokens (Sonnet would cache) but <2048 (Haiku will not)
    const c = new Claude('claude-haiku-4-5-20251001');
    let seen = null;
    stub(c, async (req) => { seen = req; return (await OK()()); });

    const prefix = 'P'.repeat(Math.ceil(minCacheableChars('claude-sonnet-5')) + 100);
    await c.sendRequest([{ role: 'user', content: 'hi' }], prefix + CACHE_BOUNDARY + 'tail');

    assert.equal(typeof seen.system, 'string', 'below the floor a breakpoint only costs money');
    assert.ok(!seen.system.includes('CACHE_BOUNDARY'), 'the marker must never be sent');
});

test('real usage is exposed, including cache hits', async () => {
    const model = 'claude-haiku-4-5-20251001';
    const c = new Claude(model);
    stub(c, OK({ input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0 }));

    await c.sendRequest([{ role: 'user', content: 'hi' }], promptFor(model).prompt);
    assert.equal(c.last_usage.cache_read_tokens, 1800);
    assert.equal(c.last_usage.uncached_in_tokens, 200);
    assert.equal(c.last_usage.in_tokens, 2000);
    assert.equal(c.last_usage.out_tokens, 30);
});

test('usage from a previous call never leaks into a failed one', async () => {
    const c = new Claude('claude-haiku-4-5-20251001');
    stub(c, OK({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 999 }));
    await c.sendRequest([{ role: 'user', content: 'hi' }], 'plain prompt');
    assert.equal(c.last_usage.cache_read_tokens, 999);

    stub(c, async () => { const e = new Error('boom'); e.status = 500; throw e; });
    await assert.rejects(c.sendRequest([{ role: 'user', content: 'hi' }], 'plain prompt'));
    assert.equal(c.last_usage, null, 'stale usage would be metered against the failed call');
});

// The whole point: a failure must not come back as prose. Returning a string
// here would be metered as a successful call, suppress the router's fallback,
// and leave the dashboard reporting zero errors during a total outage.
test('failures throw, with a message that names the actual problem', async () => {
    const cases = [
        [{ status: 401 }, /API key/i],
        [{ status: 404 }, /model/i],
        [{ status: 429 }, /rate limit/i],
        [{ status: 500 }, /failed/i],
    ];
    for (const [props, expected] of cases) {
        const c = new Claude('claude-haiku-4-5-20251001');
        stub(c, async () => { throw Object.assign(new Error('upstream detail'), props); });
        await assert.rejects(
            () => c.sendRequest([{ role: 'user', content: 'hi' }], 'plain prompt'),
            expected, `status ${props.status} should surface a useful message`);
    }
});

// The default persona tells the bot to answer with a bare tab when it has
// nothing to add, and Anthropic strips whitespace-only text blocks — so an
// empty content array means "chose to stay silent", not "failed". Returning
// prose here made the bot say "No response from Claude." out loud in chat and
// stored it as a real assistant turn.
test('an empty content array is silence, not an error string', async () => {
    const c = new Claude('claude-haiku-4-5-20251001');
    stub(c, async () => ({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    const res = await c.sendRequest([{ role: 'user', content: 'hi' }], 'plain prompt');
    assert.equal(res, '', 'must be empty so handleMessage ends the turn quietly');
});

test('a response with only a thinking block is also silence', async () => {
    const c = new Claude('claude-haiku-4-5-20251001');
    stub(c, async () => ({ content: [{ type: 'thinking', thinking: '...' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    assert.equal(await c.sendRequest([{ role: 'user', content: 'hi' }], 'plain prompt'), '');
});

// Truncation is a real failure and must not masquerade as silence.
test('no text because of max_tokens throws rather than going quiet', async () => {
    const c = new Claude('claude-haiku-4-5-20251001');
    stub(c, async () => ({ content: [], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 4096 } }));
    await assert.rejects(() => c.sendRequest([{ role: 'user', content: 'hi' }], 'plain prompt'), /max_tokens/);
});

test('a thinking block before the text block is skipped, not returned', async () => {
    const c = new Claude('claude-haiku-4-5-20251001');
    stub(c, async () => ({
        content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'the answer' }],
        usage: { input_tokens: 1, output_tokens: 1 },
    }));
    assert.equal(await c.sendRequest([{ role: 'user', content: 'hi' }], 'plain prompt'), 'the answer');
});
