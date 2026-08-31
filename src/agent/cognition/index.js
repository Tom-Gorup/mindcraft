import { readFileSync, writeFileSync, existsSync } from 'fs';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { DriveState } from './drives.js';
import { selectDrive } from './arbiter.js';
import { ExecutionMonitor } from './monitor.js';
import { Planner, formatPlan } from './planner.js';
import { readSensors } from './sensors.js';
import { Blackboard } from './blackboard.js';

// The cognitive core: arbitrate drives -> generate a goal -> plan steps ->
// drive the existing handleMessage/command machinery -> observe -> replan.
// Split into two cadenced tiers over the shared blackboard (PIANO-style):
//   planTick (slow) — drives, arbitration, goal generation, replanning,
//     preemption, and timeouts. Runs even while the act tier is mid-LLM-call,
//     so preemption/timeouts stay live during slow steps.
//   actTick (fast) — step prompting through handleMessage.
// Each tier has its own busy guard; they coordinate via pending_replan and
// step_interrupt. Dormant unless settings.use_cognition.
export class CognitionLoop {
    constructor(agent) {
        this.agent = agent;
        this.blackboard = agent.blackboard || new Blackboard();
        const profile = agent.prompter.profile;
        const opts = profile.cognition || {};

        this.drive_state = new DriveState(profile.drives || {});
        this.monitor = new ExecutionMonitor(opts);
        this.planner = new Planner(agent);

        this.step_cooldown_ms = opts.step_cooldown_ms ?? 2000;
        this.goal_cooldown_ms = opts.goal_cooldown_ms ?? 15000;
        this.drive_cooldown_ms = opts.drive_cooldown_ms ?? 3 * 60000;
        this.success_cooldown_ms = opts.success_cooldown_ms ?? 60000;
        this.preempt_check_ms = opts.preempt_check_ms ?? 10000;
        this.max_step_responses = opts.max_step_responses ?? 5;
        this.arbiter_opts = {
            switch_margin: opts.switch_margin ?? 0.1,
            min_urgency: opts.min_urgency ?? 0.25,
        };

        // active = {drive, goal, reason, steps, step_index}
        this.active = null;
        this.pending_replan = null;
        this.last_failure = null;
        this.plan_busy = false;
        this.act_busy = false;
        this.step_interrupt = false;
        this.idle_ms = 0;
        this.no_command_count = 0;
        this.last_goal_attempt = 0;
        this.preempt_accum = 0;
        this.recent_outcomes = [];
        this.visited_chunks = new Set();
        this.last_thought = '';
        this.persist_accum = 0;
        this.sensor_accum = 0;
        this.sensor_levels = {};
        this.sensor_error_logged = false;

        this.state_fp = opts.state_fp ?? `./bots/${agent.name}/cognition.json`;
        this.load();
    }

    isPursuing() {
        return settings.use_cognition && this.active !== null;
    }

    // Lets handleMessage's checkInterrupt() break a step's command loop when
    // the goal it serves has been abandoned/preempted mid-loop. Only consulted
    // for the act tier's OWN handleMessage call (opts.cognition_step) — a
    // global flag would also kill unrelated system prompts that happen to be
    // running concurrently: death messages, mode reprompts, user !goal loops.
    shouldInterrupt() {
        return !!settings.use_cognition && this.step_interrupt;
    }

    // Break the in-flight step loop (reflex seized the slot, user spoke, etc).
    // No-op when no loop is running, so the flag can never latch.
    interruptAct() {
        if (this.act_busy)
            this.step_interrupt = true;
    }

    // Compatibility entry point (pre-Phase-4 callers and tests): runs both
    // tiers back to back.
    update(delta) {
        this.planTick(delta);
        this.actTick(delta);
    }

    // Slow tier: drives, arbitration, goal lifecycle decisions. Runs even
    // while the act tier is busy — it coordinates via step_interrupt and
    // pending_replan rather than mutating an in-flight step. Never throws.
    planTick(delta) {
        if (!settings.use_cognition) return;
        try {
            this._planInner(delta);
        } catch (err) {
            console.error('Cognition: plan tick error:', err);
        }
    }

    _planInner(delta) {
        this._tickDrives(delta);
        this.persist_accum += delta;
        if (this.persist_accum > 60000) {
            this.persist_accum = 0;
            this.persist();
        }

        const can_act = this._canAct();

        // Step budget counts only time the step could actually progress:
        // while a tier is working it or it's idle-and-eligible. Time in
        // conversations, user goals, or long-running actions doesn't count.
        if (this.active && (this.act_busy || this.plan_busy || (can_act && this.agent.isIdle())))
            this.monitor.noteActiveTime(delta);

        this._syncBlackboard();

        if (this.plan_busy || !can_act) return;

        if (this.pending_replan !== null) {
            if (this.act_busy) {
                this.step_interrupt = true; // break the act loop first
                return;
            }
            const reason = this.pending_replan;
            this.pending_replan = null;
            this._runPlan(() => this._replan(reason));
            return;
        }
        if (this.active) {
            if (this._maybePreempt(delta)) return;
            if (this.monitor.isStepTimedOut()) {
                this._onFailure(`Step timed out: "${this._currentStep()}"`);
            }
        }
        else if (!this.act_busy) {
            this._maybeStartGoal();
        }
    }

    // Fast tier: prompts the model to work the current step. Never throws.
    actTick(delta) {
        if (!settings.use_cognition) return;
        try {
            this._actInner(delta);
        } catch (err) {
            console.error('Cognition: act tick error:', err);
        }
    }

    _actInner(delta) {
        // the interrupt flag targets an in-flight act loop; once no loop is
        // running it has served its purpose — clear it BEFORE any guard so it
        // can never latch while active is null (that would suppress every
        // system-sourced prompt in handleMessage)
        if (this.step_interrupt && !this.act_busy)
            this.step_interrupt = false;
        if (this.act_busy || this.plan_busy || !this.active || this.pending_replan !== null) {
            this.idle_ms = 0;
            return;
        }
        if (!this._canAct()) {
            this.idle_ms = 0;
            return;
        }
        if (this.agent.actions.isReflexActive?.()) {
            // never fight a reflex for the action slot — wait it out; the
            // interruption is on the blackboard for the next prompt
            this.idle_ms = 0;
            return;
        }
        if (this.agent.isIdle())
            this.idle_ms += delta;
        else
            this.idle_ms = 0;
        if (this.idle_ms >= this.step_cooldown_ms) {
            this.idle_ms = 0;
            this._runAct(() => this._promptStep());
        }
    }

    // ---- goal lifecycle ----

    _maybeStartGoal() {
        const now = Date.now();
        if (now - this.last_goal_attempt < this.goal_cooldown_ms) return;
        const drive = selectDrive(this.drive_state.getUrgencies(now), null, this.arbiter_opts);
        if (drive === null) return; // content — nothing urgent enough
        this.last_goal_attempt = now;
        this._runPlan(() => this._startGoal(drive));
    }

    // Mid-goal arbitration: a drive that beats the current one by the
    // hysteresis margin (e.g. safety spiking) preempts the goal. Preemption
    // is not failure — no drive cooldown, outcome recorded as 'preempted'.
    _maybePreempt(delta) {
        this.preempt_accum += delta;
        if (this.preempt_accum < this.preempt_check_ms) return false;
        this.preempt_accum = 0;
        const winner = selectDrive(this.drive_state.getUrgencies(), this.active.drive, this.arbiter_opts);
        if (winner && winner !== this.active.drive) {
            const active = this.active;
            this.active = null;
            this.pending_replan = null;
            this.step_interrupt = this.act_busy; // only break a loop that exists
            this.blackboard.interruption = null; // stale reflex notes die with the goal
            this._recordOutcome(active, 'preempted', `${winner} became more urgent`);
            this.last_thought = `Setting aside "${active.goal}" — ${winner} needs attention.`;
            console.log(`Cognition: goal preempted by ${winner}: ${active.goal}`);
            this._safeRecordMemory('goal_abandoned', `Set aside goal (${active.drive}): ${active.goal} — ${winner} became more urgent`, { drive: active.drive, goal: active.goal, preempted_by: winner });
            this.persist();
            return true;
        }
        return false;
    }

    async _startGoal(drive) {
        this.last_thought = `My ${drive} drive is high, thinking of a goal...`;
        const goal = await this.planner.generateGoal(drive, this._driveStateText());
        if (!goal) {
            console.warn('Cognition: failed to generate a goal for drive', drive);
            return;
        }
        if (this.active !== null || !this._canAct()) return; // world changed during the LLM call
        const steps = await this.planner.makePlan(goal.goal);
        if (!steps) {
            console.warn('Cognition: failed to plan for goal', goal.goal);
            return;
        }
        if (this.active !== null || !this._canAct()) return;
        this.active = { drive, goal: goal.goal, reason: goal.reason, steps, step_index: 0 };
        this.monitor.reset();
        this.monitor.startStep();
        this.no_command_count = 0;
        this.step_interrupt = false;
        this.last_thought = goal.reason || `Pursuing: ${goal.goal}`;
        this._safeRecordMemory('goal_started', `Started goal (${drive}): ${goal.goal}. Plan: ${steps.join('; ')}`, { drive, goal: goal.goal, steps });
        console.log(`Cognition: new goal (${drive}): ${goal.goal}\nPlan:\n${formatPlan(steps, 0)}`);
        this.persist();
        if (goal.reason)
            await this._narrate(goal.reason);
    }

    async _promptStep() {
        const active = this.active;
        if (!active) return;
        this.step_interrupt = false;
        // a reflex broke our previous action — surface it so the model can
        // re-assess instead of blindly continuing
        let interruption_note = '';
        const intr = this.blackboard.takeInterruption();
        if (intr && Date.now() - intr.at < 2 * 60000) // stale notes aren't worth reasoning about
            interruption_note = `NOTE: your previous action '${intr.interrupted.replace('action:', '')}' was interrupted by your ${intr.by} reflex. Re-assess your situation before continuing.\n`;
        const msg = interruption_note
            + `You are autonomously pursuing this goal, motivated by your ${active.drive} drive: "${active.goal}"\n`
            + `Your plan:\n${formatPlan(active.steps, active.step_index)}\n`
            + `Work ONLY on the CURRENT step. Your next response MUST contain a command with !commandName syntax. `
            + `When the current step is complete, use !stepDone. If the step is impossible or keeps failing, use !stepFailed("short reason"). Respond:`;
        // bounded so control returns to the loop: timeouts, replans, and
        // preemption stay live even for chatty query-heavy plans.
        // cognition_step scopes step_interrupt to THIS loop.
        const used_command = await this.agent.handleMessage('system', msg, this.max_step_responses, { cognition_step: true });
        if (this.active !== active) return; // goal ended during the loop
        if (!used_command) {
            this.no_command_count++;
            if (this.no_command_count >= 3) {
                this.no_command_count = 0;
                this._onFailure('Did not act on the current step after 3 prompts');
            }
        }
        else {
            this.no_command_count = 0;
        }
    }

    async _replan(reason) {
        const active = this.active;
        if (!active) return;
        this.last_thought = `Replanning: ${reason}`;
        let context = `A previous plan for this goal failed. Failure: ${reason}.`;
        if (active.step_index > 0) {
            const done = active.steps.slice(0, active.step_index).join('; ');
            context += ` Already completed: ${done}.`;
        }
        context += ' Make a new plan that avoids this failure.';
        let steps = null;
        try {
            steps = await this.planner.makePlan(active.goal, context);
        } catch (err) {
            console.warn('Cognition: replanning threw:', err.message || err);
        }
        if (this.active !== active) return; // abandoned/preempted during the LLM call
        if (!steps) {
            this._abandonGoal('Could not make a new plan');
            return;
        }
        active.steps = steps;
        active.step_index = 0;
        this.monitor.startStep();
        this.no_command_count = 0;
        this._safeRecordMemory('plan_revised', `Replanned goal "${active.goal}" after failure: ${reason}. New plan: ${steps.join('; ')}`, { goal: active.goal, reason });
        console.log(`Cognition: replanned goal "${active.goal}"\nPlan:\n${formatPlan(steps, 0)}`);
        this.persist();
        await this._narrate('New plan, trying a different approach.');
    }

    _completeGoal() {
        const active = this.active;
        this.active = null;
        this.pending_replan = null;
        this.step_interrupt = this.act_busy; // stop the loop from free-associating past the goal
        this.blackboard.interruption = null;
        this.drive_state.satisfy(active.drive, 0.8);
        // sensor drives can't hold a satisfy() (the sensor overwrites it next
        // tick) — the success cooldown is what stops instant goal re-fire
        this.drive_state.setCooldown(active.drive, Date.now() + this.success_cooldown_ms);
        this._recordOutcome(active, 'completed', null);
        this.last_thought = `Completed: ${active.goal}`;
        console.log(`Cognition: goal complete (${active.drive}): ${active.goal}`);
        this._safeRecordMemory('goal_completed', `Completed goal (${active.drive}): ${active.goal}`, { drive: active.drive, goal: active.goal });
        this.persist();
    }

    // Public so !endGoal and shutdown paths can cancel autonomous goals.
    abandonGoal(reason) {
        if (!this.active) return;
        const active = this.active;
        this.active = null;
        this.pending_replan = null;
        this.step_interrupt = this.act_busy; // only break a loop that exists
        this.blackboard.interruption = null;
        this._recordOutcome(active, 'failed', reason);
        this.drive_state.setCooldown(active.drive, Date.now() + this.drive_cooldown_ms);
        this.last_thought = `Gave up: ${active.goal} (${reason})`;
        console.log(`Cognition: goal abandoned (${reason}): ${active.goal}`);
        this._safeRecordMemory('goal_abandoned', `Abandoned goal (${active.drive}): ${active.goal} — ${reason}`, { drive: active.drive, goal: active.goal, reason });
        this.persist();
    }

    _abandonGoal(reason) {
        this.abandonGoal(reason);
    }

    // !endGoal while a cognition goal is active means "I accomplished it".
    completeGoalByRequest() {
        if (!this.active) return 'No active autonomous goal.';
        const goal = this.active.goal;
        this._completeGoal();
        this.step_interrupt = this.act_busy; // only break a loop that exists
        return `Goal "${goal}" marked complete.`;
    }

    // ---- command hooks (called from !stepDone / !stepFailed performs) ----

    onStepDone() {
        if (!this.isPursuing()) return 'No active autonomous plan.';
        const active = this.active;
        active.step_index++;
        if (active.step_index >= active.steps.length) {
            this._completeGoal();
            return 'All steps complete. Goal accomplished!';
        }
        this.monitor.startStep();
        this.no_command_count = 0;
        this.persist();
        return `Step complete. Next step: ${this._currentStep()}`;
    }

    onStepFailed(reason) {
        if (!this.isPursuing()) return 'No active autonomous plan.';
        const decision = this._onFailure(reason || 'unspecified failure');
        if (decision === 'retry')
            return `Noted. Try the current step again, differently: ${this._currentStep()}`;
        if (decision === 'replan')
            return 'Understood. Making a new plan.';
        return 'Goal abandoned.';
    }

    // ---- event hooks ----

    onInteraction() {
        if (!settings.use_cognition) return;
        this.drive_state.satisfy('social', 0.15);
    }

    onDeath() {
        if (!this.isPursuing()) return;
        this._onFailure('You died and respawned');
    }

    // Called from modes.js when a reflex seizes the action slot from a
    // deliberate (act-tier) action. Recorded on the blackboard for the next
    // step prompt and in memory for the research trace.
    onModeInterruption(mode_name, interrupted_action) {
        if (!settings.use_cognition || !this.isPursuing()) return;
        if (!interrupted_action || !interrupted_action.startsWith('action:')) return;
        // only attribute actions the act tier actually launched — a reflex
        // interrupting a user-conversation command is not a plan interruption
        if (!this.act_busy) return;
        this.blackboard.noteInterruption(mode_name, interrupted_action);
        this._safeRecordMemory('interruption',
            `Action '${interrupted_action.replace('action:', '')}' was interrupted by ${mode_name} reflex during goal: ${this.active.goal}`,
            { mode: mode_name, action: interrupted_action });
    }

    // ---- internals ----

    _onFailure(reason) {
        this.last_failure = reason;
        const decision = this.monitor.noteFailure();
        if (decision === 'retry') {
            this.monitor.startStep();
            this.last_thought = `Step failed (${reason}), retrying.`;
        }
        else if (decision === 'replan') {
            this.pending_replan = reason;
        }
        else {
            this._abandonGoal(reason);
        }
        this.persist();
        return decision;
    }

    _canAct() {
        const agent = this.agent;
        if (agent.task && agent.task.data) return false;       // benchmark tasks own the agent
        if (!agent.self_prompter.isStopped()) return false;    // user-assigned !goal outranks drives
        if (convoManager.inConversation()) return false;
        if (agent.shut_up) return false;
        return true;
    }

    _tickDrives(delta) {
        // sensors have minute-scale dynamics; reading entities/inventory at
        // 3.3Hz is wasted work — sample at 1Hz
        this.sensor_accum += delta;
        if (this.sensor_accum >= 1000 || Object.keys(this.sensor_levels).length === 0) {
            this.sensor_accum = 0;
            try {
                this.sensor_levels = readSensors(this.agent);
                this.sensor_error_logged = false;
                const pos = this.agent.bot.entity?.position;
                if (pos) {
                    const chunk = `${this.agent.bot.game.dimension}:${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`;
                    if (!this.visited_chunks.has(chunk)) {
                        if (this.visited_chunks.size >= 10000) {
                            // evict oldest fifth so novelty rewards keep flowing
                            const it = this.visited_chunks.values();
                            for (let i = 0; i < 2000; i++)
                                this.visited_chunks.delete(it.next().value);
                        }
                        this.visited_chunks.add(chunk);
                        if (this.visited_chunks.size > 1) // don't reward the spawn chunk
                            this.drive_state.satisfy('curiosity', 0.02);
                    }
                }
            } catch (err) {
                // expected pre-spawn; log once if it persists after spawn
                if (this.agent.bot?.entity && !this.sensor_error_logged) {
                    this.sensor_error_logged = true;
                    console.warn('Cognition: sensor read failed (drives running decay-only):', err.message || err);
                }
            }
        }
        this.drive_state.update(delta, this.sensor_levels);
    }

    _currentStep() {
        return this.active ? this.active.steps[this.active.step_index] : null;
    }

    _driveStateText() {
        let text = this.drive_state.describe();
        if (this.recent_outcomes.length > 0) {
            text += '\nRecent goal outcomes:\n';
            for (const o of this.recent_outcomes.slice(-5))
                text += `- ${o.result === 'preempted' ? 'set aside' : o.result}: ${o.goal}${o.reason ? ` (${o.reason})` : ''}\n`;
        }
        return text.trim();
    }

    _recordOutcome(active, result, reason) {
        this.recent_outcomes.push({ goal: active.goal, drive: active.drive, result, reason, ts: Date.now() });
        if (this.recent_outcomes.length > 20)
            this.recent_outcomes = this.recent_outcomes.slice(-20);
    }

    _safeRecordMemory(type, content, data) {
        try {
            this.agent.memory?.record(type, content, data);
        } catch (err) {
            console.error('Cognition: memory record failed:', err.message || err);
        }
    }

    _runPlan(fn) {
        this.plan_busy = true;
        this._plan_task = fn()
            .catch(err => console.error('Cognition plan error:', err))
            .finally(() => { this.plan_busy = false; });
    }

    _runAct(fn) {
        this.act_busy = true;
        this._act_task = fn()
            .catch(err => console.error('Cognition act error:', err))
            .finally(() => { this.act_busy = false; });
    }

    // Keep the blackboard the authoritative shared view of cognitive state.
    _syncBlackboard() {
        const bb = this.blackboard;
        bb.percepts = { ...this.sensor_levels };
        bb.drives = this.drive_state.getUrgencies().map(u => ({
            name: u.name,
            urgency: Number(u.urgency.toFixed(2)),
            level: Number(u.level.toFixed(2)),
            on_cooldown: u.on_cooldown,
        }));
        bb.goal = this.active ? {
            drive: this.active.drive,
            goal: this.active.goal,
            step_index: this.active.step_index + 1,
            steps_total: this.active.steps.length,
            step: this._currentStep(),
        } : null;
        bb.pending_replan = this.pending_replan;
        bb.last_thought = this.last_thought;
        bb.current_action = this.agent.actions?.currentActionLabel || '';
        // real work-in-flight state: the scheduler's tier telemetry only sees
        // the synchronous dispatch, not the launched LLM calls
        bb.cognition_busy = { plan: this.plan_busy, act: this.act_busy };
    }

    async _narrate(message) {
        if (settings.narrate_behavior)
            await this.agent.openChat(message);
    }

    // Context injected into the conversing prompt via $SELF_PROMPT.
    getGoalContext() {
        if (!this.isPursuing()) return '';
        return `YOUR CURRENT GOAL (from your ${this.active.drive} drive): "${this.active.goal}". Current step: ${this._currentStep()}\n`;
    }

    // Surfaced through getFullState() for the dashboard.
    getStatus() {
        return {
            enabled: settings.use_cognition,
            state: this.isPursuing() ? 'pursuing' : 'idle',
            drive: this.active?.drive ?? null,
            goal: this.active?.goal ?? null,
            step: this.active ? {
                index: this.active.step_index + 1,
                total: this.active.steps.length,
                text: this._currentStep(),
            } : null,
            urgencies: this.drive_state.getUrgencies().map(u => ({
                name: u.name,
                urgency: Number(u.urgency.toFixed(2)),
                level: Number(u.level.toFixed(2)),
            })),
            last_thought: this.last_thought,
        };
    }

    persist() {
        try {
            const data = {
                drives: this.drive_state.getJson(),
                active: this.active,
                monitor: this.active ? { replans: this.monitor.replans } : null,
                recent_outcomes: this.recent_outcomes,
                visited_chunks: [...this.visited_chunks].slice(-4000),
            };
            writeFileSync(this.state_fp, JSON.stringify(data));
        } catch (err) {
            console.error('Cognition: failed to persist state:', err);
        }
    }

    load() {
        try {
            // don't resurrect goals for a disabled subsystem — a stale active
            // goal would make isPursuing()/getStatus() misreport and let
            // !stepDone mutate cross-session state during benchmarks
            if (!settings.use_cognition) return;
            if (!existsSync(this.state_fp)) return;
            const data = JSON.parse(readFileSync(this.state_fp, 'utf8'));
            this.drive_state.loadJson(data.drives);
            this.recent_outcomes = data.recent_outcomes || [];
            this.visited_chunks = new Set(data.visited_chunks || []);
            const a = data.active;
            const valid_active = a && typeof a.goal === 'string' && Array.isArray(a.steps)
                && a.steps.every(s => typeof s === 'string') && a.steps.length > 0
                && Number.isInteger(a.step_index) && a.step_index >= 0 && a.step_index < a.steps.length;
            if (valid_active) {
                this.active = a;
                this.monitor.reset();
                if (Number.isInteger(data.monitor?.replans))
                    this.monitor.replans = Math.min(data.monitor.replans, this.monitor.max_replans);
                this.monitor.startStep();
                this.last_thought = `Resuming goal from last session: ${this.active.goal}`;
            }
            console.log('Cognition: loaded persisted state.');
        } catch (err) {
            console.error('Cognition: failed to load state:', err);
        }
    }
}
