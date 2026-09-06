/**
 * Pure intent-derivation tests (src/driver/intent.ts): no I/O, no fake
 * client needed — comment lists are plain arrays. These encode the frozen
 * anti-spoofing rules from docs/architecture-v1.md §3.3 (fake ai:ready
 * labels, stale plans and untrusted approvals must never produce intents).
 */
import { describe, expect, it } from 'vitest';

import type { CommentDetail, IssueDetail } from '../../src/github/client';
import { buildPlanCommentBody } from '../../src/github/comments';
import {
  aiLabels,
  buildFeedbackMarkdown,
  buildTaskMarkdown,
  deriveIntents,
  extractPlanContent,
} from '../../src/driver/intent';

const OWNER = 'octo';
const TRUSTED = new Set(['alice']);

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


describe('aiLabels', () => {
  it('counts only ai:* labels', () => {
    expect(aiLabels(['ai:planning', 'bug', 'ai:extra'])).toEqual(['ai:planning', 'ai:extra']);
    expect(aiLabels(['bug'])).toEqual([]);
  });
});

describe('deriveIntents — planning', () => {
  it('closed issues never produce intents', () => {
    expect(deriveIntents(issue({ state: 'closed' }), [], TRUSTED, OWNER)).toEqual([]);
  });

  it('zero or multiple ai:* labels produce no intents (logless)', () => {
    expect(deriveIntents(issue({ labels: [] }), [], TRUSTED, OWNER)).toEqual([]);
    expect(deriveIntents(issue({ labels: ['ai:planning', 'ai:review'] }), [], TRUSTED, OWNER)).toEqual([]);
  });

  it('ai:planning with no feedback → consumer round 01, reason planning', () => {
    const intents = deriveIntents(issue(), [], TRUSTED, OWNER);
    expect(intents).toEqual([
      {
        role: 'consumer',
        issueNumber: 7,
        reason: 'planning',
        revision: '01',
        planCommentId: null,
        approvalCommentId: null,
      },
    ]);
  });

  it('ai:planning counts ALL-time feedback commands into the round (contract §3)', () => {
    const comments = [
      comment(10, OWNER, '/change 不要使用 SQLite。'),
      comment(11, 'alice', '/choose db postgres'),
    ];
    const intents = deriveIntents(issue(), comments, TRUSTED, OWNER);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.revision).toBe('03');
    expect(intents[0]?.reason).toBe('feedback_applied');
  });

  it('feedback from non-trusted authors is ignored entirely', () => {
    const comments = [comment(10, 'random-guy', '/change hijack the spec')];
    const intents = deriveIntents(issue(), comments, TRUSTED, OWNER);
    expect(intents[0]?.revision).toBe('01');
    expect(intents[0]?.reason).toBe('planning');
  });
});

describe('deriveIntents — review (feedback newer than plan)', () => {
  const review = issue({ labels: ['ai:review'] });

  it('no feedback newer than the latest plan → no intent', () => {
    const comments = [
      comment(10, OWNER, '/change v1'),
      comment(20, 'gateflow-driver[bot]', buildPlanCommentBody('Plan A', 'gf_r1_i7_consumer_01')),
    ];
    expect(deriveIntents(review, comments, TRUSTED, OWNER)).toEqual([]);
  });

  it('feedback newer than the latest plan → consumer round 1 + total feedback', () => {
    const comments = [
      comment(10, OWNER, '/change v1'),
      comment(20, 'gateflow-driver[bot]', buildPlanCommentBody('Plan A', 'gf_r1_i7_consumer_01')),
      comment(30, OWNER, '/change v2 — drop SQLite'),
    ];
    const intents = deriveIntents(review, comments, TRUSTED, OWNER);
    expect(intents).toEqual([
      {
        role: 'consumer',
        issueNumber: 7,
        reason: 'feedback_applied',
        // Round = 1 + ALL-TIME feedback count (2 commands → '03'), contract §3.
        revision: '03',
        planCommentId: null,
        approvalCommentId: null,
      },
    ]);
  });

  it('ai:review without any plan comment → no intent', () => {
    const comments = [comment(30, OWNER, '/change v2')];
    expect(deriveIntents(review, comments, TRUSTED, OWNER)).toEqual([]);
  });
});

describe('deriveIntents — ready (approval gating dies here)', () => {
  const planBody = buildPlanCommentBody('Plan A body', 'gf_r123_i7_consumer_01');
  const ready = issue({ labels: ['ai:ready'] });
  const botComment = (id: number, body: string, overrides: Partial<CommentDetail> = {}) =>
    comment(id, 'gateflow-driver[bot]', body, overrides);

  it('ai:ready WITHOUT an approval record → no executor dispatch (fake label dies)', () => {
    const comments = [botComment(501, planBody)];
    expect(deriveIntents(ready, comments, TRUSTED, OWNER)).toEqual([]);
  });

  it('approval by a NON-trusted human → no executor dispatch', () => {
    const comments = [botComment(501, planBody), comment(600, 'impostor', '/approve 501')];
    expect(deriveIntents(ready, comments, TRUSTED, OWNER)).toEqual([]);
  });

  it('approval pointing at a DIFFERENT (stale) plan comment → no executor dispatch', () => {
    const comments = [
      botComment(400, buildPlanCommentBody('Old plan', 'gf_r123_i7_consumer_01')),
      botComment(501, planBody),
      comment(600, OWNER, '/approve 400'),
    ];
    expect(deriveIntents(ready, comments, TRUSTED, OWNER)).toEqual([]);
  });

  it('valid trusted approval → executor intent bound to p<planCommentId>', () => {
    const comments = [
      botComment(501, planBody),
      comment(600, 'alice', '/approve 501', { createdAt: '2026-09-06T12:00:00Z' }),
    ];
    const intents = deriveIntents(ready, comments, TRUSTED, OWNER);
    expect(intents).toEqual([
      {
        role: 'executor',
        issueNumber: 7,
        reason: 'approved_plan',
        revision: 'p501',
        planCommentId: 501,
        approvalCommentId: 600,
      },
    ]);
  });

  it('plan EDITED after the approval → no executor dispatch (stale-plan attack dies)', () => {
    const comments = [
      botComment(501, planBody, {
        createdAt: '2026-09-06T11:00:00Z',
        updatedAt: '2026-09-06T13:00:00Z', // edited AFTER approval below
      }),
      comment(600, OWNER, '/approve 501', { createdAt: '2026-09-06T12:00:00Z' }),
    ];
    expect(deriveIntents(ready, comments, TRUSTED, OWNER)).toEqual([]);
  });

  it('plan edited BEFORE the approval still dispatches', () => {
    const comments = [
      botComment(501, planBody, {
        createdAt: '2026-09-06T10:00:00Z',
        updatedAt: '2026-09-06T11:30:00Z',
      }),
      comment(600, OWNER, '/approve 501', { createdAt: '2026-09-06T12:00:00Z' }),
    ];
    expect(deriveIntents(ready, comments, TRUSTED, OWNER)).toHaveLength(1);
  });
});

describe('deriveIntents — sync-only states', () => {
  for (const label of ['ai:working', 'ai:blocked', 'ai:done']) {
    it(`${label} → no intents (outbox syncing is the Driver's job)`, () => {
      expect(deriveIntents(issue({ labels: [label] }), [], TRUSTED, OWNER)).toEqual([]);
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

describe('extractPlanContent', () => {
  it('drops the marker line and dispatch-id comment, trims the rest', () => {
    const body = buildPlanCommentBody('Plan A body', 'gf_r123_i7_consumer_01');
    expect(extractPlanContent(body)).toBe('Plan A body');
  });

  it('preserves unrelated HTML comments and inner structure', () => {
    const body = [
      '<!-- ai-workflow:plan:v1 -->',
      '',
      '<!-- gateflow:dispatch-id: gf_r123_i7_consumer_01 -->',
      '',
      '## Steps',
      '',
      '<!-- keep me -->',
      '1. one',
      '2. two',
    ].join('\n');
    expect(extractPlanContent(body)).toBe('## Steps\n\n<!-- keep me -->\n1. one\n2. two');
  });
});
