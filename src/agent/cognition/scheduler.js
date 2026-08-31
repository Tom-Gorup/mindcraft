// Cadenced tier dispatch for the PIANO-style architecture. Driven from the
// agent's 300ms update pump: each tick() distributes elapsed time to tiers;
// a tier fires when its cadence elapses, is skipped (not queued twice) while
// its previous run is still in flight, and its errors are isolated — a
// throwing tier never takes down the pump or its siblings.
// Pure: knows nothing about agents. Unit-testable with fake tiers.
export class TierScheduler {
    constructor(blackboard = null) {
        this.blackboard = blackboard;
        this.tiers = [];
        this.stall_ms = 180000;
    }

    // runFn(elapsed_ms) — sync or async. Registration order = execution order
    // within a tick (register reflexes first).
    addTier(name, cadence_ms, runFn) {
        this.tiers.push({
            name, cadence_ms, runFn,
            accum: 0, busy: false,
            runs: 0, errors: 0, last_error: null, last_run: 0,
        });
    }

    tick(delta) {
        for (const tier of this.tiers) {
            tier.accum += delta;
            if (tier.busy || tier.accum < tier.cadence_ms) {
                this._publish(tier);
                continue;
            }
            const elapsed = tier.accum;
            tier.accum = 0;
            tier.busy = true;
            tier.last_run = Date.now();
            let result;
            try {
                result = tier.runFn(elapsed);
            } catch (err) {
                this._fail(tier, err);
                tier.busy = false;
                this._publish(tier);
                continue;
            }
            if (result && typeof result.then === 'function') {
                // async tier: stays busy (skipped, not queued) until it settles.
                // A tier that never settles would otherwise wedge forever with
                // errors=0 — i.e. look healthy on the dashboard while doing
                // nothing — so warn once past a generous deadline.
                const stuck = setTimeout(() => {
                    if (tier.busy) {
                        tier.stalled = true;
                        console.warn(`Tier '${tier.name}' has not completed after ${Math.round(this.stall_ms / 1000)}s; it may be waiting on a hung provider.`);
                        this._publish(tier);
                    }
                }, this.stall_ms);
                stuck.unref?.();
                result
                    .then(() => { tier.runs++; })
                    .catch(err => this._fail(tier, err))
                    .then(() => {
                        clearTimeout(stuck);
                        tier.busy = false;
                        tier.stalled = false;
                        this._publish(tier);
                    });
            } else {
                // sync tier: completes within this tick
                tier.runs++;
                tier.busy = false;
            }
            this._publish(tier);
        }
    }

    getTier(name) {
        return this.tiers.find(t => t.name === name) || null;
    }

    _fail(tier, err) {
        tier.errors++;
        tier.last_error = String(err?.message || err);
        console.error(`Tier '${tier.name}' error:`, err);
    }

    _publish(tier) {
        if (!this.blackboard) return;
        this.blackboard.tier_status[tier.name] = {
            runs: tier.runs,
            errors: tier.errors,
            busy: tier.busy,
            stalled: !!tier.stalled,
            last_run: tier.last_run,
            cadence_ms: tier.cadence_ms,
        };
    }
}
