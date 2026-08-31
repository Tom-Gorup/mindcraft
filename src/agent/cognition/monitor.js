// Pure execution monitoring: tracks failures on the current plan step and
// decides between retrying the step, replanning the goal, or abandoning it.
// Step timeouts count *active* time only — the loop feeds in time via
// noteActiveTime() exclusively while the agent could actually work the step
// (prompting, or idle and eligible), so conversations, user goals, and
// legitimately long Minecraft actions don't burn the budget.
// No agent references — unit-testable.

export class ExecutionMonitor {
    constructor(opts = {}) {
        this.max_step_retries = opts.max_step_retries ?? 1;
        this.max_replans = opts.max_replans ?? 2;
        this.step_timeout_ms = opts.step_timeout_ms ?? 5 * 60000;
        this.reset();
    }

    // Called when a new goal/plan begins.
    reset() {
        this.step_failures = 0;
        this.replans = 0;
        this.step_active_ms = 0;
    }

    startStep() {
        this.step_failures = 0;
        this.step_active_ms = 0;
    }

    noteActiveTime(delta_ms) {
        this.step_active_ms += delta_ms;
    }

    // A step failed (self-reported, repeated non-response, or timeout).
    // Returns 'retry' | 'replan' | 'abandon'.
    noteFailure() {
        this.step_failures++;
        if (this.step_failures <= this.max_step_retries)
            return 'retry';
        if (this.replans < this.max_replans) {
            this.replans++;
            this.step_failures = 0;
            return 'replan';
        }
        return 'abandon';
    }

    isStepTimedOut() {
        return this.step_active_ms > this.step_timeout_ms;
    }
}
