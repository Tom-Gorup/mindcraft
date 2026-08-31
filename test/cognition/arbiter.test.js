import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDrive } from '../../src/agent/cognition/arbiter.js';

function u(name, urgency, on_cooldown = false) {
    return { name, urgency, level: 1 - urgency, weight: 1, on_cooldown };
}

test('picks the most urgent eligible drive', () => {
    const drives = [u('safety', 0.3), u('curiosity', 0.6), u('wealth', 0.4)];
    assert.equal(selectDrive(drives), 'curiosity');
});

test('returns null when nothing exceeds min_urgency (contentment)', () => {
    const drives = [u('safety', 0.1), u('curiosity', 0.2)];
    assert.equal(selectDrive(drives, null, { min_urgency: 0.25 }), null);
});

test('ignores drives on cooldown', () => {
    const drives = [u('curiosity', 0.9, true), u('wealth', 0.4)];
    assert.equal(selectDrive(drives), 'wealth');
});

test('hysteresis: sticks with current drive within switch_margin', () => {
    const drives = [u('curiosity', 0.55), u('wealth', 0.5)];
    assert.equal(selectDrive(drives, 'wealth', { switch_margin: 0.1 }), 'wealth');
});

test('hysteresis: switches when beaten by a clear margin', () => {
    const drives = [u('curiosity', 0.65), u('wealth', 0.5)];
    assert.equal(selectDrive(drives, 'wealth', { switch_margin: 0.1 }), 'curiosity');
});

test('switches away from a current drive that dropped below min_urgency', () => {
    const drives = [u('curiosity', 0.5), u('wealth', 0.1)];
    assert.equal(selectDrive(drives, 'wealth', { min_urgency: 0.25 }), 'curiosity');
});

test('unsorted input is handled', () => {
    const drives = [u('wealth', 0.3), u('safety', 0.9), u('curiosity', 0.5)];
    assert.equal(selectDrive(drives), 'safety');
});
