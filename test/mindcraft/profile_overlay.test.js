// Browser edits must survive a restart, without touching tracked files.
//
// set-profile used to update the agent in memory only, so every personality
// tweak made in Configure was lost on the next restart — how a configured
// legacy: 0.9 vanished between two runs while genuinely being active for one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    diffProfile,
    overlayPath,
    readOverlay,
    writeOverlay,
    loadProfile,
    writeSettingsOverlay,
    readSettingsOverlay,
    applySettingsOverlay,
    diffSettings,
    settingsOverlayPath,
} from '../../src/mindcraft/profile_overlay.js';

function sandbox(fn) {
    const w = path.join(os.tmpdir(), `mc-overlay-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(w, 'profiles'), { recursive: true });
    const cwd = process.cwd();
    process.chdir(w);
    try { return fn(w); } finally { process.chdir(cwd); rmSync(w, { recursive: true, force: true }); }
}

const BASE = { name: 'Wilbur', model: 'claude-haiku-4-5', drives: { safety: { weight: 0.9 } } };

test('the overlay stores only what differs', () => {
    const diff = diffProfile(BASE, { ...BASE, drives: { legacy: { weight: 0.9 } } });
    assert.deepEqual(diff, { drives: { legacy: { weight: 0.9 } } },
        'an unchanged model must not be duplicated into the overlay');
});

test('the agent name is never stored, so an overlay cannot rename an agent', () => {
    assert.deepEqual(diffProfile(BASE, { ...BASE, name: 'Someone_Else' }), {});
});

test('an edit survives a round trip to disk', () => sandbox(() => {
    writeOverlay('Wilbur', BASE, { ...BASE, drives: { legacy: { weight: 0.9 } } });
    assert.deepEqual(readOverlay('Wilbur').drives, { legacy: { weight: 0.9 } });
}));

test('loadProfile merges the overlay over the tracked profile', () => sandbox(() => {
    writeFileSync('./profiles/wilbur.json', JSON.stringify(BASE));
    writeOverlay('Wilbur', BASE, { ...BASE, drives: { legacy: { weight: 0.9 } } });

    const merged = loadProfile('./profiles/wilbur.json');
    assert.deepEqual(merged.drives, { legacy: { weight: 0.9 } }, 'the override wins');
    assert.equal(merged.model, 'claude-haiku-4-5', 'untouched keys come from the tracked profile');
    assert.equal(readFileSync('./profiles/wilbur.json', 'utf8'), JSON.stringify(BASE),
        'the tracked profile is never modified');
}));

// The point of storing a diff: pulling an improved tracked profile still
// reaches you, except where you deliberately overrode it.
test('improvements to the tracked profile still arrive', () => sandbox(() => {
    writeFileSync('./profiles/wilbur.json', JSON.stringify(BASE));
    writeOverlay('Wilbur', BASE, { ...BASE, drives: { legacy: { weight: 0.9 } } });

    const upstream = { ...BASE, model: 'claude-sonnet-5', cognition: { needs_gate: 0.55 } };
    writeFileSync('./profiles/wilbur.json', JSON.stringify(upstream));

    const merged = loadProfile('./profiles/wilbur.json');
    assert.equal(merged.model, 'claude-sonnet-5', 'the upstream change arrives');
    assert.deepEqual(merged.cognition, { needs_gate: 0.55 }, 'so does a new upstream key');
    assert.deepEqual(merged.drives, { legacy: { weight: 0.9 } }, 'the deliberate override survives');
}));

test('reverting every change removes the overlay rather than leaving it empty', () => sandbox(() => {
    writeOverlay('Wilbur', BASE, { ...BASE, model: 'x' });
    assert.ok(existsSync(overlayPath('Wilbur')));
    const res = writeOverlay('Wilbur', BASE, { ...BASE });
    assert.deepEqual(res.keys, []);
    assert.ok(!existsSync(overlayPath('Wilbur')),
        'an empty file reads as "there are overrides here"');
}));

// The name becomes a filename. Refused, not sanitised: a cleaned name could
// collide with another agent's overlay and hand it the wrong configuration.
test('an unsafe agent name is refused, not cleaned', () => sandbox(() => {
    for (const bad of ['../../keys', 'a/b', '', 'x'.repeat(33), 'has space'])
        assert.equal(overlayPath(bad), null, `${JSON.stringify(bad)} must be refused`);
    assert.throws(() => writeOverlay('../../keys', BASE, { model: 'x' }), /unsafe agent name/);
}));

test('a corrupt overlay is ignored loudly rather than crashing the boot', () => sandbox(() => {
    writeFileSync('./profiles/wilbur.json', JSON.stringify(BASE));
    mkdirSync('./profiles/local', { recursive: true });
    writeFileSync('./profiles/local/Wilbur.json', '{ this is not json');

    const merged = loadProfile('./profiles/wilbur.json');
    assert.equal(merged.model, 'claude-haiku-4-5', 'falls back to the tracked profile');
}));

test('comment keys in the overlay are not applied as config', () => sandbox(() => {
    writeFileSync('./profiles/wilbur.json', JSON.stringify(BASE));
    mkdirSync('./profiles/local', { recursive: true });
    writeFileSync('./profiles/local/Wilbur.json', JSON.stringify({ '//': 'a note', model: 'x' }));

    const merged = loadProfile('./profiles/wilbur.json');
    assert.equal(merged.model, 'x');
    assert.ok(!('//' in merged), 'the comment key must not reach the profile');
}));

// ---- runtime settings overlay ----
//
// set-agent-settings had the same defect: in-memory only, so every checkbox in
// the Settings dialog was a claim about durability that was not true. This is
// the "why didn't use_cognition persist?" bug.

const SETTINGS = { host: '192.168.10.50', port: 25565, use_cognition: false, world: '' };

test('a settings edit survives a restart', () => sandbox(() => {
    writeSettingsOverlay('Wilbur', SETTINGS, { ...SETTINGS, use_cognition: true, world: 'homelab' });
    const merged = applySettingsOverlay('Wilbur', SETTINGS);
    assert.equal(merged.use_cognition, true);
    assert.equal(merged.world, 'homelab');
    assert.equal(merged.host, '192.168.10.50', 'untouched keys come from the global settings');
}));

// The caller reuses one settings object across agents in a loop; mutating it
// would leak one agent's overrides into the next.
test('applying an overlay does not mutate the shared settings object', () => sandbox(() => {
    writeSettingsOverlay('Wilbur', SETTINGS, { ...SETTINGS, use_cognition: true });
    const shared = { ...SETTINGS };
    const merged = applySettingsOverlay('Wilbur', shared);
    assert.equal(merged.use_cognition, true);
    assert.equal(shared.use_cognition, false, 'the base must be untouched');
    assert.notEqual(merged, shared, 'a new object, not the same reference');

    const other = applySettingsOverlay('Greta', shared);
    assert.equal(other.use_cognition, false, "Wilbur's override must not reach Greta");
}));

// Storing these would let a dashboard edit quietly override which profiles the
// operator's own settings file says to run.
test('structural keys are never stored in an overlay', () => {
    const diff = diffSettings(SETTINGS, {
        ...SETTINGS, use_cognition: true,
        profiles: ['./evil.json'], profile: { name: 'X' },
    });
    assert.deepEqual(diff, { use_cognition: true });
});

test('profile and settings overlays are separate files', () => sandbox(() => {
    writeOverlay('Wilbur', BASE, { ...BASE, model: 'x' });
    writeSettingsOverlay('Wilbur', SETTINGS, { ...SETTINGS, port: 25566 });
    assert.notEqual(overlayPath('Wilbur'), settingsOverlayPath('Wilbur'));
    assert.equal(readOverlay('Wilbur').model, 'x', 'the profile overlay is intact');
    assert.equal(readSettingsOverlay('Wilbur').port, 25566, 'and so is the settings overlay');
}));

test('a settings overlay for an unsafe name is refused', () => {
    assert.equal(settingsOverlayPath('../../keys'), null);
    assert.throws(() => writeSettingsOverlay('../../keys', SETTINGS, { port: 1 }), /unsafe agent name/);
});
