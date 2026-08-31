import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setSettings } from '../../src/agent/settings.js';
import { CognitionLoop } from '../../src/agent/cognition/index.js';
import { Blackboard } from '../../src/agent/cognition/blackboard.js';

setSettings({ use_cognition: true, narrate_behavior: false });

function makeAgent(cog_opts = {}) {
    const captured = [];
    const agent = {
        name: 'tiertest',
        captured,
        prompter: {
            profile: {
                cognition: {
                    state_fp: path.join(mkdtempSync(path.join(tmpdir(), 'cog-')), 'cognition.json'),
                    step_cooldown_ms: 100,
                    ...cog_opts,
                },
            },
            promptTaskPlanning: () => Promise.resolve('```json\n{"steps": ["step A", "step B"]}\n```'),
            promptGoalGeneration: () => Promise.resolve('```json\n{"goal": "test goal", "reason": ""}\n```'),
        },
        self_prompter: { isStopped: () => true },
        task: {},
        shut_up: false,
        isIdle: () => true,
        actions: {
            reflex: false,
            currentActionLabel: '',
            isReflexActive() { return this.reflex; },
        },
        bot: { entity: null, game: { dimension: 'overworld' } },
        memory: null,
        handleMessage: (source, msg) => { captured.push(msg); return Promise.resolve(true); },
    };
    agent.blackboard = new Blackboard();
    return agent;
}

function activeGoal() {
    return { drive: 'wealth', goal: 'get an iron pickaxe', reason: '', steps: ['mine iron ore', 'smelt and craft'], step_index: 0 };
}

test('reflex interruption: plan survives intact and the next prompt re-assesses', async () => {
    const agent = makeAgent();
    const cog = new CognitionLoop(agent);
    cog.active = activeGoal();
    cog.monitor.startStep();

    // reflex seizes the slot from our deliberate action (act loop in flight)
    agent.actions.reflex = true;
    cog.act_busy = true;
    cog.onModeInterruption('self_defense', 'action:collectBlocks');
    cog.act_busy = false; // the interrupted loop drains
    assert.equal(agent.blackboard.hasUnhandledInterruption(), true);

    // act tier never fights a reflex for the slot
    cog.actTick(300);
    assert.equal(agent.captured.length, 0);

    // reflex done — next prompt carries the interruption note, plan untouched
    agent.actions.reflex = false;
    cog.actTick(300);
    await cog._act_task;
    assert.equal(agent.captured.length, 1);
    assert.ok(agent.captured[0].includes("interrupted by your self_defense reflex"));
    assert.ok(agent.captured[0].includes('[CURRENT] mine iron ore'));
    assert.equal(cog.active.step_index, 0); // task tree not corrupted

    // interruption is consumed exactly once
    cog.actTick(300);
    await cog._act_task;
    assert.equal(agent.captured[1].includes('reflex'), false);
});

test('replan requested mid-step: act loop is broken first, then the plan revises', async () => {
    const agent = makeAgent();
    const cog = new CognitionLoop(agent);
    cog.active = activeGoal();
    cog.active.step_index = 1;
    cog.monitor.startStep();

    // act tier is mid-LLM-call when a failure demands a replan
    cog.act_busy = true;
    cog.pending_replan = 'tool broke';
    cog.planTick(1000);
    assert.equal(cog.step_interrupt, true);       // signal the act loop to break
    assert.equal(cog.pending_replan, 'tool broke'); // not serviced while act is busy
    assert.equal(cog.shouldInterrupt(true), true);

    // act loop ended — plan tier revises
    cog.act_busy = false;
    cog.planTick(1000);
    await cog._plan_task;
    assert.deepEqual(cog.active.steps, ['step A', 'step B']);
    assert.equal(cog.active.step_index, 0);
    assert.equal(cog.pending_replan, null);
});

test('step timeout accrues while the act tier is busy and triggers on the plan tick', () => {
    const agent = makeAgent({ step_timeout_ms: 500 });
    const cog = new CognitionLoop(agent);
    cog.active = activeGoal();
    cog.monitor.startStep();

    cog.act_busy = true;
    cog.planTick(600); // active time counted during the in-flight LLM call
    cog.act_busy = false;
    cog.planTick(1000); // budget blown -> failure path (first = retry)
    assert.ok(String(cog.last_failure).includes('timed out'));
    assert.equal(cog.active !== null, true); // retry keeps the goal
});

test('act tier stands down while the plan tier is generating', () => {
    const agent = makeAgent();
    const cog = new CognitionLoop(agent);
    cog.active = activeGoal();
    cog.plan_busy = true;
    cog.actTick(300);
    cog.actTick(300);
    assert.equal(agent.captured.length, 0);
    assert.equal(cog.idle_ms, 0);
});

test('step_interrupt never latches after a goal ends (regression: swallowed system prompts)', () => {
    const agent = makeAgent();
    const cog = new CognitionLoop(agent);
    cog.active = activeGoal();
    cog.monitor.startStep();

    // abandon with NO act loop in flight (e.g. user !endGoal between steps)
    cog.abandonGoal('user asked');
    assert.equal(cog.step_interrupt, false); // nothing to break -> not raised
    assert.equal(cog.shouldInterrupt(true), false); // death msgs etc. unaffected

    // abandon WITH an act loop in flight raises it...
    cog.active = activeGoal();
    cog.act_busy = true;
    cog.abandonGoal('failed hard');
    assert.equal(cog.shouldInterrupt(true), true);
    // ...and the first tick after the loop drains clears it, even with no goal
    cog.act_busy = false;
    cog.actTick(300);
    assert.equal(cog.step_interrupt, false);
    assert.equal(cog.shouldInterrupt(true), false);
});

test('interruptions from non-act-tier actions are not attributed to the plan', () => {
    const agent = makeAgent();
    const cog = new CognitionLoop(agent);
    cog.active = activeGoal();
    // act tier NOT busy: this action came from a user conversation
    cog.onModeInterruption('self_defense', 'action:collectBlocks');
    assert.equal(agent.blackboard.hasUnhandledInterruption(), false);
    // act tier busy: genuinely ours
    cog.act_busy = true;
    cog.onModeInterruption('self_defense', 'action:collectBlocks');
    assert.equal(agent.blackboard.hasUnhandledInterruption(), true);
});

test('blackboard mirrors goal state after a plan tick', () => {
    const agent = makeAgent();
    const cog = new CognitionLoop(agent);
    cog.active = activeGoal();
    cog.last_thought = 'mining time';
    cog.planTick(1000);
    const bb = agent.blackboard;
    assert.equal(bb.goal.goal, 'get an iron pickaxe');
    assert.equal(bb.goal.step, 'mine iron ore');
    assert.equal(bb.goal.steps_total, 2);
    assert.equal(bb.last_thought, 'mining time');
    assert.ok(Array.isArray(bb.drives) && bb.drives.length >= 5);
});
