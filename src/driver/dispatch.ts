/**
 * Dispatch: a DispatchIntent becomes a fully built inbox directory, a
 * current.json pointer, a receipt and an activation notice (docs/
 * architecture-v1.md §3.1-§3.4, workspace-protocol.md §6).
 *
 * FROZEN CONSTRAINTS:
 * - dispatch_id comes from the frozen grammar (docs §3): consumer rounds are
 *   zero-padded `01`-style revisions, executor revisions bind the approved
 *   Plan comment (`p<id>`). Dedup runs BEFORE any filesystem write.
 * - Inbox writes are atomic and dispatch.json is written LAST by writeInbox
 *   (ready-marker convention, docs §6); current.json follows, then the
 *   receipt. A crash mid-way leaves no "ready" inbox without a receipt.
 * - Activation failure must NEVER fail the dispatch (architecture §3.4):
 *   the issue keeps its canonical label state, the inbox stays valid, and a
 *   human can always act on current.json. We log and continue.
 * - The Driver never calls an LLM and never transitions labels here (or
 *   anywhere) — it only prepares the workspace and wakes a client.
 */
import type { RepositoryInfo } from '../github/client';
import { resolveAdapterForAgent, toActivationDispatch } from '../activation';
import type { Dispatch, WorkspaceContext } from '../workspace/protocol';
import { makeConsumerDispatchId, makeExecutorDispatchId } from '../workspace/protocol';
import { resolveWorkspace } from '../workspace/paths';
import { sha256Hex, writeCurrent, writeInbox } from '../workspace/inbox';
import type { InboxBuild } from '../workspace/inbox';
import { readReceipt, writeReceipt } from '../workspace/outbox';
import { buildFeedbackMarkdown, buildTaskMarkdown, extractPlanContent } from './intent';
import { discoverWork } from './discovery';
import { shouldDispatch } from './dedup';
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
 * 1. compute the frozen-grammar dispatch_id;
 * 2. dedup against the receipt (already-dispatched / retry-limit → no-op);
 * 3. atomically build the inbox (TASK.md, PLAN.md?, FEEDBACK.md?, context,
 *    dispatch.json LAST), write current.json, then the receipt;
 * 4. notify the role's activation adapter (failures logged, never thrown).
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
      ? makeConsumerDispatchId(repositoryId, issueNumber, Number(intent.revision))
      : makeExecutorDispatchId(repositoryId, issueNumber, intent.planCommentId ?? 0);

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
    plan = extractPlanContent(planComment.body);
  }

  const createdAt = now().toISOString();
  const dispatch: Dispatch = {
    schema: 1,
    dispatch_id: dispatchId,
    repository,
    repository_id: repositoryId,
    issue_number: issueNumber,
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
    schema: 1,
    dispatch_id: dispatchId,
    ...(intent.role === 'executor' && intent.planCommentId !== null && plan !== null
      ? { plan_comment_id: intent.planCommentId, plan_sha256: sha256Hex(plan) }
      : {}),
    feedback_count: discovery.feedback.length,
  };

  const build: InboxBuild = { dispatch, context, task, plan, feedback };
  // Ready-marker convention (docs §6): writeInbox writes dispatch.json LAST;
  // current.json then points agents at the dispatch; the receipt lands after
  // so a crash between inbox and receipt still re-dispatches idempotently
  // (the inbox rebuild is a full overwrite).
  await writeInbox(paths, build);
  await writeCurrent(paths, {
    schema: 1,
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
    error: null,
  });

  // Activation is best-effort by design (architecture §3.4 note): a failed
  // wake-up leaves the issue in its canonical state with a valid inbox.
  const agentName =
    intent.role === 'consumer' ? deps.config.routing.consumer : deps.config.routing.executor;
  const adapter = resolveAdapterForAgent(
    agentName ?? '__none__',
    deps.config.agents,
    deps.config.activation.fallback,
  );
  try {
    const activation = await adapter.notify(
      toActivationDispatch({
        dispatch_id: dispatchId,
        role: intent.role,
        issue_number: issueNumber,
        repository,
      }),
      deps.projectRoot,
    );
    if (activation.notified) {
      deps.log.info(`activation '${adapter.name}' notified for ${dispatchId}: ${activation.detail}`);
    } else {
      deps.log.warning(`activation '${adapter.name}' could not notify for ${dispatchId}: ${activation.detail}`);
    }
  } catch (err) {
    deps.log.warning(`activation adapter threw for ${dispatchId} (dispatch stays valid): ${errorMessage(err)}`);
  }

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
  const discoveries = await discoverWork(deps.client, repository, deps.config, deps.log);
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
