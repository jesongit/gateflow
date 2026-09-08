/**
 * Sync/Dispatch Preflight — the unified current-task authorization check
 * (hardening Phase 4.1, docs/plans/v1_hardening_decisions.md §5; V1.1
 * delegates the authorization chain to the SHARED validator —
 * src/protocol/workflow-chain.ts, Phase 1 §4.6 "Driver Preflight != Gate
 * Authorization": the Driver may pre-block, the Gate must re-prove).
 *
 * EVERY state-relevant GitHub write in the sync layer must run
 * `runPreflight` first and fail closed on `ok: false`. The preflight re-reads
 * canonical state FRESH (issue + comments via the API) and validates:
 *
 *   Repository id / issue number / epoch binding of the dispatch id
 *   Issue exists and is open
 *   Exactly one ai:* label (0 = cancelled, >1 = corrupted)
 *   Current workflow epoch (V1.1 trusted resolution: issuer classes,
 *     repo/issue binding, operation-id conflicts) == dispatch epoch
 *   No suspect authorization records on the issue (tampering → fail closed)
 *   Executor: current Plan exists, an approval RECORD binds
 *             (epoch, plan id, exact plan_sha256, intact human anchor)
 *
 * KNOWN CONSISTENCY LIMIT (frozen, docs §4.1): GitHub's "read state → write"
 * is not a transaction. Preflight shrinks the race window; it cannot close
 * it. The Gate therefore re-validates epoch/revision/plan on every protocol
 * object it accepts, and this Driver is the single controlled writer for its
 * workspace. Where preflight cannot prove current authorization → fail
 * closed (never guess).
 */
import type { DriverGitHubClient, IssueDetail, CommentDetail, IssueRef } from '../github/client';
import { findLatestPlanComment, readIssueRecordsForIssue, type IssueRecordView } from '../github/issue-sync';
import { validateApprovalBinding } from '../protocol/workflow-chain';
import { parseDispatchId } from '../workspace/protocol';
import type { Dispatch } from '../workspace/protocol';
import { aiLabels } from './intent';

/** Fresh canonical snapshot the sync layer makes its decisions against. */
export interface SyncSnapshot {
  issue: IssueDetail;
  comments: CommentDetail[];
  /** Current workflow epoch (records), guaranteed present when ok. */
  epoch: string;
  view: IssueRecordView;
  /** Current plan comment (latest plan-marker comment); null when none. */
  planCommentId: number | null;
  planSha256: string | null;
  /** Canonical workflow state derived from the fresh labels. */
  aiState: string;
}

export type PreflightVerdict =
  | { ok: true; snapshot: SyncSnapshot }
  | { ok: false; reason: string; /**
     * true = the dispatch is DEFINITIVELY invalidated (cancel, issue closed,
     * epoch superseded, approval invalidated): the receipt may move to
     * `obsolete`. false = transient/unprovable (API oddity, tampering):
     * fail closed but keep retrying/logging.
     */
     obsolete: boolean };

/** Identity inputs the preflight re-validates records against. */
export interface PreflightIdentity {
  /** Driver-side allowlist of Gate record identities. */
  gateLogins: ReadonlySet<string>;
  /**
   * V1.1 Phase 2: allowlist for `driver_bootstrap` epoch records (config
   * default: the owner of a personal repository).
   */
  bootstrapIssuers: ReadonlySet<string>;
  /** Trusted humans (config + repo owner) for the /approve anchor check. */
  trustedHumans: ReadonlySet<string>;
  repoOwner: string;
}

/**
 * Run the full preflight for one dispatch. Throws only on infrastructure
 * errors (GitHub client failures) — validation outcomes are returned.
 */
export async function runPreflight(
  client: DriverGitHubClient,
  repositoryInfo: { owner: string; name: string; id: number },
  dispatch: Dispatch,
  identity: PreflightIdentity,
): Promise<PreflightVerdict> {
  // (1) Dispatch identity must agree with the dispatch document itself.
  const parsed = parseDispatchId(dispatch.dispatch_id);
  if (parsed === null) {
    return { ok: false, reason: `dispatch id "${dispatch.dispatch_id}" violates the frozen grammar`, obsolete: true };
  }
  if (parsed.repositoryId !== dispatch.repository_id || parsed.issueNumber !== dispatch.issue_number) {
    return { ok: false, reason: 'dispatch id components disagree with the dispatch document', obsolete: true };
  }
  if (parsed.epochCode !== dispatch.workflow_epoch.slice(3)) {
    return { ok: false, reason: 'dispatch id epoch code disagrees with the dispatch epoch', obsolete: true };
  }
  if (dispatch.repository_id !== repositoryInfo.id) {
    return { ok: false, reason: `dispatch targets repository ${dispatch.repository_id}, driver operates on ${repositoryInfo.id}`, obsolete: true };
  }

  const ref: IssueRef = {
    owner: repositoryInfo.owner,
    repo: repositoryInfo.name,
    issueNumber: dispatch.issue_number,
  };

  // (2) Fresh issue state.
  const issue = await client.getIssue(ref);
  if (issue === null) {
    return { ok: false, reason: `issue #${dispatch.issue_number} does not exist`, obsolete: true };
  }
  if (issue.state === 'closed') {
    return { ok: false, reason: `issue #${dispatch.issue_number} is closed (cancel/closure invalidates the dispatch)`, obsolete: true };
  }
  const labels = aiLabels(issue.labels);
  if (labels.length === 0) {
    return { ok: false, reason: `issue #${dispatch.issue_number} carries no ai:* label (workflow exited — cancel invalidates the dispatch)`, obsolete: true };
  }
  if (labels.length > 1) {
    return { ok: false, reason: `issue #${dispatch.issue_number} carries multiple ai:* labels [${labels.join(', ')}] (corrupted state — refusing to guess)`, obsolete: false };
  }

  // (3) Fresh records: current epoch (SHARED trusted resolution, V1.1) +
  // authorization records. ANY suspect record fails closed.
  const comments = await client.listComments(ref);
  const view = readIssueRecordsForIssue(comments, {
    repositoryId: repositoryInfo.id,
    issueNumber: dispatch.issue_number,
    gateLogins: identity.gateLogins,
    bootstrapIssuers: identity.bootstrapIssuers,
  });
  if (view.suspect.length > 0) {
    return {
      ok: false,
      reason:
        `suspect authorization record(s) on #${dispatch.issue_number} (fail closed): ` +
        view.suspect.map((entry) => `#${entry.commentId} (${entry.reason})`).join(', '),
      obsolete: false,
    };
  }
  if (view.epoch === null) {
    return { ok: false, reason: `no workflow_epoch record on #${dispatch.issue_number} (fail closed)`, obsolete: false };
  }
  if (view.epoch.record.workflow_epoch !== dispatch.workflow_epoch) {
    return {
      ok: false,
      reason:
        `dispatch epoch ${dispatch.workflow_epoch} is superseded by current epoch ` +
        `${view.epoch.record.workflow_epoch} (old dispatch invalid)`,
      obsolete: true,
    };
  }

  // (4) Executor binding (SHARED approval binding, V1.1): current plan + a
  // Gate-issued approval record binding (epoch, plan id, exact plan hash,
  // intact human anchor), no record conflicts. The dispatch document must
  // also still name that plan comment.
  let planCommentId: number | null = null;
  let planHash: string | null = null;
  if (dispatch.role === 'executor') {
    const plan = findLatestPlanComment(comments);
    if (plan === null || plan.id !== dispatch.plan_comment_id) {
      return {
        ok: false,
        reason: `approved plan comment ${String(dispatch.plan_comment_id)} is no longer the current plan`,
        obsolete: true,
      };
    }
    const binding = validateApprovalBinding({
      epoch: dispatch.workflow_epoch,
      repositoryId: repositoryInfo.id,
      issueNumber: dispatch.issue_number,
      comments,
      gateIssuers: identity.gateLogins,
      trustedHumans: identity.trustedHumans,
      repoOwner: identity.repoOwner,
    });
    if (!binding.ok) {
      return {
        ok: false,
        reason: `executor approval binding invalid: ${binding.reason}`,
        obsolete: true,
      };
    }
    if (binding.planCommentId !== dispatch.plan_comment_id) {
      return {
        ok: false,
        reason: 'approval binding names a different plan comment than the dispatch document',
        obsolete: true,
      };
    }
    planCommentId = binding.planCommentId;
    planHash = binding.planSha256;
  }

  return {
    ok: true,
    snapshot: {
      issue,
      comments,
      epoch: view.epoch.record.workflow_epoch,
      view,
      planCommentId,
      planSha256: planHash,
      aiState: labels[0] ?? '',
    },
  };
}
