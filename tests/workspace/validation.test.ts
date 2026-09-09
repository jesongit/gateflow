/**
 * Machine-file validators (schema 3): strict keys, mode/status rules, the
 * human-only blacklist and the result cross-field constraints.
 */
import { describe, expect, it } from 'vitest';

import {
  validateTaskFile,
  validateResult,
  validateResultForTask,
  validateCurrent,
  validateDriverState,
} from '../../src/workspace/validation';

const TASK_ID = 'gf_r123_i7_wabc123def456_plan_01';
const EXECUTE_ID = 'gf_r123_i7_wabc123def456_execute_p900';

function baseTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 3,
    task_id: TASK_ID,
    repository: 'octo/repo',
    repository_id: 123,
    issue_number: 7,
    workflow_epoch: 'wf_abc123def456',
    mode: 'plan',
    reason: 'planning',
    created_at: '2026-09-06T10:00:00Z',
    plan_comment_id: null,
    approval_comment_id: null,
    input: { task: 'task.md', plan: null, feedback: null },
    ...overrides,
  };
}

describe('validateTaskFile', () => {
  it('accepts a valid plan task', () => {
    expect(validateTaskFile(baseTask()).ok).toBe(true);
  });

  it('accepts a valid execute task with plan/approval bindings', () => {
    const task = baseTask({
      task_id: EXECUTE_ID,
      mode: 'execute',
      reason: 'approved_plan',
      plan_comment_id: 900,
      approval_comment_id: 901,
      input: { task: 'task.md', plan: 'plan.md', feedback: null },
    });
    expect(validateTaskFile(task).ok).toBe(true);
  });

  it('rejects unknown and missing keys', () => {
    const extra = baseTask({ surprise: 1 });
    expect(validateTaskFile(extra).ok).toBe(false);
    const missing = baseTask();
    delete (missing as Record<string, unknown>)['mode'];
    expect(validateTaskFile(missing).ok).toBe(false);
  });

  it('rejects a schema mismatch', () => {
    expect(validateTaskFile(baseTask({ schema: 2 })).ok).toBe(false);
  });

  it('rejects mode/reason mismatch and wrong-id mode component', () => {
    expect(validateTaskFile(baseTask({ reason: 'approved_plan' })).ok).toBe(false);
    expect(validateTaskFile(baseTask({ task_id: EXECUTE_ID })).ok).toBe(false);
  });

  it('rejects an epoch that disagrees with the task_id', () => {
    expect(validateTaskFile(baseTask({ workflow_epoch: 'wf_000000000000' })).ok).toBe(false);
  });

  it('rejects a non-null plan_comment_id on plan tasks', () => {
    expect(validateTaskFile(baseTask({ plan_comment_id: 5 })).ok).toBe(false);
  });
});

describe('validateResult / validateResultForTask', () => {
  const base = {
    schema: 3,
    task_id: TASK_ID,
    mode: 'plan',
    status: 'completed',
    report: 'plan.md',
  };

  it('accepts a valid plan completion', () => {
    expect(validateResultForTask(base, { taskId: TASK_ID, mode: 'plan' }).ok).toBe(true);
  });

  it('rejects task_id/mode disagreement with the task', () => {
    expect(validateResultForTask(base, { taskId: EXECUTE_ID, mode: 'plan' }).ok).toBe(false);
    expect(
      validateResultForTask({ ...base, mode: 'execute' }, { taskId: TASK_ID, mode: 'plan' }).ok,
    ).toBe(false);
  });

  it('execute completion requires report.md and validation', () => {
    const good = { ...base, task_id: EXECUTE_ID, mode: 'execute', report: 'report.md', validation: 'passed' };
    expect(validateResultForTask(good, { taskId: EXECUTE_ID, mode: 'execute' }).ok).toBe(true);
    expect(
      validateResultForTask({ ...good, validation: undefined }, { taskId: EXECUTE_ID, mode: 'execute' }).ok,
    ).toBe(false);
    expect(
      validateResultForTask({ ...good, report: 'plan.md' }, { taskId: EXECUTE_ID, mode: 'execute' }).ok,
    ).toBe(false);
  });

  it('a failed validation is never publishable as completed', () => {
    const failed = { ...base, task_id: EXECUTE_ID, mode: 'execute', report: 'report.md', validation: 'failed' };
    expect(validateResultForTask(failed, { taskId: EXECUTE_ID, mode: 'execute' }).ok).toBe(true);
  });

  it('blocked/question/failed require a non-empty reason and no report', () => {
    expect(
      validateResultForTask({ ...base, status: 'blocked', report: undefined, reason: '缺少依赖' }, { taskId: TASK_ID, mode: 'plan' }).ok,
    ).toBe(true);
    expect(
      validateResultForTask({ ...base, status: 'question', report: undefined }, { taskId: TASK_ID, mode: 'plan' }).ok,
    ).toBe(false);
    expect(
      validateResultForTask({ ...base, status: 'failed', report: undefined, reason: 'x' }, { taskId: TASK_ID, mode: 'plan' }).ok,
    ).toBe(true);
  });

  it('rejects the human-only blacklist in any casing', () => {
    for (const status of ['approve', 'READY', 'Cancel', 'human-close']) {
      const outcome = validateResult({ ...base, report: undefined, status });
      expect(outcome.ok).toBe(false);
    }
  });

  it('rejects unknown statuses and keys', () => {
    expect(validateResult({ ...base, status: 'done' }).ok).toBe(false);
    expect(validateResult({ ...base, extra: 1 }).ok).toBe(false);
    expect(validateResult({ ...base, schema: 2 }).ok).toBe(false);
  });
});

describe('validateCurrent', () => {
  it('accepts a valid pointer and rejects junk', () => {
    expect(
      validateCurrent({ schema: 3, task_id: TASK_ID, mode: 'plan', issue_number: 7, updated_at: '2026-09-06T10:00:00Z' }).ok,
    ).toBe(true);
    expect(validateCurrent({ schema: 3, task_id: '../x', mode: 'plan', issue_number: 7, updated_at: '2026-09-06T10:00:00Z' }).ok).toBe(false);
  });
});

describe('validateDriverState', () => {
  const record = {
    task_id: TASK_ID,
    status: 'prepared',
    attempts: 1,
    mode: 'plan',
    issue_number: 7,
    workflow_epoch: 'wf_abc123def456',
    input_snapshot_sha256: 'a'.repeat(64),
  };

  it('accepts a valid state file', () => {
    expect(
      validateDriverState({ schema: 3, updated_at: '2026-09-06T10:00:00Z', tasks: { [TASK_ID]: record } }).ok,
    ).toBe(true);
  });

  it('rejects a record whose key disagrees with task_id or a bad status', () => {
    expect(
      validateDriverState({ schema: 3, updated_at: '2026-09-06T10:00:00Z', tasks: { other: record } }).ok,
    ).toBe(false);
    expect(
      validateDriverState({
        schema: 3,
        updated_at: '2026-09-06T10:00:00Z',
        tasks: { [TASK_ID]: { ...record, status: 'synced' } },
      }).ok,
    ).toBe(false);
  });
});
