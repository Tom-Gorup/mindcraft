import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionMonitor } from '../../src/agent/cognition/monitor.js';

test('first failure retries, second triggers replan', () => {
    const m = new ExecutionMonitor({ max_step_retries: 1, max_replans: 2 });
    m.startStep();
    assert.equal(m.noteFailure(), 'retry');
    assert.equal(m.noteFailure(), 'replan');
});

test('replan resets step failures', () => {
    const m = new ExecutionMonitor({ max_step_retries: 1, max_replans: 2 });
    m.startStep();
    m.noteFailure(); // retry
    m.noteFailure(); // replan #1
    assert.equal(m.noteFailure(), 'retry'); // fresh step budget after replan
});

test('abandons after replan budget is exhausted', () => {
    const m = new ExecutionMonitor({ max_step_retries: 0, max_replans: 2 });
    m.startStep();
    assert.equal(m.noteFailure(), 'replan'); // #1
    assert.equal(m.noteFailure(), 'replan'); // #2
    assert.equal(m.noteFailure(), 'abandon');
});

test('startStep resets failures but not replans', () => {
    const m = new ExecutionMonitor({ max_step_retries: 1, max_replans: 1 });
    m.startStep();
    m.noteFailure(); // retry
    m.startStep();   // step completed elsewhere, new step
    assert.equal(m.noteFailure(), 'retry'); // budget reset
    assert.equal(m.noteFailure(), 'replan');
    m.startStep();
    m.noteFailure();
    assert.equal(m.noteFailure(), 'abandon'); // replan budget still spent
});

test('timeout counts only fed-in active time', () => {
    const m = new ExecutionMonitor({ step_timeout_ms: 1000 });
    assert.equal(m.isStepTimedOut(), false); // no time fed
    m.startStep();
    m.noteActiveTime(600);
    assert.equal(m.isStepTimedOut(), false);
    // time NOT fed (conversation, user goal, long action) doesn't count —
    // the caller simply doesn't call noteActiveTime
    m.noteActiveTime(500);
    assert.equal(m.isStepTimedOut(), true);
});

test('startStep resets the active-time budget', () => {
    const m = new ExecutionMonitor({ step_timeout_ms: 1000 });
    m.startStep();
    m.noteActiveTime(1500);
    assert.equal(m.isStepTimedOut(), true);
    m.startStep();
    assert.equal(m.isStepTimedOut(), false);
});

test('reset clears everything', () => {
    const m = new ExecutionMonitor({ max_step_retries: 0, max_replans: 1, step_timeout_ms: 1000 });
    m.startStep();
    m.noteActiveTime(5000);
    m.noteFailure(); // replan #1 spent
    m.reset();
    assert.equal(m.noteFailure(), 'replan'); // budget restored
    assert.equal(m.isStepTimedOut(), false);
});
