// Live check of the run-download routes.
//
//   node tools/probe_download.mjs
//
// Not part of the app or its tests. It boots the mindserver on a spare port
// against a throwaway runs/ directory and exercises both routes, including the
// traversal cases — Express percent-decodes route params AFTER matching, which
// is exactly how ..%2F once escaped the asset route, so the defence is checked
// against decoded input rather than assumed.

import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

const W = path.join(os.tmpdir(), 'mc-dl-probe');
const ID = 'overnight-1756600000000';
rmSync(W, { recursive: true, force: true });
mkdirSync(path.join(W, 'runs', ID), { recursive: true });

writeFileSync(path.join(W, 'runs', 'index.json'), JSON.stringify({
    runs: [{
        id: ID, name: 'overnight', started_at: 1756600000000, ended_at: 1756640000000,
        agents: ['Wilbur'], worlds: ['lan'], event_count: 3,
    }],
}));

// Deliberately NO structured `data` — this is the shape of an archive written
// before the fields were allowlisted, i.e. the run already on disk.
const events = [
    { ts: 1756600001000, agent: 'Wilbur', type: 'goal_abandoned', content: 'Abandoned goal (legacy): build a watchtower — step timed out', run: ID, world: 'lan' },
    { ts: 1756600002000, agent: 'Wilbur', type: 'goal_abandoned', content: 'Set aside goal (legacy): build a watchtower — food became more urgent', run: ID, world: 'lan' },
    { ts: 1756600003000, agent: 'Wilbur', type: 'belief', content: 'Pathfinding timeouts are a systemic problem', run: ID, world: 'lan' },
];
writeFileSync(path.join(W, 'runs', ID, 'events.jsonl'),
    events.map(e => JSON.stringify(e)).join('\n') + '\n');

// RunRegistry resolves ./runs from cwd at import time.
process.chdir(W);
const { createMindServer } = await import('/Users/tom/mc-work/mindcraft/src/mindcraft/mindserver.js');
createMindServer(false, 8099);
await new Promise(r => setTimeout(r, 800));

const B = 'http://localhost:8099';   // the server binds ::1, so use the name

const rep = await fetch(`${B}/run/${ID}/report.json`);
console.log('report.json   ', rep.status, '|', rep.headers.get('content-disposition'));
const bundle = await rep.json();
const w = bundle.report.goal_outcomes.Wilbur;
console.log('  recovered from prose:', JSON.stringify(w.by_reason), JSON.stringify(w.preemptions));
console.log('  beliefs in full     :', bundle.beliefs.length, '-', bundle.beliefs[0]?.content.slice(0, 45));

const ev = await fetch(`${B}/run/${ID}/events.jsonl`);
const text = await ev.text();
console.log('events.jsonl  ', ev.status, '|', text.trim().split('\n').length, 'lines |',
    ev.headers.get('content-type'));

console.log('--- hostile ids: every one must be 4xx and leak nothing ---');
const bad = ['../../keys.json', '..%2F..%2Fkeys.json', '..%252F..%252Fkeys.json',
    'nonexistent-run', 'UPPER-case', 'has_underscore', '.', 'a/../../b', ''];
let ok = true;
for (const b of bad) {
    const r = await fetch(`${B}/run/${encodeURIComponent(b)}/events.jsonl`);
    const body = await r.text();
    const leaked = /sk-ant|api_key|ANTHROPIC_API/i.test(body);
    if (r.status < 400 || leaked) ok = false;
    console.log(`  ${r.status}${leaked ? '  *** LEAKED ***' : ''}  ${JSON.stringify(b)}`);
}
console.log(ok ? 'PASS — all rejected' : 'FAIL — something got through');
rmSync(W, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
