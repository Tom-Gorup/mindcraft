import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setSettings } from '../../src/agent/settings.js';
import { LearnedSkills } from '../../src/agent/skills/library.js';

setSettings({ use_skill_library: true });

// Deterministic embedding: axis 0 = mining-ish, axis 1 = building-ish.
function stubEmbed(text) {
    const t = text.toLowerCase();
    const mine = (t.match(/iron|mine|ore|smelt/g) || []).length;
    const build = (t.match(/build|house|wall|shelter/g) || []).length;
    return Promise.resolve([mine, build, 1]);
}

function makeAgent(dir, opts = {}) {
    const embedding_model = opts.no_embed ? null : { embed: stubEmbed };
    return {
        name: 'testbot',
        prompter: {
            profile: { skills: { dir, ...opts } },
            embedding_model,
            // mirrors Prompter.embedCached (uncached is fine for tests)
            embedCached: (text) => embedding_model ? embedding_model.embed(text) : Promise.resolve(null),
            promptSkillDocstring: () => Promise.resolve('Mines 10 iron ore and smelts it into ingots'),
        },
        memory: null,
    };
}

function freshDir() {
    return mkdtempSync(path.join(tmpdir(), 'learned-'));
}

test('saveFromSuccess creates a named, docstringed, embedded skill', async () => {
    const lib = new LearnedSkills(makeAgent(freshDir()));
    const skill = await lib.saveFromSuccess('Mine 10 iron ore and smelt it', 'await skills.collectBlock(bot, "iron_ore", 10);', 'Collected 10 iron_ore.');
    assert.equal(skill.name, 'mine_10_iron_ore_and_smelt_it');
    assert.equal(skill.docstring, 'Mines 10 iron ore and smelts it into ingots');
    assert.equal(skill.successes, 1);
    assert.ok(lib.embeddings.has(skill.name));
});

test('near-duplicate save refreshes the existing skill instead of duplicating', async () => {
    const lib = new LearnedSkills(makeAgent(freshDir()));
    await lib.saveFromSuccess('Mine 10 iron ore and smelt it', 'old code;', 'ok');
    const again = await lib.saveFromSuccess('Mine 10 iron ore and smelt it', 'new code;', 'ok');
    assert.equal(lib.count(), 1);
    assert.equal(again.code, 'new code;');
    assert.equal(again.successes, 1); // refresh does NOT double-count the run
});

test('code that composes a matching skill is saved as NEW, never a self-referential refresh', async () => {
    const lib = new LearnedSkills(makeAgent(freshDir()));
    const base = await lib.saveFromSuccess('Mine iron ore', 'mine();', 'ok');
    const composed = await lib.saveFromSuccess('Mine iron ore', `await learned.${base.name}(bot); extra();`, 'ok');
    assert.equal(lib.count(), 2); // refresh would have bricked base with a cycle
    assert.notEqual(composed.name, base.name);
    assert.equal(base.code, 'mine();');
});

test('overlap guard: differing quantities and letterless tasks never direct-execute', async () => {
    const lib = new LearnedSkills(makeAgent(freshDir(), { no_embed: true }));
    await lib.saveFromSuccess('mine 5 diamonds', 'mine();', 'ok');
    const wrong_qty = await lib.findBestMatch('mine 50 diamonds');
    assert.equal(lib.shouldDirectExecute(wrong_qty), false);
    const same_qty = await lib.findBestMatch('mine 5 diamonds');
    assert.ok(lib.shouldDirectExecute(same_qty));
    assert.equal(lib._taskOverlap('10', '42'), 0); // digit-stripped ['']-overlap bug
});

test('wrapper does not count interrupted runs as success or failure', async () => {
    const lib = new LearnedSkills(makeAgent(freshDir()));
    const a = await lib.saveFromSuccess('Mine iron ore', 'mine();', 'ok');
    const ns = lib.buildNamespace(() => (bot) => { bot.interrupt_code = true; return Promise.resolve(); });
    await ns[a.name]({ interrupt_code: false });
    const skill = lib.getSkill(a.name);
    assert.equal(skill.successes, 1); // only the original save
    assert.equal(skill.failures, 0);
});

test('findBestMatch ranks by task similarity; shouldDirectExecute uses thresholds', async () => {
    const lib = new LearnedSkills(makeAgent(freshDir()));
    await lib.saveFromSuccess('Mine iron ore', 'mine();', 'ok');
    await lib.saveFromSuccess('Build a wooden house', 'build();', 'ok');

    const match = await lib.findBestMatch('mine some iron ore for me');
    assert.equal(match.skill.task, 'Mine iron ore');
    assert.equal(match.method, 'embedding');
    assert.ok(lib.shouldDirectExecute(match)); // parallel vectors -> cosine 1

    const weak = await lib.findBestMatch('go fishing at the lake');
    assert.equal(lib.shouldDirectExecute(weak), false);
});

test('unreliable skills (more failures than successes) are not direct-executed', async () => {
    const lib = new LearnedSkills(makeAgent(freshDir()));
    const skill = await lib.saveFromSuccess('Mine iron ore', 'mine();', 'ok');
    lib.noteResult(skill.name, false);
    lib.noteResult(skill.name, false);
    const match = await lib.findBestMatch('Mine iron ore');
    assert.ok(match.similarity > 0.92);
    assert.equal(lib.shouldDirectExecute(match), false);
});

test('stats and skills survive a restart', async () => {
    const dir = freshDir();
    const first = new LearnedSkills(makeAgent(dir, { persist_throttle_ms: 0 }));
    const skill = await first.saveFromSuccess('Mine iron ore', 'mine();', 'ok');
    first.noteResult(skill.name, true);

    const second = new LearnedSkills(makeAgent(dir));
    assert.equal(second.count(), 1);
    assert.equal(second.getSkill(skill.name).uses, 1);
    assert.equal(second.getSkill(skill.name).successes, 2);
    assert.ok(second.embeddings.has(skill.name));
});

test('overlap fallback works without an embedding model', async () => {
    const lib = new LearnedSkills(makeAgent(freshDir(), { no_embed: true }));
    await lib.saveFromSuccess('Build a wooden house with a door', 'build();', 'ok');
    const match = await lib.findBestMatch('Build a wooden house with a door');
    assert.equal(match.method, 'overlap');
    assert.ok(lib.shouldDirectExecute(match)); // identical task text
});

test('namespace executes, tracks stats, and guards composition cycles', async () => {
    const lib = new LearnedSkills(makeAgent(freshDir()));
    const a = await lib.saveFromSuccess('Mine iron ore', 'mine();', 'ok');
    const calls = [];
    const ns = lib.buildNamespace((code) => async (bot) => {
        calls.push(code);
        if (code === 'recurse();') await ns[a.name](bot); // A -> A cycle
    });

    await ns[a.name]({});
    assert.deepEqual(calls, ['mine();']);
    assert.equal(lib.getSkill(a.name).uses, 1);
    assert.equal(ns.nonexistent, undefined);
    assert.equal(a.name in ns, true);

    a.code = 'recurse();';
    lib.compiled.delete(a.name);
    await assert.rejects(() => ns[a.name]({}), /cycle/);
    assert.equal(lib.getSkill(a.name).failures, 1);
});

test('docs are formatted for the unified code-docs pool', async () => {
    const lib = new LearnedSkills(makeAgent(freshDir()));
    await lib.saveFromSuccess('Mine iron ore', 'mine();', 'ok');
    const docs = lib.getDocs();
    assert.ok(docs[0].startsWith('learned.mine_iron_ore\n'));
    assert.ok(docs[0].includes('await learned.mine_iron_ore(bot);'));
    const ranked = await lib.getRankedDocs('mine iron');
    assert.equal(ranked.length, 1);
    assert.ok(ranked[0].score > 0.9);
});

test('disabled library is a complete no-op', async () => {
    setSettings({ use_skill_library: false });
    const lib = new LearnedSkills(makeAgent(freshDir()));
    assert.equal(lib.isEnabled(), false);
    assert.equal(await lib.saveFromSuccess('task', 'code;', 'ok'), null);
    assert.equal(await lib.findBestMatch('task'), null);
    assert.deepEqual(await lib.getRankedDocs('task'), []);
    setSettings({ use_skill_library: true });
});
