/**
 * Intent derivation (pure): the five workflow states → zero or one task
 * intent, gated by Gate-issued records. This is where fake approvals die.
 */
import { describe, expect, it } from 'vitest';

import { deriveIntents, aiLabels, buildTaskMarkdown, buildFeedbackMarkdown } from '../../src/driver/intent';
import type { IntentContext } from '../../src/driver/intent';
import type { CommentDetail, IssueDetail } from '../../src/github/client';
import { planSha256 } from '../../src/protocol/plan';
import { buildRecordBody, parseRecord } from '../../src/protocol/records';
import {
  approvalRecord,
  epochRecord,
  feedbackRecord,
  planCommentBody,
  testEpoch,
  OWNER,
} from './helpers';

const REPO_ID = 123;
const ISSUE_N = 7;
const EPOCH = testEpoch(ISSUE_N);

function ctx(): IntentContext {
  return {
    repositoryId: REPO_ID,
    repoOwner: OWNER,
    trustedHumans: new Set([OWNER]),
    gateLogins: new Set(['github-actions[bot]']),
  };
}

function issue(labels: string[], overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    number: ISSUE_N,
    title: 'Task',
    body: 'Body',
    state: 'open',
    labels,
    updatedAt: '2026-09-06T10:00:00Z',
    ...overrides,
  };
}

let seq = 0;
function comment(user: string, body: string): CommentDetail {
  seq += 1;
  return { id: 5000 + seq, user, body, createdAt: '2026-09-06T11:00:00Z', updatedAt: '2026-09-06T11:00:00Z' };
}

describe('aiLabels', () => {
  it('filters ai:* labels', () => {
    expect(aiLabels(['ai:planning', 'bug', 'ai:done'])).toEqual(['ai:planning', 'ai:done']);
  });
});

describe('deriveIntents', () => {
  it('ai:planning with an epoch record → plan task round 01', () => {
    const comments = [comment('github-actions[bot]', epochComment().body)];
    const intents = deriveIntents(issue(['ai:planning']), comments, ctx());
    expect(intents).toEqual([
      {
        mode: 'plan',
        issueNumber: ISSUE_N,
        reason: 'planning',
        revision: '01',
        epoch: EPOCH,
        planCommentId: null,
        approvalCommentId: null,
        planSha256: null,
      },
    ]);
  });

  it('no epoch record → no intent (fail closed)', () => {
    expect(deriveIntents(issue(['ai:planning']), [], ctx())).toEqual([]);
  });

  it('a suspect (untrusted-author) record freezes the whole issue', () => {
    const comments = [
      comment('github-actions[bot]', epochComment().body),
      comment('spoofer', epochComment().body), // forged epoch record
    ];
    expect(deriveIntents(issue(['ai:ready']), comments, ctx())).toEqual([]);
  });

  it('ai:review → plan task only when accepted feedback is newer than the plan', () => {
    const plan = comment('gateflow-driver[bot]', planCommentBody('# Plan', 'gf_r123_i7_w' + EPOCH.slice(3) + '_plan_01'));
    const noFeedback = deriveIntents(issue(['ai:review']), [epochComment(), plan], ctx());
    expect(noFeedback).toEqual([]);

    const change = comment(OWNER, '/change 请精简状态');
    const record = feedbackRecordComment(change.id);
    const withFeedback = deriveIntents(issue(['ai:review']), [epochComment(), plan, change, record], ctx());
    expect(withFeedback).toHaveLength(1);
    expect(withFeedback[0]).toMatchObject({ mode: 'plan', reason: 'feedback_applied', revision: '02' });
  });

  it('ai:ready → execute task ONLY with a valid approval record bound to the exact plan bytes', () => {
    const planBodyText = '# Execution Plan\n\nStep 1.';
    const taskId = `gf_r123_i7_w${EPOCH.slice(3)}_plan_01`;
    const plan = comment('gateflow-driver[bot]', planCommentBody(planBodyText, taskId));
    const approve = comment(OWNER, `/approve ${plan.id}`);
    const approval = comment(
      'github-actions[bot]',
      buildRecordBody(
        approvalRecord({
          repositoryId: REPO_ID,
          issueNumber: ISSUE_N,
          epoch: EPOCH,
          planCommentId: plan.id,
          planSha256: planSha256(planCommentBody(planBodyText, taskId)),
          approvalCommandCommentId: approve.id,
        }),
      ),
    );
    const intents = deriveIntents(issue(['ai:ready']), [epochComment(), plan, approve, approval], ctx());
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      mode: 'execute',
      reason: 'approved_plan',
      revision: `p${plan.id}`,
      planCommentId: plan.id,
      approvalCommentId: approval.id,
    });

    // A plan edited after approval → hash mismatch → no intent.
    const editedPlan = comment('gateflow-driver[bot]', planCommentBody(planBodyText + '\nEdited.', taskId));
    expect(
      deriveIntents(issue(['ai:ready']), [epochComment(), editedPlan, approve, approval], ctx()),
    ).toEqual([]);
  });

  it('a fake /approve comment alone authorizes nothing', () => {
    const taskId = `gf_r123_i7_w${EPOCH.slice(3)}_plan_01`;
    const plan = comment('gateflow-driver[bot]', planCommentBody('# P', taskId));
    comment(OWNER, `/approve ${plan.id}`); // command WITHOUT a Gate record
    expect(deriveIntents(issue(['ai:ready']), [epochComment(), plan], ctx())).toEqual([]);
  });

  it('sync-only states produce no intents', () => {
    const comments = [comment('github-actions[bot]', epochComment().body)];
    for (const label of ['ai:working', 'ai:blocked', 'ai:done']) {
      expect(deriveIntents(issue([label]), comments, ctx())).toEqual([]);
    }
  });

  it('0 or >1 ai: labels and closed issues produce no intents', () => {
    const comments = [comment('github-actions[bot]', epochComment().body)];
    expect(deriveIntents(issue([]), comments, ctx())).toEqual([]);
    expect(deriveIntents(issue(['ai:planning', 'ai:done']), comments, ctx())).toEqual([]);
    expect(deriveIntents(issue(['ai:ready'], { state: 'closed' }), comments, ctx())).toEqual([]);
  });
});

describe('task.md / feedback.md builders', () => {
  it('task.md names the mode and the goal', () => {
    const plan = buildTaskMarkdown(issue(['ai:planning']), 'plan');
    expect(plan).toContain('## Mode');
    expect(plan).toContain('plan');
    const exec = buildTaskMarkdown(issue(['ai:ready']), 'execute');
    expect(exec).toContain('execute');
    expect(exec).toContain('plan.md');
  });

  it('feedback.md renders /change entries as numbered sections', () => {
    expect(buildFeedbackMarkdown([])).toBeNull();
    const entry = {
      comment: comment(OWNER, '/change 换成方案 B'),
      kind: 'change' as const,
    };
    const md = buildFeedbackMarkdown([entry]) ?? '';
    expect(md).toContain('# Human Feedback');
    expect(md).toContain('## 1');
    expect(md).toContain('换成方案 B');
  });
});

/* ---------- record comment helpers (marker + fenced JSON via records.ts) ---------- */

function epochComment(): CommentDetail {
  return comment(
    'github-actions[bot]',
    buildRecordBody(epochRecord(REPO_ID, ISSUE_N, EPOCH)),
  );
}

function feedbackRecordComment(feedbackCommentId: number): CommentDetail {
  return comment(
    'github-actions[bot]',
    buildRecordBody(feedbackRecord({ repositoryId: REPO_ID, issueNumber: ISSUE_N, epoch: EPOCH, feedbackCommentId, kind: 'change' })),
  );
}

describe('fixtures', () => {
  it('record builders produce parseable record comments', () => {
    const parsed = parseRecord(1, epochComment().body);
    expect(parsed.ok).toBe(true);
  });
});
