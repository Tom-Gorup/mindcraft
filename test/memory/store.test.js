import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { MemoryStore } from '../../src/agent/memory/store.js';

function freshDir() {
    return mkdtempSync(path.join(tmpdir(), 'mem-store-'));
}

test('events and embeddings round-trip', () => {
    const dir = freshDir();
    const store = new MemoryStore(dir);
    store.appendEvent({ id: 'a', ts: 1, type: 'speech', content: 'hi', importance: 0.4 });
    store.appendEvent({ id: 'b', ts: 2, type: 'death', content: 'ouch', importance: 0.9 });
    store.appendEmbedding('a', [0.1, 0.2]);

    const { events, embeddings } = new MemoryStore(dir).loadAll();
    assert.equal(events.length, 2);
    assert.equal(events[1].content, 'ouch');
    assert.deepEqual(embeddings.get('a'), [0.1, 0.2]);
    assert.equal(embeddings.has('b'), false);
});

test('corrupt lines are skipped, not fatal', () => {
    const dir = freshDir();
    const store = new MemoryStore(dir);
    store.appendEvent({ id: 'a', ts: 1, type: 'speech', content: 'ok', importance: 0.4 });
    appendFileSync(path.join(dir, 'events.jsonl'), '{truncated garba\n');
    store.appendEvent({ id: 'b', ts: 2, type: 'speech', content: 'still ok', importance: 0.4 });

    const { events } = new MemoryStore(dir).loadAll();
    assert.deepEqual(events.map(e => e.id), ['a', 'b']);
});

test('empty store loads cleanly', () => {
    const { events, embeddings } = new MemoryStore(freshDir()).loadAll();
    assert.deepEqual(events, []);
    assert.equal(embeddings.size, 0);
});
