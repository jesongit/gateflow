/**
 * Sync Preflight — the unified current-task authorization check (hardening
 * Phase 4.1, kept intact by the V1 simplification).
 *
 * EVERY state-relevant GitHub write in the sync layer must run `runPreflight`
 * first and fail closed on `ok: false`. The preflight re-reads canonical
 * state FRESH (issue + comments via the API) and validates:
 *
 *   Repository id / issue number / epoch binding of the task id
 *   Issue exists and is open
 *   Exactly one ai:* label (0 = cancelled, >1 = corrupted)
 *   Current workflow epoch (Gate-issued records) == task epoch
 *   No suspect authorization records on the issue (tampering → fail closed)
 *   Execute: current Plan exists, an approval RECORD binds
 *            (epoch, plan id, exact plan_sha256)
 *
 * KNOWN CONSISTENCY LIMIT (frozen): GitHub's "read state → write" is not a
 * transaction. Preflight shrinks the race window; it cannot close it. The
 * Gate therefore re-validates epoch/revision/plan on every protocol object
 * it accepts, and this Driver is the single controlled writer for its
 * workspace. Where preflight cannot prove current authorization → fail
 * closed (never guess).
 */
import type { DriverGitHubClient, IssueDetail, CommentDetail, IssueRef } from '../github/client';
import {
  approvalRecordAnchorFailure,
  findLatestPlanComment,
  readIssueRecords,
  type IssueRecordView,
} from '../github/issue-sync';
import { planSha256 } from '../protocol/plan';
import { approvalRecordsConflict } from '../protocol/records';
import { parseTaskId } from '../workspace/protocol';
import type { TaskFile } from '../workspace/protocol';
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
     * true = the task is DEFINITIVELY invalidated (cancel, issue closed,
     * epoch superseded, approval invalidated): the record may move to
     * `obsolete`. false = transient/unprovable (API oddity, tampering):
     * fail closed but keep retrying/logging.
     */
     obsolete: boolean };

/** Identity inputs the preflight re-validates records against. */
export interface PreflightIdentity {
  /** Driver-side allowlist of Gate record identities. */
  gateLogins: ReadonlySet<string>;
  /** Trusted humans (config + repo owner) for the /approve anchor check. */
  trustedHumans: ReadonlySet<string>;
  repoOwner: string;
}

/**
 * Run the full preflight for one task. Throws only on infrastructure
 * errors (GitHub client failures) — validation outcomes are returned.
 */
export async function runPreflight(
  client: DriverGitHubClient,
  repositoryInfo: { owner: string; name: string; id: number },
  task: TaskFile,
  identity: PreflightIdentity,
): Promise<PreflightVerdict> {
  // (1) Task identity must agree with the task document itself.
  const parsed = parseTaskId(task.task_id);
  if (parsed === null) {
    return { ok: false, reason: `task id "${task.task_id}" violates the frozen grammar`, obsolete: true };
  }
  if (parsed.repositoryId !== task.repository_id || parsed.issueNumber !== task.issue_number) {
    return { ok: false, reason: 'task id components disagree with the task document', obsolete: true };
  }
  if (parsed.epochCode !== task.workflow_epoch.slice(3)) {
    return { ok: false, reason: 'task id epoch code disagrees with the task epoch', obsolete: true };
  }
  if (task.repository_id !== repositoryInfo.id) {
    return { ok: false, reason: `task targets repository ${task.repository_id}, driver operates on ${repositoryInfo.id}`, obsolete: true };
  }

  const ref: IssueRef = {
    owner: repositoryInfo.owner,
    repo: repositoryInfo.name,
    issueNumber: task.issue_number,
  };

  // (2) Fresh issue state.
  const issue = await client.getIssue(ref);
  if (issue === null) {
    return { ok: false, reason: `issue #${task.issue_number} does not exist`, obsolete: true };
  }
  if (issue.state === 'closed') {
    return { ok: false, reason: `issue #${task.issue_number} is closed (cancel/closure invalidates the task)`, obsolete: true };
  }
  const labels = aiLabels(issue.labels);
  if (labels.length === 0) {
    return { ok: false, reason: `issue #${task.issue_number} carries no ai:* label (workflow exited — cancel invalidates the task)`, obsolete: true };
  }
  if (labels.length > 1) {
    return { ok: false, reason: `issue #${task.issue_number} carries multiple ai:* labels [${labels.join(', ')}] (corrupted state — refusing to guess)`, obsolete: false };
  }

  // (3) Fresh records: current epoch + authorization records.
  const comments = await client.listComments(ref);
  const view = readIssueRecords(comments, identity.gateLogins);
  if (view.suspect.length > 0) {
    return {
      ok: false,
      reason:
        `suspect authorization record(s) on #${task.issue_number} (fail closed): ` +
        view.suspect.map((entry) => `#${entry.commentId} (${entry.reason})`).join(', '),
      obsolete: false,
    };
  }
  if (view.epoch === null) {
    return { ok: false, reason: `no workflow_epoch record on #${task.issue_number} (fail closed)`, obsolete: false };
  }
  if (view.epoch.record.workflow_epoch !== task.workflow_epoch) {
    return {
      ok: false,
      reason:
        `task epoch ${task.workflow_epoch} is superseded by current epoch ` +
        `${view.epoch.record.workflow_epoch} (old task invalid)`,
      obsolete: true,
    };
  }

  // (4) Execute binding: current plan + approval record with matching hash.
  // The approval RECORD is the authority that binds the exact plan bytes;
  // the task only needs to name the plan comment id.
  let planCommentId: number | null = null;
  let planHash: string | null = null;
  if (task.mode === 'execute') {
    const plan = findLatestPlanComment(comments);
    if (plan === null || plan.id !== task.plan_comment_id) {
      return {
        ok: false,
        reason: `approved plan comment ${String(task.plan_comment_id)} is no longer the current plan`,
        obsolete: true,
      };
    }
    const hash = planSha256(plan.body);
    const candidates = view.approvals.filter(
      (entry) =>
        entry.record.workflow_epoch === task.workflow_epoch &&
        entry.record.plan_comment_id === task.plan_comment_id &&
        entry.record.plan_sha256 === hash &&
        approvalRecordAnchorFailure(entry.record, comments, identity.trustedHumans, identity.repoOwner) ===
          null,
    );
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: `no valid Gate-issued approval record binds (epoch, plan ${String(task.plan_comment_id)}, hash)`,
        obsolete: true,
      };
    }
    const conflict = approvalRecordsConflict(candidates);
    if (conflict.conflict) {
      return { ok: false, reason: `conflicting approval records: ${conflict.reason ?? 'divergent content'}`, obsolete: true };
    }
    planCommentId = plan.id;
    planHash = hash;
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
