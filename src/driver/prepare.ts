/**
 * Task preparation (schema 3): a TaskIntent becomes a fully built task
 * directory, a current.json pointer, a driver-state record and a printed
 * Manual Activation prompt.
 *
 * FROZEN CONSTRAINTS:
 * - task ids bind repository/issue/EPOCH/mode/revision (frozen grammar);
 *   dedup (shouldPrepare) runs BEFORE any filesystem write.
 * - A task directory is bound by an input snapshot hash (driver-private
 *   state): re-preparing the SAME task id with DIFFERENT input content is
 *   refused (`input-changed`) instead of silently overwriting a task an
 *   agent may already be running. Identical content rebuilds idempotently
 *   (crash between the task directory and the state record).
 * - task.json is written LAST (ready-marker convention); current.json is a
 *   MANUAL UI POINTER only and never decides task identity.
 * - ONE workspace, ONE active task: switching to a different issue while the
 *   current task is unfinished requires an explicit selection.
 * - Activation is Manual by definition: the Driver prints a prompt and
 *   returns; it never spawns or notifies a client.
 * - The Driver never calls an LLM and never transitions labels here (or
 *   anywhere) — it only prepares the workspace.
 */
import type { RepositoryInfo } from '../github/client';
import type { Mode, TaskFile } from '../workspace/protocol';
import { makeExecuteTaskId, makePlanTaskId } from '../workspace/protocol';
import { resolveWorkspace } from '../workspace/paths';
import type { WorkspacePaths } from '../workspace/paths';
import {
  inputSnapshotSha256,
  writeCurrent,
  writeTaskDir,
} from '../workspace/tasks';
import {
  getTaskRecord,
  readDriverState,
  shouldPrepare,
  withTaskRecord,
  writeDriverState,
} from '../workspace/driver-state';
import { canonicalPlanContent } from '../protocol/plan';
import { buildFeedbackMarkdown, buildTaskMarkdown } from './intent';
import { buildTaskPrompt } from './prompts';
import type { TaskIntent } from './intent';
import type { Discovery } from './discovery';
import type { DriverDeps } from './driver';

/** Result of one task preparation attempt for one intent. */
export interface PrepareOutcome {
  prepared: boolean;
  taskId: string | null;
  reason: string;
  /** The Manual Activation prompt (present when the task is usable). */
  prompt?: string;
  issueNumber?: number;
  mode?: Mode;
  issueTitle?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Prepare a single task:
 * 1. compute the frozen-grammar task id (epoch-bound);
 * 2. dedup against the driver state (already-prepared / retry-limit → no-op,
 *    but still return the prompt so a repeated `run` just reprints it);
 * 3. execute mode only: resolve the approved Plan body from the snapshot;
 * 4. refuse same-id rebuilds with changed input content;
 * 5. atomically build the task dir (task.md, plan.md?, feedback.md?,
 *    task.json LAST), write current.json, then the state record;
 * 6. return the copy-paste prompt.
 */
export async function prepareTask(
  deps: DriverDeps,
  repositoryInfo: RepositoryInfo,
  discovery: Discovery,
  intent: TaskIntent,
): Promise<PrepareOutcome> {
  const paths: WorkspacePaths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);
  const now = deps.now ?? (() => new Date());
  const { id: repositoryId, owner, name } = repositoryInfo;
  const issueNumber = intent.issueNumber;
  const repository = `${owner}/${name}`;

  const taskId =
    intent.mode === 'plan'
      ? makePlanTaskId(repositoryId, issueNumber, intent.epoch, Number(intent.revision))
      : makeExecuteTaskId(repositoryId, issueNumber, intent.epoch, intent.planCommentId ?? 0);

  const state = await readDriverState(paths);
  const existing = getTaskRecord(state, taskId);
  const verdict = shouldPrepare(existing, deps.config.driver.maxAttempts);
  if (!verdict.ok && verdict.reason !== 'already-prepared') {
    deps.log.info(`skip ${taskId}: ${verdict.reason}`);
    return { prepared: false, taskId, reason: verdict.reason, issueNumber, mode: intent.mode };
  }

  const task = buildTaskMarkdown(discovery.issue, intent.mode);
  const feedback = buildFeedbackMarkdown(discovery.feedback);

  let plan: string | null = null;
  if (intent.mode === 'execute') {
    const planComment =
      intent.planCommentId !== null
        ? (discovery.comments.find((comment) => comment.id === intent.planCommentId) ?? null)
        : null;
    if (planComment === null) {
      // Execute intents always carry a resolved plan comment id; a missing
      // comment means canonical state changed mid-cycle. Refuse to build a
      // task without the approved Plan.
      deps.log.warning(`skip ${taskId}: approved plan comment vanished mid-cycle`);
      return { prepared: false, taskId, reason: 'plan-comment-not-found', issueNumber, mode: intent.mode };
    }
    plan = canonicalPlanContent(planComment.body);
  }

  const snapshot = inputSnapshotSha256({ task, plan, feedback });

  // Snapshot binding: a same-id task with DIFFERENT input content must never
  // be silently overwritten (the agent may already be working from it).
  const existingRecordSnapshot = existing?.input_snapshot_sha256;
  if (
    existingRecordSnapshot !== undefined &&
    existingRecordSnapshot !== snapshot &&
    (existing?.status === 'prepared' || existing?.status === 'publishing' || existing?.status === 'failed')
  ) {
    deps.log.warning(
      `skip ${taskId}: input snapshot changed since the task was prepared ` +
        '(refusing to overwrite a possibly-running task)',
    );
    return { prepared: false, taskId, reason: 'input-changed', issueNumber, mode: intent.mode };
  }

  const createdAt = now().toISOString();
  const taskFile: TaskFile = {
    schema: 3,
    task_id: taskId,
    repository,
    repository_id: repositoryId,
    issue_number: issueNumber,
    workflow_epoch: intent.epoch,
    mode: intent.mode,
    reason: intent.reason,
    created_at: createdAt,
    plan_comment_id: intent.planCommentId,
    approval_comment_id: intent.approvalCommentId,
    input: {
      task: 'task.md',
      plan: plan !== null ? 'plan.md' : null,
      feedback: feedback !== null ? 'feedback.md' : null,
    },
  };

  // Ready-marker convention: writeTaskDir writes task.json LAST; the state
  // record lands after so a crash between the two still re-prepares
  // idempotently (an identical-content rebuild).
  await writeTaskDir(paths, { taskFile, task, plan, feedback });
  await writeCurrent(paths, {
    schema: 3,
    task_id: taskId,
    mode: intent.mode,
    issue_number: issueNumber,
    updated_at: createdAt,
  });
  await writeDriverState(
    paths,
    withTaskRecord(state, {
      ...(existing ?? {}),
      task_id: taskId,
      status: existing?.status === 'publishing' ? 'publishing' : 'prepared',
      attempts: (existing?.attempts ?? 0) + 1,
      mode: intent.mode,
      issue_number: issueNumber,
      workflow_epoch: intent.epoch,
      input_snapshot_sha256: snapshot,
      plan_comment_id: intent.planCommentId ?? undefined,
      approval_comment_id: intent.approvalCommentId ?? undefined,
      error: null,
    }),
  );

  const prompt = buildTaskPrompt({
    taskId,
    mode: intent.mode,
    issueNumber,
    issueTitle: discovery.issue.title,
    reason: intent.reason,
  });
  deps.log.info(
    `prepared ${taskId} (${intent.mode}/${intent.reason}) for issue #${issueNumber}`,
  );
  return {
    prepared: true,
    taskId,
    reason: verdict.reason,
    prompt,
    issueNumber,
    mode: intent.mode,
    issueTitle: discovery.issue.title,
  };
}

/**
 * Prepare THE task of this workspace (single-active-task rule):
 * 1. discover work on all open issues;
 * 2. collect every derived intent;
 * 3. selection: an explicit issue number wins; otherwise the current
 *    active task (if still pending) keeps the focus; otherwise the lowest
 *    issue number with a pending intent;
 * 4. refuse an implicit switch away from an unfinished current task.
 * A failing issue (odd GitHub payload, disk error) is logged and skipped so
 * one bad issue cannot abort the pass; cycle-level client errors still
 * propagate.
 */
export async function prepareCurrentTask(
  deps: DriverDeps,
  repositoryInfo: RepositoryInfo,
  discoveries: Discovery[],
  opts: { issue?: number } = {},
): Promise<PrepareOutcome> {
  const paths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);

  const pending: Array<{ discovery: Discovery; intent: TaskIntent }> = [];
  for (const discovery of discoveries) {
    for (const intent of discovery.intents) {
      pending.push({ discovery, intent });
    }
  }
  if (pending.length === 0) {
    return {
      prepared: false,
      taskId: null,
      reason: 'no pending task: run /ai-plan (or /change → re-plan, /approve → execute) on GitHub first',
    };
  }

  const state = await readDriverState(paths);
  const unfinished = Object.values(state.tasks).filter(
    (record) => record.status === 'prepared' || record.status === 'publishing',
  );

  let chosen: { discovery: Discovery; intent: TaskIntent } | undefined;
  if (opts.issue !== undefined) {
    chosen = pending.find((entry) => entry.intent.issueNumber === opts.issue);
    if (chosen === undefined) {
      return {
        prepared: false,
        taskId: null,
        reason: `issue #${opts.issue} has no pending task (its state may be review/working/done, or it is not in the workflow)`,
      };
    }
  } else {
    const current = unfinished.sort((a, b) => a.issue_number - b.issue_number)[0];
    if (current !== undefined) {
      chosen = pending.find((entry) => entry.intent.issueNumber === current.issue_number);
      if (chosen === undefined) {
        return {
          prepared: false,
          taskId: current.task_id,
          reason:
            `the current task ${current.task_id} (issue #${current.issue_number}) is still unfinished ` +
            '(prepare → AI → sync). Finish it, run `gateflow retry ' +
            current.task_id + '`, or select explicitly with --issue.',
        };
      }
    } else {
      chosen = pending.sort((a, b) => a.intent.issueNumber - b.intent.issueNumber)[0];
    }
  }
  if (chosen === undefined) {
    return { prepared: false, taskId: null, reason: 'no pending task matched the selection' };
  }

  try {
    return await prepareTask(deps, repositoryInfo, chosen.discovery, chosen.intent);
  } catch (err) {
    deps.log.error(
      `preparation failed for issue #${chosen.intent.issueNumber} ` +
        `(${chosen.intent.mode}/${chosen.intent.revision}): ${errorMessage(err)}`,
    );
    return {
      prepared: false,
      taskId: null,
      reason: `preparation failed: ${errorMessage(err)}`,
      issueNumber: chosen.intent.issueNumber,
      mode: chosen.intent.mode,
    };
  }
}
