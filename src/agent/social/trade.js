// Trade negotiation state. Pure bookkeeping + a relationship-modulated
// fairness judgement; the actual item transfer reuses skills.giveToPlayer via
// the existing command layer, and the *negotiation* is left to the agents'
// own conversation (emergent over scripted).

// Rough per-unit worth, used only to judge whether an offer is lopsided.
const ITEM_VALUES = {
    diamond: 16, emerald: 12, gold_ingot: 6, iron_ingot: 4, coal: 1,
    raw_iron: 3, raw_gold: 5, redstone: 1, lapis_lazuli: 1, quartz: 2,
    oak_log: 1, spruce_log: 1, birch_log: 1, stone: 0.5, cobblestone: 0.5,
    dirt: 0.1, sand: 0.2, gravel: 0.2, bread: 2, cooked_beef: 3, apple: 2,
    golden_apple: 20, wheat: 1, carrot: 1, potato: 1, stick: 0.2,
    iron_pickaxe: 15, diamond_pickaxe: 60, iron_sword: 10, diamond_sword: 40,
    torch: 0.5, crafting_table: 2, furnace: 4, chest: 3, bed: 5, shield: 8,
    bow: 8, arrow: 1, string: 1, leather: 2, feather: 0.5, bone: 1,
};

export function itemValue(item, qty = 1) {
    return (ITEM_VALUES[item] ?? 1) * qty;
}

export function newOffer(from, to, give_item, give_qty, want_item, want_qty, now = Date.now()) {
    return { from, to, give_item, give_qty, want_item, want_qty, created_at: now, state: 'pending' };
}

// Ratio of what we receive to what we give. >1 favors us.
export function offerRatio(offer) {
    const receive = itemValue(offer.give_item, offer.give_qty);   // what THEY give us
    const give = itemValue(offer.want_item, offer.want_qty);      // what WE give them
    if (give <= 0) return receive > 0 ? Infinity : 1;
    return receive / give;
}

// Should the receiving agent accept? Generosity and a good relationship widen
// the band of acceptable deals; a grudge narrows it. Pure — the LLM still
// decides in practice, this is the disposition we hand it.
export function evaluateOffer(offer, disposition, generosity = 0.5) {
    const ratio = offerRatio(offer);
    // neutral strangers want at least parity; friends accept worse deals
    const threshold = 1 - (disposition * 0.45) - (generosity - 0.5) * 0.4;
    const fair = ratio >= threshold;
    let advice;
    if (ratio >= 1.25) advice = 'this offer favors you';
    else if (ratio >= 0.85) advice = 'this offer is roughly fair';
    else if (ratio >= 0.5) advice = 'this offer favors them';
    else advice = 'this offer is very lopsided against you';
    return { ratio: Number(ratio.toFixed(2)), fair, threshold: Number(threshold.toFixed(2)), advice };
}

export class TradeBook {
    constructor() {
        this.offers = new Map(); // peer name -> offer
    }

    propose(offer) {
        this.offers.set(offer.to, offer);
        return offer;
    }

    receive(offer) {
        this.offers.set(offer.from, offer);
        return offer;
    }

    pending(peer) {
        const offer = this.offers.get(peer);
        return offer && offer.state === 'pending' ? offer : null;
    }

    resolve(peer, state) {
        const offer = this.offers.get(peer);
        if (!offer) return null;
        offer.state = state;
        return offer;
    }

    clear(peer) {
        this.offers.delete(peer);
    }

    // Expire stale offers so a forgotten proposal can't be accepted hours later.
    expire(max_age_ms = 5 * 60000, now = Date.now()) {
        const expired = [];
        for (const [peer, offer] of this.offers) {
            if (offer.state === 'pending' && now - offer.created_at > max_age_ms) {
                offer.state = 'expired';
                expired.push(peer);
            }
        }
        return expired;
    }
}
