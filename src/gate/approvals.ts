/**
 * V1 approval validation: binding a Trusted Human /approve to a specific
 * Plan comment (docs/protocol.md section 3.4 "V1 审批证明（Plan-ID 绑定）",
 * docs/architecture-v1.md section 3.3, plan sections 27-28).
 *
 * The V1 approval model, in one paragraph:
 *  - The approval command is "/approve <plan-comment-id>" and the DURABLE
 *    Approval Record is that very comment (its author = the approving human,
 *    its argument = the approved plan; both are auditable on GitHub).
 *  - The gate validates that the referenced comment EXISTS on this issue,
 *    carries a VALID plan marker (same uniqueness / line-ownership rules as
 *    any marker comment, via detectCommentMarker) and IS the CURRENT plan —
 *    the LAST valid plan-marker comment on the issue in chronological (id)
 *    order. Only then does it perform the T2 label transition.
 *  - Markers alone never prove permission; a marker comment is only a
 *    structural hint. Content-hash / staleness enforcement (the plan must not
 *    have been edited after the approval) happens at executor-dispatch time
 *    in the Driver, which re-validates the Approval Record independently
 *    (architecture-v1 3.3). This module therefore decides nothing about
 *    dispatch — it only guards the REVIEW -> READY label transition.
 *
 * The functions here are pure: no I/O, no GitHub calls. The caller (gate.ts)
 * supplies the referenced comment and the issue's plan-marker comments as
 * plain data (see GateComment), and inspects the returned reason string to
 * log a precise, state-precondition no-op warning on failure.
 */
import { MARKERS } from './protocol';
import { detectCommentMarker } from './markers';

/** The subset of a GitHub issue comment the approval validation needs. */
export interface GateComment {
  id: number;
  /** user.login of the comment author ('unknown' when the API omits it). */
  user: string;
  body: string;
}

/** Outcome of validating an /approve target. */
export type ApprovalInspection =
  | { status: 'valid'; planCommentId: number }
  | { status: 'invalid'; reason: ApprovalRejectionReason };

/** Why an /approve target comment was rejected, distinguished for logging. */
export type ApprovalRejectionReason =
  /** rest.issues.getComment returned 404: the referenced comment is gone. */
  | 'comment-not-found'
  /**
   * The referenced comment cannot be tied to this issue as a plan comment:
   * it is neither in this issue's valid plan-marker comment list nor does its
   * body carry a valid plan marker (issue membership is only verifiable via
   * the issue's comment list, not via the comment fetch itself).
   */
  | 'comment-on-other-issue'
  /** The referenced comment exists on this issue but has no valid plan marker. */
  | 'not-a-plan-comment'
  /** A valid plan comment, but not the LAST one on the issue (a newer plan exists). */
  | 'not-current-plan';

/**
 * Validates that `planCommentId` names the CURRENT plan of the issue.
 *
 * Inputs (all supplied by the caller from the GitHub API):
 *  - `referencedComment`: the comment fetched by id, or null on 404;
 *  - `planMarkerComments`: ALL comments of this issue whose body carries a
 *    valid plan marker (detectCommentMarker === plan marker), sorted by
 *    comment id ascending — i.e. the chronological plan revision history.
 *
 * Validation order (first failure wins, docs/protocol.md section 3.4):
 *  1. referenced comment must exist                    -> 'comment-not-found';
 *  2. its body must carry a valid plan marker          -> 'comment-on-other-issue'
 *     when membership in this issue's plan list cannot be established
 *     (id absent from `planMarkerComments`), otherwise 'not-a-plan-comment';
 *  3. `planMarkerComments` must be non-empty and the referenced comment must
 *     be its LAST element (the current plan)           -> 'not-current-plan'.
 *
 * Pure function: never throws, never performs I/O.
 */
export function validatePlanCommentForApproval(args: {
  planCommentId: number;
  referencedComment: GateComment | null;
  planMarkerComments: GateComment[];
}): ApprovalInspection {
  const { planCommentId, referencedComment, planMarkerComments } = args;

  if (referencedComment === null) {
    return { status: 'invalid', reason: 'comment-not-found' };
  }

  if (detectCommentMarker(referencedComment.body) !== MARKERS.plan) {
    // The comment fetch itself does not prove issue membership; membership is
    // established by the id appearing in this issue's plan-marker list. An id
    // outside that list without a plan marker may belong to another issue —
    // or to this one as plain content — and is rejected either way.
    const inPlanList = planMarkerComments.some((comment) => comment.id === planCommentId);
    return {
      status: 'invalid',
      reason: inPlanList ? 'not-a-plan-comment' : 'comment-on-other-issue',
    };
  }

  const currentPlan = planMarkerComments[planMarkerComments.length - 1];
  if (currentPlan === undefined || currentPlan.id !== planCommentId) {
    return { status: 'invalid', reason: 'not-current-plan' };
  }

  return { status: 'valid', planCommentId };
}
