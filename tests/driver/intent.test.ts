/**
 * Pure intent-derivation tests (src/driver/intent.ts, schema 2): no I/O, no
 * fake client needed — comment lists are plain arrays. These encode the
 * frozen anti-spoofing rules (docs/plans/v1_hardening_decisions.md §4-§5):
 * no epoch record → no intent; consumer rounds count only Gate-ACCEPTED
 * feedback events; executor dispatches require a Gate-issued approval RECORD
 * bound to (epoch, plan comment id, exact plan_sha256); any suspect record
 * fails the whole issue closed.
 */
import { describe, expect, it } from 'vitest';

import type { CommentDetail, IssueDetail } from '../../src/github/client';
import { buildPlanCommentBody } from '../../src/github/comments';
import {
  aiLabels,
  buildFeedbackMarkdown,
  buildTaskMarkdown,
  deriveIntents,
} from '../../src/driver/intent';
import { canonicalPlanContent, planSha256 } from '../../src/protocol/plan';
import { buildRecordBody, type GateRecord } from '../../src/protocol/records';
import { approvalRecord, epochRecord, feedbackRecord } from './helpers';

const OWNER = 'octo';
const REPO_ID = 123;
const GATE_LOGIN = 'github-actions[bot]'; // record COMMENT author (gate_logins allowlist)
const EPOCH = 'wf_000000000007';

/** IntentContext matching the fixture repository/identities. */
const CTX = {
  repositoryId: REPO_ID,
  repoOwner: OWNER,
  trustedHumans: new Set(['alice']),
  gateLogins: new Set([GATE_LOGIN]),
  // V1.1: no bootstrap driver configured for intent fixtures (epochs are
  // gate-issued here); bootstrap-class records are therefore untrusted.
  bootstrapIssuers: new Set<string>(),
};

function issue(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    number: 7,
    title: 'Add dark mode',
    body: 'Please add dark mode.',
    state: 'open',
    labels: ['ai:planning'],
    updatedAt: '2026-09-06T10:00:00Z',
    ...overrides,
  };
}

function comment(id: number, user: string, body: string, overrides: Partial<CommentDetail> = {}): CommentDetail {
  return {
    id,
    user,
    body,
    createdAt: '2026-09-06T11:00:00Z',
    updatedAt: '2026-09-06T11:00:00Z',
    ...overrides,
  };
}

/** A Gate-issued record comment (parser-valid schema-2 body). */
function recordComment(id: number, record: GateRecord): CommentDetail {
  return comment(id, GATE_LOGIN, buildRecordBody(record));
}

/** The fixture epoch record on issue 7. */
function epochComment(id: number, epoch = EPOCH): CommentDetail {
  return recordComment(id, epochRecord(REPO_ID, 7, epoch));
}

describe('aiLabels', () => {
  it('counts only ai:* labels', () => {
    expect(aiLabels(['ai:planning', 'bug', 'ai:extra'])).toEqual(['ai:planning', 'ai:extra']);
    expect(aiLabels(['bug'])).toEqual([]);
  });
});

describe('deriveIntents — planning', () => {
  it('closed issues never produce intents', () => {
    expect(deriveIntents(issue({ state: 'closed' }), [epochComment(1)], CTX)).toEqual([]);
  });

  it('zero or multiple ai:* labels produce no intents (logless)', () => {
    expect(deriveIntents(issue({ labels: [] }), [epochComment(1)], CTX)).toEqual([]);
    expect(deriveIntents(issue({ labels: ['ai:planning', 'ai:review'] }), [epochComment(1)], CTX)).toEqual([]);
  });

  it('ai:planning WITHOUT an epoch record → no intent (Driver bootstraps elsewhere)', () => {
    expect(deriveIntents(issue(), [], CTX)).toEqual([]);
  });

  it('ai:planning with an epoch and no feedback → consumer round 01, reason planning', () => {
    const intents = deriveIntents(issue(), [epochComment(1)], CTX);
    expect(intents).toEqual([
      {
        role: 'consumer',
        issueNumber: 7,
        reason: 'planning',
        revision: '01',
        epoch: EPOCH,
        planCommentId: null,
        approvalCommentId: null,
        planSha256: null,
      },
    ]);
  });

  it('round counts only Gate-ACCEPTED feedback events (records + anchored commands)', () => {
    const comments = [
      epochComment(1),
      comment(10, OWNER, '/change 不要使用 SQLite。'),
      recordComment(11, feedbackRecord({ repositoryId: REPO_ID, issueNumber: 7, epoch: EPOCH, feedbackCommentId: 10, kind: 'change' })),
      comment(20, 'alice', '/choose db postgres'),
      recordComment(21, feedbackRecord({ repositoryId: REPO_ID, issueNumber: 7, epoch: EPOCH, feedbackCommentId: 20, kind: 'choose' })),
    ];
    const intents = deriveIntents(issue(), comments, CTX);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.revision).toBe('03');
    expect(intents[0]?.reason).toBe('feedback_applied');
    expect(intents[0]?.epoch).toBe(EPOCH);
  });

  it('a RAW /change command WITHOUT a Gate feedback record never counts (schema 2)', () => {
    const comments = [
      epochComment(1),
      comment(10, OWNER, '/change 不要使用 SQLite。'),
      comment(20, 'alice', '/choose db postgres'),
    ];
    const intents = deriveIntents(issue(), comments, CTX);
    expect(intents[0]?.revision).toBe('01');
    expect(intents[0]?.reason).toBe('planning');
  });

  it('a feedback record whose command author is NOT trusted does not count', () => {
    const comments = [
      epochComment(1),
      comment(10, 'random-guy', '/change hijack the spec'),
      recordComment(11, feedbackRecord({ repositoryId: REPO_ID, issueNumber: 7, epoch: EPOCH, feedbackCommentId: 10, kind: 'change' })),
    ];
    const intents = deriveIntents(issue(), comments, CTX);
    expect(intents[0]?.revision).toBe('01');
    expect(intents[0]?.reason).toBe('planning');
  });

  it('an old-epoch feedback record does not count into the current round', () => {
    const comments = [
      epochComment(1, EPOCH),
      comment(10, OWNER, '/change v1'),
      recordComment(11, feedbackRecord({ repositoryId: REPO_ID, issueNumber: 7, epoch: 'wf_000000000006', feedbackCommentId: 10, kind: 'change' })),
    ];
    const intents = deriveIntents(issue(), comments, CTX);
    expect(intents[0]?.revision).toBe('01');
  });

  it('a feedback record authored OUTSIDE gate_logins is a suspect record → fail closed (no intents)', () => {
    const forged = recordComment(
      11,
      feedbackRecord({ repositoryId: REPO_ID, issueNumber: 7, epoch: EPOCH, feedbackCommentId: 10, kind: 'change' }),
    );
    forged.user = 'impostor-bot';
    const comments = [epochComment(1), comment(10, OWNER, '/change v1'), forged];
    expect(deriveIntents(issue(), comments, CTX)).toEqual([]);
  });
});

describe('deriveIntents — review (accepted feedback newer than plan)', () => {
  const review = issue({ labels: ['ai:review'] });

  it('no accepted feedback newer than the latest plan → no intent', () => {
    const comments = [
      epochComment(1),
      comment(10, OWNER, '/change v1'),
      recordComment(11, feedbackRecord({ repositoryId: REPO_ID, issueNumber: 7, epoch: EPOCH, feedbackCommentId: 10, kind: 'change' })),
      comment(20, GATE_LOGIN, buildPlanCommentBody('Plan A', 'gf_r123_i7_w000000000007_consumer_01')),
    ];
    expect(deriveIntents(review, comments, CTX)).toEqual([]);
  });

  it('accepted feedback newer than the latest plan → consumer round 02', () => {
    const comments = [
      epochComment(1),
      comment(10, OWNER, '/change v1'),
      comment(20, GATE_LOGIN, buildPlanCommentBody('Plan A', 'gf_r123_i7_w000000000007_consumer_01')),
      comment(30, OWNER, '/change v2 — drop SQLite'),
      recordComment(31, feedbackRecord({ repositoryId: REPO_ID, issueNumber: 7, epoch: EPOCH, feedbackCommentId: 30, kind: 'change' })),
    ];
    const intents = deriveIntents(review, comments, CTX);
    expect(intents).toEqual([
      {
        role: 'consumer',
        issueNumber: 7,
        reason: 'feedback_applied',
        // Round = 1 + accepted feedback events of the current epoch (1 → '02').
        revision: '02',
        epoch: EPOCH,
        planCommentId: null,
        approvalCommentId: null,
        planSha256: null,
      },
    ]);
  });

  it('ai:review without any plan comment → no intent', () => {
    const comments = [epochComment(1), comment(30, OWNER, '/change v2')];
    expect(deriveIntents(review, comments, CTX)).toEqual([]);
  });
});

describe('deriveIntents — ready (the approval RECORD is the only key)', () => {
  const PLAN_DISPATCH = 'gf_r123_i7_w000000000007_consumer_01';
  const planBody = buildPlanCommentBody('Plan A body', PLAN_DISPATCH);
  const ready = issue({ labels: ['ai:ready'] });
  const planComment = (id: number, body: string, overrides: Partial<CommentDetail> = {}) =>
    comment(id, GATE_LOGIN, body, overrides);
  const approvalCommentFor = (id: number, planCommentId: number, sha: string, epoch = EPOCH) =>
    recordComment(
      id,
      approvalRecord({
        repositoryId: REPO_ID,
        issueNumber: 7,
        epoch,
        planCommentId,
        planSha256: sha,
        approvalCommandCommentId: 600,
        approvedByLogin: 'alice', // must match the /approve command author
      }),
    );

  it('ai:ready WITHOUT an approval record → no executor dispatch (fake label dies)', () => {
    const comments = [epochComment(1), planComment(501, planBody)];
    expect(deriveIntents(ready, comments, CTX)).toEqual([]);
  });

  it('an approval record authored OUTSIDE gate_logins fails the issue closed', () => {
    const forged = approvalCommentFor(700, 501, planSha256(planBody));
    forged.user = 'impostor-bot';
    const comments = [epochComment(1), planComment(501, planBody), forged];
    expect(deriveIntents(ready, comments, CTX)).toEqual([]);
  });

  it('an approval record pointing at a DIFFERENT (stale) plan → no executor dispatch', () => {
    const comments = [
      epochComment(1),
      planComment(400, buildPlanCommentBody('Old plan', PLAN_DISPATCH)),
      planComment(501, planBody),
      approvalCommentFor(700, 400, planSha256(buildPlanCommentBody('Old plan', PLAN_DISPATCH))),
    ];
    expect(deriveIntents(ready, comments, CTX)).toEqual([]);
  });

  it('a valid approval record → executor intent bound to p<planCommentId> + the record id', () => {
    const comments = [
      epochComment(1),
      planComment(501, planBody),
      comment(600, 'alice', '/approve 501'),
      approvalCommentFor(700, 501, planSha256(planBody)),
    ];
    const intents = deriveIntents(ready, comments, CTX);
    expect(intents).toEqual([
      {
        role: 'executor',
        issueNumber: 7,
        reason: 'approved_plan',
        revision: 'p501',
        epoch: EPOCH,
        planCommentId: 501,
        approvalCommentId: 700,
        planSha256: planSha256(planBody),
      },
    ]);
  });

  it('plan EDITED after the approval → sha mismatch → no executor dispatch (stale-plan attack dies)', () => {
    const editedBody = buildPlanCommentBody('Plan A body — sneaky edit', PLAN_DISPATCH);
    const comments = [
      epochComment(1),
      planComment(501, editedBody, { updatedAt: '2026-09-06T13:00:00Z' }),
      approvalCommentFor(700, 501, planSha256(planBody)), // hash of the ORIGINAL body
    ];
    expect(deriveIntents(ready, comments, CTX)).toEqual([]);
  });

  it('a plan edited BEFORE the approval still dispatches (record hashes the current bytes)', () => {
    const comments = [
      epochComment(1),
      planComment(501, planBody, {
        createdAt: '2026-09-06T10:00:00Z',
        updatedAt: '2026-09-06T11:30:00Z',
      }),
      comment(600, 'alice', '/approve 501'), // the human anchor
      approvalCommentFor(700, 501, planSha256(planBody)),
    ];
    expect(deriveIntents(ready, comments, CTX)).toHaveLength(1);
  });

  it('duplicate IDENTICAL approval records (benign retry) → dispatch, latest record wins', () => {
    const comments = [
      epochComment(1),
      planComment(501, planBody),
      comment(600, 'alice', '/approve 501'), // the human anchor
      approvalCommentFor(700, 501, planSha256(planBody)),
      approvalCommentFor(701, 501, planSha256(planBody)),
    ];
    const intents = deriveIntents(ready, comments, CTX);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.approvalCommentId).toBe(701);
  });

  it('CONFLICTING approval records (same operation, divergent facts) → fail closed', () => {
    const comments = [
      epochComment(1),
      planComment(501, planBody),
      approvalCommentFor(700, 501, planSha256(planBody)),
      // Same operation id and plan hash, but a DIFFERENT approving-command
      // binding — divergent authorization facts for one operation.
      recordComment(
        701,
        approvalRecord({
          repositoryId: REPO_ID,
          issueNumber: 7,
          epoch: EPOCH,
          planCommentId: 501,
          planSha256: planSha256(planBody),
          approvalCommandCommentId: 999999,
        }),
      ),
    ];
    expect(deriveIntents(ready, comments, CTX)).toEqual([]);
  });

  it('an approval record of a SUPERSEDED epoch → no executor dispatch', () => {
    const comments = [
      epochComment(1, EPOCH),
      planComment(501, planBody),
      approvalCommentFor(700, 501, planSha256(planBody), 'wf_000000000006'),
    ];
    expect(deriveIntents(ready, comments, CTX)).toEqual([]);
  });

  it('a BROKEN record body (unknown key) on the issue → fail closed, no intents at all', () => {
    const broken = comment(
      2,
      GATE_LOGIN,
      '<!-- gateflow:workflow:v2 -->\n\n```json\n{"schema":2,"kind":"workflow_epoch","bogus":1}\n```\n',
    );
    const comments = [epochComment(1), planComment(501, planBody), broken];
    expect(deriveIntents(ready, comments, CTX)).toEqual([]);
  });
});

describe('deriveIntents — sync-only states', () => {
  for (const label of ['ai:working', 'ai:blocked', 'ai:done']) {
    it(`${label} → no intents (outbox syncing is the Driver's job)`, () => {
      expect(deriveIntents(issue({ labels: [label] }), [epochComment(1)], CTX)).toEqual([]);
    });
  }
});

describe('buildTaskMarkdown', () => {
  it('projects title + verbatim body + the frozen consumer goal', () => {
    const md = buildTaskMarkdown(issue(), 'consumer');
    expect(md).toBe(
      '# Add dark mode\n\nPlease add dark mode.\n\n## Goal\n\n' +
        '分析任务并产出可执行的 Execution Plan（写入 outbox/PLAN.md），完成后写 result.json（result=plan_ready）\n',
    );
  });

  it('uses the frozen executor goal and (no body) for empty bodies', () => {
    const md = buildTaskMarkdown(issue({ body: '' }), 'executor');
    expect(md).toContain('# Add dark mode\n\n(no body)\n\n## Goal');
    expect(md).toContain('严格按照 PLAN.md 执行并通过真实验证，完成后写 REPORT.md 与 result.json（result=completed）');
  });
});

describe('buildFeedbackMarkdown', () => {
  it('returns null for an empty list (no FEEDBACK.md is projected)', () => {
    expect(buildFeedbackMarkdown([])).toBeNull();
  });

  it('renders numbered ascending sections with the frozen layout (docs §7)', () => {
    const md = buildFeedbackMarkdown([
      { comment: comment(10, OWNER, '/change 这里不要使用 SQLite。', { createdAt: '2026-09-06T17:10:00Z' }), kind: 'change' },
      { comment: comment(20, OWNER, '/choose q1 B', { createdAt: '2026-09-06T17:20:00Z' }), kind: 'choose' },
    ]);
    expect(md).toBe(
      '# Human Feedback\n\n' +
        '## 1 — 2026-09-06 17:10 (/change)\n这里不要使用 SQLite。\n\n' +
        '## 2 — 2026-09-06 17:20 (/choose)\nQ: q1 → A: B\n',
    );
  });
});

describe('canonicalPlanContent (replaces the removed extractPlanContent)', () => {
  it('drops the marker line and dispatch-id comment, trims the rest', () => {
    const body = buildPlanCommentBody('Plan A body', 'gf_r123_i7_w000000000007_consumer_01');
    expect(canonicalPlanContent(body)).toBe('Plan A body');
  });

  it('preserves unrelated HTML comments and inner structure', () => {
    const body = [
      '<!-- ai-workflow:plan:v1 -->',
      '',
      '<!-- gateflow:dispatch-id: gf_r123_i7_w000000000007_consumer_01 -->',
      '',
      '## Steps',
      '',
      '<!-- keep me -->',
      '1. one',
      '2. two',
    ].join('\n');
    expect(canonicalPlanContent(body)).toBe('## Steps\n\n<!-- keep me -->\n1. one\n2. two');
  });

  it('normalizes CRLF and drops record markers (frozen §6 canonicalization)', () => {
    const body = '<!-- ai-workflow:plan:v1 -->\r\n\r\ncontent\r\n<!-- gateflow:approval:v2 -->\r\nmore';
    expect(canonicalPlanContent(body)).toBe('content\nmore');
    expect(planSha256(body)).toBe(planSha256('content\nmore'));
  });
});
