import { describe, expect, it } from 'vitest';
import {
  validatePlanCommentForApproval,
  type GateComment,
} from '../../src/gate/approvals';
import { MARKERS } from '../../src/gate/protocol';

/* --------------------------------------------------------------- helpers */

const PLAN_BODY = `## Execution Plan\n\nDo the thing.\n\n${MARKERS.plan}`;
const TRACKER_BODY = `## Execution Tracker\n\n**Status:** In Progress\n\n<!-- ai-workflow:execution-tracker:v1 -->`;

const comment = (id: number, body: string, user = 'consumer-bot'): GateComment => ({ id, user, body });

const valid = (...planIds: number[]): GateComment[] => planIds.map((id) => comment(id, PLAN_BODY));

/* ----------------------------------------------------------------- tests */

describe('validatePlanCommentForApproval (V1 plan-ID binding, protocol 3.4)', () => {
  it('accepts the LAST valid plan-marker comment as the current plan', () => {
    expect(
      validatePlanCommentForApproval({
        planCommentId: 456,
        referencedComment: comment(456, PLAN_BODY),
        planMarkerComments: valid(123, 456),
      }),
    ).toEqual({ status: 'valid', planCommentId: 456 });
  });

  it('accepts when the single plan comment of the issue is the referenced one', () => {
    expect(
      validatePlanCommentForApproval({
        planCommentId: 123,
        referencedComment: comment(123, PLAN_BODY),
        planMarkerComments: valid(123),
      }),
    ).toEqual({ status: 'valid', planCommentId: 123 });
  });

  it('rejects a missing referenced comment (404 -> null) as comment-not-found', () => {
    expect(
      validatePlanCommentForApproval({
        planCommentId: 99999,
        referencedComment: null,
        planMarkerComments: valid(123),
      }),
    ).toEqual({ status: 'invalid', reason: 'comment-not-found' });
  });

  it('comment-not-found wins even when the plan list is empty', () => {
    expect(
      validatePlanCommentForApproval({
        planCommentId: 1,
        referencedComment: null,
        planMarkerComments: [],
      }),
    ).toEqual({ status: 'invalid', reason: 'comment-not-found' });
  });

  it('rejects a comment that is neither in the plan list nor carries a plan marker as comment-on-other-issue', () => {
    // Issue membership is only verifiable via the plan-marker list of the
    // issue; a foreign id without a plan marker could belong to any issue.
    expect(
      validatePlanCommentForApproval({
        planCommentId: 777,
        referencedComment: comment(777, 'just a plain question'),
        planMarkerComments: valid(123),
      }),
    ).toEqual({ status: 'invalid', reason: 'comment-on-other-issue' });
  });

  it('rejects a comment carrying a DIFFERENT valid marker as comment-on-other-issue (not a plan)', () => {
    expect(
      validatePlanCommentForApproval({
        planCommentId: 778,
        referencedComment: comment(778, TRACKER_BODY),
        planMarkerComments: valid(123),
      }),
    ).toEqual({ status: 'invalid', reason: 'comment-on-other-issue' });
  });

  it('rejects an id listed as a plan whose fetched body lost its marker as not-a-plan-comment', () => {
    // Inconsistent caller data (e.g. the comment was edited between the list
    // read and the id fetch): membership is proven by the list, but the body
    // no longer carries the plan marker it must have.
    expect(
      validatePlanCommentForApproval({
        planCommentId: 123,
        referencedComment: comment(123, 'marker edited away'),
        planMarkerComments: valid(123),
      }),
    ).toEqual({ status: 'invalid', reason: 'not-a-plan-comment' });
  });

  it('rejects an older plan once a NEWER plan-marker comment exists as not-current-plan', () => {
    expect(
      validatePlanCommentForApproval({
        planCommentId: 123,
        referencedComment: comment(123, PLAN_BODY),
        planMarkerComments: valid(123, 456),
      }),
    ).toEqual({ status: 'invalid', reason: 'not-current-plan' });
  });

  it('rejects when the issue has no valid plan-marker comment at all', () => {
    expect(
      validatePlanCommentForApproval({
        planCommentId: 123,
        referencedComment: comment(123, PLAN_BODY),
        planMarkerComments: [],
      }),
    ).toEqual({ status: 'invalid', reason: 'not-current-plan' });
  });

  it('applies the same marker rules as the gate: an inline marker is not a plan marker', () => {
    expect(
      validatePlanCommentForApproval({
        planCommentId: 800,
        referencedComment: comment(800, `the plan follows: ${MARKERS.plan}`),
        planMarkerComments: valid(123),
      }),
    ).toEqual({ status: 'invalid', reason: 'comment-on-other-issue' });
  });

  it('applies the same marker rules as the gate: markers inside fenced code blocks never count', () => {
    expect(
      validatePlanCommentForApproval({
        planCommentId: 801,
        referencedComment: comment(801, '```\n' + MARKERS.plan + '\n```'),
        planMarkerComments: valid(123),
      }),
    ).toEqual({ status: 'invalid', reason: 'comment-on-other-issue' });
  });

  it('applies the same marker rules as the gate: multiple marker occurrences invalidate the comment', () => {
    expect(
      validatePlanCommentForApproval({
        planCommentId: 802,
        referencedComment: comment(802, `${MARKERS.plan}\n${TRACKER_BODY}`),
        planMarkerComments: valid(123),
      }),
    ).toEqual({ status: 'invalid', reason: 'comment-on-other-issue' });
  });
});
