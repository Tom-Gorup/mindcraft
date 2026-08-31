import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeBook, newOffer, offerRatio, evaluateOffer, itemValue } from '../../src/agent/social/trade.js';

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

test('a zero-value ask is not treated as infinitely generous by mistake', () => {
    // both sides unknown items -> parity, not Infinity
    const offer = newOffer('A', 'B', 'mystery_a', 1, 'mystery_b', 1);
    assert.equal(offerRatio(offer), 1);
});
