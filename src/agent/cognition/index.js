import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { DriveState } from './drives.js';
import { selectDrive } from './arbiter.js';
import { ExecutionMonitor } from './monitor.js';
import { ProjectStore } from './projects.js';
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

        this.drive_state = new DriveState(profile.drives || {}, opts);
        // Phase 9: ambition that outlives a goal. Loaded from cognition.json.
        this.projects = new ProjectStore({}, opts);
        this.monitor = new ExecutionMonitor(opts);
        this.planner = new Planner(agent);

        this.step_cooldown_ms = opts.step_cooldown_ms ?? 2000;
        // Event-driven prompting: after something actually happens the agent
        // may prompt again after step_cooldown_ms. With nothing happening it
        // waits for the heartbeat instead of re-prompting every 2s, which was
        // the single largest source of call volume (~96% of the cooldown
        // ceiling, 24/7). Set heartbeat_ms very low to restore polling.
        this.heartbeat_ms = opts.heartbeat_ms ?? 20000;
        this.pending_event = 'goal started';
        this.since_prompt_ms = 0;
        this.interrupt_wait_ms = 0;
        this.interrupt_grace_ms = opts.interrupt_grace_ms ?? 15000;
        this.goal_cooldown_ms = opts.goal_cooldown_ms ?? 15000;
        this.drive_cooldown_ms = opts.drive_cooldown_ms ?? 3 * 60000;
        this.success_cooldown_ms = opts.success_cooldown_ms ?? 60000;
        this.preempt_check_ms = opts.preempt_check_ms ?? 10000;
        // how much the motivating drive must ease before a goal is re-decided
        this.goal_relief_margin = opts.goal_relief_margin ?? 0.25;
        this.goal_max_active_ms = opts.goal_max_active_ms ?? 12 * 60000;
        // A new goal gets a grace period before it can be preempted. Sensor
        // drives are noisy — safety is capped hard whenever a hostile is within
        // 16 blocks, so a wandering mob flips it — and without this the arbiter
        // ping-pongs, burning two plan-tier calls per goal and never making
        // progress. Observed live: goals living 10-22 seconds each.
        this.min_goal_commit_ms = opts.min_goal_commit_ms ?? 60000;
        this.commit_margin_multiplier = opts.commit_margin_multiplier ?? 3;
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
        this.outcome_ttl_ms = opts.outcome_ttl_ms ?? 2 * 3600000;
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

    // On, but not currently committed to a goal — "content" rather than "off".
    isEnabled() {
        return !!settings.use_cognition;
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
        if (this.active && (this.act_busy || this.plan_busy || (can_act && this.agent.isIdle()))) {
            this.monitor.noteActiveTime(delta);
            // goal-level budget, separate from the per-step one: a goal can
            // churn through many steps without ever finishing
            this.active.active_ms = (this.active.active_ms ?? 0) + delta;
        }

        this._syncBlackboard();

        if (this.plan_busy || !can_act) return;

        // Preemption and the step timeout run BEFORE the replan branch, so a
        // wedged act loop can never strand them behind an early return.
        if (this.active) {
            if (this._maybePreempt(delta)) return;
            if (this.monitor.isStepTimedOut())
                this._onFailure(`Step timed out: "${this._currentStep()}"`);
        }

        if (this.pending_replan !== null) {
            if (this.act_busy) {
                this.step_interrupt = true; // ask the act loop to break
                this.interrupt_wait_ms += delta;
                // step_interrupt is only honored at checkInterrupt points; it
                // cannot break an action blocked inside ActionManager. Past a
                // grace period, stop the action itself or the agent freezes
                // here permanently with an active goal and no LLM calls.
                if (this.interrupt_wait_ms >= this.interrupt_grace_ms) {
                    this.interrupt_wait_ms = 0;
                    console.warn('Cognition: act loop did not yield; stopping the running action to replan.');
                    try { this.agent.actions.stop(); } catch (err) { console.error('Cognition: stop failed:', err); }
                }
                return;
            }
            this.interrupt_wait_ms = 0;
            const reason = this.pending_replan;
            this.pending_replan = null;
            this._runPlan(() => this._replan(reason));
            return;
        }
        this.interrupt_wait_ms = 0;

        if (!this.active && !this.act_busy) {
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
        // Time since the last prompt. Accumulated BEFORE any guard and reset
        // only when a prompt is actually issued — unlike idle_ms, which seven
        // guard paths below zero, so ambient activity could otherwise starve
        // the heartbeat indefinitely.
        this.since_prompt_ms += delta;

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
        // Prompt when something happened (after a short settle), or when the
        // heartbeat expires so a stuck plan still gets re-examined.
        // The heartbeat is an unconditional floor, not the else-branch: a
        // latched resume action (a standing !followPlayer, say) keeps isIdle()
        // false forever, so idle_ms never reaches the settle threshold and a
        // pending event used to starve the act tier permanently.
        const ready = this.since_prompt_ms >= this.heartbeat_ms
            || (this.pending_event && this.idle_ms >= this.step_cooldown_ms);
        if (ready) {
            this.idle_ms = 0;
            const reason = this.pending_event;
            this._runAct(() => this._promptStep(reason));
        }
    }

    // Something happened that may warrant a new decision. Cheap and
    // idempotent — many callers, at most one prompt.
    notifyEvent(reason) {
        if (!settings.use_cognition) return;
        this.pending_event = reason || 'event';
    }

    // ---- goal lifecycle ----

    _maybeStartGoal() {
        const now = Date.now();
        if (now - this.last_goal_attempt < this.goal_cooldown_ms) return;
        const urgencies = this.drive_state.getUrgencies(now);
        const drive = selectDrive(urgencies, null, this.arbiter_opts);
        if (drive === null) return; // content — nothing urgent enough
        this.last_goal_attempt = now;

        // An aspiration drive does not want a fresh goal, it wants its project
        // advanced. This is the whole point of the projects layer: being
        // interrupted by nightfall becomes a pause rather than an abandonment,
        // because the next time legacy wins we pick up the next milestone
        // instead of inventing something new.
        const is_aspiration = urgencies.find(u => u.name === drive)?.aspiration;
        if (is_aspiration) {
            this._runPlan(() => this._advanceProject(drive));
            return;
        }
        this._runPlan(() => this._startGoal(drive));
    }

    // Either resume the active project or, if there is none, decide what this
    // agent wants to be remembered for.
    async _advanceProject(drive) {
        let project = this.projects.active;

        if (!project) {
            this.last_thought = 'Thinking about what I want to leave behind...';
            const proposal = await this.planner.proposeProject(drive, this._driveStateText());
            if (!proposal) {
                // same backoff as goal generation: a model that cannot emit the
                // JSON will not start doing so, and this tier is billed
                this.drive_state.setCooldown(drive, Date.now() + this.drive_cooldown_ms);
                return;
            }
            project = this.projects.start(proposal.intent, proposal.milestones,
                { drive, now: Date.now(), needed: proposal.materials });
            this._safeRecordMemory('discovery',
                `Decided on a project: ${project.intent}. Milestones: ${project.milestones.map(m => m.text).join('; ')}`,
                { project: project.id, intent: project.intent });
            console.log(`Cognition: new PROJECT (${drive}): ${project.intent}`);
        }

        const milestone = project.nextMilestone;
        if (!milestone) return;   // finished between ticks

        // The goal is the milestone, with the project as context. The step
        // planner then breaks it down exactly as it would any other goal.
        if (this.active !== null || !this._canAct()) return;
        const steps = await this.planner.makePlan(
            `${milestone.text} (part of your ongoing project: ${project.intent})`);
        if (!steps) {
            this.drive_state.setCooldown(drive, Date.now() + this.goal_cooldown_ms);
            return;
        }
        if (this.active !== null || !this._canAct()) return;
        this.active = {
            drive, goal: milestone.text, reason: `Advancing my project: ${project.intent}`,
            steps, step_index: 0,
            urgency_at_start: this.drive_state.urgency(drive),
            active_ms: 0,
            project_id: project.id,          // links the goal back to the project
            milestone: milestone.text,
        };
        this.notifyEvent('project milestone started');
        this.monitor.reset();
        this.monitor.startStep();
        this.no_command_count = 0;
        this.step_interrupt = false;
        this.last_thought = `Working on my project: ${milestone.text}`;
        this._safeRecordMemory('goal_started',
            `Resumed project "${project.intent}" — milestone: ${milestone.text}. Plan: ${steps.join('; ')}`,
            { drive, goal: milestone.text, project: project.id, steps });
        console.log(`Cognition: project milestone (${drive}): ${milestone.text}`);
        this.persist();
    }

    // Mid-goal arbitration: a drive that beats the current one by the
    // hysteresis margin (e.g. safety spiking) preempts the goal. Preemption
    // is not failure — no drive cooldown, outcome recorded as 'preempted'.
    _maybePreempt(delta) {
        this.preempt_accum += delta;
        if (this.preempt_accum < this.preempt_check_ms) return false;
        this.preempt_accum = 0;
        // A goal outliving its motivation. Preemption only fires when a
        // DIFFERENT drive wins, so a goal whose premise has evaporated survives
        // as long as its own drive stays on top. Observed live: "Deal with the
        // nearby skeleton threat" persisted long after the skeleton left,
        // because safety is a sensor drive fed by health — the threat was gone
        // but the low health that also depresses safety was not.
        const stale = this._goalNoLongerWarranted();
        if (stale) {
            const active = this.active;
            this.active = null;
            this.pending_replan = null;
            this.step_interrupt = this.act_busy;
            this.blackboard.interruption = null;
            this._recordOutcome(active, 'preempted', stale);
            this.last_thought = `Dropping "${active.goal}" — ${stale}.`;
            console.log(`Cognition: goal no longer warranted (${stale}): ${active.goal}`);
            this._safeRecordMemory('goal_abandoned', `Dropped goal (${active.drive}): ${active.goal} — ${stale}`,
                { drive: active.drive, goal: active.goal, reason: stale });
            this.persist();
            return true;
        }

        // Inside the commitment window a challenger must clear a much larger
        // margin. Genuine emergencies (a big urgency swing) still preempt;
        // noise does not.
        const young = (this.active.active_ms ?? 0) < this.min_goal_commit_ms;
        const opts = young
            ? { ...this.arbiter_opts, switch_margin: this.arbiter_opts.switch_margin * this.commit_margin_multiplier }
            : this.arbiter_opts;
        const winner = selectDrive(this.drive_state.getUrgencies(), this.active.drive, opts);
        if (winner && winner !== this.active.drive) {
            const active = this.active;
            this.active = null;
            this.pending_replan = null;
            this.step_interrupt = this.act_busy; // only break a loop that exists
            this.blackboard.interruption = null; // stale reflex notes die with the goal
            this._recordOutcome(active, 'preempted',
                `${winner} became more urgent after ${Math.round((active.active_ms ?? 0) / 1000)}s`);
            this.last_thought = `Setting aside "${active.goal}" — ${winner} needs attention.`;
            console.log(`Cognition: goal preempted by ${winner}: ${active.goal}`);
            this._safeRecordMemory('goal_abandoned', `Set aside goal (${active.drive}): ${active.goal} — ${winner} became more urgent`, { drive: active.drive, goal: active.goal, preempted_by: winner });
            this.persist();
            return true;
        }
        return false;
    }

    // Two cheap, arithmetic-only reasons to stop pursuing a goal. Neither costs
    // an LLM call, which matters because this runs every preempt_check_ms.
    _goalNoLongerWarranted() {
        const a = this.active;
        if (!a) return null;
        // 1. The need that motivated it has substantially eased. The goal was
        //    written for a situation that no longer obtains, so re-deciding
        //    beats grinding through a plan aimed at a solved problem.
        const now_urgency = this.drive_state.urgency(a.drive);
        if (typeof a.urgency_at_start === 'number'
            && a.urgency_at_start - now_urgency >= this.goal_relief_margin)
            return `${a.drive} has eased (${a.urgency_at_start.toFixed(2)} → ${now_urgency.toFixed(2)})`;
        // 2. Backstop: any goal worked this long without finishing is stuck,
        //    whatever the drives say.
        if (this.goal_max_active_ms > 0 && (a.active_ms ?? 0) > this.goal_max_active_ms)
            return `no progress after ${Math.round(a.active_ms / 60000)} minutes`;
        return null;
    }

    async _startGoal(drive) {
        this.last_thought = `My ${drive} drive is high, thinking of a goal...`;
        const goal = await this.planner.generateGoal(drive, this._driveStateText());
        if (!goal) {
            // Back off instead of retrying every goal_cooldown_ms forever: a
            // model that cannot emit the JSON will not start doing so, and
            // this tier is billed.
            this.gen_failures = (this.gen_failures || 0) + 1;
            this.last_thought = `Could not form a goal (attempt ${this.gen_failures}).`;
            console.warn('Cognition: failed to generate a goal for drive', drive);
            if (this.gen_failures >= 3) {
                this.gen_failures = 0;
                this.drive_state.setCooldown(drive, Date.now() + this.drive_cooldown_ms);
                this.last_thought = `Giving the ${drive} drive a rest — I keep failing to form a goal.`;
                console.warn(`Cognition: cooling down '${drive}' after repeated goal-generation failures.`);
            }
            return;
        }
        this.gen_failures = 0;
        if (this.active !== null || !this._canAct()) return; // world changed during the LLM call
        const steps = await this.planner.makePlan(goal.goal);
        if (!steps) {
            console.warn('Cognition: failed to plan for goal', goal.goal);
            return;
        }
        if (this.active !== null || !this._canAct()) return;
        this.active = {
            drive, goal: goal.goal, reason: goal.reason, steps, step_index: 0,
            // captured so _goalNoLongerWarranted can tell whether the need that
            // produced this goal has since eased
            urgency_at_start: this.drive_state.urgency(drive),
            active_ms: 0,
        };
        this.notifyEvent('goal started');
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

    async _promptStep(consumed_event = null) {
        const active = this.active;
        if (!active) return; // pending_event deliberately NOT consumed here
        this.step_interrupt = false;
        // only now is a prompt certain to be issued — clearing earlier burned
        // the event on calls that returned without prompting at all
        if (this.pending_event === consumed_event)
            this.pending_event = null;
        this.since_prompt_ms = 0;
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
            + `When the current step is complete, use !stepDone. If the step is impossible or keeps failing, use !stepFailed("short reason"). `
            + `Reply with the command and nothing else — no reasoning, no commentary. Respond:`;
        // bounded so control returns to the loop: timeouts, replans, and
        // preemption stay live even for chatty query-heavy plans.
        // cognition_step scopes step_interrupt to THIS loop.
        const used_command = await this.agent.handleMessage('system', msg, this.max_step_responses, { cognition_step: true });
        if (this.active !== active) return; // goal ended during the loop
        // An interrupted loop produced no command because it was cut short,
        // not because the model refused to act — counting it as a failure was
        // the dominant cause of spurious goal abandonment.
        if (this.step_interrupt || this.agent.shut_up)
            return;
        if (this.agent._model_failures > 0) {
            // The model is unreachable. Counting that as "the model produced no
            // command" would retry, replan and eventually abandon a goal that
            // was never actually attempted.
            this.last_thought = 'Waiting — I cannot reach my model right now.';
            return;
        }
        if (!used_command) {
            this.no_command_count++;
            if (this.no_command_count >= 3) {
                this.no_command_count = 0;
                this._onFailure('Did not act on the current step after 3 prompts');
            }
            else {
                // A response with no command produces no world change and so
                // no event. Without this the retry waits a full heartbeat,
                // stretching "didn't act after 3 prompts" from seconds into
                // minutes. Bounded by no_command_count.
                this.notifyEvent('no command issued, retrying');
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
        this.notifyEvent('replanned');
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
        // If this goal was a project milestone, the project advances with it.
        if (active.project_id) {
            const project = this.projects.active;
            if (project && project.id === active.project_id && project.nextMilestone?.text === active.milestone) {
                project.completeNextMilestone();
                if (project.status === 'complete') {
                    this._safeRecordMemory('discovery',
                        `Finished my project: ${project.intent}. It took ${Math.round(project.active_ms / 60000)} minutes of work across ${project.sessions + 1} sessions.`,
                        { project: project.id, intent: project.intent });
                    console.log(`Cognition: PROJECT COMPLETE — ${project.intent}`);
                }
            }
        }
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
        this.notifyEvent('step completed');
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
        this.notifyEvent('someone spoke to me');
        this.drive_state.satisfy('social', 0.15);
    }

    onDeath() {
        this.notifyEvent('died');
        if (!this.isPursuing()) return;
        this._onFailure('You died and respawned');
    }

    // Called from modes.js when a reflex seizes the action slot from a
    // deliberate (act-tier) action. Recorded on the blackboard for the next
    // step prompt and in memory for the research trace.
    onModeInterruption(mode_name, interrupted_action) {
        if (!settings.use_cognition || !this.isPursuing()) return;
        this.notifyEvent(`interrupted by ${mode_name}`);
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
        // A step failure is often the agent establishing a real fact about the
        // world — "brown mushrooms cannot be cooked or smelted in Minecraft"
        // was worked out over six calls and then discarded, because only
        // goal-level events were recorded. Storing it makes it retrievable, so
        // the next goal generation sees it via $RELEVANT_MEMORIES, reflection
        // can turn it into a belief, and it shows up in the feed instead of
        // being re-learned every time.
        if (this.active?.project_id) {
            const project = this.projects.active;
            if (project && project.id === this.active.project_id) project.addNote(reason);
        }
        this._safeRecordMemory('discovery',
            `Could not do "${this._currentStep()}" while pursuing "${this.active?.goal}": ${reason}`,
            { goal: this.active?.goal, step: this._currentStep(), reason });
        const decision = this.monitor.noteFailure();
        if (decision === 'retry') {
            this.notifyEvent('step failed, retrying');
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
        // An aspiration is satisfied by what stands, not by a sensor reading.
        const built = this.projects.satisfaction();
        if (this.drive_state.drives.legacy)
            this.drive_state.drives.legacy.level = built;
        // and it earns a claim on attention for every tick it is passed over
        this.drive_state.noteAttention(delta, this.active?.drive ?? null);
        if (this.active?.project_id && this.projects.active?.id === this.active.project_id)
            this.projects.noteWork(delta, Date.now());
        this.drive_state.update(delta, this.sensor_levels);
    }

    _currentStep() {
        return this.active ? this.active.steps[this.active.step_index] : null;
    }

    // Only outcomes recent enough to still be informative.
    _liveOutcomes(now = Date.now()) {
        return this.recent_outcomes.filter(o => !(this.outcome_ttl_ms > 0) || (now - (o.ts || 0)) < this.outcome_ttl_ms);
    }

    _driveStateText() {
        let text = this.drive_state.describe();
        const project = this.projects.active;
        if (project) text += '\n\n' + project.describe();
        const live = this._liveOutcomes();
        if (live.length > 0) {
            text += '\nRecent goal outcomes:\n';
            for (const o of live.slice(-5))
                text += `- ${o.result === 'preempted' ? 'set aside' : o.result}: ${o.goal}${o.reason ? ` (${o.reason})` : ''}\n`;
        }
        return text.trim();
    }

    _recordOutcome(active, result, reason) {
        this.recent_outcomes.push({ goal: active.goal, drive: active.drive, result, reason, ts: Date.now() });
        this.recent_outcomes = this._liveOutcomes().slice(-20);
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
        // (project appended below)
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
                on_cooldown: u.on_cooldown,
            })),
            last_thought: this.last_thought,
            // Phase 9: the long-horizon thing, so the dashboard can show what
            // this agent is actually trying to leave behind.
            project: this.projects.active ? {
                intent: this.projects.active.intent,
                progress: this.projects.active.progress,
                milestones: this.projects.active.milestones,
                next: this.projects.active.nextMilestone?.text ?? null,
                outstanding: this.projects.active.outstanding,
                active_ms: this.projects.active.active_ms,
                sessions: this.projects.active.sessions,
            } : null,
            projects_completed: this.projects.completed.length,
        };
    }

    persist() {
        try {
            const data = {
                drives: this.drive_state.getJson(),
                active: this.active,
                monitor: this.active ? { replans: this.monitor.replans } : null,
                recent_outcomes: this.recent_outcomes,
                projects: this.projects.toJSON(),
                visited_chunks: [...this.visited_chunks].slice(-4000),
            };
            const tmp = this.state_fp + '.tmp';
            writeFileSync(tmp, JSON.stringify(data));
            renameSync(tmp, this.state_fp);
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
            this.projects = new ProjectStore(data.projects || {}, {});
            // A restart is a new session for whatever was in flight; counting
            // them is how "finished across several sessions" becomes checkable.
            this.projects.noteSession();
            this.recent_outcomes = this._liveOutcomes();
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
