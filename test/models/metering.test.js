import test from 'node:test';
import assert from 'node:assert/strict';
import { Meter, estimateTokens, costOf, priceFor, CHARS_PER_TOKEN } from '../../src/models/metering.js';

test('token estimation scales with length', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens('x'.repeat(Math.round(CHARS_PER_TOKEN * 100))), 100);
});

test('pricing matches exact ids and known prefixes; unknown is free', () => {
    assert.equal(priceFor('gpt-5.4-mini').in, 0.25);
    assert.equal(priceFor('claude-sonnet-4-6-20260101').in, 3.0); // dated id via prefix
    assert.deepEqual(priceFor('some-local-llama'), { in: 0, out: 0 });
    assert.deepEqual(priceFor(null), { in: 0, out: 0 });
    // 1M in + 1M out on a known model
    assert.ok(Math.abs(costOf('gpt-5.4-mini', 1e6, 1e6) - 2.25) < 1e-9);
});

test('local calls are free regardless of model name', () => {
    const m = new Meter();
    m.record({ tier: 'chat', site: 'conversing', model: 'gpt-5.4', local: true, in_text: 'x'.repeat(42100), out_text: '' });
    assert.equal(m.totals.cost, 0);
    assert.equal(m.totals.in_tokens, 10000);
});

test('totals, per-tier and per-site breakdowns accumulate', () => {
    const m = new Meter();
    m.record({ tier: 'chat', site: 'conversing', model: 'gpt-5.4-mini', local: false, in_tokens: 1000, out_tokens: 100 });
    m.record({ tier: 'chat', site: 'conversing', model: 'gpt-5.4-mini', local: false, in_tokens: 1000, out_tokens: 100 });
    m.record({ tier: 'reflect', site: 'reflection', model: 'claude-opus-4-1', local: false, in_tokens: 500, out_tokens: 50 });

    assert.equal(m.totals.calls, 3);
    assert.equal(m.totals.in_tokens, 2500);
    assert.equal(m.by_tier.chat.calls, 2);
    assert.equal(m.by_site.reflection.calls, 1);
    // the frontier tier should dominate cost despite being the rarest call
    assert.ok(m.by_tier.reflect.cost > m.by_tier.chat.cost);
});

test('local share is the acceptance metric and ignores stale calls', () => {
    const m = new Meter({ now: 0, window_ms: 1000 });
    assert.equal(m.localShare(0), 1); // no calls yet: vacuously local
    for (let i = 0; i < 7; i++) m.record({ tier: 'chat', site: 's', model: 'l', local: true, now: 100 });
    for (let i = 0; i < 3; i++) m.record({ tier: 'plan', site: 's', model: 'gpt-5.4', local: false, now: 100 });
    assert.ok(Math.abs(m.localShare(200) - 0.7) < 1e-9);

    // calls older than the window drop out
    m.record({ tier: 'plan', site: 's', model: 'gpt-5.4', local: false, now: 5000 });
    assert.equal(m.localShare(5000), 0);
});

test('errors are counted but do not corrupt totals', () => {
    const m = new Meter();
    m.record({ tier: 'chat', site: 'conversing', model: 'gpt-5.4-mini', local: false, in_tokens: 10, out_tokens: 0, error: true });
    assert.equal(m.totals.errors, 1);
    assert.equal(m.totals.calls, 1);
});

test('summary is JSON-safe and reports rounded values', () => {
    const m = new Meter({ now: 0 });
    m.record({ tier: 'chat', site: 'conversing', model: 'gpt-5.4-mini', local: false, in_tokens: 1000, out_tokens: 100, now: 0 });
    const s = m.summary(1800000); // half an hour in
    assert.ok(JSON.stringify(s));
    assert.equal(s.totals.calls, 1);
    assert.equal(typeof s.local_share, 'number');
    assert.equal(s.per_hour.calls, 2); // 1 call in 30 min -> 2/hr
    assert.equal(s.by_tier.chat.local_share, 0);
});

test('a cache hit is priced as a cache read, not as fresh input', () => {
    const m = new Meter();
    // 2000 input tokens of which 1800 came from cache, 200 fresh
    m.record({
        tier: 'chat', site: 'conversing', model: 'claude-haiku-4-5',
        in_tokens: 2000, out_tokens: 100,
        cache_read_tokens: 1800, uncached_in_tokens: 200,
    });
    const cached = m.totals.cost;

    const m2 = new Meter();
    m2.record({
        tier: 'chat', site: 'conversing', model: 'claude-haiku-4-5',
        in_tokens: 2000, out_tokens: 100,
    });
    const uncached = m2.totals.cost;

    assert.ok(cached < uncached, `a cache hit should cost less (${cached} vs ${uncached})`);
    // 1800 tok at 0.1x + 200 at 1x = the input cost of 380 tokens, not 2000
    assert.ok(cached < uncached * 0.6, 'a mostly-cached call should be far cheaper');
    assert.equal(m.summary(0).cache_hit_rate, 0.9);
});

test('a cache write costs more than plain input, and is reported', () => {
    const m = new Meter();
    m.record({
        tier: 'chat', site: 'conversing', model: 'claude-haiku-4-5',
        in_tokens: 2000, out_tokens: 100,
        cache_write_tokens: 1800, uncached_in_tokens: 200,
    });
    const m2 = new Meter();
    m2.record({ tier: 'chat', site: 'conversing', model: 'claude-haiku-4-5', in_tokens: 2000, out_tokens: 100 });
    assert.ok(m.totals.cost > m2.totals.cost, 'the first call pays a premium to populate the cache');
    assert.equal(m.totals.cache_write_tokens, 1800);
    assert.equal(m.summary(0).cache_hit_rate, 0);
});

test('with no usage reported the estimate path is unchanged', () => {
    const m = new Meter();
    m.record({ tier: 'chat', site: 'conversing', model: 'claude-haiku-4-5', in_text: 'x'.repeat(4210), out_text: 'y' });
    assert.equal(m.totals.in_tokens, 1000);
    assert.equal(m.summary(0).cache_hit_rate, 0);
});

test('the models actually shipped in profiles all have a price', () => {
    // A model with no entry silently costs $0.00, which reads as "free" on the
    // dashboard rather than as "unpriced" — so every id we ship must resolve.
    for (const id of ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5']) {
        const p = priceFor(id);
        assert.ok(p.in > 0 && p.out > 0, `${id} has no price entry`);
    }
});

test('superseded ids still price, so an old profile is not silently free', () => {
    assert.equal(priceFor('claude-sonnet-4-6').in, 3.0);
    assert.equal(priceFor('claude-3-5-sonnet-latest').in, 3.0);
});
