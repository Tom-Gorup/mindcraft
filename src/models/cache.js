// Prompt caching support.
//
// Providers cache on an exact PREFIX of the request. That only pays off if the
// large static part of a system prompt comes first and the volatile part last,
// which is why the templates put $COMMAND_DOCS ahead of $STATS/$MEMORY.
//
// CACHE_BOUNDARY marks where the stable prefix ends. Providers that support an
// explicit cache breakpoint (Anthropic) split there and mark the prefix
// cacheable; every other provider just has the marker stripped and benefits
// from the ordering alone via automatic prefix caching.

export const CACHE_BOUNDARY = '\n<<<CACHE_BOUNDARY>>>\n';

// Anthropic's minimum cacheable prefix is model-dependent: 1024 tokens on
// Sonnet/Opus, 2048 on Haiku. Below the bar the breakpoint is silently ignored
// — no error, no hit, and the cache-write premium is still charged — so the
// threshold has to follow the model, not a single constant.
// Deliberately ABOVE the observed ratio. Estimating tokens from characters
// decides whether to send a cache breakpoint at all, and the two errors are not
// symmetric: claiming cacheable when the prefix is under the model's floor gets
// the breakpoint silently ignored and still pays the cache-write premium, while
// being too cautious only forgoes a marginal cache. Measured against a real
// Haiku run the true ratio was ~4.41 chars/token for this prompt, and a 4.2
// estimate wrongly reported 2107 tokens for a prefix Anthropic counted as
// ~2007 — 41 short of the floor, and the cache never engaged.
const CHARS_PER_TOKEN = 5.3;
export const MIN_CACHEABLE_TOKENS = 1024;
export const MIN_CACHEABLE_TOKENS_SMALL = 2048;
export const MIN_CACHEABLE_CHARS = MIN_CACHEABLE_TOKENS * CHARS_PER_TOKEN;

// Haiku (and any future small model) needs the higher bar. Unknown models get
// the conservative one: forgoing a marginal cache beats paying for one that
// never hits.
export function minCacheableChars(model_name) {
    const m = String(model_name || '').toLowerCase();
    const tokens = (!m || m.includes('haiku')) ? MIN_CACHEABLE_TOKENS_SMALL : MIN_CACHEABLE_TOKENS;
    return tokens * CHARS_PER_TOKEN;
}

export function hasBoundary(system) {
    return typeof system === 'string' && system.includes(CACHE_BOUNDARY);
}

// -> { prefix, rest, cacheable } . prefix is '' when there is no boundary.
export function splitCachePrefix(system, model_name) {
    if (!hasBoundary(system))
        return { prefix: '', rest: String(system ?? ''), cacheable: false };
    const i = system.indexOf(CACHE_BOUNDARY);
    const prefix = system.substring(0, i);
    const rest = system.substring(i + CACHE_BOUNDARY.length);
    return { prefix, rest, cacheable: prefix.length >= minCacheableChars(model_name) };
}

// For providers with no explicit breakpoint: remove the marker, keep the text.
export function stripBoundary(system) {
    return typeof system === 'string' ? system.split(CACHE_BOUNDARY).join('\n') : system;
}
