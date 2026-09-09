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
import { detectCommentMarker } from '../gate/markers';
import { MARKERS } from '../gate/protocol';
import { planSha256 } from '../protocol/plan';
import {
  approvalRecordsConflict,
  readTrustedWorkflowEpoch,
} from '../protocol/records';
import {
  expectedExecuteDispatchId,
  expectedPlanDispatchId,
  findDispatchId,
  inspectDispatchId,
  validateExpectedDispatchId,
} from '../gate/execution-chain';
import { isWorkflowEpoch } from '../protocol/epoch';
import { parseTaskId } from '../workspace/protocol';
import type { TaskFile } from '../workspace/protocol';
import { aiLabels } from './intent';
import {
  assertTargetOutsideRuntime,
  isRepositorySlug,
  normalizeTargetWorkspace,
  sameRepositorySlug,
} from '../workspace/binding';

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
  /** Whether a valid Gate Approval currently accepts the concrete Plan. */
  planAccepted: boolean;
  /** The concrete current Plan object, when one exists. */
  currentPlan: CommentDetail | null;
  /** The latest concrete Tracker for this execute task, when one exists. */
  currentTracker: CommentDetail | null;
  /** All concrete Report objects for this execute task, in comment order. */
  currentReports: CommentDetail[];
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

/** Optional local context used to reject targets inside `.gateflow/`. */
export interface PreflightWorkspaceContext {
  projectRoot: string;
  workspaceDir: string;
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
  workspaceContext?: PreflightWorkspaceContext,
): Promise<PreflightVerdict> {
  // (1) Task identity must agree with the task document itself.
  const parsed = parseTaskId(task.task_id);
  if (parsed === null) {
    return { ok: false, reason: `task id "${task.task_id}" violates the frozen grammar`, obsolete: true };
  }
  if (parsed.mode !== task.mode) {
    return { ok: false, reason: 'task id mode disagrees with the task document', obsolete: true };
  }
  if (!isWorkflowEpoch(task.workflow_epoch)) {
    return { ok: false, reason: 'task document carries a malformed workflow epoch', obsolete: true };
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
  const controlRepository = `${repositoryInfo.owner}/${repositoryInfo.name}`;
  if (!isRepositorySlug(task.control_repository) || !sameRepositorySlug(task.control_repository, controlRepository)) {
    return {
      ok: false,
      reason: `task Control Repository ${JSON.stringify(task.control_repository)} does not match the Driver Control Repository ${controlRepository}`,
      obsolete: true,
    };
  }
  if (task.target_repository !== null && !isRepositorySlug(task.target_repository)) {
    return { ok: false, reason: 'task target_repository is malformed', obsolete: true };
  }
  try {
    if (workspaceContext === undefined) {
      normalizeTargetWorkspace(task.target_workspace);
    } else {
      assertTargetOutsideRuntime(workspaceContext.projectRoot, workspaceContext.workspaceDir, task.target_workspace);
    }
  } catch (err) {
    return {
      ok: false,
      reason: `task target_workspace is unsafe: ${err instanceof Error ? err.message : String(err)}`,
      obsolete: true,
    };
  }

  const expectedTaskId =
    task.mode === 'plan'
      ? /^\d+$/.test(parsed.revision)
        ? expectedPlanDispatchId(
            task.repository_id,
            task.issue_number,
            task.workflow_epoch,
            Number(parsed.revision),
          )
        : null
      : expectedExecuteDispatchId(
          task.repository_id,
          task.issue_number,
          task.workflow_epoch,
          task.plan_comment_id ?? 0,
        );
  const taskBinding = validateExpectedDispatchId(task.task_id, expectedTaskId);
  if (!taskBinding.ok) {
    return { ok: false, reason: `task id is not canonically bound: ${taskBinding.reason}`, obsolete: true };
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
  if (issue.number !== task.issue_number) {
    return {
      ok: false,
      reason: `GitHub returned issue #${issue.number} for requested issue #${task.issue_number}`,
      obsolete: false,
    };
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
  const trustedEpoch = readTrustedWorkflowEpoch(
    comments,
    repositoryInfo.id,
    task.issue_number,
    identity.gateLogins,
  );
  if (!trustedEpoch.ok) {
    return {
      ok: false,
      reason: `workflow epoch is not trusted: ${trustedEpoch.reason}`,
      obsolete: false,
    };
  }
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
  if (trustedEpoch.record.workflow_epoch !== task.workflow_epoch) {
    return {
      ok: false,
      reason:
        `task epoch ${task.workflow_epoch} is superseded by current epoch ` +
        `${trustedEpoch.record.workflow_epoch} (old task invalid)`,
      obsolete: true,
    };
  }

  // A command-bound epoch is only trustworthy when its source is an actual
  // Trusted Human command.  The record parser proves the source is an
  // `/ai-plan` object; this boundary proves who authored that object.
  if (trustedEpoch.record.request_comment_id !== undefined) {
    const source = comments.find((comment) => comment.id === trustedEpoch.record.request_comment_id);
    if (
      source === undefined ||
      !identity.trustedHumans.has(source.user.toLowerCase())
    ) {
      return {
        ok: false,
        reason:
          `workflow epoch source comment #${trustedEpoch.record.request_comment_id} ` +
          'is not authored by a trusted human (fail closed)',
        obsolete: false,
      };
    }
  }

  // A trusted comment author is not enough for another record kind: its
  // self-reported gate_login must name a configured Gate identity.
  // Foreign repository/issue records are also suspicious instead of being
  // silently ignored by the candidate filters below.
  for (const entry of [...view.approvals, ...view.feedback]) {
    if (entry.record.repository_id !== repositoryInfo.id || entry.record.issue_number !== task.issue_number) {
      return {
        ok: false,
        reason: `record #${entry.commentId} does not bind the current repository/issue (fail closed)`,
        obsolete: false,
      };
    }
    const source = comments.find((comment) => comment.id === entry.commentId);
    const gateLogin = 'gate_login' in entry.record ? entry.record.gate_login : null;
    if (
      source === undefined ||
      gateLogin === null ||
      !identity.gateLogins.has(gateLogin.toLowerCase()) ||
      !identity.gateLogins.has(source.user.toLowerCase())
    ) {
      return {
        ok: false,
        reason: `record #${entry.commentId} is not authored by the configured Gate identity (fail closed)`,
        obsolete: false,
      };
    }
  }

  // (4) Execute binding: current plan + approval record with matching hash.
  // The approval RECORD is the authority that binds the exact plan bytes;
  // the task only needs to name the plan comment id.
  let planCommentId: number | null = null;
  let planHash: string | null = null;
  const currentPlan = findLatestPlanComment(comments);
  let planAccepted = false;
  let currentTracker: CommentDetail | null = null;
  let currentReports: CommentDetail[] = [];
  if (task.mode === 'execute') {
    if (currentPlan === null || currentPlan.id !== task.plan_comment_id) {
      return {
        ok: false,
        reason: `approved plan comment ${String(task.plan_comment_id)} is no longer the current plan`,
        obsolete: true,
      };
    }
    const planDispatch = inspectDispatchId(findDispatchId(currentPlan.body));
    if (
      !planDispatch.ok ||
      planDispatch.binding.repositoryId !== task.repository_id ||
      planDispatch.binding.issueNumber !== task.issue_number ||
      planDispatch.binding.workflowEpoch !== task.workflow_epoch ||
      planDispatch.binding.mode !== 'plan'
    ) {
      return {
        ok: false,
        reason: `current Plan #${currentPlan.id} is not bound to the task epoch/repository/issue`,
        obsolete: true,
      };
    }
    const hash = planSha256(currentPlan.body);
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
    planAccepted = candidates.length > 0;
    planCommentId = currentPlan.id;
    planHash = hash;
    currentTracker = findBoundComment(comments, MARKERS.executionTracker, task.task_id);
    currentReports = findBoundComments(comments, MARKERS.completionReport, task.task_id);
  } else if (currentPlan !== null) {
    const currentPlanDispatch = validateExpectedDispatchId(
      findDispatchId(currentPlan.body),
      findDispatchId(currentPlan.body),
    );
    if (currentPlanDispatch.ok) {
      const candidates = view.approvals.filter(
        (entry) =>
          entry.record.workflow_epoch === task.workflow_epoch &&
          entry.record.repository_id === task.repository_id &&
          entry.record.issue_number === task.issue_number &&
          entry.record.plan_comment_id === currentPlan.id &&
          entry.record.plan_sha256 === planSha256(currentPlan.body) &&
          approvalRecordAnchorFailure(entry.record, comments, identity.trustedHumans, identity.repoOwner) ===
            null,
      );
      const conflict = approvalRecordsConflict(candidates);
      if (conflict.conflict) {
        return {
          ok: false,
          reason: `conflicting approval records: ${conflict.reason ?? 'divergent content'}`,
          obsolete: true,
        };
      }
      planAccepted = candidates.length > 0;
    }
  }

  return {
    ok: true,
    snapshot: {
      issue,
      comments,
      epoch: trustedEpoch.record.workflow_epoch,
      view,
      planCommentId,
      planSha256: planHash,
      planAccepted,
      currentPlan,
      currentTracker,
      currentReports,
      aiState: labels[0] ?? '',
    },
  };
}

/** Find the latest marker object whose strict dispatch id is this task id. */
function findBoundComment(
  comments: CommentDetail[],
  marker: string,
  taskId: string,
): CommentDetail | null {
  const matches = findBoundComments(comments, marker, taskId);
  return matches[matches.length - 1] ?? null;
}

/** Find all marker objects whose strict dispatch id is this task id. */
function findBoundComments(
  comments: CommentDetail[],
  marker: string,
  taskId: string,
): CommentDetail[] {
  const matches: CommentDetail[] = [];
  for (const comment of comments) {
    if (detectCommentMarker(comment.body) !== marker) continue;
    const id = findDispatchId(comment.body);
    const binding = validateExpectedDispatchId(id, taskId);
    if (binding.ok) matches.push(comment);
  }
  return matches;
}
