// Reset an agent to a blank slate: no memories, no beliefs, no relationships,
// no learned skills, no drive state, no project.
//
//   node tools/reset_agent.mjs Wilbur Greta          # dry run — shows what would go
//   node tools/reset_agent.mjs Wilbur --yes          # do it
//   node tools/reset_agent.mjs --all --yes           # every agent
//   node tools/reset_agent.mjs Wilbur --yes --keep-skills
//
// Three things this deliberately does NOT do:
//
//   · it never touches runs/ — those archives are research data, and the point
//     of a fresh start is to compare it against the old one;
//   · it never deletes, it MOVES to bots/.archive/<name>-<stamp>/, because
//     "start fresh" and "destroy the evidence of what went wrong" are different
//     requests and only one of them is reversible;
//   · it only removes known state paths, so bots/execTemplate.js and
//     bots/lintTemplate.js survive. Those are read at runtime by coder.js, and
//     an `rm -rf bots/*` silently breaks code generation.
//
// Stop the agent first. Resetting a running agent races its own state flush on
// shutdown, which will write some of it straight back.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs';
import path from 'path';

const BOTS = './bots';
const ARCHIVE = path.join(BOTS, '.archive');

// Everything an agent accumulates, and what it means. Keep in step with the
// paths in agent.js, cognition/index.js, memory/, skills/ and social/.
const STATE = [
    { rel: 'memory.json', what: 'memory bank (named places)' },
    { rel: 'memory', what: 'event stream and beliefs', dir: true },
    { rel: 'histories', what: 'conversation history', dir: true },
    { rel: 'cognition.json', what: 'drives, goal, project' },
    { rel: 'social', what: 'relationships, trust, grudges', dir: true },
    { rel: 'skills', what: 'learned skill library', dir: true, skill: true },
    { rel: 'action-code', what: 'generated code', dir: true, skill: true },
    { rel: 'last_profile.json', what: 'cached profile' },
    { rel: 'screenshots', what: 'vision screenshots', dir: true },
];

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const keepSkills = args.includes('--keep-skills');
const all = args.includes('--all');
let names = args.filter(a => !a.startsWith('--'));

if (!existsSync(BOTS)) {
    console.error(`No ${BOTS}/ directory here. Run this from the repo root.`);
    process.exit(1);
}

// An agent is a directory. Files at the top of bots/ are the code templates.
const onDisk = readdirSync(BOTS)
    .filter(f => !f.startsWith('.'))
    .filter(f => statSync(path.join(BOTS, f)).isDirectory());

if (all) names = onDisk;
if (names.length === 0) {
    console.error('Name at least one agent, or pass --all.');
    console.error(`Agents with state here: ${onDisk.join(', ') || '(none)'}`);
    process.exit(1);
}

const unknown = names.filter(n => !onDisk.includes(n));
if (unknown.length) {
    console.error(`No state on disk for: ${unknown.join(', ')}`);
    console.error(`Available: ${onDisk.join(', ') || '(none)'}`);
    process.exit(1);
}

// Stamped once so every agent in one reset lands in a matching archive.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
let moved = 0, skipped = 0;

for (const name of names) {
    console.log(`\n${name}`);
    const dir = path.join(BOTS, name);
    const dest = path.join(ARCHIVE, `${name}-${stamp}`);

    for (const item of STATE) {
        const from = path.join(dir, item.rel);
        if (!existsSync(from)) continue;
        if (keepSkills && item.skill) {
            console.log(`  keep     ${item.rel.padEnd(18)} ${item.what}`);
            skipped++;
            continue;
        }
        if (!confirmed) {
            console.log(`  would archive ${item.rel.padEnd(18)} ${item.what}`);
            moved++;
            continue;
        }
        mkdirSync(dest, { recursive: true });
        renameSync(from, path.join(dest, item.rel));
        console.log(`  archived ${item.rel.padEnd(18)} ${item.what}`);
        moved++;
    }
}

console.log('');
if (!confirmed) {
    console.log(`Dry run: ${moved} item(s) would be archived to ${ARCHIVE}/<agent>-${stamp}/`);
    console.log('Nothing has changed. Re-run with --yes to do it.');
} else {
    console.log(`Archived ${moved} item(s) to ${ARCHIVE}/`);
    if (skipped) console.log(`Kept ${skipped} skill/code item(s).`);
    console.log('runs/ was not touched — your research archives are intact.');
    console.log('Recover with: mv bots/.archive/<agent>-<stamp>/<item> bots/<agent>/');
}
