/**
 * Workflow epoch identity tests (hardening Phase 3.1):
 * CSPRNG-shaped, never derived from time/counters, round-trippable through
 * the dispatch-id epoch code.
 */
import { describe, expect, it } from 'vitest';

import { epochCode, epochFromCode, isWorkflowEpoch, newWorkflowEpoch } from '../../src/protocol/epoch';
import {
  buildRecordBody,
  epochOperationId,
  gateEpochOperationId,
  parseRecord,
  readTrustedWorkflowEpoch,
} from '../../src/protocol/records';

describe('newWorkflowEpoch', () => {
  it('produces well-formed epochs', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(isWorkflowEpoch(newWorkflowEpoch())).toBe(true);
    }
  });

  it('does not repeat across a reasonable sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(newWorkflowEpoch());
    }
    expect(seen.size).toBe(200);
  });
});

describe('epochCode round trip', () => {
  it('strips and restores the wf_ prefix', () => {
    const epoch = newWorkflowEpoch();
    const code = epochCode(epoch);
    expect(code).not.toBeNull();
    expect(code).toHaveLength(12);
    expect(epochFromCode(code ?? '')).toBe(epoch);
  });

  it('rejects malformed epochs', () => {
    expect(epochCode('not-an-epoch')).toBeNull();
    expect(epochCode('wf_short')).toBeNull();
    expect(epochCode('wf_UPPERCASE')).toBeNull();
    expect(epochFromCode('UPPERCASE789')).toBeNull();
  });

  it('isWorkflowEpoch rejects non-strings and junk', () => {
    expect(isWorkflowEpoch(42)).toBe(false);
    expect(isWorkflowEpoch('wf_0123456789ab')).toBe(true); // 12 chars
    expect(isWorkflowEpoch('wf_0123456789a')).toBe(false); // 11 chars
    expect(isWorkflowEpoch('wf_0123456789abc')).toBe(false); // 13 chars
    expect(isWorkflowEpoch('wf_0123456789A_')).toBe(false); // uppercase/junk
  });
});

describe('trusted workflow_epoch records', () => {
  const epoch = 'wf_0123456789ab';
  const gate = 'github-actions[bot]';

  function comment(
    id: number,
    user: string,
    record: Record<string, unknown>,
  ): { id: number; user: string; body: string } {
    return { id, user, body: buildRecordBody(record as never) };
  }

  it('accepts a Gate-authored record and preserves the existing operation id', () => {
    const record = {
      schema: 2,
      kind: 'workflow_epoch',
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: epoch,
      created_at: '2026-09-06T11:00:00Z',
      issued_by: gate,
      operation_id: epochOperationId(123, 7, epoch),
    };
    const result = readTrustedWorkflowEpoch(
      [comment(1001, gate, record)],
      123,
      7,
      new Set([gate]),
    );
    expect(result.ok).toBe(true);
    expect(parseRecord(1001, buildRecordBody(record as never)).ok).toBe(true);
  });

  it('accepts the retry-bound form and exposes its source command', () => {
    const record = {
      schema: 2,
      kind: 'workflow_epoch',
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: epoch,
      created_at: '2026-09-06T11:00:00Z',
      issued_by: gate,
      operation_id: gateEpochOperationId(123, 7, 42),
      request_comment_id: 42,
    };
    const input = [
      { id: 42, user: 'octo', body: '/ai-plan' },
      comment(1002, gate, record),
    ];
    const result = readTrustedWorkflowEpoch(input, 123, 7, new Set([gate]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.request_comment_id).toBe(42);
      expect(result.record.operation_id).toBe(gateEpochOperationId(123, 7, 42));
    }
  });

  it('fails closed on a valid-looking record from an ordinary user', () => {
    const record = {
      schema: 2,
      kind: 'workflow_epoch',
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: epoch,
      created_at: '2026-09-06T11:00:00Z',
      issued_by: gate,
      operation_id: epochOperationId(123, 7, epoch),
    };
    const result = readTrustedWorkflowEpoch(
      [comment(1003, 'spoofer', record)],
      123,
      7,
      new Set([gate]),
    );
    expect(result).toEqual({
      ok: false,
      reason: 'workflow_epoch record #1003 is not authored by a trusted Gate identity',
    });
  });

  it('fails closed on foreign bindings and operation-id tampering', () => {
    const foreign = {
      schema: 2,
      kind: 'workflow_epoch',
      repository_id: 999,
      issue_number: 7,
      workflow_epoch: epoch,
      created_at: '2026-09-06T11:00:00Z',
      issued_by: gate,
      operation_id: epochOperationId(999, 7, epoch),
    };
    expect(readTrustedWorkflowEpoch([comment(1004, gate, foreign)], 123, 7, new Set([gate])).ok).toBe(false);

    const tampered = {
      ...foreign,
      repository_id: 123,
      operation_id: 'epoch:123:7:wrong',
    };
    const parsed = parseRecord(1005, buildRecordBody(tampered as never));
    expect(parsed.ok).toBe(false);
  });

  it('does not accept a command-bound operation with a legacy operation id', () => {
    const record = {
      schema: 2,
      kind: 'workflow_epoch',
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: epoch,
      created_at: '2026-09-06T11:00:00Z',
      issued_by: gate,
      operation_id: epochOperationId(123, 7, epoch),
      request_comment_id: 42,
    };
    expect(parseRecord(1006, buildRecordBody(record as never)).ok).toBe(false);
  });

  it('rejects duplicate command operations with divergent epochs', () => {
    const first = {
      schema: 2,
      kind: 'workflow_epoch',
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: epoch,
      created_at: '2026-09-06T11:00:00Z',
      issued_by: gate,
      operation_id: gateEpochOperationId(123, 7, 42),
      request_comment_id: 42,
    };
    const second = { ...first, workflow_epoch: 'wf_abcdefghijkl' };
    const result = readTrustedWorkflowEpoch(
      [
        { id: 42, user: 'octo', body: '/ai-plan' },
        comment(1007, gate, first),
        comment(1008, gate, second),
      ],
      123,
      7,
      new Set([gate]),
    );
    expect(result.ok).toBe(false);
  });
});
