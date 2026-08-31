import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSubjects, selectGossip, shouldGossip, credibility, attributedNote } from '../../src/agent/social/gossip.js';

const NOW = 1_000_000_000;

function ev(id, content, importance, age_ms = 0, type = 'speech', data = {}) {
    return { id, content, importance, ts: NOW - age_ms, type, data };
}

test('extractSubjects finds known names on word boundaries only', () => {
    const known = ['Wilbur', 'Steve', 'Andy'];
    assert.deepEqual(extractSubjects('Wilbur took the diamonds', known), ['Wilbur']);
    assert.deepEqual(extractSubjects('Wilburson is fine', known), []); // no partial match
    assert.deepEqual(extractSubjects('Steve and Andy argued', known), ['Steve', 'Andy']);
    assert.deepEqual(extractSubjects('Wilbur helped', known, ['Wilbur']), []); // excluded
});

test('selectGossip prefers important, recent, third-party memories', () => {
    const known = ['Wilbur', 'Steve'];
    const events = [
        ev('a', 'Wilbur stole from the chest', 0.9, 60000),
        ev('b', 'I mined some stone', 0.6, 1000),           // no subject
        ev('c', 'Steve said hello', 0.55, 5 * 3600000),      // old
    ];
    const pick = selectGossip(events, 'Steve', known, { now: NOW });
    assert.equal(pick.event.id, 'a');
    assert.equal(pick.subject, 'Wilbur');
});

test('selectGossip filters noise, staleness, and what the listener told us', () => {
    const known = ['Wilbur'];
    assert.equal(selectGossip([ev('n', 'Wilbur x', 0.9, 0, 'narration')], 'Steve', known, { now: NOW }), null);
    assert.equal(selectGossip([ev('c', 'Wilbur x', 0.9, 0, 'command')], 'Steve', known, { now: NOW }), null);
    assert.equal(selectGossip([ev('l', 'Wilbur x', 0.2)], 'Steve', known, { now: NOW }), null); // low importance
    assert.equal(selectGossip([ev('o', 'Wilbur x', 0.9, 99 * 3600000)], 'Steve', known, { now: NOW }), null); // stale
    // don't repeat back what the listener themselves told us
    const from_listener = [ev('s', 'Wilbur x', 0.9, 0, 'chat_received', { source: 'Steve' })];
    assert.equal(selectGossip(from_listener, 'Steve', known, { now: NOW }), null);
});

test('already-told memories are not repeated', () => {
    const known = ['Wilbur'];
    const events = [ev('a', 'Wilbur stole from the chest', 0.9)];
    assert.ok(selectGossip(events, 'Steve', known, { now: NOW }));
    const told = new Set(['a']);
    assert.equal(selectGossip(events, 'Steve', known, { now: NOW, already_told: told }), null);
});

test('gossip propensity and closeness gate sharing', () => {
    assert.equal(shouldGossip(0, 1, 0.0001), false);   // never gossips
    assert.equal(shouldGossip(1, 1, 0.5), true);       // chatterbox with a friend
    assert.equal(shouldGossip(0.5, -1, 0.2), false);   // won't confide in someone disliked
    assert.equal(shouldGossip(0.5, 1, 0.2), true);     // will confide in a friend
});

test('credibility scales with trust and is always damped', () => {
    assert.equal(credibility(0), 0);
    assert.ok(credibility(0.5) > 0 && credibility(0.5) < 0.5);
    assert.ok(credibility(1) <= 0.6, 'hearsay never counts as fully as firsthand');
    assert.ok(credibility(1) > credibility(0.4));
});

test('attribution keeps provenance and stays single-line', () => {
    const note = attributedNote('Andy', 'Steve', 'he stole\nfrom the chest');
    assert.match(note, /^Andy told me about Steve:/);
    assert.ok(!note.includes('\n'));
});
