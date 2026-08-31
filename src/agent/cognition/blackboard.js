// The shared blackboard: one place where all tiers read/write agent state.
// Pure data + small helpers — no agent references, unit-testable.
// Writers: plan tier (drives, goal, thought), act tier (action context),
// reflex tier via onModeInterruption (interruptions), social tier (social),
// scheduler (tier_status). Readers: every tier, full_state for the dashboard.
export class Blackboard {
    constructor() {
        this.percepts = {};          // latest sensor snapshot {safety, food, wealth}
        this.drives = [];            // urgency list from DriveState.getUrgencies()
        this.goal = null;            // {drive, goal, step_index, steps_total, step}
        this.pending_replan = null;  // failure reason awaiting the plan tier
        this.current_action = '';    // ActionManager label
        this.last_thought = '';
        this.social = { in_conversation: false, partner: null };
        this.interruption = null;    // {by, interrupted, at, handled}
        this.tier_status = {};       // {tier: {runs, errors, busy, last_run}}
    }

    // A reflex seized the action slot from a deliberate action. Kept until the
    // act tier consumes it; a newer interruption replaces an unhandled older
    // one (the latest cause is the one worth reasoning about).
    noteInterruption(by, interrupted_action) {
        this.interruption = { by, interrupted: interrupted_action, at: Date.now(), handled: false };
    }

    // Read-and-consume: returns the unhandled interruption once, or null.
    takeInterruption() {
        if (!this.interruption || this.interruption.handled)
            return null;
        this.interruption.handled = true;
        return this.interruption;
    }

    hasUnhandledInterruption() {
        return this.interruption !== null && !this.interruption.handled;
    }

    // JSON-safe copy for the dashboard / full_state.
    snapshot() {
        return {
            percepts: { ...this.percepts },
            drives: this.drives.map(d => ({ ...d })),
            goal: this.goal ? { ...this.goal } : null,
            pending_replan: this.pending_replan,
            current_action: this.current_action,
            last_thought: this.last_thought,
            social: { ...this.social },
            interruption: this.interruption ? { ...this.interruption } : null,
            tiers: Object.fromEntries(Object.entries(this.tier_status).map(([k, v]) => [k, { ...v }])),
        };
    }
}
