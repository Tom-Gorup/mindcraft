import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeBook, newOffer, offerRatio, evaluateOffer, itemValue, formatOfferMessage, parseOfferMessage } from '../../src/agent/social/trade.js';

test('offer ratio reflects relative worth', () => {
    // they give 1 diamond (16), we give 16 cobblestone (8) -> favors us
    assert.ok(offerRatio(newOffer('A', 'B', 'diamond', 1, 'cobblestone', 16)) > 1.5);
    // they give 1 dirt, we give 1 diamond -> terrible for us
    assert.ok(offerRatio(newOffer('A', 'B', 'dirt', 1, 'diamond', 1)) < 0.05);
    assert.equal(itemValue('unknown_item', 3), 3); // unknown items default to 1 each
});

test('friends accept worse deals than strangers, enemies demand better', () => {
    const lopsided = newOffer('A', 'B', 'iron_ingot', 1, 'iron_ingot', 2); // ratio 0.5
    const stranger = evaluateOffer(lopsided, 0, 0.5);
    const friend = evaluateOffer(lopsided, 0.9, 0.5);
    const enemy = evaluateOffer(lopsided, -0.9, 0.5);
    assert.ok(friend.threshold < stranger.threshold);
    assert.ok(enemy.threshold > stranger.threshold);
    // nobody pays double, however friendly
    assert.equal(friend.fair, false);

    // a slightly unfavorable deal: friends take it, strangers and enemies don't
    const slight = newOffer('A', 'B', 'iron_ingot', 3, 'iron_ingot', 4); // ratio 0.75
    assert.equal(evaluateOffer(slight, 0.9, 0.5).fair, true);
    assert.equal(evaluateOffer(slight, 0, 0.5).fair, false);
    assert.equal(evaluateOffer(slight, -0.9, 0.5).fair, false);
});

test('generosity widens the acceptable band', () => {
    const offer = newOffer('A', 'B', 'iron_ingot', 1, 'iron_ingot', 2);
    assert.ok(evaluateOffer(offer, 0, 1).threshold < evaluateOffer(offer, 0, 0).threshold);
});

test('advice text matches the ratio band', () => {
    assert.match(evaluateOffer(newOffer('A','B','diamond',2,'dirt',1), 0).advice, /favors you/);
    assert.match(evaluateOffer(newOffer('A','B','iron_ingot',1,'iron_ingot',1), 0).advice, /roughly fair/);
    assert.match(evaluateOffer(newOffer('A','B','dirt',1,'diamond',4), 0).advice, /lopsided/);
});

test('trade book tracks, resolves, and expires offers', () => {
    const book = new TradeBook();
    book.receive(newOffer('Wilbur', 'me', 'diamond', 1, 'bread', 4, 1000));
    assert.ok(book.pending('Wilbur'));

    book.resolve('Wilbur', 'accepted');
    assert.equal(book.pending('Wilbur'), null); // no longer pending once resolved

    book.receive(newOffer('Steve', 'me', 'diamond', 1, 'bread', 4, 1000));
    const expired = book.expire(5 * 60000, 1000 + 6 * 60000);
    assert.deepEqual(expired, ['Steve']);
    assert.equal(book.pending('Steve'), null); // stale offers can't be accepted later
});

test('an outgoing offer can never be accepted by its own author', () => {
    const book = new TradeBook();
    // we offer Greta a diamond and want bread back
    book.propose(newOffer('me', 'Greta', 'diamond', 1, 'bread', 4));
    // pending() is for offers made TO us — ours must not appear, or we would
    // "accept" it and hand over the bread we meant to receive
    assert.equal(book.pending('Greta'), null);
    assert.ok(book.outstanding('Greta'));
});

test('offer messages round-trip through the wire format', () => {
    const msg = formatOfferMessage('diamond', 1, 'bread', 4);
    const parsed = parseOfferMessage(msg);
    assert.deepEqual(parsed, { give_item: 'diamond', give_qty: 1, want_item: 'bread', want_qty: 4 });
    // embedded in a longer utterance
    assert.ok(parseOfferMessage(`Hey there. ${msg} Let me know!`));
    // non-offers and nonsense quantities are rejected
    assert.equal(parseOfferMessage('lovely weather'), null);
    assert.equal(parseOfferMessage("I'll trade you 0 diamond for 4 bread. Deal?"), null);
    assert.equal(parseOfferMessage(null), null);
});

test('awaitingDelivery only surfaces offers we have already paid for', () => {
    const book = new TradeBook();
    book.receive(newOffer('Wilbur', 'me', 'diamond', 1, 'bread', 4));
    assert.equal(book.awaitingDelivery().length, 0);
    const offer = book.pending('Wilbur');
    offer.state = 'awaiting_delivery';
    assert.equal(book.awaitingDelivery().length, 1);
});

test('inherited object keys cannot poison item values', () => {
    assert.equal(itemValue('constructor', 1), 1);
    assert.equal(itemValue('toString', 2), 2);
    assert.ok(Number.isFinite(offerRatio(newOffer('A', 'B', 'constructor', 1, 'toString', 1))));
});

test('a zero-value ask is not treated as infinitely generous by mistake', () => {
    // both sides unknown items -> parity, not Infinity
    const offer = newOffer('A', 'B', 'mystery_a', 1, 'mystery_b', 1);
    assert.equal(offerRatio(offer), 1);
});
