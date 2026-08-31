import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionMonitor } from '../../src/agent/cognition/monitor.js';

test('first failure retries, second triggers replan', () => {
    const m = new ExecutionMonitor({ max_step_retries: 1, max_replans: 2 });
    m.startStep(0);
    assert.equal(m.noteFailure(), 'retry');
    assert.equal(m.noteFailure(), 'replan');
});

test('replan resets step failures', () => {
    const m = new ExecutionMonitor({ max_step_retries: 1, max_replans: 2 });
    m.startStep(0);
    m.noteFailure(); // retry
    m.noteFailure(); // replan #1
    assert.equal(m.noteFailure(), 'retry'); // fresh step budget after replan
});

test('abandons after replan budget is exhausted', () => {
    const m = new ExecutionMonitor({ max_step_retries: 0, max_replans: 2 });
    m.startStep(0);
    assert.equal(m.noteFailure(), 'replan'); // #1
    assert.equal(m.noteFailure(), 'replan'); // #2
    assert.equal(m.noteFailure(), 'abandon');
});

test('startStep resets failures but not replans', () => {
    const m = new ExecutionMonitor({ max_step_retries: 1, max_replans: 1 });
    m.startStep(0);
    m.noteFailure(); // retry
    m.startStep(0);  // step completed elsewhere, new step
    assert.equal(m.noteFailure(), 'retry'); // budget reset
    assert.equal(m.noteFailure(), 'replan');
    m.startStep(0);
    m.noteFailure();
    assert.equal(m.noteFailure(), 'abandon'); // replan budget still spent
});

test('step timeout detection', () => {
    const m = new ExecutionMonitor({ step_timeout_ms: 1000 });
    assert.equal(m.isStepTimedOut(5000), false); // no step started
    m.startStep(1000);
    assert.equal(m.isStepTimedOut(1500), false);
    assert.equal(m.isStepTimedOut(2001), true);
});

test('reset clears everything', () => {
    const m = new ExecutionMonitor({ max_step_retries: 0, max_replans: 1 });
    m.startStep(0);
    m.noteFailure(); // replan #1 spent
    m.reset();
    assert.equal(m.noteFailure(), 'replan'); // budget restored
    assert.equal(m.isStepTimedOut(999999999), false);
});
