import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setSettings } from '../../src/agent/settings.js';
import { SocialModule } from '../../src/agent/social/index.js';
import { AgentMemory } from '../../src/agent/memory/index.js';
import { formatOfferMessage, parseOfferMessage } from '../../src/agent/social/trade.js';

setSettings({ use_social: true, use_memory: true });

function makeAgent(name, social_opts = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), `social-${name}-`));
    const agent = {
        name,
        prompter: {
            profile: { social: { dir, ...social_opts }, memory: { dir, exclude_recent_ms: 0 } },
            embedding_model: null,
            promptReflection: () => Promise.resolve('{}'),
        },
        bot: { players: { Wilbur: {}, Steve: {}, Andy: {} } },
        last_sender: null,
    };
    agent.memory = new AgentMemory(agent);
    agent.social = new SocialModule(agent);
    return agent;
}

test('firsthand harm creates a grudge that shapes the conversation prompt', () => {
    const andy = makeAgent('Andy');
    andy.social.record('Steve', 'killed_by');
    const ctx = andy.social.getContext();
    assert.match(ctx, /Steve/);
    assert.match(ctx, /enemy|distrust|wary/);
    assert.ok(andy.social.dispositionToward('Steve') < -0.3);
});

test('gossip propagates with attribution and is believed in proportion to trust', () => {
    const hearer = makeAgent('Wilbur');

    // a trusted friend's word moves the needle more than a stranger's
    hearer.social.record('Andy', 'helped');
    hearer.social.record('Andy', 'helped');
    hearer.social.record('Andy', 'gave_item');
    const trusted = hearer.social.get('Andy').trust;

    hearer.social.receiveGossip('Andy', 'Steve', 'Steve stole diamonds from the shared chest', 'negative');
    const after_trusted = hearer.social.dispositionToward('Steve');
    assert.ok(after_trusted < 0, 'secondhand bad news should sour the relationship');

    // attribution is preserved, both in the relationship note and in memory
    const note = hearer.social.get('Steve').notes.at(-1);
    assert.match(note, /^Andy told me about Steve:/);
    assert.match(hearer.social.getContext(), /Andy told me about Steve/);
    const gossip_events = hearer.memory.events.filter(e => e.type === 'gossip');
    assert.equal(gossip_events.length, 1);
    assert.equal(gossip_events[0].data.teller, 'Andy');
    assert.equal(gossip_events[0].data.subject, 'Steve');

    // the same claim from a distrusted source lands softer
    const skeptic = makeAgent('Wilbur2');
    skeptic.social.record('Mallory', 'attacked_by');
    skeptic.social.receiveGossip('Mallory', 'Steve', 'Steve stole diamonds', 'negative');
    assert.ok(skeptic.social.dispositionToward('Steve') > after_trusted,
        'hearsay from someone you distrust should move you less');
});

test('hearsay never outweighs firsthand experience', () => {
    const a = makeAgent('A');
    a.social.record('Steve', 'attacked_by');
    const firsthand = a.social.dispositionToward('Steve');

    const b = makeAgent('B');
    b.social.record('Teller', 'helped'); // maximally credible short of perfect
    b.social.receiveGossip('Teller', 'Steve', 'Steve attacked me', 'negative');
    assert.ok(b.social.dispositionToward('Steve') > firsthand);
});

test('an honest trade pays off only once the goods actually arrive', () => {
    const seller = makeAgent('Seller');
    const buyer = makeAgent('Buyer');

    // the offer travels as a chat sentence and is parsed back into the book
    seller.social.proposeTrade('Buyer', 'diamond', 1, 'bread', 4);
    const wire = formatOfferMessage('diamond', 1, 'bread', 4);
    const parsed = parseOfferMessage(wire);
    buyer.social.receiveTrade('Seller', parsed.give_item, parsed.give_qty, parsed.want_item, parsed.want_qty);

    const evaluated = buyer.social.evaluatePending('Seller');
    assert.ok(evaluated.ratio > 1, 'a diamond for 4 bread favors the buyer');
    assert.match(buyer.social.getContext('Seller'), /Pending trade with Seller/);

    // buyer pays first — and earns nothing yet
    buyer.social.markAwaitingDelivery('Seller', 0);
    assert.equal(buyer.social.dispositionToward('Seller'), 0, 'paying is not evidence of good faith');

    // the diamond arrives
    buyer.social.checkDeliveries({ diamond: 1 });
    assert.ok(buyer.social.dispositionToward('Seller') > 0);
    assert.equal(buyer.social.trades.awaitingDelivery().length, 0);
});

test('a peer who takes payment and never delivers earns a grudge, not trust', () => {
    const buyer = makeAgent('Buyer2');
    buyer.social.receiveTrade('Cheater', 'diamond', 1, 'bread', 4);
    buyer.social.markAwaitingDelivery('Cheater', 0);

    // nothing arrives before the deadline
    buyer.social.checkDeliveries({}, Date.now() + 10 * 60000);
    assert.ok(buyer.social.dispositionToward('Cheater') < -0.1, 'reneging must cost the cheater');
    assert.ok(buyer.social.get('Cheater').grudge > 0.2);
    assert.match(buyer.social.get('Cheater').notes.at(-1), /reneged on a trade/);
});

test('relationships survive a restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'social-persist-'));
    const first = makeAgent('P');
    first.social.dir = dir;
    first.social.fp = path.join(dir, 'relationships.json');
    first.social.record('Steve', 'killed_by');
    first.social.addNote('Steve', 'he ambushed me at the ravine');
    first.social.flush();

    const second = makeAgent('P');
    second.social.dir = dir;
    second.social.fp = path.join(dir, 'relationships.json');
    second.social.relationships.clear();
    second.social._load();
    const rel = second.social.get('Steve');
    assert.ok(rel.grudge > 0.5);
    assert.match(rel.notes.at(-1), /ambushed me at the ravine/);
});

test('disabled social module is a complete no-op', () => {
    setSettings({ use_social: false, use_memory: true });
    const agent = makeAgent('Off');
    assert.equal(agent.social.enabled(), false);
    assert.equal(agent.social.record('Steve', 'killed_by'), null);
    assert.equal(agent.social.getContext('Steve'), '');
    assert.equal(agent.social.pickGossipFor('Steve'), '');
    assert.equal(agent.social.proposeTrade('Steve', 'a', 1, 'b', 1), null);
    setSettings({ use_social: true, use_memory: true });
});
