/**
 * Gate-issued record tests (hardening GF-H02, docs/plans/
 * v1_hardening_decisions.md §4): build/parse round trip, strict-key
 * validation, tampering rejection, and the approval conflict rule.
 */
import { describe, expect, it } from 'vitest';

import {
  approvalOperationId,
  approvalRecordsConflict,
  buildRecordBody,
  gateEpochOperationId,
  bootstrapEpochOperationId,
  transitionOperationId,
  feedbackOperationId,
  findSourceIdInBody,
  parseRecord,
  parseRecords,
  recordKindOf,
  sourceIdComment,
  submitOperationId,
  type ApprovalRecord,
  type FeedbackAcceptedRecord,
  type WorkflowEpochRecord,
} from '../../src/protocol/records';
import { isWorkflowEpoch, newWorkflowEpoch } from '../../src/protocol/epoch';
import { planSha256 } from '../../src/protocol/plan';

const REPO = 123;
const ISSUE = 7;

function anEpochRecord(epoch = newWorkflowEpoch(), over: Partial<WorkflowEpochRecord> = {}): WorkflowEpochRecord {
  return {
    schema: 2,
    kind: 'workflow_epoch',
    repository_id: REPO,
    issue_number: ISSUE,
    workflow_epoch: epoch,
    created_by: 'gate',
    created_at: '2026-09-07T09:00:00Z',
    issued_by: 'github-actions[bot]',
    operation_id: gateEpochOperationId(REPO, ISSUE, 42),
    ...over,
  };
}

function anApprovalRecord(over: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const epoch = over.workflow_epoch ?? newWorkflowEpoch();
  const planCommentId = over.plan_comment_id ?? 100;
  return {
    schema: 2,
    kind: 'approval',
    repository_id: REPO,
    issue_number: ISSUE,
    workflow_epoch: epoch,
    plan_comment_id: planCommentId,
    plan_sha256: planSha256('Plan A'),
    approval_command_comment_id: 200,
    approved_by_id: 42,
    approved_by_login: 'human',
    gate_login: 'github-actions[bot]',
    gate_user_id: 41898282,
    created_at: '2026-09-07T09:05:00Z',
    operation_id: approvalOperationId(REPO, ISSUE, epoch, planCommentId),
    ...over,
  };
}

function aFeedbackRecord(over: Partial<FeedbackAcceptedRecord> = {}): FeedbackAcceptedRecord {
  const epoch = over.workflow_epoch ?? newWorkflowEpoch();
  const feedbackCommentId = over.feedback_comment_id ?? 300;
  return {
    schema: 2,
    kind: 'feedback_accepted',
    repository_id: REPO,
    issue_number: ISSUE,
    workflow_epoch: epoch,
    event_id: `fe${feedbackCommentId}`,
    feedback_comment_id: feedbackCommentId,
    feedback_kind: 'change',
    gate_login: 'github-actions[bot]',
    gate_user_id: 41898282,
    created_at: '2026-09-07T09:10:00Z',
    operation_id: feedbackOperationId(REPO, ISSUE, epoch, feedbackCommentId),
    ...over,
  };
}

describe('record body build/parse round trip', () => {
  it('round trips an epoch record', () => {
    const record = anEpochRecord();
    const parsed = parseRecord(1, buildRecordBody(record));
    expect(parsed).toEqual({ ok: true, commentId: 1, record });
  });

  it('round trips an approval record', () => {
    const record = anApprovalRecord();
    const parsed = parseRecord(2, buildRecordBody(record));
    expect(parsed).toEqual({ ok: true, commentId: 2, record });
  });

  it('round trips a feedback record', () => {
    const record = aFeedbackRecord();
    const parsed = parseRecord(3, buildRecordBody(record));
    expect(parsed).toEqual({ ok: true, commentId: 3, record });
  });

  it('tolerates CRLF bodies and surrounding text', () => {
    const record = anApprovalRecord();
    const body = `some preamble\r\n${buildRecordBody(record).split('\n').join('\r\n')}\r\ntrailer`;
    const parsed = parseRecord(4, body);
    expect(parsed.ok).toBe(true);
  });
});

describe('record parse fails closed on tampering', () => {
  it('rejects a missing JSON fence', () => {
    const record = anEpochRecord();
    const body = buildRecordBody(record).replace(/```json[\s\S]*```/, 'no fence');
    expect(parseRecord(1, body)).toMatchObject({ ok: false });
  });

  it('rejects invalid JSON', () => {
    const body = '<!-- gateflow:approval:v2 -->\n\n```json\n{ not json\n```\n';
    expect(parseRecord(1, body)).toMatchObject({ ok: false });
  });

  it('rejects unknown and missing keys', () => {
    const record = anApprovalRecord();
    const forged = { ...record, attacker: 'inject' } as unknown as Record<string, unknown>;
    expect(parseRecord(1, buildRecordBody(forged as never))).toMatchObject({ ok: false });

    const { operation_id: _dropped, ...missing } = record;
    expect(parseRecord(1, buildRecordBody(missing as unknown as ApprovalRecord))).toMatchObject({
      ok: false,
    });
  });

  it('rejects a record whose operation id does not bind its fields', () => {
    const record = anApprovalRecord();
    const mismatched = anApprovalRecord({ operation_id: 'approval:999:999:wf_000000000000:p1' });
    void record;
    const parsed = parseRecord(1, buildRecordBody(mismatched));
    expect(parsed.ok).toBe(false);
  });

  it('rejects a malformed marker line (not line-exclusive)', () => {
    const record = anEpochRecord();
    const body = buildRecordBody(record).replace(
      '<!-- gateflow:workflow:v2 -->',
      'text <!-- gateflow:workflow:v2 --> more',
    );
    expect(parseRecord(1, body)).toMatchObject({ ok: false });
  });

  it('rejects bad enum/hash/epoch values', () => {
    expect(
      parseRecord(1, buildRecordBody(aFeedbackRecord({ feedback_kind: 'approve' } as never))),
    ).toMatchObject({ ok: false });
    expect(
      parseRecord(1, buildRecordBody(anApprovalRecord({ plan_sha256: 'deadbeef' }))),
    ).toMatchObject({ ok: false });
    expect(
      parseRecord(1, buildRecordBody(anEpochRecord({ workflow_epoch: 'wf_TAMPERED' } as never))),
    ).toMatchObject({ ok: false });
  });
});

describe('recordKindOf and parseRecords', () => {
  it('classifies record kinds and ignores non-record comments', () => {
    expect(recordKindOf('leading <!-- gateflow:approval:v2 --> trailing')).toBeNull();
    expect(recordKindOf(buildRecordBody(anEpochRecord()))).toBe('workflow_epoch');
    expect(recordKindOf('plain comment')).toBeNull();
    // Workflow markers are NOT record markers.
    expect(recordKindOf('<!-- ai-workflow:plan:v1 -->')).toBeNull();
  });

  it('separates valid records from invalid ones (fail-closed feed)', () => {
    const good = buildRecordBody(anApprovalRecord());
    const bad = '<!-- gateflow:approval:v2 -->\n\n```json\n{}\n```\n';
    const comments = [
      { id: 1, user: 'github-actions[bot]', body: good },
      { id: 2, user: 'github-actions[bot]', body: bad },
    ];
    const { records, invalid } = parseRecords('approval', comments);
    expect(records).toHaveLength(1);
    expect(invalid).toEqual([{ commentId: 2, reason: expect.any(String) }]);
  });
});

describe('approvalRecordsConflict', () => {
  it('accepts identical retries (created_at may differ)', () => {
    const a = anApprovalRecord();
    const b = { ...a, created_at: '2026-09-07T09:09:09Z' };
    expect(approvalRecordsConflict([
      { commentId: 1, record: a },
      { commentId: 2, record: b },
    ])).toEqual({ conflict: false, reason: null });
  });

  it('flags divergent content under the same operation id', () => {
    const epoch = newWorkflowEpoch();
    const a = anApprovalRecord({ workflow_epoch: epoch, plan_sha256: planSha256('Plan A') });
    const b = anApprovalRecord({ workflow_epoch: epoch, plan_sha256: planSha256('Plan A edited') });
    void epoch;
    const result = approvalRecordsConflict([
      { commentId: 1, record: a },
      { commentId: 2, record: b },
    ]);
    expect(result.conflict).toBe(true);
  });

  it('flags a forged approver under the same operation id', () => {
    const epoch = newWorkflowEpoch();
    const a = anApprovalRecord({ workflow_epoch: epoch, approved_by_login: 'human' });
    const b = anApprovalRecord({
      workflow_epoch: epoch,
      approved_by_login: 'human',
      approved_by_id: a.approved_by_id + 1,
    });
    const result = approvalRecordsConflict([
      { commentId: 1, record: a },
      { commentId: 2, record: b },
    ]);
    expect(result.conflict).toBe(true);
  });
});

describe('operation id grammar', () => {
  it('binds every authorization object to content/task identity', () => {
    const epoch = newWorkflowEpoch();
    expect(gateEpochOperationId(REPO, ISSUE, 42)).toBe(`epoch:${REPO}:${ISSUE}:c42`);
    expect(bootstrapEpochOperationId(REPO, ISSUE)).toBe(`epoch:${REPO}:${ISSUE}:bootstrap`);
    expect(approvalOperationId(REPO, ISSUE, epoch, 100)).toBe(
      `approval:${REPO}:${ISSUE}:${epoch}:p100`,
    );
    expect(feedbackOperationId(REPO, ISSUE, epoch, 300)).toBe(
      `feedback:${REPO}:${ISSUE}:${epoch}:300`,
    );
    expect(submitOperationId('sub_0123456789abcdef')).toBe('submit:sub_0123456789abcdef');
    expect(isWorkflowEpoch(epoch)).toBe(true);
  });
});

describe('producer source-id anchor', () => {
  it('round trips through an issue body', () => {
    const body = `TASK\n\n${sourceIdComment('submit:sub_0123456789abcdef')}\n\n> note`;
    expect(findSourceIdInBody(body)).toBe('submit:sub_0123456789abcdef');
  });

  it('returns null for foreign or absent anchors', () => {
    expect(findSourceIdInBody('no anchor')).toBeNull();
    expect(findSourceIdInBody('<!-- gateflow:source-id: approval:1:2:wf_000000000000:p3 -->')).toBeNull();
  });
});
