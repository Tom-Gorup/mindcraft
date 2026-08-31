import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import settings from '../settings.js';
import { getInventoryCounts } from '../library/world.js';
import {
    newRelationship, applyInteraction, decay, disposition, describeRelationship,
    DEFAULT_PERSONALITY,
} from './relationships.js';
import { selectGossip, shouldGossip, credibility, attributedNote } from './gossip.js';
import { TradeBook, newOffer, evaluateOffer } from './trade.js';

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clampPM1 = (x) => Math.max(-1, Math.min(1, x));

// The social module: durable per-peer relationships, gossip with attribution,
// and trade bookkeeping. Reaches behavior by MODULATING the existing
// conversation prompt ($SOCIAL) rather than driving actions itself — it is
// not a deliberative tier and never competes for the action slot.
// Costs no LLM calls: relationship math is pure and gossip is selected from
// memories the agent already holds.
// Public methods never throw (called from chat/event hot paths).
export class SocialModule {
    constructor(agent) {
        this.agent = agent;
        const profile = agent.prompter.profile;
        // profile values are user-authored: a non-numeric knob would turn every
        // relationship value into NaN permanently (NaN survives clamping)
        const raw_personality = { ...DEFAULT_PERSONALITY, ...(profile.social || {}) };
        this.personality = { ...DEFAULT_PERSONALITY };
        for (const key of Object.keys(DEFAULT_PERSONALITY)) {
            if (typeof raw_personality[key] === 'number' && Number.isFinite(raw_personality[key]))
                this.personality[key] = raw_personality[key];
            else if (raw_personality[key] !== undefined && key in (profile.social || {}))
                console.warn(`Social: ignoring non-numeric personality value for '${key}'.`);
        }
        const opts = profile.social || {};
        this.max_notes = opts.max_notes ?? 6;
        this.persist_throttle_ms = opts.persist_throttle_ms ?? 10000;
        this.gossip_cooldown_ms = opts.gossip_cooldown_ms ?? 2 * 60000;
        this.gossip_repeat_ms = opts.gossip_repeat_ms ?? 15000; // idempotency window for prompt renders
        // Generous by design: an honest partner still has to notice the
        // acceptance, walk across the world, and toss the items. Punishing a
        // slow-but-honest peer as a defector is worse than missing a cheat.
        this.delivery_timeout_ms = opts.delivery_timeout_ms ?? 6 * 60000;
        this.max_relationships = opts.max_relationships ?? 200;
        this.min_notable_disposition = opts.min_notable_disposition ?? 0.08;
        this.interaction_cooldowns = opts.interaction_cooldowns ?? { conversed: 20000, gave_item: 5000, attacked: 10000 };

        this.relationships = new Map();
        this.trades = new TradeBook();
        this.told = new Map();          // peer -> Set of event ids already retold
        this._last_interaction_at = new Map(); // "peer:type" -> ts, anti-spam
        this._gossip_cache = null;
        this.last_gossip_at = 0;
        this.last_decay = Date.now();
        this.last_persist = 0;
        this._persist_timer = null;
        this.dir = null;

        if (settings.use_social) {
            this.dir = opts.dir || `./bots/${agent.name}/social`;
            this.fp = path.join(this.dir, 'relationships.json');
            try {
                mkdirSync(this.dir, { recursive: true });
                this._load();
            } catch (err) {
                console.error('Social: failed to initialize store:', err.message || err);
            }
        }
    }

    enabled() {
        return !!settings.use_social && this.dir !== null;
    }

    // ---- relationships ----

    get(name) {
        if (!name) return null;
        if (!this.relationships.has(name))
            this.relationships.set(name, newRelationship(name, Date.now()));
        return this.relationships.get(name);
    }

    // Record an interaction with a peer. Never throws.
    // Repeatable interactions are rate-limited per (peer, type): otherwise a
    // peer can farm trust or a grudge just by spamming chat lines, since every
    // inbound message records 'conversed'.
    record(name, type, opts = {}) {
        if (!this.enabled() || !name || name === this.agent.name) return null;
        try {
            const cooldown = this.interaction_cooldowns[type];
            if (cooldown) {
                const key = `${name}:${type}`;
                const last = this._last_interaction_at.get(key) || 0;
                const now = Date.now();
                if (now - last < cooldown)
                    return this.relationships.get(name) || null;
                this._last_interaction_at.set(key, now);
            }
            const rel = this.get(name);
            const before = disposition(rel);
            applyInteraction(rel, type, this.personality, { ...opts, now: Date.now() });
            const after = disposition(rel);
            this._persistThrottled();
            // notable swings are worth remembering as events for the trace
            if (Math.abs(after - before) >= 0.12) {
                // plain-language only: dumping trust/affinity numbers and
                // stored notes here would put internal telemetry into the
                // retrievable memory stream and back into $MEMORY
                const direction = after > before ? 'warmed toward' : 'cooled toward';
                this.agent.memory?.record('social',
                    `You ${direction} ${name} after ${type.replace(/_/g, ' ')}.`,
                    { peer: name, interaction: type, disposition: Number(after.toFixed(2)) });
            }
            return rel;
        } catch (err) {
            console.error('Social: record failed:', err.message || err);
            return null;
        }
    }

    addNote(name, note) {
        if (!this.enabled() || !note) return;
        try {
            const rel = this.get(name);
            rel.notes.push(String(note).replace(/[\r\n]+/g, ' ').substring(0, 200));
            if (rel.notes.length > this.max_notes)
                rel.notes = rel.notes.slice(-this.max_notes);
            this._persistThrottled();
        } catch (err) {
            console.error('Social: addNote failed:', err.message || err);
        }
    }

    dispositionToward(name) {
        if (!this.enabled() || !this.relationships.has(name)) return 0;
        return disposition(this.relationships.get(name));
    }

    // ---- tier tick (cadenced by the scheduler; pure bookkeeping) ----

    tick() {
        if (!this.enabled()) return;
        try {
            const now = Date.now();
            const elapsed = now - this.last_decay;
            if (elapsed >= 60000) {
                this.last_decay = now;
                for (const rel of this.relationships.values())
                    decay(rel, elapsed, this.personality);
            }
            for (const peer of this.trades.expire(5 * 60000, now))
                this.agent.memory?.record('social', `Trade offer with ${peer} expired.`, { peer });
            if (this.trades.awaitingDelivery().length > 0) {
                const counts = this.agent.bot ? getInventoryCounts(this.agent.bot) : {};
                this.checkDeliveries(counts, now);
            }
            // bound the anti-spam map on a 24/7 process with transient players.
            // Drop only interaction cooldowns; gossip keys stay, or clearing
            // them would briefly re-open the compounding-grudge window.
            if (this._last_interaction_at.size > 2000) {
                for (const key of [...this._last_interaction_at.keys()])
                    if (!key.startsWith('gossip:')) this._last_interaction_at.delete(key);
            }
            // eviction must run during the session too, not only on load:
            // relationships accrue for every distinct chat source
            if (this.relationships.size > this.max_relationships)
                this._evictRelationships();
        } catch (err) {
            console.error('Social: tick failed:', err.message || err);
        }
    }

    // ---- gossip ----

    // A line of secondhand news to volunteer to `listener`, or ''. Selected
    // from existing memories — no model call.
    // IDEMPOTENT within a short window: this is reached from prompt rendering,
    // which runs up to 3x per promptConvo (retry loop) and again on every
    // prompt of a turn. Re-rolling per call would burn through the agent's
    // gossip on retries and make the same turn's prompts inconsistent.
    pickGossipFor(listener) {
        if (!this.enabled() || !this.agent.memory?.enabled()) return '';
        try {
            const now = Date.now();
            const cached = this._gossip_cache;
            if (cached && cached.listener === listener && now - cached.at < this.gossip_repeat_ms)
                return cached.line;
            if (now - this.last_gossip_at < this.gossip_cooldown_ms)
                return this._cacheGossip(listener, '', now);
            const known = this._knownNames();
            if (known.length === 0)
                return this._cacheGossip(listener, '', now);
            if (!shouldGossip(this.personality.gossip_propensity, this.dispositionToward(listener), Math.random()))
                return this._cacheGossip(listener, '', now);
            const told = this.told.get(listener) || new Set();
            const pick = selectGossip(this.agent.memory.events, listener, known, { now, already_told: told });
            if (!pick)
                return this._cacheGossip(listener, '', now);
            told.add(pick.event.id);
            this.told.set(listener, told);
            this.last_gossip_at = now;
            const claim = String(pick.event.content).replace(/[\r\n]+/g, ' ').substring(0, 200);
            return this._cacheGossip(listener, `You could mention to ${listener} what you know about ${pick.subject}: "${claim}"`, now);
        } catch (err) {
            console.error('Social: gossip selection failed:', err.message || err);
            return '';
        }
    }

    _cacheGossip(listener, line, at) {
        this._gossip_cache = { listener, line, at };
        return line;
    }

    // Someone told us something about a third party. Belief — and the
    // relationship nudge toward the subject — is weighted by trust in the teller.
    receiveGossip(teller, subject, claim, valence = 'negative') {
        if (!this.enabled() || !subject || subject === this.agent.name) return;
        try {
            // one peer repeating the same accusation must not compound into a
            // maxed-out grudge — rate-limit per (teller, subject)
            const key = `gossip:${teller}:${subject}`;
            const now = Date.now();
            if (now - (this._last_interaction_at.get(key) || 0) < this.gossip_cooldown_ms)
                return;
            this._last_interaction_at.set(key, now);
            const teller_rel = this.get(teller);
            const weight = credibility(teller_rel.trust);
            if (weight <= 0) return;
            const note = attributedNote(teller, subject, claim);
            this.addNote(subject, note);
            this.record(subject, valence === 'positive' ? 'heard_well_of' : 'heard_ill_of', { weight });
            this.agent.memory?.record('gossip', note, { teller, subject, weight: Number(weight.toFixed(2)) });
        } catch (err) {
            console.error('Social: receiveGossip failed:', err.message || err);
        }
    }

    // ---- trade ----

    proposeTrade(to, give_item, give_qty, want_item, want_qty) {
        if (!this.enabled()) return null;
        return this.trades.propose(newOffer(this.agent.name, to, give_item, give_qty, want_item, want_qty));
    }

    receiveTrade(from, give_item, give_qty, want_item, want_qty) {
        if (!this.enabled()) return null;
        return this.trades.receive(newOffer(from, this.agent.name, give_item, give_qty, want_item, want_qty));
    }

    // We paid our side. Trust is NOT awarded yet — it is earned only when the
    // counterparty actually delivers (see checkDeliveries). Otherwise anyone
    // could farm trust by making offers and never honoring them.
    markAwaitingDelivery(peer, baseline_count) {
        const offer = this.trades.pending(peer);
        if (!offer) return null;
        offer.state = 'awaiting_delivery';
        offer.paid_at = Date.now();
        offer.baseline_count = baseline_count;
        return offer;
    }

    // Called from the social tier: did the goods arrive?
    checkDeliveries(inventoryCounts, now = Date.now()) {
        if (!this.enabled()) return;
        for (const offer of this.trades.awaitingDelivery()) {
            const have = inventoryCounts[offer.give_item] || 0;
            if (have >= (offer.baseline_count || 0) + offer.give_qty) {
                offer.state = 'completed';
                this.record(offer.from, 'traded_fairly');
                this.agent.memory?.record('social',
                    `${offer.from} delivered ${offer.give_qty} ${offer.give_item} as promised.`, { peer: offer.from });
            }
            else if (now - offer.paid_at > this.delivery_timeout_ms) {
                offer.state = 'reneged';
                this.record(offer.from, 'trade_reneged');
                this.agent.memory?.record('social',
                    `${offer.from} took my ${offer.want_qty} ${offer.want_item} and never delivered the ${offer.give_item}.`,
                    { peer: offer.from });
                this.addNote(offer.from, `reneged on a trade: took ${offer.want_qty} ${offer.want_item}, never paid`);
            }
        }
    }

    // The peer accepted our offer and says they have paid. Mark our outgoing
    // offer accepted so it is not expired out from under us, and record what
    // we now owe — without this, an honest trade ends with BOTH sides booking
    // a renege: theirs on our silence, ours on the expiry.
    onOfferAccepted(peer, accepted) {
        if (!this.enabled()) return null;
        try {
            const offer = this.trades.outstanding(peer);
            if (!offer) return null;
            offer.state = 'accepted';
            offer.accepted_at = Date.now();
            this.agent.memory?.record('social',
                `${peer} accepted the trade and sent ${accepted.sent_qty} ${accepted.sent_item}; I owe ${offer.give_qty} ${offer.give_item}.`,
                { peer });
            return offer;
        } catch (err) {
            console.error('Social: onOfferAccepted failed:', err.message || err);
            return null;
        }
    }

    // What we still owe a peer, for the $SOCIAL prompt context.
    owedTo(peer) {
        const offer = this.trades.outgoing.get(peer);
        return offer && offer.state === 'accepted' ? offer : null;
    }

    evaluatePending(peer) {
        const offer = this.trades.pending(peer);
        if (!offer) return null;
        return { offer, ...evaluateOffer(offer, this.dispositionToward(peer), this.personality.generosity) };
    }

    // ---- prompt context ($SOCIAL) ----

    getContext(peer = null) {
        if (!this.enabled()) return '';
        try {
            let text = '';
            // only peers the agent actually has an opinion about: a wall of
            // "neutral acquaintance (trust 0.50, affinity 0.00)" lines is pure
            // prompt noise, and it accrues for every stranger who says hello
            const rels = [...this.relationships.values()]
                .filter(r => Math.abs(disposition(r)) >= this.min_notable_disposition || r.notes.length > 0)
                .sort((a, b) => Math.abs(disposition(b)) - Math.abs(disposition(a)))
                .slice(0, 5);
            if (rels.length > 0) {
                text += 'Your relationships:\n';
                for (const rel of rels)
                    text += `- ${describeRelationship(rel)}\n`;
            }
            if (peer) {
                const evaluated = this.evaluatePending(peer);
                if (evaluated) {
                    const o = evaluated.offer;
                    text += `Pending trade with ${peer}: they give ${o.give_qty} ${o.give_item} for your ${o.want_qty} ${o.want_item} — ${evaluated.advice}.\n`;
                }
                const owed = this.owedTo(peer);
                if (owed)
                    text += `${peer} accepted your trade and has paid — you still owe them ${owed.give_qty} ${owed.give_item}. Use !givePlayer to deliver.\n`;
                const gossip = this.pickGossipFor(peer);
                if (gossip)
                    text += gossip + '\n';
            }
            return text.trim();
        } catch (err) {
            console.error('Social: getContext failed:', err.message || err);
            return '';
        }
    }

    getStatus() {
        try {
            return this._status();
        } catch (err) {
            console.error('Social: getStatus failed:', err.message || err);
            return { enabled: false, relationships: [] };
        }
    }

    _status() {
        return {
            enabled: this.enabled(),
            relationships: [...this.relationships.values()].map(r => ({
                name: r.name,
                trust: Number(r.trust.toFixed(2)),
                affinity: Number(r.affinity.toFixed(2)),
                grudge: Number(r.grudge.toFixed(2)),
                disposition: Number(disposition(r).toFixed(2)),
                interactions: r.interactions,
            })),
        };
    }

    // ---- internals ----

    _knownNames() {
        const names = new Set(this.relationships.keys());
        try {
            for (const n of this.agent.bot?.players ? Object.keys(this.agent.bot.players) : [])
                if (n !== this.agent.name) names.add(n);
        } catch { /* bot not ready */ }
        return [...names];
    }

    _load() {
        if (!existsSync(this.fp)) return;
        try {
            const data = JSON.parse(readFileSync(this.fp, 'utf8'));
            for (const rel of (Array.isArray(data.relationships) ? data.relationships : [])) {
                if (!rel || typeof rel.name !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(rel.name))
                    continue;
                // Coerce every field: a hand-edited or truncated file must not
                // put a string/null into trust, which makes disposition() NaN
                // and throws out of the prompt path (silently disabling social
                // context for the whole session).
                const base = newRelationship(rel.name, num(rel.first_seen, Date.now()));
                this.relationships.set(rel.name, {
                    ...base,
                    trust: clamp01(num(rel.trust, base.trust)),
                    affinity: clampPM1(num(rel.affinity, base.affinity)),
                    grudge: clamp01(num(rel.grudge, base.grudge)),
                    interactions: Math.max(0, Math.floor(num(rel.interactions, 0))),
                    last_interaction: num(rel.last_interaction, base.last_interaction),
                    // strip newlines here too, matching addNote: notes reach the
                    // system prompt, and a hand-edited file must not be able to
                    // forge prompt structure the write path forbids
                    notes: Array.isArray(rel.notes)
                        ? rel.notes.filter(n => typeof n === 'string').slice(-this.max_notes)
                            .map(n => n.replace(/[\r\n]+/g, ' ').substring(0, 200))
                        : [],
                });
            }
            this._evictRelationships();
            if (this.relationships.size > 0)
                console.log(`Social: loaded ${this.relationships.size} relationships.`);
        } catch (err) {
            console.error('Social: failed to load relationships, starting fresh:', err.message || err);
        }
    }

    // Keep the most significant relationships; an unbounded map is
    // re-serialized into the blackboard every 2s and polled every 1s.
    _evictRelationships() {
        if (this.relationships.size <= this.max_relationships) return;
        const kept = [...this.relationships.values()]
            .sort((a, b) => Math.abs(disposition(b)) - Math.abs(disposition(a)))
            .slice(0, this.max_relationships);
        this.relationships = new Map(kept.map(r => [r.name, r]));
    }

    flush() {
        if (!this.enabled()) return;
        if (this._persist_timer) {
            clearTimeout(this._persist_timer);
            this._persist_timer = null;
        }
        this._persistNow();
    }

    _persistNow() {
        if (!this.enabled()) return;
        try {
            this.last_persist = Date.now();
            const tmp = this.fp + '.tmp';
            writeFileSync(tmp, JSON.stringify({ relationships: [...this.relationships.values()] }));
            renameSync(tmp, this.fp);
        } catch (err) {
            console.error('Social: failed to persist:', err.message || err);
        }
    }

    _persistThrottled() {
        if (!this.enabled()) return;
        const since = Date.now() - this.last_persist;
        if (since >= this.persist_throttle_ms) {
            this._persistNow();
        } else if (!this._persist_timer) {
            this._persist_timer = setTimeout(() => {
                this._persist_timer = null;
                this._persistNow();
            }, this.persist_throttle_ms - since);
            this._persist_timer.unref?.();
        }
    }
}
