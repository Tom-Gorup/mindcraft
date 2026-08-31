// Pure execution monitoring: tracks failures on the current plan step and
// decides between retrying the step, replanning the goal, or abandoning it.
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
        this.step_started_at = null;
    }

    startStep(now = Date.now()) {
        this.step_failures = 0;
        this.step_started_at = now;
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

    isStepTimedOut(now = Date.now()) {
        return this.step_started_at !== null && (now - this.step_started_at) > this.step_timeout_ms;
    }
}
