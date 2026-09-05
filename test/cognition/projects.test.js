import test from 'node:test';
import assert from 'node:assert/strict';
import { Project, ProjectStore, milestoneRequirement } from '../../src/agent/cognition/projects.js';

const MILESTONES = ['gather 64 stone', 'lay the foundation', 'raise the walls'];

test('a project advances one milestone at a time and reports what is next', () => {
    const s = new ProjectStore();
    const p = s.start('build a stone keep', MILESTONES, { now: 1000 });
    assert.equal(p.nextMilestone.text, 'gather 64 stone');
    assert.equal(p.progress, 0);

    p.completeNextMilestone();
    assert.equal(p.nextMilestone.text, 'lay the foundation');
    assert.ok(Math.abs(p.progress - 1 / 3) < 1e-9);
});

test('finishing every milestone completes the project', () => {
    const s = new ProjectStore();
    const p = s.start('build a stone keep', MILESTONES, { now: 1 });
    for (let i = 0; i < MILESTONES.length; i++) p.completeNextMilestone();
    assert.equal(p.status, 'complete');
    assert.ok(p.isFinished);
    assert.equal(s.active, null, 'a completed project is no longer the active one');
    assert.equal(s.completed.length, 1);
});

// One at a time: an agent juggling three castles finishes none, and the arbiter
// already has enough ways to thrash.
test('only one project is active at a time', () => {
    const s = new ProjectStore();
    const first = s.start('build a keep', MILESTONES, { now: 1 });
    const second = s.start('dig a canal', ['survey'], { now: 2 });
    assert.equal(second.id, first.id, 'starting a second project returns the existing one');
    assert.equal(s.projects.length, 1);
});

// Contributions are cumulative, not current inventory — a project must not
// un-build itself because the agent later spent its logs on something else.
test('material contributions accumulate and outstanding shrinks', () => {
    const s = new ProjectStore();
    const p = s.start('keep', MILESTONES, { now: 1, needed: { stone: 64, oak_log: 10 } });
    assert.deepEqual(p.outstanding, { stone: 64, oak_log: 10 });

    p.contribute('stone', 40);
    p.contribute('stone', 24);
    p.contribute('oak_log', 10);
    assert.deepEqual(p.outstanding, {}, 'nothing outstanding once the ledger is met');

    p.contribute('stone', 5);   // overshoot must not reappear as a shortfall
    assert.deepEqual(p.outstanding, {});
});

test('nonsense contributions are ignored rather than corrupting the ledger', () => {
    const p = new Project({ intent: 'x', materials: { needed: { stone: 10 } } });
    p.contribute('stone', -5);
    p.contribute('stone', NaN);
    p.contribute('', 5);
    p.contribute(null, 5);
    assert.deepEqual(p.outstanding, { stone: 10 });
});

test('work time and sessions accumulate, which is what "across sessions" means', () => {
    const s = new ProjectStore();
    s.start('keep', MILESTONES, { now: 1 });
    s.noteWork(5000, 6000);
    s.noteWork(5000, 11000);
    assert.equal(s.active.active_ms, 10000);
    assert.equal(s.active.last_worked_at, 11000);

    s.noteSession();
    s.noteSession();
    assert.equal(s.active.sessions, 2);
});

test('the description is compact and carries what a prompt needs', () => {
    const s = new ProjectStore();
    const p = s.start('build a stone keep on the ridge', MILESTONES,
        { now: 1, needed: { stone: 64 } });
    p.contribute('stone', 20);
    p.site = { x: 10, y: 70, z: -5 };
    p.addNote('the ridge is exposed at night');
    const d = p.describe();

    assert.match(d, /build a stone keep on the ridge/);
    assert.match(d, /Next: gather 64 stone/);
    assert.match(d, /44 stone/, 'reports the shortfall, not the requirement');
    assert.match(d, /x10 y70 z-5/);
    assert.match(d, /exposed at night/);
    assert.ok(d.length < 600, `description should stay prompt-sized, was ${d.length}`);
});

test('a project survives a round trip through JSON', () => {
    const s = new ProjectStore();
    const p = s.start('keep', MILESTONES, { now: 1, needed: { stone: 64 } });
    p.completeNextMilestone('foundation is uneven');
    p.contribute('stone', 30);
    p.site = { x: 1, y: 2, z: 3 };
    s.noteSession();

    const revived = new ProjectStore(JSON.parse(JSON.stringify(s.toJSON())));
    const r = revived.active;
    assert.equal(r.intent, 'keep');
    assert.equal(r.nextMilestone.text, 'lay the foundation');
    assert.deepEqual(r.outstanding, { stone: 34 });
    assert.deepEqual(r.site, { x: 1, y: 2, z: 3 });
    assert.equal(r.sessions, 1);
    assert.ok(r.notes.includes('foundation is uneven'));
});

// The legacy drive asks "does something I made still stand?" — an ambition
// nobody has acted on must not satisfy it.
test('satisfaction comes from finished work, not from having ambitions', () => {
    const s = new ProjectStore();
    assert.equal(s.satisfaction(), 0);
    s.start('keep', ['a'], { now: 1 });
    assert.equal(s.satisfaction(), 0, 'starting a project satisfies nothing');

    s.active.completeNextMilestone();
    assert.ok(s.satisfaction() > 0, 'finishing one does');
    const afterOne = s.satisfaction();

    s.start('wall', ['a'], { now: 2 });
    s.active.completeNextMilestone();
    assert.ok(s.satisfaction() > afterOne, 'and more work satisfies further');
});

test('abandoning frees the slot and records why', () => {
    const s = new ProjectStore();
    s.start('keep', MILESTONES, { now: 1 });
    s.abandonActive('ran out of stone and the site flooded', 500);
    assert.equal(s.active, null);
    assert.equal(s.projects[0].status, 'abandoned');
    assert.match(s.projects[0].notes.at(-1), /flooded/);
});

test('history is bounded so the store cannot grow without limit', () => {
    const s = new ProjectStore({}, { max_history: 3 });
    for (let i = 0; i < 10; i++) {
        s.start(`build ${i}`, ['a'], { now: i });
        s.active.completeNextMilestone();
    }
    assert.ok(s.projects.length <= 3 + 1, `bounded, got ${s.projects.length}`);
});

// An overnight run stuck on milestone 1 looks identical to one making steady
// progress unless attempts are counted.
test('milestone attempts are counted and surface a stall', () => {
    const s = new ProjectStore();
    const p = s.start('watchtower', ['gather 40 logs', 'raise the base'], { now: 1 });
    assert.equal(p.nextMilestone.attempts, 0);
    for (let i = 0; i < 5; i++) p.noteAttempt();
    assert.equal(p.nextMilestone.attempts, 5);
    assert.equal(p.stalledMilestone, null, 'five is not yet a stall');
    p.noteAttempt();
    assert.ok(p.stalledMilestone, 'six is');
    assert.match(p.describe(), /attempted this 6 times/);
});

test('attempts reset with the milestone and survive persistence', () => {
    const s = new ProjectStore();
    const p = s.start('watchtower', ['a', 'b'], { now: 1 });
    p.noteAttempt(); p.noteAttempt();
    p.completeNextMilestone();
    assert.equal(p.nextMilestone.text, 'b');
    assert.equal(p.nextMilestone.attempts, 0, 'the next milestone starts fresh');

    const revived = new ProjectStore(JSON.parse(JSON.stringify(s.toJSON())));
    assert.equal(revived.active.milestones[0].attempts, 2, 'history is kept');
});

// ---- work counts for what it achieves ----
//
// Run of 2026-09-05: Greta completed "Chop down the 3-4 nearest spruce trees"
// and "Deposit my 55 spruce logs into the chest" under the wealth drive while
// her active milestone was "Gather 64 spruce logs". She did the work; the
// project stayed at 0% because the goal had not been launched as a milestone.

test('a gathering milestone closes once its materials are in hand', () => {
    const s = new ProjectStore();
    const p = s.start('a lighthouse', ['gather 64 spruce logs', 'lay the foundation'],
        { now: 1, needed: { spruce_log: 64 } });

    p.contribute('spruce_log', 55);
    assert.deepEqual(p.outstanding, { spruce_log: 9 }, 'not yet');
    assert.equal(p.nextMilestone.text, 'gather 64 spruce logs');

    p.contribute('spruce_log', 9);
    assert.deepEqual(p.outstanding, {}, 'materials met');
    p.completeNextMilestone();
    assert.equal(p.nextMilestone.text, 'lay the foundation', 'the project advances');
    assert.ok(p.progress > 0, 'and progress is no longer zero');
});

// Cumulative, so spending the logs later does not un-build the project.
test('crediting from inventory never goes backwards', () => {
    const p = new Project({ intent: 'x', materials: { needed: { stone: 64 } } });
    const credit = (held) => {
        const already = p.materials.contributed.stone ?? 0;
        if (held > already) p.contribute('stone', held - already);
    };
    credit(30); credit(64);
    assert.deepEqual(p.outstanding, {});
    credit(0);   // spent it all on something else
    assert.deepEqual(p.outstanding, {}, 'the project stays built');
});

// ---- what a gathering milestone actually asks for ----
//
// Run of 2026-09-05: Greta completed a goal literally named "Organize and
// secure my 37 spruce logs" while her milestone was "Gather 32 spruce logs",
// and it stayed open for three attempts. The old check tested the PROJECT
// ledger, so the whole shrine's logs, planks, torches and railings all had to
// be in hand before the first gathering step could close.

test('a gathering milestone yields its own requirement', () => {
    assert.deepEqual(milestoneRequirement('Gather 32 spruce logs by felling nearby trees'),
        { qty: 32, names: ['spruce_logs', 'spruce_log'] });
    // Minecraft ids are inconsistent about plurals (spruce_log, spruce_planks),
    // so both forms are offered and the caller matches the inventory.
    assert.ok(milestoneRequirement('Gather 60 spruce planks').names.includes('spruce_planks'));
    // "10 stone blocks" means ten stone
    assert.deepEqual(milestoneRequirement('Collect 10 stone blocks by mining').names[0], 'stone');
});

// Conservative by design: only gathering milestones are eligible, so a
// dimension is never mistaken for a material.
test('build and clear milestones are never auto-closed', () => {
    for (const text of [
        'Build a wooden pillar 16 blocks tall at the center',
        'Clear and level a circular foundation 12 blocks wide',
        'Clear and level a 10x10 base in the nearby flat ground',
        'Construct a platform at the top with railings',
        'Add a torch beacon at the summit',
    ])
        assert.equal(milestoneRequirement(text), null, `must not match: ${text}`);
});

test('a gathering milestone with no count is not auto-closed either', () => {
    assert.equal(milestoneRequirement('Fell and limb a stand of spruce trees'), null);
    assert.equal(milestoneRequirement('Gather 0 logs'), null);
});
