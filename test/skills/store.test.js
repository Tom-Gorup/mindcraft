import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SkillStore } from '../../src/agent/skills/store.js';

function freshDir() {
    return mkdtempSync(path.join(tmpdir(), 'skills-'));
}

test('skills and embeddings round-trip', () => {
    const dir = freshDir();
    const store = new SkillStore(dir);
    const skills = [{ name: 'mine_iron', task: 'mine iron', docstring: 'Mines iron ore', code: 'await skills.wait(bot, 1);', created_at: 1, uses: 3, successes: 2, failures: 1, last_used: 5 }];
    store.persist(skills, { mine_iron: [0.1, 0.2] });

    const loaded = new SkillStore(dir).load();
    assert.equal(loaded.skills.length, 1);
    assert.equal(loaded.skills[0].name, 'mine_iron');
    assert.equal(loaded.skills[0].uses, 3);
    assert.deepEqual(loaded.embeddings.mine_iron, [0.1, 0.2]);
});

test('empty store loads cleanly', () => {
    const loaded = new SkillStore(freshDir()).load();
    assert.deepEqual(loaded.skills, []);
    assert.deepEqual(loaded.embeddings, {});
});

test('corrupt file starts fresh instead of throwing', () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'skills.json'), '{corrupt!!');
    const loaded = new SkillStore(dir).load();
    assert.deepEqual(loaded.skills, []);
});

test('malformed entries are filtered on load', () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'skills.json'), JSON.stringify({
        skills: [{ name: 'good', code: 'x' }, { name: 'no_code' }, null, 'junk'],
        embeddings: null,
    }));
    const loaded = new SkillStore(dir).load();
    assert.equal(loaded.skills.length, 1);
    assert.equal(loaded.skills[0].name, 'good');
    assert.deepEqual(loaded.embeddings, {});
});
