// The reset tool moves real files, so it is tested against a real throwaway
// tree. The two things that must never happen are deleting research archives
// and deleting the code templates coder.js reads at runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TOOL = path.resolve('tools/reset_agent.mjs');

function fixture() {
    const w = path.join(os.tmpdir(), `mc-reset-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(w, 'bots', 'Testy', 'memory'), { recursive: true });
    mkdirSync(path.join(w, 'bots', 'Testy', 'skills'), { recursive: true });
    mkdirSync(path.join(w, 'runs', 'run-1'), { recursive: true });
    writeFileSync(path.join(w, 'bots', 'Testy', 'cognition.json'), '{"drives":1}');
    writeFileSync(path.join(w, 'bots', 'Testy', 'memory', 'events.jsonl'), 'evt\n');
    writeFileSync(path.join(w, 'bots', 'Testy', 'skills', 'skills.json'), '{"skills":[]}');
    // read at runtime by coder.js — an rm -rf bots/* breaks code generation
    writeFileSync(path.join(w, 'bots', 'execTemplate.js'), 'exec');
    writeFileSync(path.join(w, 'bots', 'lintTemplate.js'), 'lint');
    writeFileSync(path.join(w, 'runs', 'run-1', 'events.jsonl'), 'research\n');
    return w;
}

const run = (cwd, args) => execFileSync('node', [TOOL, ...args], { cwd, encoding: 'utf8' });

test('a dry run changes nothing', () => {
    const w = fixture();
    try {
        const out = run(w, ['Testy']);
        assert.match(out, /would archive/);
        assert.match(out, /Nothing has changed/);
        assert.ok(existsSync(path.join(w, 'bots', 'Testy', 'cognition.json')), 'state is still there');
        assert.ok(!existsSync(path.join(w, 'bots', '.archive')), 'and nothing was archived');
    } finally { rmSync(w, { recursive: true, force: true }); }
});

test('--yes archives agent state and leaves research and templates alone', () => {
    const w = fixture();
    try {
        run(w, ['Testy', '--yes']);
        assert.ok(!existsSync(path.join(w, 'bots', 'Testy', 'cognition.json')), 'drives cleared');
        assert.ok(!existsSync(path.join(w, 'bots', 'Testy', 'memory')), 'memories cleared');

        assert.equal(readFileSync(path.join(w, 'runs', 'run-1', 'events.jsonl'), 'utf8'), 'research\n',
            'runs/ is research data and must survive a reset');
        assert.equal(readFileSync(path.join(w, 'bots', 'execTemplate.js'), 'utf8'), 'exec',
            'coder.js reads this at runtime');
        assert.equal(readFileSync(path.join(w, 'bots', 'lintTemplate.js'), 'utf8'), 'lint');
    } finally { rmSync(w, { recursive: true, force: true }); }
});

test('archived state is recoverable, not destroyed', () => {
    const w = fixture();
    try {
        run(w, ['Testy', '--yes']);
        const archives = readdirSync(path.join(w, 'bots', '.archive'));
        assert.equal(archives.length, 1);
        const saved = path.join(w, 'bots', '.archive', archives[0], 'cognition.json');
        assert.equal(readFileSync(saved, 'utf8'), '{"drives":1}', 'the old state is intact');
    } finally { rmSync(w, { recursive: true, force: true }); }
});

test('--keep-skills spares the learned library', () => {
    const w = fixture();
    try {
        run(w, ['Testy', '--yes', '--keep-skills']);
        assert.ok(existsSync(path.join(w, 'bots', 'Testy', 'skills', 'skills.json')), 'skills kept');
        assert.ok(!existsSync(path.join(w, 'bots', 'Testy', 'memory')), 'memories still cleared');
    } finally { rmSync(w, { recursive: true, force: true }); }
});

test('an unknown agent name is refused rather than silently doing nothing', () => {
    const w = fixture();
    try {
        assert.throws(() => run(w, ['Nope', '--yes']), /./);
        assert.ok(existsSync(path.join(w, 'bots', 'Testy', 'cognition.json')));
    } finally { rmSync(w, { recursive: true, force: true }); }
});
