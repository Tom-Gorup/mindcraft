import test from 'node:test';
import assert from 'node:assert/strict';
import { recencyScore, scoreEvent, rankEvents, humanizeAge, DEFAULT_WEIGHTS } from '../../src/agent/memory/scoring.js';

const HOUR = 3600000;

test('recency decays by half each half-life', () => {
    const now = 1000 * HOUR;
    assert.equal(recencyScore(now, now, 24), 1);
    assert.ok(Math.abs(recencyScore(now - 24 * HOUR, now, 24) - 0.5) < 1e-9);
    assert.ok(Math.abs(recencyScore(now - 48 * HOUR, now, 24) - 0.25) < 1e-9);
    assert.equal(recencyScore(now + HOUR, now, 24), 1); // future-safe
});

test('scoreEvent is a weighted average', () => {
    assert.ok(Math.abs(scoreEvent(1, 1, 1, DEFAULT_WEIGHTS) - 1) < 1e-9);
    // default weights total 4 with relevance counted double
    assert.ok(Math.abs(scoreEvent(0.9, 0, 0, DEFAULT_WEIGHTS) - 0.225) < 1e-9);
    assert.ok(Math.abs(scoreEvent(0, 0.9, 0, DEFAULT_WEIGHTS) - 0.45) < 1e-9);
    // zeroing a weight removes that factor
    assert.ok(Math.abs(scoreEvent(0, 1, 0, { recency: 0, relevance: 1, importance: 1 }) - 0.5) < 1e-9);
});

test('rankEvents sorts by combined score and respects k', () => {
    const now = 100 * HOUR;
    const events = [
        { id: 'old_important', ts: now - 72 * HOUR, importance: 0.9, content: 'a' },
        { id: 'new_trivial', ts: now, importance: 0.05, content: 'b' },
        { id: 'new_relevant', ts: now - HOUR, importance: 0.3, content: 'c' },
    ];
    const relevance = e => e.id === 'new_relevant' ? 1 : 0.1;
    const ranked = rankEvents(events, relevance, now, { k: 2 });
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].event.id, 'new_relevant');
    assert.ok(ranked[0].score > ranked[1].score);
});

test('rankEvents min_score filters', () => {
    const now = 0;
    const events = [{ id: 'x', ts: now, importance: 0, content: 'x' }];
    assert.equal(rankEvents(events, () => 0, now, { min_score: 0.5 }).length, 0);
});

test('humanizeAge buckets', () => {
    const now = 1000 * HOUR;
    assert.equal(humanizeAge(now, now), 'just now');
    assert.equal(humanizeAge(now - 5 * 60000, now), '5m ago');
    assert.equal(humanizeAge(now - 3 * HOUR, now), '3h ago');
    assert.equal(humanizeAge(now - 72 * HOUR, now), '3d ago');
});
