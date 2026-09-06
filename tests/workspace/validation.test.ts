import { describe, expect, it } from 'vitest';

import { validateDispatchDirName, validateOutboxResult, validateOutboxStatus, MAX_FILE_BYTES } from '../../src/workspace/validation';
import { OversizedFileError } from '../../src/workspace/outbox';
import { resultFile, statusFile } from './helpers';

const CONSUMER = { dispatchId: 'gf_r1_i2_consumer_01', role: 'consumer' as const };
const EXECUTOR = { dispatchId: 'gf_r1_i2_executor_p100', role: 'executor' as const };

describe('validateDispatchDirName', () => {
  it('accepts frozen ids and rejects everything else', () => {
    expect(validateDispatchDirName('gf_r1_i2_consumer_01')).toBe(true);
    expect(validateDispatchDirName('gf_r1_i2_executor_p3472198451')).toBe(true);
    expect(validateDispatchDirName('junk')).toBe(false);
    expect(validateDispatchDirName('gf_r1_i2_consumer_01/../x')).toBe(false);
  });
});

describe('validateOutboxStatus', () => {
  it('accepts a well-formed status for the expected dispatch', () => {
    expect(validateOutboxStatus(statusFile(), CONSUMER)).toEqual({ ok: true, value: statusFile() });
    expect(
      validateOutboxStatus(
        statusFile({
          dispatch_id: EXECUTOR.dispatchId,
          role: 'executor',
          state: 'blocked',
          phase: 'waiting',
          summary: 'on credentials',
        }),
        EXECUTOR,
      ).ok,
    ).toBe(true);
  });

  it('rejects dispatch_id / role mismatches', () => {
    const wrongId = validateOutboxStatus(statusFile({ dispatch_id: 'gf_r1_i2_consumer_02' }), CONSUMER);
    expect(wrongId.ok).toBe(false);
    const wrongRole = validateOutboxStatus(statusFile({ role: 'executor' }), CONSUMER);
    expect(wrongRole.ok).toBe(false);
  });

  it('rejects human-only and out-of-whitelist states', () => {
    const ready = validateOutboxStatus(statusFile({ state: 'ready' as 'working' }), CONSUMER);
    expect(ready.ok).toBe(false);
    if (!ready.ok) {
      const joined = ready.errors.join(' ');
      expect(joined).toContain('ready');
      expect(joined).toContain('human-only');
    }
    expect(validateOutboxStatus(statusFile({ state: 'done' as 'working' }), CONSUMER).ok).toBe(false);
  });
});

describe('validateOutboxResult', () => {
  it('accepts consumer plan_ready with plan_file', () => {
    expect(validateOutboxResult(resultFile(), CONSUMER)).toEqual({ ok: true, value: resultFile() });
  });

  it('enforces plan_file iff consumer && plan_ready', () => {
    const missing = validateOutboxResult(resultFile({ plan_file: undefined }), CONSUMER);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join(' ')).toContain('plan_file is required');

    const questionWithPlan = validateOutboxResult(
      resultFile({ result: 'question', plan_file: 'PLAN.md', reason: 'which db?' }),
      CONSUMER,
    );
    expect(questionWithPlan.ok).toBe(false);

    const questionOk = validateOutboxResult(
      resultFile({ result: 'question', plan_file: undefined, reason: 'which db?' }),
      CONSUMER,
    );
    expect(questionOk.ok).toBe(true);
  });

  it('requires a non-empty reason for blocked/question/failed', () => {
    const failedWithoutReason = validateOutboxResult(resultFile({ result: 'failed', plan_file: undefined }), CONSUMER);
    expect(failedWithoutReason.ok).toBe(false);
    const failedEmptyReason = validateOutboxResult(
      resultFile({ result: 'failed', plan_file: undefined, reason: '   ' }),
      CONSUMER,
    );
    expect(failedEmptyReason.ok).toBe(false);
    const failedOk = validateOutboxResult(
      resultFile({ result: 'failed', plan_file: undefined, reason: 'issue was closed upstream' }),
      CONSUMER,
    );
    expect(failedOk.ok).toBe(true);
  });

  it('enforces report_file + validation iff executor && completed', () => {
    const base = {
      dispatch_id: EXECUTOR.dispatchId,
      role: 'executor' as const,
      result: 'completed' as const,
    };
    const noReport = validateOutboxResult({ ...resultFile(base), plan_file: undefined }, EXECUTOR);
    expect(noReport.ok).toBe(false);
    if (!noReport.ok) expect(noReport.errors.join(' ')).toContain('report_file is required');

    const noValidation = validateOutboxResult(
      { schema: 1, ...base, report_file: 'REPORT.md' },
      EXECUTOR,
    );
    expect(noValidation.ok).toBe(false);
    if (!noValidation.ok) expect(noValidation.errors.join(' ')).toContain('validation is required');

    const ok = validateOutboxResult(
      { schema: 1, ...base, report_file: 'REPORT.md', validation: 'passed' },
      EXECUTOR,
    );
    expect(ok.ok).toBe(true);

    const blockedWithReport = validateOutboxResult(
      { schema: 1, dispatch_id: EXECUTOR.dispatchId, role: 'executor', result: 'blocked', report_file: 'REPORT.md', reason: 'stuck' },
      EXECUTOR,
    );
    expect(blockedWithReport.ok).toBe(false);
  });

  it('rejects cross-role results (role whitelist)', () => {
    const consumerCompleted = validateOutboxResult(
      resultFile({ result: 'completed', plan_file: undefined, report_file: 'REPORT.md', validation: 'passed' }),
      CONSUMER,
    );
    expect(consumerCompleted.ok).toBe(false);
    const executorPlanReady = validateOutboxResult(
      resultFile({
        dispatch_id: EXECUTOR.dispatchId,
        role: 'executor',
        result: 'plan_ready',
        plan_file: 'PLAN.md',
      }),
      EXECUTOR,
    );
    expect(executorPlanReady.ok).toBe(false);
  });

  it('rejects human-only and near-variant result values naming the value', () => {
    const approved = validateOutboxResult(
      resultFile({ result: 'approved' as 'plan_ready', plan_file: undefined }),
      CONSUMER,
    );
    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      const joined = approved.errors.join(' ');
      expect(joined).toContain('approved');
    }
    const ready = validateOutboxResult(resultFile({ result: 'ready' as 'plan_ready', plan_file: undefined }), CONSUMER);
    expect(ready.ok).toBe(false);
    if (!ready.ok) expect(ready.errors.join(' ')).toContain('human-only');
  });

  it('rejects expected-identity mismatches', () => {
    expect(validateOutboxResult(resultFile({ dispatch_id: 'gf_r1_i2_consumer_09' }), CONSUMER).ok).toBe(false);
    expect(validateOutboxResult(resultFile(), EXECUTOR).ok).toBe(false);
  });

  it('caps the file size constant at 512 KB', () => {
    expect(MAX_FILE_BYTES).toBe(512 * 1024);
    expect(new OversizedFileError('x', MAX_FILE_BYTES + 1, MAX_FILE_BYTES)).toBeInstanceOf(OversizedFileError);
  });
});
