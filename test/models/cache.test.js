import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CACHE_BOUNDARY, MIN_CACHEABLE_CHARS, splitCachePrefix, stripBoundary, hasBoundary } from '../../src/models/cache.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaults = JSON.parse(readFileSync(path.join(root, 'profiles/defaults/_default.json'), 'utf8'));

test('splitting separates the stable prefix from the volatile tail', () => {
    const s = 'STABLE' + CACHE_BOUNDARY + 'VOLATILE';
    const { prefix, rest } = splitCachePrefix(s);
    assert.equal(prefix, 'STABLE');
    assert.equal(rest, 'VOLATILE');
});

test('a prefix below the provider minimum is not marked cacheable', () => {
    assert.equal(splitCachePrefix('short' + CACHE_BOUNDARY + 'tail').cacheable, false);
    const big = 'x'.repeat(Math.ceil(MIN_CACHEABLE_CHARS) + 1);
    assert.equal(splitCachePrefix(big + CACHE_BOUNDARY + 'tail').cacheable, true);
});

test('no boundary means no prefix and no crash', () => {
    const { prefix, rest, cacheable } = splitCachePrefix('just a prompt');
    assert.equal(prefix, '');
    assert.equal(rest, 'just a prompt');
    assert.equal(cacheable, false);
    assert.equal(hasBoundary(undefined), false);
    assert.equal(splitCachePrefix(undefined).rest, '');
});

test('stripping leaves no marker for providers that cannot use it', () => {
    const s = 'A' + CACHE_BOUNDARY + 'B';
    assert.ok(!stripBoundary(s).includes('CACHE_BOUNDARY'));
    assert.ok(stripBoundary(s).includes('A') && stripBoundary(s).includes('B'));
    assert.equal(stripBoundary(null), null); // non-strings pass through
});

test('the shipped templates put a genuinely cacheable prefix first', () => {
    for (const key of ['conversing', 'coding']) {
        const t = defaults[key];
        assert.ok(hasBoundary(t), `${key} has no cache boundary`);
        const { prefix, rest } = splitCachePrefix(t);
        // volatile things MUST come after the boundary or the cache never hits
        for (const volatile_token of ['$STATS', '$INVENTORY', '$MEMORY', '$EXAMPLES']) {
            if (!t.includes(volatile_token)) continue;
            assert.ok(!prefix.includes(volatile_token), `${key}: ${volatile_token} is inside the cached prefix`);
            assert.ok(rest.includes(volatile_token), `${key}: ${volatile_token} missing after the boundary`);
        }
    }
    // the big static block must be inside the prefix, or there is nothing to cache
    assert.ok(splitCachePrefix(defaults.conversing).prefix.includes('$COMMAND_DOCS'));
});

test('with command docs rendered, the conversing prefix clears the provider minimum', () => {
    // $COMMAND_DOCS renders to ~8.7k chars; that is what makes this worth doing
    const rendered = defaults.conversing
        .replaceAll('$COMMAND_DOCS', 'x'.repeat(8774))
        .replaceAll('$NAME', 'Andy');
    const { prefix, cacheable } = splitCachePrefix(rendered);
    assert.ok(cacheable, 'rendered prefix should exceed the minimum');
    assert.ok(prefix.length > MIN_CACHEABLE_CHARS);
});

test('every profile that overrides conversing keeps a usable boundary', () => {
    // a profile can override the template; if it does, it must not silently
    // lose caching or (worse) leave volatile state inside the prefix
    const overrides = ['profiles/andy-4-reasoning.json', 'profiles/tasks/cooking_profile.json',
        'profiles/tasks/construction_profile.json', 'profiles/tasks/crafting_profile.json'];
    for (const f of overrides) {
        const p = JSON.parse(readFileSync(path.join(root, f), 'utf8'));
        if (!p.conversing) continue;
        if (!hasBoundary(p.conversing)) continue; // no boundary is legal: just no caching
        const { prefix } = splitCachePrefix(p.conversing);
        for (const v of ['$STATS', '$INVENTORY', '$MEMORY'])
            assert.ok(!prefix.includes(v), `${f}: ${v} inside the cached prefix defeats caching`);
    }
});
