import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const spec = JSON.parse(readFileSync(path.join(root, 'src/mindcraft/public/profile_spec.json'), 'utf8'));
const defaults = JSON.parse(readFileSync(path.join(root, 'profiles/defaults/_default.json'), 'utf8'));

// The profile editor generates its whole form from this spec, and the
// mindserver filters incoming profiles against it. Drift here silently drops
// user config, so these are structural guards rather than trivia.

const KNOWN_TYPES = new Set(['string', 'number', 'boolean', 'object', 'model', 'prompt']);
const KNOWN_SECTIONS = new Set(['identity', 'models', 'routing', 'personality', 'behavior', 'tuning', 'prompts']);

function entries() {
    return Object.entries(spec).filter(([k]) => !k.startsWith('_'));
}

test('every spec entry has a known type and a section the editor renders', () => {
    for (const [key, def] of entries()) {
        assert.ok(KNOWN_TYPES.has(def.type), `${key}: unknown type ${def.type}`);
        assert.ok(KNOWN_SECTIONS.has(def.section), `${key}: unrenderable section ${def.section}`);
        assert.equal(typeof def.description, 'string', `${key}: needs a description for the UI`);
    }
});

test('object entries describe their fields so the editor can build inputs', () => {
    for (const [key, def] of entries()) {
        if (def.type !== 'object') continue;
        assert.ok(def.fields, `${key}: object without fields renders as opaque JSON`);
        for (const [fk, fd] of Object.entries(def.fields)) {
            assert.ok(KNOWN_TYPES.has(fd.type), `${key}.${fk}: unknown type`);
            assert.equal(typeof fd.description, 'string', `${key}.${fk}: needs a description`);
            if (fd.type === 'number' && fd.min !== undefined && fd.max !== undefined)
                assert.ok(fd.min < fd.max, `${key}.${fk}: min must be below max`);
        }
    }
});

test('every prompt template in the spec exists in the default profile', () => {
    for (const [key, def] of entries()) {
        if (def.type !== 'prompt') continue;
        assert.equal(typeof defaults[key], 'string', `${key}: spec advertises a prompt the defaults do not provide`);
    }
});

test('the config blocks every phase added are all editable', () => {
    // the UI-parity debt this phase exists to clear
    for (const block of ['drives', 'social', 'cognition', 'memory', 'skills', 'tiers', 'modes'])
        assert.ok(spec[block], `${block} has no editor entry — config would be JSON-only`);
});

test('drives spec covers the drives the engine actually ships', async () => {
    const { DEFAULT_DRIVES } = await import('../../src/agent/cognition/drives.js');
    for (const name of Object.keys(DEFAULT_DRIVES))
        assert.ok(spec.drives.keys.includes(name), `drive '${name}' is missing from the editor`);
});

test('tiers spec matches the router tier list exactly', async () => {
    const { TIERS } = await import('../../src/models/router.js');
    assert.deepEqual(Object.keys(spec.tiers.fields).sort(), [...TIERS].sort());
});

test('modes spec matches the reflexes modes.js defines', () => {
    const src = readFileSync(path.join(root, 'src/agent/modes.js'), 'utf8');
    const names = [...src.matchAll(/^\s{8}name: '(\w+)',$/gm)].map(m => m[1]);
    assert.ok(names.length >= 9, 'failed to parse mode names');
    for (const n of names)
        assert.ok(spec.modes.fields[n], `mode '${n}' is missing from the editor`);
});
