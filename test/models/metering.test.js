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
