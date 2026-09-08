/**
 * Dispatch: a DispatchIntent becomes a fully built inbox directory, a
 * current.json pointer, a receipt and an activation notice (docs/
 * architecture-v1.md §3.1-§3.4, workspace-protocol.md §6).
 *
 * SCHEMA 2 FROZEN CONSTRAINTS (docs/plans/v1_hardening_decisions.md):
 * - dispatch_id binds repository/issue/EPOCH/role/revision (frozen grammar);
 *   dedup runs BEFORE any filesystem write.
 * - The inbox is bound by an input snapshot hash (context.json +
 *   receipt): re-dispatching the SAME dispatch id with DIFFERENT content is
 *   refused (`input-changed`) instead of silently overwriting a task an
 *   agent may already be running. Identical content rebuilds idempotently
 *   (crash between inbox and receipt).
 * - dispatch.json is written LAST (ready-marker convention); current.json is
 *   a MANUAL UI POINTER only and never decides task identity — prompts and
 *   skills point at `.gateflow/inbox/<id>/dispatch.json`.
 * - One workspace, one active Executor: an executor dispatch is refused with
 *   `workspace-executor-busy` while the worktree's executor lock is held by
 *   a live dispatch (queueing, never preemption).
 * - Activation is best-effort and only ever recorded as
 *   notified/started/failed — NEVER as "the agent accepted the task"
 *   (hardening §9). Activation failure never fails the dispatch.
 * - The Driver never calls an LLM and never transitions labels here (or
 *   anywhere) — it only prepares the workspace and wakes a client.
 */
import type { RepositoryInfo } from '../github/client';
import { resolveAdapterForAgent, toActivationDispatch } from '../activation';
import type { Dispatch, WorkspaceContext } from '../workspace/protocol';
import { makeConsumerDispatchId, makeExecutorDispatchId } from '../workspace/protocol';
import { resolveWorkspace } from '../workspace/paths';
import { inputSnapshotSha256, readInboxDispatch, readInboxContext, sha256Hex, writeCurrent, writeInbox } from '../workspace/inbox';
import type { InboxBuild } from '../workspace/inbox';
import { readReceipt, writeReceipt } from '../workspace/outbox';
import { buildFeedbackMarkdown, buildTaskMarkdown } from './intent';
import { canonicalPlanContent } from '../protocol/plan';
import { discoverWork } from './discovery';
import { shouldDispatch } from './dedup';
import { acquireLock, releaseLock, executorLockFile, DRIVER_LOCK_HOLDER } from './workspace-lock';
import type { DispatchIntent } from './intent';
import type { Discovery } from './discovery';
import type { DriverDeps } from './driver';

/** Result of one dispatch attempt for one intent. */
export interface DispatchOutcome {
  dispatched: boolean;
  dispatchId: string | null;
  reason: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dispatch a single intent:
 * 1. compute the frozen-grammar dispatch_id (epoch-bound);
 * 2. dedup against the receipt (already-dispatched / retry-limit → no-op);
 * 3. executors only: acquire the per-worktree executor lock (queue on
 *    conflict);
 * 4. atomically build the inbox (TASK.md, PLAN.md?, FEEDBACK.md?, context,
 *    dispatch.json LAST) — refusing content-changed same-id rebuilds;
 * 5. write current.json (manual pointer), then the receipt;
 * 6. notify the role's activation adapter (failures logged, never thrown).
 */
export async function dispatchIntent(
  deps: DriverDeps,
  repositoryInfo: RepositoryInfo,
  discovery: Discovery,
  intent: DispatchIntent,
): Promise<DispatchOutcome> {
  const paths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);
  const now = deps.now ?? (() => new Date());
  const { id: repositoryId, owner, name } = repositoryInfo;
  const issueNumber = intent.issueNumber;
  const repository = `${owner}/${name}`;

  const dispatchId =
    intent.role === 'consumer'
      ? makeConsumerDispatchId(repositoryId, issueNumber, intent.epoch, Number(intent.revision))
      : makeExecutorDispatchId(repositoryId, issueNumber, intent.epoch, intent.planCommentId ?? 0);

  const existing = await readReceipt(paths, dispatchId);
  const verdict = shouldDispatch(existing, deps.config.driver.maxAttempts);
  if (!verdict.ok) {
    deps.log.info(`skip ${dispatchId}: ${verdict.reason}`);
    return { dispatched: false, dispatchId, reason: verdict.reason };
  }

  const task = buildTaskMarkdown(discovery.issue, intent.role);
  const feedback = buildFeedbackMarkdown(discovery.feedback);

  let plan: string | null = null;
  if (intent.role === 'executor') {
    const planComment =
      intent.planCommentId !== null
        ? (discovery.comments.find((comment) => comment.id === intent.planCommentId) ?? null)
        : null;
    if (planComment === null) {
      // Executor intents always carry a resolved plan comment id; a missing
      // comment means canonical state changed mid-cycle. Refuse to build an
      // inbox without the approved Plan (docs §2.1: executor input.plan is
      // mandatory).
      deps.log.warning(`skip ${dispatchId}: approved plan comment vanished mid-cycle`);
      return { dispatched: false, dispatchId, reason: 'plan-comment-not-found' };
    }
    plan = canonicalPlanContent(planComment.body);
  }

  // Executors hold the per-worktree lock for their whole active life; a
  // second executor dispatch queues (skipped, retried next cycle). A RETRY
  // of the same dispatch id first releases the lock this Driver still holds
  // from the failed attempt (retryDispatch also releases it on the explicit
  // path; this covers automatic retries below max_attempts).
  let lockAcquired = false;
  if (intent.role === 'executor') {
    if (existing !== null && existing.dispatch_id === dispatchId) {
      await releaseLock(executorLockFile(paths), DRIVER_LOCK_HOLDER, dispatchId);
    }
    // V1.1 Phase 7: executor locks carry their dispatch/epoch/workspace and
    // are NEVER stolen by time or by a dead pid — a dead-holder lock yields
    // `workspace-executor-conflict` and waits for the explicit human unlock.
    const lock = await acquireLock(
      executorLockFile(paths),
      DRIVER_LOCK_HOLDER,
      {
        dispatchId,
        workflowEpoch: intent.epoch,
        workspace: paths.root,
        kind: 'executor',
      },
      now,
    );
    if (!lock.ok) {
      const reason =
        lock.failure === 'workspace-conflict' ? 'workspace-executor-conflict' : 'workspace-executor-busy';
      deps.log.warning(
        `skip ${dispatchId}: ${reason} ` +
          `(holder ${lock.holder ? `${lock.holder.holder} pid ${lock.holder.pid}` : 'unknown'})`,
      );
      return { dispatched: false, dispatchId, reason };
    }
    lockAcquired = true;
  }

  const snapshot = inputSnapshotSha256({ task, plan, feedback });

  // Snapshot binding: a same-id inbox with DIFFERENT content must never be
  // silently overwritten (the agent may already be working from it).
  const existingDispatch = await readInboxDispatch(paths, dispatchId);
  if (existingDispatch !== null) {
    const existingContext = await readInboxContext(paths, dispatchId);
    const existingSnapshot = existingContext?.input_snapshot_sha256;
    if (existingSnapshot !== undefined && existingSnapshot !== snapshot) {
      if (lockAcquired) await releaseLock(executorLockFile(paths), DRIVER_LOCK_HOLDER, dispatchId);
      deps.log.warning(
        `skip ${dispatchId}: input snapshot changed since the inbox was built ` +
          '(refusing to overwrite a possibly-running task)',
      );
      return { dispatched: false, dispatchId, reason: 'input-changed' };
    }
  }

  const createdAt = now().toISOString();
  const dispatch: Dispatch = {
    schema: 2,
    dispatch_id: dispatchId,
    repository,
    repository_id: repositoryId,
    issue_number: issueNumber,
    workflow_epoch: intent.epoch,
    role: intent.role,
    reason: intent.reason,
    created_at: createdAt,
    plan_comment_id: intent.planCommentId,
    approval_comment_id: intent.approvalCommentId,
    input: {
      task: 'TASK.md',
      plan: plan !== null ? 'PLAN.md' : null,
      feedback: feedback !== null ? 'FEEDBACK.md' : null,
    },
  };
  const context: WorkspaceContext = {
    schema: 2,
    dispatch_id: dispatchId,
    workflow_epoch: intent.epoch,
    ...(intent.role === 'executor' && intent.planCommentId !== null && plan !== null
      ? { plan_comment_id: intent.planCommentId, plan_sha256: intent.planSha256 ?? sha256Hex(plan) }
      : {}),
    feedback_count: discovery.feedback.length,
    input_snapshot_sha256: snapshot,
  };

  const build: InboxBuild = { dispatch, context, task, plan, feedback };

  // Ready-marker convention (docs §6): writeInbox writes dispatch.json LAST;
  // current.json then points agents at the dispatch; the receipt lands after
  // so a crash between inbox and receipt still re-dispatches idempotently
  // (the inbox rebuild is a full overwrite of IDENTICAL content).
  await writeInbox(paths, build);
  await writeCurrent(paths, {
    schema: 2,
    dispatch_id: dispatchId,
    role: intent.role,
    issue_number: issueNumber,
    updated_at: createdAt,
  });
  await writeReceipt(paths, {
    ...(existing ?? {}),
    dispatch_id: dispatchId,
    status: 'dispatched',
    attempts: (existing?.attempts ?? 0) + 1,
    workflow_epoch: intent.epoch,
    plan_comment_id: intent.planCommentId ?? undefined,
    approval_comment_id: intent.approvalCommentId ?? undefined,
    input_snapshot_sha256: snapshot,
    error: null,
  });

  // Activation is best-effort by design (architecture §3.4 note): a failed
  // wake-up leaves the issue in its canonical state with a valid inbox. The
  // observation is truthful by construction: notified/started/failed — it is
  // never a claim that the agent accepted the task (hardening §9).
  const agentName =
    intent.role === 'consumer' ? deps.config.routing.consumer : deps.config.routing.executor;
  const adapter = resolveAdapterForAgent(
    agentName ?? '__none__',
    deps.config.agents,
    deps.config.activation.fallback,
  );
  let activation: { adapter: string; state: 'notified' | 'started' | 'failed'; detail?: string; at: string } = {
    adapter: adapter.name,
    state: 'failed',
    detail: 'activation not attempted',
    at: createdAt,
  };
  try {
    const result = await adapter.notify(
      toActivationDispatch({
        dispatch_id: dispatchId,
        role: intent.role,
        issue_number: issueNumber,
        repository,
      }),
      deps.projectRoot,
    );
    activation = {
      adapter: adapter.name,
      state: result.state,
      detail: result.detail,
      at: now().toISOString(),
    };
    if (result.state === 'failed') {
      deps.log.warning(`activation '${adapter.name}' failed for ${dispatchId}: ${result.detail}`);
    } else {
      deps.log.info(`activation '${adapter.name}' ${result.state} for ${dispatchId}: ${result.detail}`);
    }
  } catch (err) {
    activation = {
      adapter: adapter.name,
      state: 'failed',
      detail: errorMessage(err),
      at: now().toISOString(),
    };
    deps.log.warning(`activation adapter threw for ${dispatchId} (dispatch stays valid): ${errorMessage(err)}`);
  }
  const currentReceipt = await readReceipt(paths, dispatchId);
  await writeReceipt(paths, {
    ...(currentReceipt ?? {}),
    dispatch_id: dispatchId,
    status: currentReceipt?.status ?? 'dispatched',
    attempts: currentReceipt?.attempts ?? 1,
    activation,
  });

  deps.log.info(`dispatched ${dispatchId} (${intent.role}/${intent.reason}) for issue #${issueNumber}`);
  return { dispatched: true, dispatchId, reason: verdict.reason };
}

/**
 * One full dispatch pass: discover work on all open issues and dispatch each
 * derived intent sequentially. A failing issue (odd GitHub payload, disk
 * error) is logged and skipped so one bad issue cannot abort the cycle;
 * cycle-level client errors (listOpenIssues itself) still propagate.
 */
export async function processIntents(
  deps: DriverDeps,
  repositoryInfo: RepositoryInfo,
): Promise<DispatchOutcome[]> {
  const repository = `${repositoryInfo.owner}/${repositoryInfo.name}`;
  const discoveries = await discoverWork(deps.client, repository, deps.config, repositoryInfo, deps.log);
  const outcomes: DispatchOutcome[] = [];
  for (const discovery of discoveries) {
    for (const intent of discovery.intents) {
      try {
        outcomes.push(await dispatchIntent(deps, repositoryInfo, discovery, intent));
      } catch (err) {
        deps.log.error(
          `dispatch failed for issue #${discovery.issue.number} ` +
            `(${intent.role}/${intent.revision}): ${errorMessage(err)}`,
        );
      }
    }
  }
  return outcomes;
}
