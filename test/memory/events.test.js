import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEvent, shouldEmbed, EVENT_TYPES } from '../../src/agent/memory/events.js';

test('makeEvent applies type defaults and caps content', () => {
    const e = makeEvent('death', 'x'.repeat(600));
    assert.equal(e.type, 'death');
    assert.equal(e.importance, EVENT_TYPES.death.importance);
    assert.equal(e.content.length, 500);
    assert.ok(e.id.includes('-'));
    assert.ok(typeof e.ts === 'number');
});

test('unknown types map to other; importance overridable and clamped', () => {
    const e = makeEvent('nonsense', 'hello', {}, { importance: 5 });
    assert.equal(e.type, 'other');
    assert.equal(e.importance, 1);
});

test('ids are unique and ordered within a burst', () => {
    const a = makeEvent('speech', 'one', {}, { ts: 42 });
    const b = makeEvent('speech', 'two', {}, { ts: 42 });
    assert.notEqual(a.id, b.id);
});

test('shouldEmbed follows taxonomy', () => {
    assert.equal(shouldEmbed(makeEvent('belief', 'insight')), true);
    assert.equal(shouldEmbed(makeEvent('narration', 'Picking up item!')), false);
    assert.equal(shouldEmbed(makeEvent('command', '!stats: ...')), false);
    assert.equal(shouldEmbed(makeEvent('speech', 'hi', {}, { importance: 0.01 })), false);
});
