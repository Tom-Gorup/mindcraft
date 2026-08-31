import test from 'node:test';
import assert from 'node:assert/strict';
import { strictFormat } from '../../src/utils/text.js';

// Anthropic is the strictest consumer of this: it requires a leading user
// message, alternating roles, and rejects empty text blocks with a 400.
test('roles alternate and the list starts with a user message', () => {
    const out = strictFormat([
        { role: 'assistant', content: 'hi' },
        { role: 'assistant', content: 'still me' },
        { role: 'user', content: 'hello' },
    ]);
    assert.equal(out[0].role, 'user');
    for (let i = 1; i < out.length; i++)
        assert.notEqual(out[i].role, out[i - 1].role, `turns ${i - 1} and ${i} share a role`);
});

test('system turns become user turns and are tagged', () => {
    const out = strictFormat([{ role: 'system', content: 'do the thing' }]);
    assert.equal(out[0].role, 'user');
    assert.match(out[0].content, /^SYSTEM: /);
});

// The default persona instructs the bot to answer with a bare tab when it has
// nothing to say, and command results can come back blank. Either one used to
// reach the API as an empty text block, which is a hard 400.
test('empty and whitespace-only turns are dropped, never emitted', () => {
    const out = strictFormat([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '\t' },
        { role: 'user', content: '   ' },
        { role: 'assistant', content: 'real answer' },
    ]);
    for (const m of out)
        assert.ok(String(m.content).trim().length > 0, `empty content survived: ${JSON.stringify(m)}`);
    assert.ok(out.some(m => m.content === 'real answer'));
});

test('an all-empty history still yields one valid user turn', () => {
    const out = strictFormat([{ role: 'assistant', content: '  ' }, { role: 'user', content: '' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'user');
    assert.ok(out[0].content.length > 0);
});

test('an empty turn list yields one valid user turn', () => {
    const out = strictFormat([]);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'user');
});

// Each inserted separator must be its own object — a shared one could be
// mutated by a later append and change every position at once.
test('inserted separators are independent objects', () => {
    const out = strictFormat([
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'assistant', content: 'c' },
    ]);
    const fillers = out.filter(m => m.content === '_');
    assert.ok(fillers.length >= 2);
    fillers[0].content = 'mutated';
    assert.equal(fillers[1].content, '_', 'separators share an object reference');
});
