import { describe, expect, it } from 'vitest';

import {
  validateContext,
  validateCurrent,
  validateDispatch,
  validateReceipt,
  validateResult,
  validateStatus,
  validateSubmit,
} from '../../src/workspace/schemas';
import {
  consumerContext,
  consumerDispatch,
  currentPointer,
  executorContext,
  executorDispatch,
  receipt,
  resultFile,
  statusFile,
  submitRequest,
} from './helpers';

describe('validateDispatch', () => {
  it('accepts canonical consumer and executor dispatches', () => {
    expect(validateDispatch(consumerDispatch())).toEqual({ ok: true, value: consumerDispatch() });
    expect(validateDispatch(executorDispatch())).toEqual({ ok: true, value: executorDispatch() });
    // Feedback projection is legal for both roles.
    expect(validateDispatch(consumerDispatch({}, { feedback: 'FEEDBACK.md' })).ok).toBe(true);
    expect(validateDispatch(executorDispatch({}, { feedback: 'FEEDBACK.md' })).ok).toBe(true);
  });

  it('rejects wrong schema version and non-objects', () => {
    expect(validateDispatch(null).ok).toBe(false);
    expect(validateDispatch('nope').ok).toBe(false);
    expect(validateDispatch([]).ok).toBe(false);
    const bad = consumerDispatch({ schema: 2 as unknown as 1 });
    const parsed = validateDispatch(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(' ')).toContain('schema');
  });

  it('rejects unknown and missing keys (strict objects)', () => {
    const withExtra: Record<string, unknown> = { ...consumerDispatch(), surprise: 1 };
    expect(validateDispatch(withExtra).ok).toBe(false);
    const missing = { ...consumerDispatch() } as Record<string, unknown>;
    delete missing['repository'];
    expect(validateDispatch(missing).ok).toBe(false);
    const dispatchWithBadInput = {
      ...consumerDispatch(),
      input: { task: 'TASK.md', plan: null, feedback: null, extra: 1 },
    };
    expect(validateDispatch(dispatchWithBadInput).ok).toBe(false);
  });

  it('enforces the role/reason coupling', () => {
    expect(validateDispatch(consumerDispatch({ reason: 'feedback_applied' })).ok).toBe(true);
    expect(validateDispatch(consumerDispatch({ reason: 'approved_plan' })).ok).toBe(false);
    expect(validateDispatch(executorDispatch({ reason: 'planning' })).ok).toBe(false);
    expect(validateDispatch(executorDispatch({ reason: 'feedback_applied' })).ok).toBe(false);
    expect(validateDispatch(consumerDispatch({ role: 'manager' as 'consumer' })).ok).toBe(false);
  });

  it('enforces executor-only plan/approval comment ids', () => {
    expect(validateDispatch(executorDispatch({ plan_comment_id: null })).ok).toBe(false);
    expect(validateDispatch(executorDispatch({ approval_comment_id: null })).ok).toBe(false);
    expect(validateDispatch(executorDispatch({ plan_comment_id: 0 })).ok).toBe(false);
    expect(validateDispatch(consumerDispatch({ plan_comment_id: 100 })).ok).toBe(false);
    expect(validateDispatch(consumerDispatch({ approval_comment_id: 200 })).ok).toBe(false);
  });

  it('enforces the fixed input file names per role', () => {
    expect(validateDispatch(executorDispatch({}, { plan: null })).ok).toBe(false);
    expect(validateDispatch(consumerDispatch({}, { plan: 'PLAN.md' })).ok).toBe(false);
    expect(validateDispatch(consumerDispatch({}, { task: 'task.md' })).ok).toBe(false);
    expect(validateDispatch(consumerDispatch({}, { feedback: 'other.md' })).ok).toBe(false);
  });

  it('rejects dispatch_ids that mismatch the role or the grammar', () => {
    expect(validateDispatch(consumerDispatch({ dispatch_id: 'gf_r1_i2_executor_p100' })).ok).toBe(false);
    expect(validateDispatch(consumerDispatch({ dispatch_id: '../escape' })).ok).toBe(false);
  });

  it('rejects unparseable timestamps', () => {
    expect(validateDispatch(consumerDispatch({ created_at: 'not-a-date' })).ok).toBe(false);
    expect(validateDispatch(consumerDispatch({ created_at: '2026-09-06 17:00:00' })).ok).toBe(false);
    expect(validateDispatch(consumerDispatch({ created_at: '2026-13-45T99:00:00Z' })).ok).toBe(false);
  });
});

describe('validateContext', () => {
  it('accepts consumer and executor contexts', () => {
    expect(validateContext(consumerContext())).toEqual({ ok: true, value: consumerContext() });
    expect(validateContext(executorContext())).toEqual({ ok: true, value: executorContext() });
    expect(validateContext(consumerContext({ feedback_count: 3 })).ok).toBe(true);
  });

  it('requires plan anchors for executors only', () => {
    const { plan_comment_id: _pc, plan_sha256: _ps, ...bare } = executorContext();
    void _pc;
    void _ps;
    expect(validateContext(bare).ok).toBe(false);
    expect(validateContext(executorContext({ plan_sha256: 'nothex' })).ok).toBe(false);
    expect(validateContext(consumerContext({ plan_comment_id: 100 })).ok).toBe(false);
    expect(validateContext(consumerContext({ plan_sha256: 'a'.repeat(64) })).ok).toBe(false);
  });

  it('rejects unknown keys and negative feedback counts', () => {
    expect(validateContext({ ...consumerContext(), bonus: 1 }).ok).toBe(false);
    expect(validateContext(consumerContext({ feedback_count: -1 })).ok).toBe(false);
    expect(validateContext(consumerContext({ dispatch_id: 'gf_rzz_i2_consumer_01' })).ok).toBe(false);
  });
});

describe('validateStatus', () => {
  it('accepts working/blocked/failed for both roles', () => {
    for (const state of ['working', 'blocked', 'failed'] as const) {
      for (const role of ['consumer', 'executor'] as const) {
        expect(validateStatus(statusFile({ state, role, dispatch_id: role === 'consumer' ? 'gf_r1_i2_consumer_01' : 'gf_r1_i2_executor_p100' })).ok).toBe(true);
      }
    }
  });

  it('rejects human-only state values with an error naming the value', () => {
    for (const state of ['ready', 'approve', 'cancel', 'human-close', 'READY'] as const) {
      const parsed = validateStatus(statusFile({ state: state as 'working' }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors.join(' ')).toContain('human-only');
        expect(parsed.errors.join(' ')).toContain(state);
      }
    }
  });

  it('rejects unknown keys, bad state values and oversized phase/summary', () => {
    expect(validateStatus({ ...statusFile(), progress: 1 }).ok).toBe(false);
    expect(validateStatus(statusFile({ state: 'done' as 'working' })).ok).toBe(false);
    expect(validateStatus(statusFile({ phase: 'x'.repeat(501) })).ok).toBe(false);
    expect(validateStatus(statusFile({ summary: 'x'.repeat(501) })).ok).toBe(false);
    expect(validateStatus(statusFile({ phase: 'x'.repeat(500) })).ok).toBe(true);
    expect(validateStatus(statusFile({ updated_at: 'yesterday' })).ok).toBe(false);
    expect(validateStatus(statusFile({ schema: 2 as unknown as 1 })).ok).toBe(false);
  });
});

describe('validateResult', () => {
  it('accepts the canonical terminal results', () => {
    expect(validateResult(resultFile())).toEqual({ ok: true, value: resultFile() });
    expect(
      validateResult({
        schema: 1,
        dispatch_id: 'gf_r1_i2_executor_p100',
        role: 'executor',
        result: 'completed',
        report_file: 'REPORT.md',
        validation: 'passed',
      }).ok,
    ).toBe(true);
    expect(
      validateResult({
        schema: 1,
        dispatch_id: 'gf_r1_i2_executor_p100',
        role: 'executor',
        result: 'blocked',
        reason: 'missing credentials',
      }).ok,
    ).toBe(true);
  });

  it('rejects human-only result values with an error naming the value', () => {
    for (const result of ['approve', 'ready', 'cancel', 'human-close', 'Ready'] as const) {
      const parsed = validateResult(resultFile({ result: result as 'plan_ready' }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors.join(' ')).toContain('human-only');
        expect(parsed.errors.join(' ')).toContain(result);
      }
    }
  });

  it('rejects near-variant values like "approved" with an error naming the value', () => {
    const parsed = validateResult(resultFile({ result: 'approved' as 'plan_ready' }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const joined = parsed.errors.join(' ');
      expect(joined).toContain('approved');
      expect(joined).toContain('not a valid result value');
    }
  });

  it('rejects unknown keys and malformed field values', () => {
    expect(validateResult({ ...resultFile(), plan: 'PLAN.md' }).ok).toBe(false);
    expect(validateResult(resultFile({ plan_file: 'plan.md' })).ok).toBe(false);
    expect(validateResult(resultFile({ validation: 'skipped' as 'passed' })).ok).toBe(false);
    expect(validateResult(resultFile({ reason: 'x'.repeat(1001) })).ok).toBe(false);
    expect(validateResult(resultFile({ result: 'victory' as 'plan_ready' })).ok).toBe(false);
    expect(validateResult(resultFile({ dispatch_id: 'gf_r1_i2_consumer_XX' })).ok).toBe(false);
  });
});

describe('validateCurrent', () => {
  it('round-trips a valid pointer and rejects broken ones', () => {
    expect(validateCurrent(currentPointer())).toEqual({ ok: true, value: currentPointer() });
    expect(validateCurrent({ ...currentPointer(), extra: 1 }).ok).toBe(false);
    expect(validateCurrent({ ...currentPointer(), issue_number: 0 }).ok).toBe(false);
    expect(validateCurrent({ ...currentPointer(), role: 'human' as 'consumer' }).ok).toBe(false);
    expect(validateCurrent({ ...currentPointer(), updated_at: 'nope' }).ok).toBe(false);
  });
});

describe('validateReceipt', () => {
  it('round-trips a full receipt', () => {
    const full = receipt({
      status: 'synced',
      attempts: 2,
      tracker_comment_id: 123,
      last_progress_sha256: 'b'.repeat(64),
      last_feedback_comment_id: 456,
      last_sync_at: '2026-09-06T17:31:00Z',
      error: null,
    });
    expect(validateReceipt(full)).toEqual({ ok: true, value: full });
  });

  it('is strict: no schema field, unknown keys rejected', () => {
    expect(validateReceipt({ ...receipt(), schema: 1 }).ok).toBe(false);
    expect(validateReceipt({ ...receipt(), extra: 1 }).ok).toBe(false);
  });

  it('validates enums, attempts and dates', () => {
    expect(validateReceipt(receipt({ status: 'queued' as 'dispatched' })).ok).toBe(false);
    expect(validateReceipt(receipt({ attempts: 0 })).ok).toBe(false);
    expect(validateReceipt(receipt({ attempts: 1.5 })).ok).toBe(false);
    expect(validateReceipt(receipt({ last_sync_at: 'nope' })).ok).toBe(false);
    expect(validateReceipt(receipt({ error: '' })).ok).toBe(false);
    expect(validateReceipt(receipt({ dispatch_id: 'junk' })).ok).toBe(false);
  });
});

describe('validateSubmit', () => {
  it('accepts a canonical submit request', () => {
    expect(validateSubmit(submitRequest())).toEqual({ ok: true, value: submitRequest() });
  });

  it('enforces title cap and enums', () => {
    expect(validateSubmit(submitRequest({ title: '' })).ok).toBe(false);
    expect(validateSubmit(submitRequest({ title: 'x'.repeat(257) })).ok).toBe(false);
    expect(validateSubmit(submitRequest({ title: 'x'.repeat(256) })).ok).toBe(true);
    expect(validateSubmit(submitRequest({ kind: 'hotfix' as 'feature' })).ok).toBe(false);
    expect(validateSubmit(submitRequest({ maturity_hint: 'someday' as 'requirement' })).ok).toBe(false);
    expect(validateSubmit(submitRequest({ created_at: '2026/09/06' })).ok).toBe(false);
    expect(validateSubmit({ ...submitRequest(), schema: 3 as unknown as 1 }).ok).toBe(false);
    expect(validateSubmit({ ...submitRequest(), whoops: 1 }).ok).toBe(false);
  });
});
