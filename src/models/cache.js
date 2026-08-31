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

// Anthropic's minimum cacheable prefix is model-dependent, and the published
// figures do not carry forward between model generations. MEASURED with
// tools/probe_cache_floor.mjs against the live API:
//
//   claude-haiku-4-5   caching begins between 3,149 and 4,114 tokens (~4096)
//   sonnet / opus      1024 (documented, and our prefix clears it easily)
//
// The 2048 figure widely cited for "Haiku" is Haiku 3/3.5. Assuming it applied
// to 4.5 cost several debugging rounds: the breakpoint was sent every time, the
// API parsed it, and it silently declined to write anything.
//
// Re-probe when adding a model. Do not infer this from documentation.
const CHARS_PER_TOKEN = 3.6;   // measured; see tools/count_prompt_tokens.mjs

// Longest-prefix wins, so a dated id resolves to its family.
export const CACHE_FLOORS = [
    ['claude-haiku-4-5', 4096],   // MEASURED
    ['claude-3-5-haiku', 2048],   // documented
    ['claude-3-haiku', 2048],     // documented
    ['claude-sonnet', 1024],
    ['claude-opus', 1024],
    ['claude-3-5-sonnet', 1024],
];
const STRICTEST = Math.max(...CACHE_FLOORS.map(([, f]) => f));
const LENIENT = 1024;

// Tokens of stable prefix this model needs before a breakpoint does anything.
export function cacheFloorTokens(model_name) {
    const m = String(model_name || '').toLowerCase();
    let best = null;
    for (const [prefix, floor] of CACHE_FLOORS)
        if (m.startsWith(prefix) && (!best || prefix.length > best[0].length))
            best = [prefix, floor];
    if (best) return best[1];
    // An unrecognised model gets the strictest floor we have measured, not the
    // most permissive: sending a breakpoint that silently does nothing costs
    // money quietly, whereas withholding one only forgoes a discount.
    return m ? STRICTEST : LENIENT;
}

export const MIN_CACHEABLE_CHARS = LENIENT * CHARS_PER_TOKEN;

export function minCacheableChars(model_name) {
    return cacheFloorTokens(model_name) * CHARS_PER_TOKEN;
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
