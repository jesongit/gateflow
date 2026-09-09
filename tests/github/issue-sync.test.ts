import { describe, expect, it } from 'vitest';

import {
  acceptedFeedbackEvents,
  approvalRecordAnchorFailure,
  findHumanFeedbackCommands,
  readIssueRecords,
} from '../../src/github/issue-sync';
import type { CommentDetail } from '../../src/github/client';
import type { ApprovalRecord, GateRecord } from '../../src/protocol/records';
import { buildRecordBody, gateEpochOperationId } from '../../src/protocol/records';
import {
  approvalRecord,
  epochRecord,
  feedbackRecord,
  testEpoch,
} from '../driver/helpers';

const REPOSITORY_ID = 123;
const ISSUE_NUMBER = 7;
const OWNER = 'octo';
const GATE_LOGIN = 'github-actions[bot]';
const EPOCH = testEpoch(1);

function comment(id: number, user: string, body: string): CommentDetail {
  return {
    id,
    user,
    body,
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
  };
}

function epochComment(id: number, epoch = EPOCH): CommentDetail {
  // Task 03 may add a source binding to newly-issued epoch records. Including
  // it here keeps this fixture valid for both the extended and legacy parser.
  const requestCommentId = 100 + id;
  const record = {
    ...epochRecord(REPOSITORY_ID, ISSUE_NUMBER, epoch),
    request_comment_id: requestCommentId,
    operation_id: gateEpochOperationId(REPOSITORY_ID, ISSUE_NUMBER, requestCommentId),
  } as GateRecord;
  return comment(id, GATE_LOGIN, buildRecordBody(record));
}

describe('issue-sync command and record projections', () => {
  it('counts only Gate-accepted /change records, not ordinary comments', () => {
    const rawChange = comment(2, OWNER, '/change this was never accepted');
    const acceptedChange = comment(3, OWNER, '/change accepted feedback');
    const acceptedRecord = comment(
      4,
      GATE_LOGIN,
      buildRecordBody(
        feedbackRecord({
          repositoryId: REPOSITORY_ID,
          issueNumber: ISSUE_NUMBER,
          epoch: EPOCH,
          feedbackCommentId: acceptedChange.id,
          kind: 'change',
        }),
      ),
    );
    // A retry can leave the same accepted record body twice; it is one event.
    const duplicateRecord = comment(5, GATE_LOGIN, acceptedRecord.body);
    const comments = [epochComment(1), rawChange, acceptedChange, acceptedRecord, duplicateRecord];
    const view = readIssueRecords(comments, new Set([GATE_LOGIN]));

    expect(
      acceptedFeedbackEvents(view, comments, new Set([OWNER.toUpperCase()]), OWNER),
    ).toEqual([{ comment: acceptedChange, kind: 'change' }]);
  });

  it('ignores a feedback record from an old epoch and an invalid source command', () => {
    const currentEpoch = testEpoch(2);
    const oldChange = comment(3, OWNER, '/change old round');
    const invalidChange = comment(4, OWNER, '/change first\nsecond');
    const oldRecord = comment(
      5,
      GATE_LOGIN,
      buildRecordBody(
        feedbackRecord({
          repositoryId: REPOSITORY_ID,
          issueNumber: ISSUE_NUMBER,
          epoch: EPOCH,
          feedbackCommentId: oldChange.id,
          kind: 'change',
        }),
      ),
    );
    const invalidRecord = comment(
      6,
      GATE_LOGIN,
      buildRecordBody(
        feedbackRecord({
          repositoryId: REPOSITORY_ID,
          issueNumber: ISSUE_NUMBER,
          epoch: currentEpoch,
          feedbackCommentId: invalidChange.id,
          kind: 'change',
        }),
      ),
    );
    const comments = [epochComment(1), epochComment(2, currentEpoch), oldChange, invalidChange, oldRecord, invalidRecord];
    const view = readIssueRecords(comments, new Set([GATE_LOGIN]));
    expect(acceptedFeedbackEvents(view, comments, new Set([OWNER]), OWNER)).toEqual([]);
  });

  it('uses the same strict command parser for candidate feedback discovery', () => {
    const comments = [
      comment(1, OWNER, '/change one'),
      comment(2, OWNER, 'ordinary /change two'),
      comment(3, OWNER, '/change'),
      comment(4, OWNER, '/change first\nsecond'),
      comment(5, 'mallory', '/change not trusted'),
    ];
    expect(findHumanFeedbackCommands(comments, new Set([OWNER]), OWNER).map((e) => e.comment.id)).toEqual([1]);
  });

  it('uses the shared strict parser when validating an approval anchor', () => {
    const approvalCommand = comment(7, OWNER, '/approve 9');
    const record = approvalRecord({
      repositoryId: REPOSITORY_ID,
      issueNumber: ISSUE_NUMBER,
      epoch: EPOCH,
      planCommentId: 9,
      planSha256: 'a'.repeat(64),
      approvalCommandCommentId: approvalCommand.id,
    }) as ApprovalRecord;
    expect(approvalRecordAnchorFailure(record, [approvalCommand], new Set([OWNER]), OWNER)).toBeNull();

    expect(
      approvalRecordAnchorFailure(
        record,
        [comment(7, OWNER, '/approve 9\nextra')],
        new Set([OWNER]),
        OWNER,
      ),
    ).toMatch(/anchored/);
  });
});
