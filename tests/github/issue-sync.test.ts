import { describe, expect, it, vi } from 'vitest';
import type { CommentDetail, DriverGitHubClient, IssueRef } from '../../src/github/client';
import { buildTrackerCommentBody } from '../../src/github/comments';
import {
  acceptedFeedbackEvents,
  findCompletionReportComments,
  findHumanFeedbackCommands,
  findLatestPlanComment,
  findPlanComments,
  findTrackerComment,
  isKnownLogin,
  publishCompletionReport,
  publishPlanComment,
  publishTrackerComment,
  readIssueRecords,
  updateTracker,
} from '../../src/github/issue-sync';
import {
  approvalOperationId,
  buildRecordBody,
  epochOperationId,
  feedbackOperationId,
  type ApprovalRecord,
  type FeedbackAcceptedRecord,
  type WorkflowEpochRecord,
} from '../../src/protocol/records';
import { planSha256 } from '../../src/protocol/plan';

/*
 * Offline tests for the Driver's issue-sync use cases: marker-based comment
 * discovery, anchored human-command parsing, Gate-record reading (schema 2),
 * and protocol-comment publishing. The client is a plain vi.fn() fake shaped
 * like DriverGitHubClient — no real GitHub API is ever touched.
 */

const ref: IssueRef = { owner: 'owner-user', repo: 'demo', issueNumber: 2 };
const PLAN_MARKER = '<!-- ai-workflow:plan:v1 -->';
const TRACKER_MARKER = '<!-- ai-workflow:execution-tracker:v1 -->';
const COMPLETION_MARKER = '<!-- ai-workflow:completion-report:v1 -->';
// NOTE: schema-1-shaped ids on purpose. findDispatchIdInComment (src/github/
// comments.ts) still parses only the schema-1 id shape, and updateTracker
// refuses to rebuild bodies whose dispatch id it cannot re-extract. These
// constants exercise that parser, so they keep the shape it accepts.
const DISPATCH_01 = 'gf_r1_i2_consumer_01';
const DISPATCH_EXE = 'gf_r1_i2_executor_p5';
const dispatchComment = (id: string) => `<!-- gateflow:dispatch-id: ${id} -->`;
const TRUSTED = new Set(['alice', 'release-bot']);
const REPO_ID = 1;
const ISSUE_NUMBER = 2;
const GATE = 'github-actions[bot]';
const GATE_LOGINS = new Set(['github-actions[bot]']);
const EPOCH = 'wf_0000000000a1';
const OLD_EPOCH = 'wf_0000000000zz';
const PLAN_COMMENT_ID = 501;
const PLAN_CONTENT = '# Plan A\n\n1. step';
const PLAN_BODY = `${PLAN_MARKER}\n\n${dispatchComment(DISPATCH_01)}\n\n${PLAN_CONTENT}\n`;

function comment(id: number, user: string, body: string): CommentDetail {
  return {
    id,
    user,
    body,
    createdAt: '2026-09-06T10:00:00Z',
    updatedAt: '2026-09-06T10:00:00Z',
  };
}

function epochRecord(epoch: string = EPOCH, issuedBy: string = GATE): WorkflowEpochRecord {
  return {
    schema: 2,
    kind: 'workflow_epoch',
    repository_id: REPO_ID,
    issue_number: ISSUE_NUMBER,
    workflow_epoch: epoch,
    created_at: '2026-09-06T10:00:00Z',
    issued_by: issuedBy,
    operation_id: epochOperationId(REPO_ID, ISSUE_NUMBER, epoch),
  };
}

function approvalRecord(
  overrides: Partial<ApprovalRecord> & { workflow_epoch?: string; plan_comment_id?: number } = {},
): ApprovalRecord {
  const epoch = overrides.workflow_epoch ?? EPOCH;
  const planCommentId = overrides.plan_comment_id ?? PLAN_COMMENT_ID;
  const base: ApprovalRecord = {
    schema: 2,
    kind: 'approval',
    repository_id: REPO_ID,
    issue_number: ISSUE_NUMBER,
    workflow_epoch: epoch,
    plan_comment_id: planCommentId,
    plan_sha256: planSha256(PLAN_BODY),
    approval_command_comment_id: 600,
    approved_by_id: 9001,
    approved_by_login: 'alice',
    gate_login: GATE,
    gate_user_id: 41898282,
    created_at: '2026-09-06T10:00:00Z',
    operation_id: approvalOperationId(REPO_ID, ISSUE_NUMBER, epoch, planCommentId),
  };
  return { ...base, ...overrides };
}

function feedbackRecord(
  feedbackCommentId: number,
  kind: 'choose' | 'change' = 'change',
  epoch: string = EPOCH,
): FeedbackAcceptedRecord {
  return {
    schema: 2,
    kind: 'feedback_accepted',
    repository_id: REPO_ID,
    issue_number: ISSUE_NUMBER,
    workflow_epoch: epoch,
    event_id: `fe${feedbackCommentId}`,
    feedback_comment_id: feedbackCommentId,
    feedback_kind: kind,
    gate_login: GATE,
    gate_user_id: 41898282,
    created_at: '2026-09-06T10:00:00Z',
    operation_id: feedbackOperationId(REPO_ID, ISSUE_NUMBER, epoch, feedbackCommentId),
  };
}

/** A Gate-issued record comment (schema 2 marker + fenced JSON). */
function gateComment(id: number, record: WorkflowEpochRecord | ApprovalRecord | FeedbackAcceptedRecord): CommentDetail {
  return comment(id, GATE, buildRecordBody(record));
}

function fakeClient() {
  return {
    getRepository: vi.fn(async () => ({ owner: 'owner-user', name: 'demo', id: 1, ownerType: 'User' })),
    getAuthenticatedUser: vi.fn(async () => ({ id: 5001, login: 'gateflow-driver[bot]' })),
    getIssue: vi.fn(async (_r: IssueRef) => null),
    listComments: vi.fn(async (_r: IssueRef) => [] as CommentDetail[]),
    addIssueComment: vi.fn(async (_r: IssueRef, _body: string) => ({ id: 555 })),
    updateIssueComment: vi.fn(async (_r: IssueRef, _commentId: number, _body: string) => undefined),
    addReaction: vi.fn(async (_r: IssueRef, _commentId: number, _content: string) => undefined),
    // Schema 2 discovery entry point.
    listIssues: vi.fn(async (_r: { owner: string; repo: string; state?: string }) => []),
    createIssue: vi.fn(
      async (_r: IssueRef, _input: { title: string; body: string; labels: string[] }) => ({
        number: 42,
      }),
    ),
  };
}

function trackerBody(status: 'In Progress' | 'Blocked', progress: string): string {
  return buildTrackerCommentBody({
    dispatchId: DISPATCH_EXE,
    issueNumber: 2,
    status,
    progressMarkdown: progress,
  });
}

describe('plan comment discovery', () => {
  it('finds plan-marker comments and attaches dispatch ids; fenced / inline / duplicate markers never count', () => {
    const comments: CommentDetail[] = [
      comment(1, 'gateflow-agent[bot]', `${PLAN_MARKER}\n\n${dispatchComment(DISPATCH_01)}\n\n# Plan`),
      comment(2, 'gateflow-agent[bot]', '```\n' + PLAN_MARKER + '\n```\n'), // inside code fence
      comment(3, 'gateflow-agent[bot]', `text ${PLAN_MARKER} more`), // inline, not line-exclusive
      comment(4, 'gateflow-agent[bot]', `${PLAN_MARKER}\n${PLAN_MARKER}`), // multiple markers -> invalid
      comment(5, 'gateflow-agent[bot]', `${TRACKER_MARKER}\n\n${dispatchComment(DISPATCH_01)}`), // other marker
      comment(6, 'alice', '/change redo'), // human command
    ];

    const plans = findPlanComments(comments);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe(1);
    expect(plans[0]?.dispatchId).toBe(DISPATCH_01);
  });

  it('preserves comment order and tolerates a missing dispatch-id comment', () => {
    const comments: CommentDetail[] = [
      comment(1, 'bot', `${PLAN_MARKER}\n\nno dispatch id`),
      comment(2, 'bot', `${PLAN_MARKER}\n\n${dispatchComment('gf_r9_i1_consumer_02')}\n`),
      comment(3, 'bot', `${PLAN_MARKER}\n\n${dispatchComment('gf_r9_i1_consumer_03')}\n`),
    ];

    const plans = findPlanComments(comments);
    expect(plans.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(plans[0]?.dispatchId).toBeNull();
    expect(plans[1]?.dispatchId).toBe('gf_r9_i1_consumer_02');
  });

  it('findLatestPlanComment returns the LAST plan comment, or null when none', () => {
    const comments: CommentDetail[] = [
      comment(1, 'bot', `${PLAN_MARKER}\n\nfirst`),
      comment(2, 'alice', '/change tweak'),
      comment(3, 'bot', `${PLAN_MARKER}\n\nsecond (current)`),
    ];
    const latest = findLatestPlanComment(comments);
    expect(latest?.id).toBe(3);
    expect(findLatestPlanComment([comment(9, 'alice', '/approve 1')])).toBeNull();
    expect(findLatestPlanComment([])).toBeNull();
  });
});

describe('tracker and completion report discovery', () => {
  it('findTrackerComment matches the tracker marker AND the dispatch id', () => {
    const comments: CommentDetail[] = [
      comment(1, 'bot', `${PLAN_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}`),
      comment(2, 'bot', `${TRACKER_MARKER}\n\n${dispatchComment('gf_r1_i2_executor_p9')}`),
      comment(
        3,
        'bot',
        `${TRACKER_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}\n\n**Status:** In Progress`,
      ),
    ];
    expect(findTrackerComment(comments, DISPATCH_EXE)?.id).toBe(3);
    expect(findTrackerComment(comments, 'gf_r1_i2_executor_p404')).toBeNull();
  });

  it('findCompletionReportComments filters by marker and dispatch id', () => {
    const comments: CommentDetail[] = [
      comment(1, 'bot', `${COMPLETION_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}\n\nall green`),
      comment(2, 'bot', `${COMPLETION_MARKER}\n\n${dispatchComment('gf_r1_i2_executor_p9')}`),
      comment(3, 'bot', `${TRACKER_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}`),
    ];
    const reports = findCompletionReportComments(comments, DISPATCH_EXE);
    expect(reports.map((r) => r.id)).toEqual([1]);
  });
});

describe('human feedback command discovery', () => {
  it('accepts anchored /choose and /change from trusted humans and the repo owner', () => {
    const comments: CommentDetail[] = [
      comment(1, 'Alice', '/choose q1 B'), // login compare is case-insensitive
      comment(2, 'owner-user', '  /change use postgres instead  '), // repoOwner trusted; body trimmed
    ];
    const entries = findHumanFeedbackCommands(comments, TRUSTED, 'owner-user');
    expect(entries.map((e) => e.kind)).toEqual(['choose', 'change']);
    expect(entries[0]?.comment.id).toBe(1);
    expect(entries[1]?.comment.id).toBe(2);
  });

  it('rejects valid commands from unknown authors', () => {
    const comments: CommentDetail[] = [
      comment(1, 'mallory', '/change hijack'),
      comment(2, 'alice', '/change ok'),
    ];
    expect(
      findHumanFeedbackCommands(comments, TRUSTED, 'owner-user').map((e) => e.comment.id),
    ).toEqual([2]);
  });

  it('rejects multiline, trailing-content and malformed command bodies', () => {
    const comments: CommentDetail[] = [
      comment(1, 'alice', '/change fix it\nsecond line'), // multi-line: `.` never matches \n
      comment(2, 'alice', '/choose q1 B extra'), // trailing content
      comment(3, 'alice', '/choose q1'), // missing choice
      comment(4, 'alice', '/CHANGE all caps'), // case-sensitive
      comment(5, 'alice', 'text /change inline'), // not whole-body
      comment(6, 'alice', '/change   '), // no free text after trim
      comment(7, 'alice', '/choose'), // no args
    ];
    expect(findHumanFeedbackCommands(comments, TRUSTED, 'owner-user')).toEqual([]);
  });
});

describe('gate-issued record discovery (schema 2: readIssueRecords)', () => {
  it('parses epoch/approval/feedback records authored by a gate identity; current epoch = highest comment id', () => {
    const comments: CommentDetail[] = [
      gateComment(100, epochRecord(OLD_EPOCH)),
      gateComment(101, epochRecord()), // newest epoch record wins
      comment(200, 'alice', `${PLAN_MARKER}\n\nplan text`),
      comment(210, 'alice', '/approve 501'), // raw command: NOT a record
      gateComment(300, approvalRecord()),
      comment(310, 'alice', '/change use postgres'),
      gateComment(320, feedbackRecord(310, 'change')),
    ];

    const view = readIssueRecords(comments, GATE_LOGINS);

    expect(view.epoch).not.toBeNull();
    expect(view.epoch?.record.workflow_epoch).toBe(EPOCH);
    expect(view.epoch?.commentId).toBe(101);
    expect(view.approvals).toHaveLength(1);
    expect(view.approvals[0]?.commentId).toBe(300);
    expect(view.approvals[0]?.record.plan_comment_id).toBe(PLAN_COMMENT_ID);
    expect(view.approvals[0]?.record.plan_sha256).toBe(planSha256(PLAN_BODY));
    expect(view.feedback).toHaveLength(1);
    expect(view.feedback[0]?.record.feedback_comment_id).toBe(310);
    expect(view.suspect).toEqual([]);
  });

  it('a valid record body authored OUTSIDE the gate allowlist is excluded AND flagged suspect (forgery)', () => {
    const comments: CommentDetail[] = [
      gateComment(100, epochRecord()),
      gateComment(101, epochRecord(OLD_EPOCH)),
      comment(400, 'mallory', buildRecordBody(approvalRecord({ approved_by_login: 'mallory' }))),
      comment(401, 'gateflow-driver[bot]', buildRecordBody(feedbackRecord(402, 'change'))),
    ];

    const view = readIssueRecords(comments, GATE_LOGINS);

    expect(view.approvals).toEqual([]);
    expect(view.feedback).toEqual([]);
    const suspectIds = view.suspect.map((entry) => entry.commentId);
    expect(suspectIds).toEqual([400, 401]);
    expect(view.suspect[0]?.reason).toContain('mallory');
  });

  it('unparsable record bodies fail closed into suspect (bad JSON, wrong schema, bad timestamp)', () => {
    const brokenJson = `${'<!-- gateflow:approval:v2 -->'}\n\n\`\`\`json\n{ not json }\n\`\`\`\n`;
    const wrongSchema = buildRecordBody({
      ...approvalRecord(),
      schema: 1,
    } as unknown as ApprovalRecord);
    const badTimestamp = buildRecordBody({
      ...approvalRecord(),
      created_at: 'not-a-timestamp',
    } as unknown as ApprovalRecord);
    const comments: CommentDetail[] = [
      gateComment(100, epochRecord()),
      comment(410, GATE, brokenJson),
      comment(411, GATE, wrongSchema),
      comment(412, GATE, badTimestamp),
    ];

    const view = readIssueRecords(comments, GATE_LOGINS);

    expect(view.suspect.map((entry) => entry.commentId)).toEqual([410, 411, 412]);
  });

  it('acceptedFeedbackEvents counts only CURRENT-epoch records anchored to trusted-human commands', () => {
    const trustedHumans = new Set([...TRUSTED, 'owner-user']);
    const current = comment(310, 'alice', '/change use postgres');
    const foreignEpoch = comment(311, 'release-bot', '/choose q1 B');
    const editedAway = comment(312, 'alice', 'I changed my mind, plain text now');
    const impostor = comment(313, 'mallory', '/change hijack');
    const comments: CommentDetail[] = [
      gateComment(100, epochRecord()),
      current,
      foreignEpoch,
      editedAway,
      impostor,
      gateComment(320, feedbackRecord(310, 'change')),
      gateComment(321, feedbackRecord(311, 'choose', OLD_EPOCH)),
      gateComment(322, feedbackRecord(312, 'change')),
      gateComment(323, feedbackRecord(313, 'change')),
    ];

    const view = readIssueRecords(comments, GATE_LOGINS);
    // All records were authored by the trusted Gate identity, so none of them
    // is suspect. The impostor's command (313) never yields a valid accepted
    // event: the accepted projection re-checks the COMMAND author, and the
    // old-epoch record (321) is dropped by the epoch binding. (This also
    // models allowlist revocation: an event accepted while a human was
    // trusted stops counting once the human is removed — without poisoning
    // the whole issue as tampering.)
    expect(view.suspect).toEqual([]);
    const accepted = acceptedFeedbackEvents(view, comments, trustedHumans, 'owner-user');
    expect(accepted.map((entry) => entry.comment.id)).toEqual([310]);
    expect(accepted[0]?.kind).toBe('change');
  });

  it('isKnownLogin is case-insensitive against the allowlist', () => {
    const allowlist = new Set(['github-actions[bot]']);
    expect(isKnownLogin('GitHub-Actions[BOT]', allowlist)).toBe(true);
    expect(isKnownLogin('github-actions[bot]', allowlist)).toBe(true);
    expect(isKnownLogin('impostor', allowlist)).toBe(false);
  });
});

describe('publishing use cases', () => {
  it('publishPlanComment posts the assembled plan body and returns the comment id', async () => {
    const client = fakeClient();
    const result = await publishPlanComment(client, ref, '# Plan\n', DISPATCH_01);

    expect(result).toEqual({ id: 555 });
    expect(client.addIssueComment).toHaveBeenCalledTimes(1);
    const body = client.addIssueComment.mock.calls[0]?.[1] ?? '';
    expect(body.startsWith(`${PLAN_MARKER}\n\n${dispatchComment(DISPATCH_01)}\n\n# Plan\n`)).toBe(
      true,
    );
  });

  it('publishTrackerComment always creates the tracker as In Progress', async () => {
    const client = fakeClient();
    await publishTrackerComment(client, ref, {
      dispatchId: DISPATCH_EXE,
      issueNumber: 2,
      progressMarkdown: 'starting up',
    });

    const body = client.addIssueComment.mock.calls[0]?.[1] ?? '';
    expect(body.startsWith(`${TRACKER_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}\n\n**Status:** In Progress\n\nstarting up\n`)).toBe(true);
  });

  it('publishCompletionReport posts the assembled report body and returns the comment id', async () => {
    const client = fakeClient();
    const result = await publishCompletionReport(client, ref, 'all green', DISPATCH_EXE);

    expect(result).toEqual({ id: 555 });
    const body = client.addIssueComment.mock.calls[0]?.[1] ?? '';
    expect(body.startsWith(`${COMPLETION_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}\n\nall green\n`)).toBe(true);
  });
});

describe('updateTracker', () => {
  it('flips the status, keeps marker / dispatch-id intact, and carries over existing progress', async () => {
    const client = fakeClient();
    const current = trackerBody('In Progress', 'step 1 done\nstep 2 running');

    await updateTracker(client, ref, 777, current, { status: 'Blocked' });

    expect(client.updateIssueComment).toHaveBeenCalledTimes(1);
    const call = client.updateIssueComment.mock.calls[0];
    expect(call?.[0]).toEqual(ref);
    expect(call?.[1]).toBe(777);
    const body = call?.[2] ?? '';
    expect(
      body.startsWith(
        `${TRACKER_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}\n\n**Status:** Blocked\n\n`,
      ),
    ).toBe(true);
    expect(body).toContain('step 1 done');
    expect(body).toContain('step 2 running');
    expect(body.endsWith('step 1 done\nstep 2 running\n')).toBe(true);
  });

  it('applies a progress-only change while preserving the current Blocked status', async () => {
    const client = fakeClient();
    const current = trackerBody('Blocked', 'old progress');

    await updateTracker(client, ref, 777, current, { progressMarkdown: 'new progress' });

    const body = client.updateIssueComment.mock.calls[0]?.[2] ?? '';
    expect(body).toContain('**Status:** Blocked');
    expect(body).toContain('new progress');
    expect(body).not.toContain('old progress');
  });

  it('applies status and progress changes together', async () => {
    const client = fakeClient();
    const current = trackerBody('In Progress', 'old');

    await updateTracker(client, ref, 777, current, {
      status: 'Blocked',
      progressMarkdown: 'waiting for credentials',
    });

    const body = client.updateIssueComment.mock.calls[0]?.[2] ?? '';
    expect(body).toContain('**Status:** Blocked');
    expect(body).toContain('waiting for credentials');
    expect(body).not.toContain('old');
  });

  it('extracts the progress tail from the current body when progressMarkdown is omitted', async () => {
    const client = fakeClient();
    const current = trackerBody('In Progress', 'alpha\n\nbeta\n');

    await updateTracker(client, ref, 777, current, {});

    const body = client.updateIssueComment.mock.calls[0]?.[2] ?? '';
    expect(body).toContain('**Status:** In Progress'); // current status preserved
    expect(body.endsWith('alpha\n\nbeta\n')).toBe(true);
  });

  it('defaults to In Progress with empty progress when the body has no outside-fence status line', async () => {
    const client = fakeClient();
    const current = `${TRACKER_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}\n\n\`\`\`\n**Status:** Blocked\n\`\`\`\n`;

    await updateTracker(client, ref, 777, current, {});

    const body = client.updateIssueComment.mock.calls[0]?.[2] ?? '';
    expect(body).toContain('**Status:** In Progress');
    expect(body).not.toContain('Blocked'); // deterministic rebuild drops the fenced tail
    expect(
      body.startsWith(
        `${TRACKER_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}\n\n**Status:** In Progress\n`,
      ),
    ).toBe(true);
  });

  it('refuses to rebuild a body that lost its dispatch-id comment', async () => {
    const client = fakeClient();
    await expect(
      updateTracker(client, ref, 777, `${TRACKER_MARKER}\n\n**Status:** Blocked`, {
        status: 'In Progress',
      }),
    ).rejects.toThrow(/dispatch-id/);
    expect(client.updateIssueComment).not.toHaveBeenCalled();
  });
});
