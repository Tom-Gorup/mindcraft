import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { RunRegistry } from '../../src/mindcraft/runs.js';

function freshDir() {
    return mkdtempSync(path.join(tmpdir(), 'runs-'));
}

test('run ids are filesystem-safe whatever the user types', () => {
    for (const name of ['../../etc/passwd', 'my run!! 🎉', '', '   ', 'a'.repeat(200)]) {
        const id = RunRegistry.slugify(name, 123);
        assert.match(id, /^[a-z0-9-]+$/, `unsafe id from ${JSON.stringify(name)}`);
        assert.ok(!id.includes('..'));
        assert.ok(!id.includes('/'));
    }
});

test('a run captures events to disk and reports them back', () => {
    const reg = new RunRegistry(freshDir());
    const run = reg.start('first experiment');
    assert.ok(run.id.startsWith('first-experiment-'));
    assert.equal(reg.active, run.id);

    reg.record({ ts: 1, agent: 'Wilbur', type: 'speech', content: 'hi', world: 'w1' });
    reg.record({ ts: 2, agent: 'Greta', type: 'death', content: 'died', world: 'w2' });

    assert.equal(reg.get(run.id).event_count, 2);
    assert.deepEqual(reg.get(run.id).agents, ['Wilbur', 'Greta']);
    assert.deepEqual(reg.get(run.id).worlds, ['w1', 'w2']);

    // live reads come from the buffer
    assert.equal(reg.events(run.id).length, 2);

    // and the archive on disk is the JSONL trace.py consumes
    const fp = reg.exportPath(run.id);
    assert.ok(existsSync(fp));
    const lines = readFileSync(fp, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].agent, 'Wilbur');
    assert.equal(lines[0].run, run.id);
});

test('events outside a run are dropped, not misfiled', () => {
    const reg = new RunRegistry(freshDir());
    reg.record({ ts: 1, agent: 'X', type: 'speech', content: 'ignored' });
    assert.equal(reg.list().length, 0);
});

test('stopping ends the run; a stopped run reads back from disk', () => {
    const dir = freshDir();
    const reg = new RunRegistry(dir);
    const run = reg.start('archived');
    reg.record({ ts: 1, agent: 'A', type: 'speech', content: 'one' });
    reg.stop();
    assert.equal(reg.active, null);
    assert.ok(reg.get(run.id).ended_at > 0);
    // buffer is cleared, so this must come off disk
    assert.equal(reg.buffer.length, 0);
    assert.equal(reg.events(run.id).length, 1);
});

test('starting a new run stops the previous one', () => {
    const reg = new RunRegistry(freshDir());
    const a = reg.start('a');
    const b = reg.start('b');
    assert.ok(reg.get(a.id).ended_at > 0);
    assert.equal(reg.active, b.id);
});

test('runs survive a mindserver restart and stay comparable', () => {
    const dir = freshDir();
    const first = new RunRegistry(dir);
    const r1 = first.start('run one');
    first.record({ ts: 1, agent: 'A', type: 'death', content: 'x' });
    first.stop();
    const r2 = first.start('run two');
    first.record({ ts: 2, agent: 'B', type: 'death', content: 'y' });
    first.stop();

    const reloaded = new RunRegistry(dir);
    assert.equal(reloaded.list().length, 2);
    // both archives are readable side by side — the comparability requirement
    assert.equal(reloaded.events(r1.id).length, 1);
    assert.equal(reloaded.events(r2.id).length, 1);
    assert.equal(reloaded.events(r1.id)[0].agent, 'A');
    assert.equal(reloaded.events(r2.id)[0].agent, 'B');
});

test('a corrupt index or torn archive line does not lose the rest', () => {
    const dir = freshDir();
    const reg = new RunRegistry(dir);
    const run = reg.start('torn');
    reg.record({ ts: 1, agent: 'A', type: 'speech', content: 'first' });
    reg.stop();
    // simulate a crash mid-append
    const fp = path.join(dir, run.id, 'events.jsonl');
    writeFileSync(fp, readFileSync(fp, 'utf8') + '{"ts":2,"agent":"B"\n');
    assert.equal(new RunRegistry(dir).events(run.id).length, 1);

    writeFileSync(path.join(dir, 'index.json'), '{not json');
    const recovered = new RunRegistry(dir);
    assert.equal(recovered.list().length, 0); // starts fresh rather than throwing
});

test('oversized event fields are clamped before they reach disk', () => {
    const reg = new RunRegistry(freshDir());
    const run = reg.start('clamp');
    reg.record({ ts: 1, agent: 'A'.repeat(500), type: 'B'.repeat(500), content: 'C'.repeat(5000), world: 'D'.repeat(500) });
    const [rec] = reg.events(run.id);
    assert.ok(rec.agent.length <= 32);
    assert.ok(rec.type.length <= 40);
    assert.ok(rec.content.length <= 1000);
    assert.ok(rec.world.length <= 64);
});

test('a run larger than the archive window reports on the tail only', () => {
    const dir = freshDir();
    // a tiny window so the test does not have to write 64MB
    const reg = new RunRegistry(dir, { max_archive_bytes: 400 });
    reg.start('big', 1000);
    for (let i = 0; i < 60; i++)
        reg.record({ ts: 1000 + i, agent: 'wilbur', type: 'chat', content: `msg ${i}` });
    reg.stop(9999);

    const events = reg.events(reg.list()[0].id);
    // bounded, non-empty, and every survivor is intact JSON from the end of the run
    assert.ok(events.length > 0, 'tail read returned nothing');
    assert.ok(events.length < 60, 'window did not actually bound the read');
    assert.equal(events.at(-1).content, 'msg 59');
    for (const e of events) {
        assert.equal(e.agent, 'wilbur');
        assert.match(e.content, /^msg \d+$/);   // no torn line, no uninitialized bytes
    }
});

test('an archive smaller than the window is read whole', () => {
    const reg = new RunRegistry(freshDir(), { max_archive_bytes: 1024 * 1024 });
    reg.start('small', 1000);
    reg.record({ ts: 1001, agent: 'greta', type: 'chat', content: 'only one' });
    reg.stop(2000);
    const events = reg.events(reg.list()[0].id);
    assert.equal(events.length, 1);
    assert.equal(events[0].content, 'only one');
});
