import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, TIERS, isLocalApi } from '../../src/models/router.js';

function fakeModel(name) {
    const m = { model_name: name, sendRequest: () => Promise.resolve('ok from ' + name) };
    return m;
}
function roles() {
    return { chat: fakeModel('chat-model'), code: fakeModel('code-model'), vision: fakeModel('vision-model') };
}

test('local providers are recognized', () => {
    assert.equal(isLocalApi('ollama'), true);
    assert.equal(isLocalApi('LMStudio'), true);
    assert.equal(isLocalApi('openai'), false);
    assert.equal(isLocalApi(undefined), false);
});

test('with no tiers block every tier falls back to its existing role', () => {
    const r = roles();
    const router = new ModelRouter({}, r);
    for (const tier of TIERS) {
        const expected = tier === 'code' ? r.code : tier === 'vision' ? r.vision : r.chat;
        assert.equal(router.getModel(tier), expected, `tier ${tier}`);
    }
});

test('an unparseable tier spec degrades to the default instead of throwing', () => {
    const r = roles();
    const router = new ModelRouter({ tiers: { plan: { api: 'nonexistent-provider' } } }, r, {
        buildModel: () => { throw new Error('unknown provider'); },
    });
    assert.equal(router.getModel('plan'), r.chat);
});

test('a configured tier is built through the injected factory', () => {
    const r = roles();
    const local = fakeModel('llama-local');
    const router = new ModelRouter({ tiers: { chat: 'ollama/llama' } }, r, {
        buildModel: (spec) => ({ model: local, api: 'ollama', name: String(spec) }),
    });
    assert.equal(router.getModel('chat'), local);
    assert.equal(router.describe().chat.local, true);
    assert.equal(router.describe().plan.local, false); // untouched tiers keep their role
});

test('run() meters the call with its tier and site', async () => {
    const r = roles();
    const router = new ModelRouter({}, r);
    const out = await router.run('chat', 'conversing', (m) => m.sendRequest(), { in_text: 'hello' });
    assert.equal(out, 'ok from chat-model');
    const s = router.getStatus();
    assert.equal(s.totals.calls, 1);
    assert.equal(s.by_tier.chat.calls, 1);
    assert.equal(s.by_site.conversing.calls, 1);
});

test('a failing tier falls back once, and both attempts are metered', async () => {
    const r = roles();
    const router = new ModelRouter({}, r);
    // give 'plan' its own failing model so a distinct fallback exists
    router.models.set('plan', { model: { model_name: 'broken', sendRequest: () => Promise.reject(new Error('provider down')) }, api: 'openai', name: 'broken' });

    const out = await router.run('plan', 'taskPlanning',
        (m) => m.sendRequest ? m.sendRequest() : Promise.resolve('x'), { in_text: 'plan this' });
    assert.equal(out, 'ok from chat-model', 'should have completed on the fallback model');
    const s = router.getStatus();
    assert.equal(s.totals.errors, 1);
    assert.equal(s.totals.calls, 2); // failed attempt + successful retry
});

test('a failure with no distinct fallback propagates rather than looping', async () => {
    const r = roles();
    const router = new ModelRouter({}, r);
    const boom = () => Promise.reject(new Error('always down'));
    await assert.rejects(() => router.run('chat', 'conversing', boom, { in_text: 'x' }), /always down/);
    assert.equal(router.getStatus().totals.errors, 1);
});

test('describe() reports the resolved routing table for the dashboard', () => {
    const router = new ModelRouter({}, roles());
    const table = router.describe();
    assert.deepEqual(Object.keys(table).sort(), [...TIERS].sort());
    for (const tier of TIERS)
        assert.ok('local' in table[tier] && 'model' in table[tier]);
});

test('embeddings are metered on their own tier', () => {
    const router = new ModelRouter({}, roles());
    router.recordEmbedding('ollama', 'embeddinggemma', 'some query text');
    const s = router.getStatus();
    assert.equal(s.by_tier.embed.calls, 1);
    assert.equal(s.by_tier.embed.cost, 0); // local
    assert.equal(s.local_share, 1);
});

test('a hung provider times out instead of wedging the tier', async () => {
    const router = new ModelRouter({}, roles(), { call_timeout_ms: 20 });
    await assert.rejects(
        router.run('chat', 'test_site', () => new Promise(() => {}), { no_fallback: true }),
        /timed out after/);
    // and it is metered as an error, so the dashboard shows the outage
    assert.equal(router.meter.totals.errors, 1);
});

test('a timed-out call still falls back to a different model', async () => {
    const r = roles();
    const router = new ModelRouter({}, r, { call_timeout_ms: 20 });
    router.models.set('reflex', { model: fakeModel('hung'), api: 'ollama', name: 'hung' });
    const res = await router.run('reflex', 'test_site',
        (model) => model.model_name === 'hung' ? new Promise(() => {}) : model.sendRequest());
    assert.equal(res, 'ok from chat-model');
});

test('a fast call is unaffected by the timeout', async () => {
    const router = new ModelRouter({}, roles(), { call_timeout_ms: 5000 });
    assert.equal(await router.run('chat', 'test_site', (m) => m.sendRequest()), 'ok from chat-model');
});
