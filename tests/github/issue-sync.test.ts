import { describe, expect, it, vi } from 'vitest';
import type { CommentDetail, DriverGitHubClient, IssueRef } from '../../src/github/client';
import { buildTrackerCommentBody } from '../../src/github/comments';
import {
  findApprovalRecords,
  findCompletionReportComments,
  findHumanFeedbackCommands,
  findLatestPlanComment,
  findPlanComments,
  findTrackerComment,
  publishCompletionReport,
  publishPlanComment,
  publishTrackerComment,
  updateTracker,
} from '../../src/github/issue-sync';

/*
 * Offline tests for the Driver's issue-sync use cases: marker-based comment
 * discovery, anchored human-command parsing, and protocol-comment
 * publishing. The client is a plain vi.fn() fake shaped like
 * DriverGitHubClient — no real GitHub API is ever touched.
 */

const ref: IssueRef = { owner: 'owner-user', repo: 'demo', issueNumber: 2 };
const PLAN_MARKER = '<!-- ai-workflow:plan:v1 -->';
const TRACKER_MARKER = '<!-- ai-workflow:execution-tracker:v1 -->';
const COMPLETION_MARKER = '<!-- ai-workflow:completion-report:v1 -->';
const DISPATCH_01 = 'gf_r1_i2_consumer_01';
const DISPATCH_EXE = 'gf_r1_i2_executor_p5';
const dispatchComment = (id: string) => `<!-- gateflow:dispatch-id: ${id} -->`;
const TRUSTED = new Set(['alice', 'release-bot']);

function comment(id: number, user: string, body: string): CommentDetail {
  return {
    id,
    user,
    body,
    createdAt: '2026-09-06T10:00:00Z',
    updatedAt: '2026-09-06T10:00:00Z',
  };
}

function fakeClient() {
  return {
    getRepository: vi.fn(async () => ({ owner: 'owner-user', name: 'demo', id: 1 })),
    getIssue: vi.fn(async (_r: IssueRef) => null),
    listComments: vi.fn(async (_r: IssueRef) => [] as CommentDetail[]),
    addIssueComment: vi.fn(async (_r: IssueRef, _body: string) => ({ id: 555 })),
    updateIssueComment: vi.fn(async (_r: IssueRef, _commentId: number, _body: string) => undefined),
    addReaction: vi.fn(async (_r: IssueRef, _commentId: number, _content: string) => undefined),
    // Stub added when the Driver interface grew listOpenIssues; unused here.
    listOpenIssues: vi.fn(async (_r: { owner: string; repo: string }) => []),
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

describe('approval record discovery', () => {
  it('parses anchored /approve <plan-comment-id> from trusted humans and the repo owner', () => {
    const comments: CommentDetail[] = [
      comment(10, 'Alice', '/approve 3472198451'),
      comment(11, 'owner-user', '  /approve 42  '), // surrounding whitespace tolerated
    ];
    const records = findApprovalRecords(comments, TRUSTED, 'owner-user');
    expect(records.map((r) => r.planCommentId)).toEqual([3472198451, 42]);
    expect(records[0]?.comment.id).toBe(10);
    expect(records[1]?.comment.id).toBe(11);
  });

  it('rejects /approve from unknown authors and malformed bodies', () => {
    const comments: CommentDetail[] = [
      comment(1, 'mallory', '/approve 3472198451'), // untrusted author
      comment(2, 'alice', '/approve abc'), // not a number
      comment(3, 'alice', '/approve 42 done'), // trailing content
      comment(4, 'alice', '/approve'), // missing id
      comment(5, 'alice', 'please /approve 42'), // not whole-body
      comment(6, 'alice', '/Approve 42'), // case-sensitive
    ];
    expect(findApprovalRecords(comments, TRUSTED, 'owner-user')).toEqual([]);
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
