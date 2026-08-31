import { readFileSync, writeFileSync, existsSync } from 'fs';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { DriveState } from './drives.js';
import { selectDrive } from './arbiter.js';
import { ExecutionMonitor } from './monitor.js';
import { Planner, formatPlan } from './planner.js';
import { readSensors } from './sensors.js';

// The cognitive core: arbitrate drives -> generate a goal -> plan steps ->
// drive the existing handleMessage/command machinery -> observe -> replan.
// Runs off agent.update()'s 300ms tick; all LLM work is guarded by a busy
// flag so the loop never overlaps itself. Dormant unless settings.use_cognition.
export class CognitionLoop {
    constructor(agent) {
        this.agent = agent;
        const profile = agent.prompter.profile;
        const opts = profile.cognition || {};

        this.drive_state = new DriveState(profile.drives || {});
        this.monitor = new ExecutionMonitor(opts);
        this.planner = new Planner(agent);

        this.step_cooldown_ms = opts.step_cooldown_ms ?? 2000;
        this.goal_cooldown_ms = opts.goal_cooldown_ms ?? 15000;
        this.drive_cooldown_ms = opts.drive_cooldown_ms ?? 3 * 60000;
        this.arbiter_opts = {
            switch_margin: opts.switch_margin ?? 0.1,
            min_urgency: opts.min_urgency ?? 0.25,
        };

        // active = {drive, goal, reason, steps, step_index}
        this.active = null;
        this.pending_replan = null;
        this.last_failure = null;
        this.busy = false;
        this.idle_ms = 0;
        this.no_command_count = 0;
        this.last_goal_attempt = 0;
        this.recent_outcomes = [];
        this.visited_chunks = new Set();
        this.last_thought = '';
        this.persist_accum = 0;

        this.state_fp = `./bots/${agent.name}/cognition.json`;
        this.load();
    }

    isPursuing() {
        return settings.use_cognition && this.active !== null;
    }

    // Main tick, called from agent.update(). Synchronous; async work is
    // launched through _run() which sets the busy guard.
    update(delta) {
        if (!settings.use_cognition) return;
        this._tickDrives(delta);
        this.persist_accum += delta;
        if (this.persist_accum > 60000) {
            this.persist_accum = 0;
            this.persist();
        }
        if (this.busy || !this._canAct()) {
            this.idle_ms = 0;
            return;
        }
        if (this.pending_replan !== null) {
            const reason = this.pending_replan;
            this.pending_replan = null;
            this._run(() => this._replan(reason));
            return;
        }
        if (this.active) {
            if (this.monitor.isStepTimedOut()) {
                this._onFailure(`Step timed out: "${this._currentStep()}"`);
                return;
            }
            if (this.agent.isIdle())
                this.idle_ms += delta;
            else
                this.idle_ms = 0;
            if (this.idle_ms >= this.step_cooldown_ms) {
                this.idle_ms = 0;
                this._run(() => this._promptStep());
            }
        }
        else {
            this._maybeStartGoal();
        }
    }

    // ---- goal lifecycle ----

    _maybeStartGoal() {
        const now = Date.now();
        if (now - this.last_goal_attempt < this.goal_cooldown_ms) return;
        const drive = selectDrive(this.drive_state.getUrgencies(now), null, this.arbiter_opts);
        if (drive === null) return; // content — nothing urgent enough
        this.last_goal_attempt = now;
        this._run(() => this._startGoal(drive));
    }

    async _startGoal(drive) {
        this.last_thought = `My ${drive} drive is high, thinking of a goal...`;
        const goal = await this.planner.generateGoal(drive, this._driveStateText());
        if (!goal) {
            console.warn('Cognition: failed to generate a goal for drive', drive);
            return;
        }
        const steps = await this.planner.makePlan(goal.goal);
        if (!steps) {
            console.warn('Cognition: failed to plan for goal', goal.goal);
            return;
        }
        this.active = { drive, goal: goal.goal, reason: goal.reason, steps, step_index: 0 };
        this.monitor.reset();
        this.monitor.startStep();
        this.last_thought = goal.reason || `Pursuing: ${goal.goal}`;
        console.log(`Cognition: new goal (${drive}): ${goal.goal}\nPlan:\n${formatPlan(steps, 0)}`);
        this.persist();
        if (goal.reason)
            await this._narrate(goal.reason);
    }

    async _promptStep() {
        const active = this.active;
        const msg = `You are autonomously pursuing this goal, motivated by your ${active.drive} drive: "${active.goal}"\n`
            + `Your plan:\n${formatPlan(active.steps, active.step_index)}\n`
            + `Work ONLY on the CURRENT step. Your next response MUST contain a command with !commandName syntax. `
            + `When the current step is complete, use !stepDone. If the step is impossible or keeps failing, use !stepFailed("short reason"). Respond:`;
        const used_command = await this.agent.handleMessage('system', msg, -1);
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
        if (!this.active) return;
        const active = this.active;
        this.last_thought = `Replanning: ${reason}`;
        let context = `A previous plan for this goal failed. Failure: ${reason}.`;
        if (active.step_index > 0) {
            const done = active.steps.slice(0, active.step_index).join('; ');
            context += ` Already completed: ${done}.`;
        }
        context += ' Make a new plan that avoids this failure.';
        const steps = await this.planner.makePlan(active.goal, context);
        if (!steps) {
            this._abandonGoal('Could not make a new plan');
            return;
        }
        active.steps = steps;
        active.step_index = 0;
        this.monitor.startStep();
        console.log(`Cognition: replanned goal "${active.goal}"\nPlan:\n${formatPlan(steps, 0)}`);
        this.persist();
        await this._narrate('New plan, trying a different approach.');
    }

    _completeGoal() {
        const active = this.active;
        this.drive_state.satisfy(active.drive, 0.8);
        this._recordOutcome(active, true, null);
        this.last_thought = `Completed: ${active.goal}`;
        console.log(`Cognition: goal complete (${active.drive}): ${active.goal}`);
        this.active = null;
        this.persist();
    }

    // Public so !endGoal and shutdown paths can cancel autonomous goals.
    abandonGoal(reason) {
        if (!this.active) return;
        const active = this.active;
        this._recordOutcome(active, false, reason);
        this.drive_state.setCooldown(active.drive, Date.now() + this.drive_cooldown_ms);
        this.last_thought = `Gave up: ${active.goal} (${reason})`;
        console.log(`Cognition: goal abandoned (${reason}): ${active.goal}`);
        this.active = null;
        this.pending_replan = null;
        this.persist();
    }

    _abandonGoal(reason) {
        this.abandonGoal(reason);
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
        let sensor_levels = {};
        try {
            sensor_levels = readSensors(this.agent);
            const pos = this.agent.bot.entity?.position;
            if (pos) {
                const chunk = `${this.agent.bot.game.dimension}:${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`;
                if (!this.visited_chunks.has(chunk) && this.visited_chunks.size < 10000) {
                    this.visited_chunks.add(chunk);
                    if (this.visited_chunks.size > 1) // don't reward the spawn chunk
                        this.drive_state.satisfy('curiosity', 0.02);
                }
            }
        } catch {
            // bot not fully spawned yet; decay-only update
        }
        this.drive_state.update(delta, sensor_levels);
    }

    _currentStep() {
        return this.active ? this.active.steps[this.active.step_index] : null;
    }

    _driveStateText() {
        let text = this.drive_state.describe();
        if (this.recent_outcomes.length > 0) {
            text += '\nRecent goal outcomes:\n';
            for (const o of this.recent_outcomes.slice(-5))
                text += `- ${o.success ? 'completed' : 'failed'}: ${o.goal}${o.reason ? ` (${o.reason})` : ''}\n`;
        }
        return text.trim();
    }

    _recordOutcome(active, success, reason) {
        this.recent_outcomes.push({ goal: active.goal, drive: active.drive, success, reason, ts: Date.now() });
        if (this.recent_outcomes.length > 20)
            this.recent_outcomes = this.recent_outcomes.slice(-20);
    }

    _run(fn) {
        this.busy = true;
        this._current_task = fn()
            .catch(err => console.error('Cognition error:', err))
            .finally(() => { this.busy = false; });
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
            state: this.active ? 'pursuing' : 'idle',
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
                recent_outcomes: this.recent_outcomes,
                visited_chunks: [...this.visited_chunks],
            };
            writeFileSync(this.state_fp, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error('Cognition: failed to persist state:', err);
        }
    }

    load() {
        try {
            if (!existsSync(this.state_fp)) return;
            const data = JSON.parse(readFileSync(this.state_fp, 'utf8'));
            this.drive_state.loadJson(data.drives);
            this.recent_outcomes = data.recent_outcomes || [];
            this.visited_chunks = new Set(data.visited_chunks || []);
            if (data.active && data.active.goal && Array.isArray(data.active.steps)) {
                this.active = data.active;
                this.monitor.reset();
                this.monitor.startStep();
                this.last_thought = `Resuming goal from last session: ${this.active.goal}`;
            }
            console.log('Cognition: loaded persisted state.');
        } catch (err) {
            console.error('Cognition: failed to load state:', err);
        }
    }
}
