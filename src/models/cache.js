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

// Anthropic's minimum cacheable prefix is 1024 tokens (2048 on Haiku); below
// that a breakpoint is ignored and costs a little extra. ~4.2 chars/token.
export const MIN_CACHEABLE_CHARS = 1024 * 4.2;

export function hasBoundary(system) {
    return typeof system === 'string' && system.includes(CACHE_BOUNDARY);
}

// -> { prefix, rest, cacheable } . prefix is '' when there is no boundary.
export function splitCachePrefix(system) {
    if (!hasBoundary(system))
        return { prefix: '', rest: String(system ?? ''), cacheable: false };
    const i = system.indexOf(CACHE_BOUNDARY);
    const prefix = system.substring(0, i);
    const rest = system.substring(i + CACHE_BOUNDARY.length);
    return { prefix, rest, cacheable: prefix.length >= MIN_CACHEABLE_CHARS };
}

// For providers with no explicit breakpoint: remove the marker, keep the text.
export function stripBoundary(system) {
    return typeof system === 'string' ? system.split(CACHE_BOUNDARY).join('\n') : system;
}
