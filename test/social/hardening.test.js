import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setSettings } from '../../src/agent/settings.js';
import { SocialModule } from '../../src/agent/social/index.js';
import { AgentMemory } from '../../src/agent/memory/index.js';
import { selectGossip, SHAREABLE_TYPES } from '../../src/agent/social/gossip.js';
import { applyInteraction, newRelationship, disposition } from '../../src/agent/social/relationships.js';

setSettings({ use_social: true, use_memory: true });

function makeAgent(name, social_opts = {}, dir = null) {
    dir = dir || mkdtempSync(path.join(tmpdir(), `soc-${name}-`));
    const agent = {
        name,
        prompter: { profile: { social: { dir, ...social_opts }, memory: { dir, exclude_recent_ms: 0 } }, embedding_model: null },
        bot: { players: { Wilbur: {}, Steve: {} } },
        last_sender: null,
    };
    agent.memory = new AgentMemory(agent);
    agent.social = new SocialModule(agent);
    return agent;
}

test('a corrupt relationships.json cannot poison state with NaN', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'soc-corrupt-'));
    writeFileSync(path.join(dir, 'relationships.json'), JSON.stringify({
        relationships: [
            { name: 'Bad', trust: 'high', affinity: {}, grudge: null, interactions: 'many', notes: 'nope' },
            { name: '../../etc/passwd', trust: 1 },   // rejected: bad name
            { name: 'Multi', notes: ['line one\nline two'] },
        ],
    }));
    const agent = makeAgent('C', {}, dir);
    const bad = agent.social.get('Bad');
    assert.equal(typeof bad.trust, 'number');
    assert.ok(Number.isFinite(disposition(bad)));
    assert.deepEqual(bad.notes, []);
    assert.equal(agent.social.relationships.has('../../etc/passwd'), false);
    // notes reaching the prompt must be single-line, even from a hand-edited file
    assert.ok(!agent.social.get('Multi').notes[0].includes('\n'));
    assert.ok(agent.social.getContext().length > 0, 'context must still render');
});

test('non-numeric personality knobs are ignored rather than producing NaN', () => {
    const agent = makeAgent('P', { trust_gain: 'lots', warmth: 2 });
    assert.equal(agent.social.personality.trust_gain, 1.0); // fell back to default
    assert.equal(agent.social.personality.warmth, 2);
    agent.social.record('Wilbur', 'helped');
    assert.ok(Number.isFinite(agent.social.get('Wilbur').trust));
});

test('a spammy peer cannot farm trust by repeating messages', () => {
    const agent = makeAgent('S');
    for (let i = 0; i < 50; i++) agent.social.record('Wilbur', 'conversed');
    assert.equal(agent.social.get('Wilbur').interactions, 1, 'rate-limited to one per window');
});

test('repeating the same accusation cannot compound into a maxed grudge', () => {
    const agent = makeAgent('G');
    for (let i = 0; i < 20; i++)
        agent.social.receiveGossip('Steve', 'Wilbur', 'Wilbur stole from me', 'negative');
    const rel = agent.social.get('Wilbur');
    assert.ok(rel.interactions <= 1, 'per-teller-per-subject cooldown applies');
});

test('hearsay never manufactures a grudge', () => {
    const agent = makeAgent('H');
    agent.social.receiveGossip('Steve', 'Wilbur', 'Wilbur betrayed everyone', 'negative');
    const rel = agent.social.get('Wilbur');
    assert.ok(rel.affinity < 0, 'opinion shifts');
    assert.equal(rel.grudge, 0, 'resentment requires firsthand harm');
});

test('gossip is never relayed back to its source and internal telemetry is unshareable', () => {
    const known = ['Wilbur', 'Steve'];
    const now = Date.now();
    // hearsay from Steve must not be retold to Steve
    const heard = [{ id: 'g', type: 'gossip', importance: 0.55, ts: now, content: 'Steve told me about Wilbur: he stole', data: { teller: 'Steve', subject: 'Wilbur' } }];
    assert.equal(selectGossip(heard, 'Steve', known, { now }), null);
    // ...and gossip is not a shareable type at all, to stop two bots echoing
    assert.equal(SHAREABLE_TYPES.has('gossip'), false);
    // the agent's own relationship telemetry must never be spoken aloud
    assert.equal(SHAREABLE_TYPES.has('social'), false);
    const telemetry = [{ id: 's', type: 'social', importance: 0.6, ts: now, content: 'Feelings toward Wilbur shifted (trust 0.31)', data: {} }];
    assert.equal(selectGossip(telemetry, 'Steve', known, { now }), null);
});

test('gossip selection is idempotent across the prompt retry window', () => {
    const agent = makeAgent('I', { gossip_propensity: 1, gossip_cooldown_ms: 0 });
    agent.memory.record('speech', 'Wilbur took the diamonds from the chest');
    const first = agent.social.pickGossipFor('Steve');
    const second = agent.social.pickGossipFor('Steve');
    const third = agent.social.pickGossipFor('Steve');
    assert.equal(first, second);
    assert.equal(second, third, 'retries must not re-roll or burn extra gossip');
});

test('the aggressor and the victim are scored differently', () => {
    const aggressor = applyInteraction(newRelationship('X'), 'attacked');
    const victim = applyInteraction(newRelationship('X'), 'attacked_by');
    assert.equal(aggressor.grudge, 0, 'attacking someone does not make you resent them');
    assert.ok(victim.grudge > 0.4);
    assert.ok(disposition(aggressor) > disposition(victim));
});

test('disabled module still answers queries safely', () => {
    setSettings({ use_social: false, use_memory: true });
    const agent = makeAgent('Off');
    assert.deepEqual(agent.social.getStatus(), { enabled: false, relationships: [] });
    assert.equal(agent.social.evaluatePending('Wilbur'), null);
    agent.social.checkDeliveries({}); // must not throw
    agent.social.tick();
    setSettings({ use_social: true, use_memory: true });
});
