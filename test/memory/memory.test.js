import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setSettings } from '../../src/agent/settings.js';
import { AgentMemory } from '../../src/agent/memory/index.js';

setSettings({ use_memory: true });

// Deterministic embedding: axis 0 = mining-ish, axis 1 = social-ish.
function stubEmbed(text) {
    const t = text.toLowerCase();
    const mine = (t.match(/iron|cave|ore|pickaxe/g) || []).length;
    const social = (t.match(/hello|friend|chat|trade/g) || []).length;
    return Promise.resolve([mine, social, 1]);
}

function makeAgent(dir, opts = {}) {
    return {
        name: 'testbot',
        prompter: {
            profile: { memory: { dir, exclude_recent_ms: 0, ...opts } },
            embedding_model: { embed: opts.broken_embed
                ? () => Promise.reject(new Error('no embeddings here'))
                : stubEmbed },
            promptReflection: () => Promise.resolve(
                '```json\n{"beliefs": ["Caves near spawn are rich in iron", "Zombies are dangerous at night"]}\n```'),
        },
    };
}

function freshDir() {
    return mkdtempSync(path.join(tmpdir(), 'mem-'));
}

// let all fire-and-forget embed/reflect promises settle
function settle() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

test('retrieval ranks by embedding relevance', async () => {
    const memory = new AgentMemory(makeAgent(freshDir(), { reflection_threshold: 999 }));
    memory.record('speech', 'Found an iron ore vein in the cave');
    memory.record('chat_received', 'Steve said: hello friend, want to trade?');
    memory.record('death', 'Died from falling');
    await settle();

    const ranked = await memory.retrieve('where can I mine iron ore?', 2);
    assert.equal(ranked[0].event.content, 'Found an iron ore vein in the cave');
});

test('falls back to word overlap when embeddings break, with timed backoff', async () => {
    const memory = new AgentMemory(makeAgent(freshDir(), { reflection_threshold: 999, broken_embed: true }));
    memory.record('speech', 'I built a cozy house by the river');
    memory.record('speech', 'The desert temple had a hidden chest');
    await settle(); // the failed embed starts the backoff window

    const ranked = await memory.retrieve('tell me about the desert temple chest', 1);
    assert.ok(memory.embed_backoff_until > Date.now(), 'backoff window should be active');
    assert.equal(memory._embeddingAvailable(), false);
    assert.equal(ranked[0].event.content, 'The desert temple had a hidden chest');
});

test('backfill embeds events recorded during an outage', async () => {
    const dir = freshDir();
    const broken = new AgentMemory(makeAgent(dir, { reflection_threshold: 999, broken_embed: true }));
    broken.record('speech', 'Found diamonds in the deep cave');
    broken.record('speech', 'Traded with a villager friend');
    await settle();
    assert.equal(broken.embeddings.size, 0); // nothing embedded during outage

    // new session, embeddings healthy again -> backfill on load
    const healed = new AgentMemory(makeAgent(dir, { reflection_threshold: 999 }));
    await healed._backfill_task;
    assert.equal(healed.embeddings.size, 2);
});

test('a failing reflection does not storm and does not lose the budget mechanism', async () => {
    const dir = freshDir();
    const agent = makeAgent(dir, { reflection_threshold: 3, reflection_min_interval_ms: 0 });
    agent.prompter.promptReflection = () => Promise.reject(new Error('model down'));
    const memory = new AgentMemory(agent);
    for (let i = 0; i < 6; i++)
        memory.record('chat_received', `Steve said: thing ${i}`); // crosses threshold
    await memory._reflect_task;
    await settle();
    // budget was consumed up front: no belief, no immediate re-fire per record
    assert.equal(memory.getBeliefs().length, 0);
    assert.ok(memory.importance_since_reflection < 3);
    assert.equal(memory.reflecting, false);
    memory.record('chat_received', 'Steve said: one more'); // must not throw
});

test('events persist across instances; places hydrate', () => {
    const dir = freshDir();
    const first = new AgentMemory(makeAgent(dir, { reflection_threshold: 999 }));
    first.record('speech', 'a memorable event');
    first.recordPlace('home_base', 10.6, 64, -20.2);

    const second = new AgentMemory(makeAgent(dir, { reflection_threshold: 999 }));
    assert.equal(second.events.length, 2);
    assert.deepEqual(second.getPlaces(), { home_base: [10.6, 64, -20.2] });

    // memory_bank-style hydration
    const bank = { memory: {} };
    Object.assign(bank.memory, second.getPlaces());
    assert.ok(bank.memory.home_base);
});

test('reflection fires at the importance threshold and stores beliefs', async () => {
    const memory = new AgentMemory(makeAgent(freshDir(), { reflection_threshold: 3 }));
    for (let i = 0; i < 6; i++)
        memory.record('chat_received', `Steve said: event number ${i} in the cave`); // 0.5 each
    await memory._reflect_task;
    await settle();

    const beliefs = memory.getBeliefs();
    assert.equal(beliefs.length, 2);
    assert.ok(beliefs[0].content.includes('iron'));
    assert.equal(memory.importance_since_reflection < 3, true);
});

test('reflection accumulator resumes from disk after a belief', async () => {
    const dir = freshDir();
    const first = new AgentMemory(makeAgent(dir, { reflection_threshold: 3 }));
    for (let i = 0; i < 6; i++)
        first.record('chat_received', `Steve said: thing ${i}`);
    await first._reflect_task;
    await settle();

    const second = new AgentMemory(makeAgent(dir, { reflection_threshold: 3 }));
    // beliefs reset the accumulator; only events after the last belief count
    assert.ok(second.importance_since_reflection < 3);
});

test('disabled memory records nothing', async () => {
    setSettings({ use_memory: false });
    const memory = new AgentMemory(makeAgent(freshDir()));
    assert.equal(memory.record('speech', 'should be dropped'), null);
    assert.equal(await memory.retrieveText('anything'), '');
    setSettings({ use_memory: true });
});
