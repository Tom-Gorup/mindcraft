// Per-machine profile overrides, so browser edits survive a restart.
//
// The dashboard's Configure button called set-profile, which updated the
// agent's settings IN MEMORY and restarted the process. Nothing was ever
// written, so every personality tweak made in the browser was silently lost on
// the next `systemctl restart` — which is how a configured `legacy: 0.9`
// disappeared between two runs while genuinely being active for one of them.
//
// Writing back to profiles/<name>.json is not the fix: those are tracked, so
// every edit becomes a git conflict on pull and a candidate for leaking machine
// specifics into a public repo. This is the same shape as settings.local.json —
// a gitignored overlay that wins over the tracked file.
//
// The overlay stores only the DIFFERENCE from the tracked profile, which means
// improvements to the tracked profile still reach you on pull, and the overlay
// stays a readable record of exactly what you changed and nothing else.
//
// Merge semantics match the existing profile merge: shallow at the top level,
// so overriding a block replaces that whole block. Deliberate — a deep merge
// makes it impossible to remove an entry from a block.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import path from 'path';

export const OVERLAY_DIR = './profiles/local';

// The agent name becomes a filename. Anything outside this set is refused
// rather than sanitised, because a "cleaned" name could collide with another
// agent's overlay and hand one agent another's configuration.
const SAFE_NAME = /^[a-zA-Z0-9_]{1,32}$/;

export function overlayPath(name) {
    if (!SAFE_NAME.test(String(name ?? ''))) return null;
    return path.join(OVERLAY_DIR, `${name}.json`);
}

// Runtime settings are a separate file from the profile: they answer a
// different question (how the process runs, vs who the agent is), they are
// edited from a different dialog, and mixing them would make either one hard
// to read by hand.
export function settingsOverlayPath(name) {
    if (!SAFE_NAME.test(String(name ?? ''))) return null;
    return path.join(OVERLAY_DIR, `${name}.settings.json`);
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameValue(a, b) {
    // Profiles are plain JSON, so structural comparison is sound and cheap.
    return JSON.stringify(a) === JSON.stringify(b);
}

// Only the top-level keys where `edited` differs from `base`.
export function diffProfile(base, edited) {
    const out = {};
    if (!isPlainObject(edited)) return out;
    for (const [k, v] of Object.entries(edited)) {
        if (k === 'name') continue;                 // pinned; it is the identity
        if (!sameValue(v, base?.[k])) out[k] = v;
    }
    return out;
}

export function readOverlay(name) {
    const p = overlayPath(name);
    if (!p || !existsSync(p)) return null;
    try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        return isPlainObject(parsed) ? parsed : null;
    } catch (err) {
        // Loud, not silent: a malformed overlay changes which personality runs.
        console.error(`Profile overlay ${p} could not be read: ${err.message}`);
        console.error('Ignoring it and using the tracked profile. Fix the JSON and restart.');
        return null;
    }
}

// Write the overlay for `name`, or remove it when nothing differs — an empty
// file left behind reads as "there are overrides here" and invites confusion.
export function writeOverlay(name, base, edited) {
    const p = overlayPath(name);
    if (!p) throw new Error(`Refusing to write an overlay for unsafe agent name: ${name}`);
    const diff = diffProfile(base, edited);
    if (Object.keys(diff).length === 0) {
        if (existsSync(p)) unlinkSync(p);
        return { path: p, keys: [] };
    }
    mkdirSync(OVERLAY_DIR, { recursive: true });
    const body = {
        '//': `Local overrides for ${name}, written by the dashboard. Gitignored. `
            + 'Only keys that differ from the tracked profile are stored, so improvements '
            + 'to the tracked profile still reach you. Delete this file to revert.',
        ...diff,
    };
    // Atomic: a half-written overlay on a crash would be a corrupt personality.
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 4) + '\n');
    renameSync(tmp, p);
    return { path: p, keys: Object.keys(diff) };
}

// ---- runtime settings overlay -------------------------------------------
//
// set-agent-settings had exactly the same defect as set-profile: it updated the
// agent in memory and restarted the process without writing anything, so every
// checkbox in the Settings dialog was a claim about durability that was not
// true. This is the same diff-and-merge, pointed at settings.

// Never stored: these are structural rather than per-agent preferences, and an
// overlay that pinned them would quietly override the operator's own files.
const SETTINGS_NEVER_STORE = new Set(['profile', 'profiles']);

export function diffSettings(base, edited) {
    const out = {};
    if (!isPlainObject(edited)) return out;
    for (const [k, v] of Object.entries(edited)) {
        if (SETTINGS_NEVER_STORE.has(k)) continue;
        if (!sameValue(v, base?.[k])) out[k] = v;
    }
    return out;
}

export function readSettingsOverlay(name) {
    const p = settingsOverlayPath(name);
    if (!p || !existsSync(p)) return null;
    try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        return isPlainObject(parsed) ? parsed : null;
    } catch (err) {
        console.error(`Settings overlay ${p} could not be read: ${err.message}`);
        console.error('Ignoring it and using the global settings. Fix the JSON and restart.');
        return null;
    }
}

export function writeSettingsOverlay(name, base, edited) {
    const p = settingsOverlayPath(name);
    if (!p) throw new Error(`Refusing to write a settings overlay for unsafe agent name: ${name}`);
    const diff = diffSettings(base, edited);
    if (Object.keys(diff).length === 0) {
        if (existsSync(p)) unlinkSync(p);
        return { path: p, keys: [] };
    }
    mkdirSync(OVERLAY_DIR, { recursive: true });
    const body = {
        '//': `Runtime settings for ${name}, written by the dashboard. Gitignored. `
            + 'Only keys that differ from the global settings are stored. Delete this file to revert.',
        ...diff,
    };
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 4) + '\n');
    renameSync(tmp, p);
    return { path: p, keys: Object.keys(diff) };
}

// Apply an agent's settings overlay over the global settings. Returns a NEW
// object: the caller reuses one settings object across agents in a loop, and
// mutating it would leak one agent's overrides into the next.
export function applySettingsOverlay(name, base) {
    const overlay = readSettingsOverlay(name);
    if (!overlay) return { ...base };
    const merged = { ...base };
    const applied = [];
    for (const [k, v] of Object.entries(overlay)) {
        if (k.startsWith('//') || SETTINGS_NEVER_STORE.has(k)) continue;
        merged[k] = v;
        applied.push(k);
    }
    if (applied.length)
        console.log(`Settings overlay for ${name}: ${applied.join(', ')}`);
    return merged;
}

// Read a tracked profile and apply its overlay. Returns the merged profile.
export function loadProfile(profilePath) {
    const base = JSON.parse(readFileSync(profilePath, 'utf8'));
    const overlay = readOverlay(base?.name);
    if (!overlay) return base;
    const merged = { ...base };
    const applied = [];
    for (const [k, v] of Object.entries(overlay)) {
        if (k.startsWith('//')) continue;           // comment keys
        if (k === 'name') continue;                 // never let an overlay rename an agent
        merged[k] = v;
        applied.push(k);
    }
    if (applied.length)
        console.log(`Profile overlay for ${base.name}: ${applied.join(', ')}`);
    return merged;
}
