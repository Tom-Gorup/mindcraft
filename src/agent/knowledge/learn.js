// Phase 10 — turning outcomes into rules.
//
// The agents already produce structured failure text: "missing crafting table",
// "no stone to place", "Greta not found", "Path not found". Over twelve hours
// those went into the log and nowhere else, so the same failure recurred 41
// times without anything changing. A failure with a reason is a candidate rule,
// not a line of output.
//
// Deliberately narrow. This does not try to infer arbitrary causation from
// experience — that is how you get confident nonsense. It recognises a small
// set of failure shapes that Minecraft actually produces, and converts those.
// Everything else is left to reflection, which is a model and can afford to
// speculate because its output is prose rather than a constraint.
//
// Pure: string in, candidate fact out. Unit-testable.

// Each rule: a pattern, and what to conclude if it matches.
// `kind` matters — 'avoid' and 'requires' become hard planning constraints,
// 'note' is only ever advisory.
const RULES = [
    {
        // "Could not do X: furnace unreachable, need pickaxe to break stone"
        re: /\b(?:need|needs|requires?|missing)\s+(?:an?\s+)?([a-z_ ]{3,30}?)(?:\s+to\b|[,.]|$)/i,
        kind: 'requires',
        subject: (m) => norm(m[1]),
        claim: (m, ctx) => `${ctx.action || 'That'} needs ${norm(m[1]).replace(/_/g, ' ')} first.`,
    },
    {
        // pathfinder gave up — the single most common execution failure
        re: /\bpath\s*not\s*found|no\s+path\b|could\s+not\s+(?:find|reach)\s+a?\s*path/i,
        kind: 'avoid',
        subject: () => 'unreachable_by_path',
        claim: () => 'Pathing to distant targets fails in this terrain. '
            + 'Work near where you already are, or clear a route deliberately.',
    },
    {
        // "Greta not found" — chasing another agent across the map
        re: /\b([A-Z][a-zA-Z0-9_]{2,15})\s+not\s+found\b/,
        kind: 'avoid',
        subject: (m) => `reaching_${norm(m[1])}`,
        claim: (m) => `${m[1]} is usually not reachable when wanted. `
            + 'Arrange a meeting point or drop items rather than travelling to them.',
    },
    {
        re: /\btimed?\s*out\b/i,
        kind: 'note',
        subject: (_m, ctx) => `slow_${norm(ctx.action || 'action')}`,
        claim: (_m, ctx) => `${ctx.action || 'This'} often takes longer than the step allows. `
            + 'Break it into smaller pieces.',
    },
    {
        re: /\bno\s+([a-z_ ]{3,30}?)\s+(?:nearby|found|in range|available)/i,
        kind: 'note',
        subject: (m) => `scarce_${norm(m[1])}`,
        claim: (m) => `${norm(m[1]).replace(/_/g, ' ')} is scarce around here.`,
    },
];

function norm(s) {
    return String(s ?? '').trim().toLowerCase()
        .replace(/^(a|an|the)\s+/, '')
        .replace(/[^a-z0-9 _]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 48);
}

// Read a failure into a candidate fact, or null when nothing is confidently
// inferable. Returning null is the common and correct case.
export function factFromFailure(reason, context = {}) {
    const text = String(reason ?? '');
    if (text.length < 4) return null;
    for (const rule of RULES) {
        const m = rule.re.exec(text);
        if (!m) continue;
        const subject = rule.subject(m, context);
        if (!subject || subject.length < 3) continue;
        return { kind: rule.kind, subject, claim: rule.claim(m, context) };
    }
    return null;
}

// A success is evidence too, and cheaper: it is the only thing that can lower
// the confidence of an 'avoid' the agent has since disproved. Without this the
// agent accumulates permanent superstitions.
export function factFromSuccess(action) {
    const a = norm(action);
    if (!a || a.length < 3) return null;
    return { kind: 'note', subject: `works_${a}`, claim: `${a.replace(/_/g, ' ')} works here.` };
}
