import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setSettings } from '../../src/agent/settings.js';
import { CognitionLoop } from '../../src/agent/cognition/index.js';
import { Blackboard } from '../../src/agent/cognition/blackboard.js';

setSettings({ use_cognition: true, narrate_behavior: false });

function makeCog() {
    const agent = {
        name: 'itest',
        prompter: {
            profile: { cognition: { state_fp: path.join(mkdtempSync(path.join(tmpdir(), 'cog-')), 'c.json') } },
            promptGoalGeneration: () => Promise.resolve('{}'),
            promptTaskPlanning: () => Promise.resolve('{}'),
        },
        self_prompter: { isStopped: () => true },
        task: {}, shut_up: false, isIdle: () => true,
        actions: { currentActionLabel: '', isReflexActive: () => false },
        bot: { entity: null, game: { dimension: 'overworld' } },
        memory: null,
    };
    agent.blackboard = new Blackboard();
    const cog = new CognitionLoop(agent);
    cog.active = { drive: 'wealth', goal: 'g', reason: '', steps: ['s1', 's2'], step_index: 0 };
    cog.monitor.startStep();
    return { agent, cog };
}

test('interruptAct only fires against a live act loop', () => {
    const { cog } = makeCog();
    cog.interruptAct();                      // nothing running
    assert.equal(cog.step_interrupt, false);
    cog.act_busy = true;
    cog.interruptAct();
    assert.equal(cog.step_interrupt, true);
});

test('goal completion stops the act loop instead of letting it free-associate', () => {
    const { cog } = makeCog();
    cog.act_busy = true;
    cog.active.step_index = 1;   // on the last step
    const msg = cog.onStepDone(); // completes the goal
    assert.ok(msg.includes('Goal accomplished'));
    assert.equal(cog.active, null);
    assert.equal(cog.step_interrupt, true); // loop told to stop
});

test('a reflex interrupting a deliberate action breaks the act loop', () => {
    const { cog } = makeCog();
    cog.act_busy = true;
    // simulates modes.execute(): interruptAct() then onModeInterruption()
    cog.interruptAct();
    cog.onModeInterruption('self_defense', 'action:collectBlocks');
    assert.equal(cog.shouldInterrupt(), true);
});

test('cognition is dormant and does not resurrect goals when the flag is off', () => {
    const { agent, cog } = makeCog();
    cog.persist(); // write an active goal to disk
    setSettings({ use_cognition: false });
    const reloaded = new CognitionLoop(agent);
    assert.equal(reloaded.active, null); // no cross-flag resurrection
    assert.equal(reloaded.isPursuing(), false);
    assert.equal(reloaded.getStatus().state, 'idle');
    assert.equal(reloaded.shouldInterrupt(), false);
    setSettings({ use_cognition: true, narrate_behavior: false });
});

// A goal must not outlive the situation that produced it. Preemption only
// fires when a DIFFERENT drive wins, so a goal whose premise has evaporated
// used to survive as long as its own drive stayed on top. Observed live: a
// "deal with the nearby skeleton" goal persisted long after the skeleton left,
// because safety is fed by health as well as by hostiles.
test('a goal is dropped once its motivating drive is actually MET', () => {
    const { cog: loop } = makeCog();
    loop.goal_relief_margin = 0.25;
    loop.active = { drive: 'safety', goal: 'deal with the skeleton', steps: ['a'], step_index: 0,
        urgency_at_start: 0.80, active_ms: 120000 };
    loop.drive_state.urgency = () => 0.78;                 // barely moved
    assert.equal(loop._goalNoLongerWarranted(), null, 'a small change must not drop the goal');

    // Improved but still plainly unsafe. Dropping here is what left Wilbur
    // half-sheltered and starting over, again and again.
    loop.drive_state.urgency = () => 0.50;
    assert.equal(loop._goalNoLongerWarranted(), null,
        'a half-solved problem is not a solved one');

    loop.drive_state.urgency = () => 0.10;                 // genuinely safe now
    const reason = loop._goalNoLongerWarranted();
    assert.ok(reason, 'a met need should retire its goal');
    assert.match(reason, /safety has eased/);
});

// Run 12, 2026-09-06: Wilbur started "Build a roof on the 3x3 shelter" and
// abandoned it ELEVEN SECONDS later to "safety has eased". Placing the first
// roof blocks raised the shelter reading, which eased safety, which cancelled
// the goal that was building the roof. He completed nothing in 82 minutes and
// placed three blocks.
test('progress on a goal cannot cancel that goal', () => {
    const { cog: loop } = makeCog();
    loop.goal_relief_margin = 0.25;
    loop.active = { drive: 'safety', goal: 'build a roof', steps: ['a'], step_index: 0,
        urgency_at_start: 0.72, active_ms: 11000 };       // eleven seconds in
    loop.drive_state.urgency = () => 0.20;                 // the roof is going up

    assert.equal(loop._goalNoLongerWarranted(), null,
        'inside the commitment window, partial progress must not retire the goal');

    loop.active.active_ms = 120000;
    assert.ok(loop._goalNoLongerWarranted(), 'once committed and genuinely safe, it retires');
});

test('a goal that never finishes is dropped by the backstop', () => {
    const { cog: loop } = makeCog();
    loop.goal_relief_margin = 0.25;
    loop.goal_max_active_ms = 60000;
    loop.drive_state.urgency = () => 0.80;                 // drive unchanged, so only age can end it
    loop.active = { drive: 'safety', goal: 'stuck forever', steps: ['a'], step_index: 0,
        urgency_at_start: 0.80, active_ms: 59000 };
    assert.equal(loop._goalNoLongerWarranted(), null);
    loop.active.active_ms = 61000;
    assert.match(loop._goalNoLongerWarranted(), /no progress after/);
});

test('no active goal is not an error', () => {
    const { cog: loop } = makeCog();
    loop.active = null;
    assert.equal(loop._goalNoLongerWarranted(), null);
});
