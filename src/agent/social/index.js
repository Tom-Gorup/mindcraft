import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import settings from '../settings.js';
import {
    newRelationship, applyInteraction, decay, disposition, describeRelationship,
    DEFAULT_PERSONALITY,
} from './relationships.js';
import { selectGossip, shouldGossip, credibility, attributedNote } from './gossip.js';
import { TradeBook, newOffer, evaluateOffer } from './trade.js';

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
        this.personality = { ...DEFAULT_PERSONALITY, ...(profile.social || {}) };
        const opts = profile.social || {};
        this.max_notes = opts.max_notes ?? 6;
        this.persist_throttle_ms = opts.persist_throttle_ms ?? 10000;
        this.gossip_cooldown_ms = opts.gossip_cooldown_ms ?? 2 * 60000;

        this.relationships = new Map();
        this.trades = new TradeBook();
        this.told = new Map();          // peer -> Set of event ids already retold
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
    record(name, type, opts = {}) {
        if (!this.enabled() || !name || name === this.agent.name) return null;
        try {
            const rel = this.get(name);
            const before = disposition(rel);
            applyInteraction(rel, type, this.personality, { ...opts, now: Date.now() });
            const after = disposition(rel);
            this._persistThrottled();
            // notable swings are worth remembering as events for the trace
            if (Math.abs(after - before) >= 0.12) {
                this.agent.memory?.record('social',
                    `Feelings toward ${name} shifted after ${type.replace(/_/g, ' ')} (now ${describeRelationship(rel)})`,
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
        } catch (err) {
            console.error('Social: tick failed:', err.message || err);
        }
    }

    // ---- gossip ----

    // A line of secondhand news to volunteer to `listener`, or ''. Selected
    // from existing memories — no model call.
    pickGossipFor(listener) {
        if (!this.enabled() || !this.agent.memory?.enabled()) return '';
        try {
            const now = Date.now();
            if (now - this.last_gossip_at < this.gossip_cooldown_ms) return '';
            const known = this._knownNames();
            if (known.length === 0) return '';
            if (!shouldGossip(this.personality.gossip_propensity, this.dispositionToward(listener), Math.random()))
                return '';
            const told = this.told.get(listener) || new Set();
            const pick = selectGossip(this.agent.memory.events, listener, known, { now, already_told: told });
            if (!pick) return '';
            told.add(pick.event.id);
            this.told.set(listener, told);
            this.last_gossip_at = now;
            return `You could mention to ${listener} what you know about ${pick.subject}: "${pick.event.content}"`;
        } catch (err) {
            console.error('Social: gossip selection failed:', err.message || err);
            return '';
        }
    }

    // Someone told us something about a third party. Belief — and the
    // relationship nudge toward the subject — is weighted by trust in the teller.
    receiveGossip(teller, subject, claim, valence = 'negative') {
        if (!this.enabled() || !subject || subject === this.agent.name) return;
        try {
            const teller_rel = this.get(teller);
            const weight = credibility(teller_rel.trust);
            if (weight <= 0) return;
            const note = attributedNote(teller, subject, claim);
            this.addNote(subject, note);
            this.record(subject, valence === 'positive' ? 'praised' : 'insulted', { weight });
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
            const rels = [...this.relationships.values()]
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
                if (!rel || typeof rel.name !== 'string') continue;
                this.relationships.set(rel.name, {
                    ...newRelationship(rel.name, rel.first_seen || Date.now()),
                    ...rel,
                    notes: Array.isArray(rel.notes) ? rel.notes.slice(-this.max_notes).map(String) : [],
                });
            }
            if (this.relationships.size > 0)
                console.log(`Social: loaded ${this.relationships.size} relationships.`);
        } catch (err) {
            console.error('Social: failed to load relationships, starting fresh:', err.message || err);
        }
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
