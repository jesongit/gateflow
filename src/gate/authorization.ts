/**
 * Gate Authorization Context (hardening plan V1.1 Phase 1 §4.1).
 *
 * The gate's marker-triggered transitions (T1 / T3 / T4 / T5 / T6) must no
 * longer rely on "trusted publisher + valid marker + current label" alone:
 * EVERY migration must be traceable to the current Epoch, the current Plan,
 * the current Approval and the concrete dispatch the source object belongs
 * to. This module adapts the SHARED chain validator
 * (src/protocol/workflow-chain.ts) to the gate's inputs and resolves the
 * per-event authorization context exactly once.
 *
 * Principle (plan §2): a marker is a structural hint, a publisher identity is
 * permission to PUBLISH, but the DISPATCH CHAIN is what makes a source object
 * state-bearing. Fake markers, old-round comments and orphan reports all die
 * here (Phase 1 acceptance list).
 */
import type { GateComment } from './approvals';
import {
  acceptedFeedbackOfEpoch,
  currentPlanOf,
  resolveCurrentEpoch,
  validateConsumerPlanSource,
  validateExecutorChainSource,
  type ChainComment,
  type ChainVerdict,
  type ExecutorChainVerdict,
} from '../protocol/workflow-chain';

/**
 * The resolved authorization facts of one issue, fresh per event
 * (plan §4.1 `WorkflowAuthorizationContext`).
 */
export interface WorkflowAuthorizationContext {
  repositoryId: number;
  issueNumber: number;
  /** Current workflow epoch (trusted resolution). */
  epoch: string;
  /** Comment id of the epoch record that defines `epoch`. */
  epochRecordCommentId: number;
  /** Current plan comment (latest plan marker); null when none yet. */
  planCommentId: number | null;
}

export interface AuthorizationContextInput {
  /** Fresh comment list (id-ascending) from the GitHub API. */
  comments: ReadonlyArray<GateComment>;
  repositoryId: number;
  issueNumber: number;
  /** Logins allowed to have authored `gate`-issued epoch records. */
  gateIssuers: ReadonlySet<string>;
  /** Logins allowed to have authored `driver_bootstrap` epoch records. */
  bootstrapIssuers: ReadonlySet<string>;
}

export type AuthorizationContextResolution =
  | { ok: true; context: WorkflowAuthorizationContext }
  | { ok: false; reason: string; conflict: boolean };

/**
 * Resolves the authorization context of an issue: current epoch (with full
 * issuer/trust validation) + current plan. Fails closed on ANY suspect
 * epoch record (unparsable, wrong repo/issue, forged issuer, conflict).
 */
export function resolveAuthorizationContext(
  input: AuthorizationContextInput,
): AuthorizationContextResolution {
  const epoch = resolveCurrentEpoch({
    comments: input.comments,
    repositoryId: input.repositoryId,
    issueNumber: input.issueNumber,
    gateIssuers: input.gateIssuers,
    bootstrapIssuers: input.bootstrapIssuers,
  });
  if (!epoch.ok) {
    return { ok: false, reason: epoch.reason, conflict: epoch.conflict };
  }
  const plan = currentPlanOf(input.comments);
  return {
    ok: true,
    context: {
      repositoryId: input.repositoryId,
      issueNumber: input.issueNumber,
      epoch: epoch.epoch,
      epochRecordCommentId: epoch.commentId,
      planCommentId: plan?.id ?? null,
    },
  };
}

/**
 * T1 (Plan → REVIEW) source validation: the plan comment must belong to a
 * CURRENT consumer dispatch of the current epoch (dispatch binding present,
 * role consumer, epoch match, revision == the epoch's current consumer
 * round = 1 + accepted feedback events).
 */
export function validateConsumerSource(input: {
  context: WorkflowAuthorizationContext;
  planComment: ChainComment;
  comments: ReadonlyArray<GateComment>;
  /** Effective trusted humans (for feedback anchoring). */
  trustedHumans: ReadonlySet<string>;
}): ChainVerdict {
  const accepted = acceptedFeedbackOfEpoch({
    comments: input.comments,
    epoch: input.context.epoch,
    trustedHumans: input.trustedHumans,
  });
  return validateConsumerPlanSource({
    planComment: input.planComment,
    epoch: input.context.epoch,
    repositoryId: input.context.repositoryId,
    issueNumber: input.context.issueNumber,
    acceptedFeedbackCount: accepted.length,
  });
}

/**
 * T3/T4/T5/T6 source validation: the tracker / report comment must belong to
 * the CURRENT executor chain (dispatch binding, epoch, current plan, valid
 * sha256-bound approval record with intact human anchor).
 */
export function validateExecutorSource(input: {
  context: WorkflowAuthorizationContext;
  sourceComment: ChainComment;
  comments: ReadonlyArray<GateComment>;
  /** Effective trusted humans (for the /approve anchor check). */
  trustedHumans: ReadonlySet<string>;
  repoOwner: string;
  gateIssuers: ReadonlySet<string>;
}): ExecutorChainVerdict {
  return validateExecutorChainSource({
    sourceComment: input.sourceComment,
    epoch: input.context.epoch,
    repositoryId: input.context.repositoryId,
    issueNumber: input.context.issueNumber,
    comments: input.comments,
    gateIssuers: input.gateIssuers,
    trustedHumans: input.trustedHumans,
    repoOwner: input.repoOwner,
  });
}
