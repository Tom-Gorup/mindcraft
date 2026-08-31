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
const CHARS_PER_TOKEN = 4.2;
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
