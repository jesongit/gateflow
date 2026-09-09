/**
 * Task output → GitHub sync engine — the security-critical path (protocol
 * schema 3; hardening phases 4+5 kept intact).
 *
 * FROZEN CONSTRAINTS enforced here, in order, for EVERY task:
 * 1. UNKNOWN TASK IDS ARE REJECTED: a task directory with no valid
 *    task.json is never synced, no matter what it contains.
 * 2. DRIVER-STATE PREREQUISITE: a task with no driver-state record was never
 *    prepared by this Driver — it is never synced (recovery: `gateflow run`).
 * 3. VALIDATION BEFORE ANY SYNC: result.json must pass the frozen validator
 *    — schema, task_id/mode agreement, status whitelist and the human-only
 *    blacklist (`approve` / `ready` / `cancel` / `human-close` can never
 *    enter GitHub through an agent file). Invalid → `rejected`: log, never
 *    throw, never sync.
 * 4. INPUT BINDING BEFORE ANY SYNC: the input files (task.md, execute-mode
 *    plan.md, feedback.md) must still hash to the snapshot recorded at
 *    preparation time. A mismatch means the agent modified its inputs →
 *    rejected, never published.
 * 5. PREFLIGHT BEFORE ANY STATE-RELEVANT WRITE: the unified `runPreflight`
 *    re-reads canonical state and validates the task's epoch/plan/approval
 *    binding. Obsolete tasks (cancel, new epoch, plan change, closed issue)
 *    are refused and marked `obsolete`; unprovable states fail closed for
 *    this cycle.
 * 6. OPERATION RECONCILIATION: every publish first searches for an existing
 *    remote object by its Operation identity — found + same content →
 *    adopt; found + different content → CONFLICT (record failed, never
 *    overwrite); absent → publish, confirm, then persist the record. API
 *    timeouts reconcile next cycle, never blind-retry.
 * 7. CONTENT FILES ARE PASSTHROUGH ONLY; NO STATE TRANSITIONS: the Driver
 *    publishes protocol comments — the Gate alone moves labels.
 *    `published` (remote object confirmed) and `accepted` (Gate observed
 *    the state migration) are distinct record states; an agent's completed
 *    claim is never DONE.
 *
 * GitHub errors (network, auth, rate limit) are infrastructure failures and
 * propagate to the caller; only validation/rejected paths return without
 * throwing.
 */
import type { RepositoryInfo, CommentDetail, IssueRef } from '../github/client';
import {
  publishCompletionReport,
  publishPlanComment,
  publishTrackerComment,
  findTrackerComment,
  findPlanComments,
  findCompletionReportComments,
  updateTracker,
} from '../github/issue-sync';
import { buildTrackerCommentBody } from '../github/comments';
import type { TaskFile, TaskRecord, ResultFile, DriverStateFile } from '../workspace/protocol';
import { resolveWorkspace, listTaskDirs } from '../workspace/paths';
import type { WorkspacePaths } from '../workspace/paths';
import { readTaskFile, readResultJson, readInputMarkdown, readOutputMarkdown, inputSnapshotSha256, sha256Hex } from '../workspace/tasks';
import {
  getTaskRecord,
  readDriverState,
  withTaskRecord,
  writeDriverState,
  withoutTaskRecord,
} from '../workspace/driver-state';
import { OversizedFileError, validateResultForTask } from '../workspace/validation';
import { canonicalPlanContent } from '../protocol/plan';
import { runPreflight, type SyncSnapshot } from './preflight';
import type { DriverDeps } from './driver';

/** All sync actions. */
export type SyncAction =
  | 'plan-published'
  | 'tracker-created'
  | 'blocked'
  | 'resumed'
  | 'completed'
  | 'accepted'
  | 'notice'
  | 'skipped'
  | 'rejected'
  | 'obsolete'
  | 'unchanged';

/** Result of syncing one task directory. */
export type SyncOutcome = {
  taskId: string;
  action: SyncAction;
  detail: string;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Plain-text (marker-free) Driver notice; the Gate never parses these. */
function noticeBody(mode: string, what: string, taskId: string, reason: string): string {
  return `[gateflow] ${mode} ${what} (task ${taskId}): ${reason}`;
}

/** sha256 prefix identifying one notice payload (Operation dedup key). */
function noticeKey(body: string): string {
  return sha256Hex(body).slice(0, 16);
}

/** Record skeleton preserving prior cache fields. */
function recordBase(record: TaskRecord | null, taskId: string): TaskRecord {
  return {
    ...(record ?? {}),
    task_id: taskId,
    status: record?.status ?? 'prepared',
    attempts: record?.attempts ?? 1,
    mode: record?.mode ?? 'plan',
    issue_number: record?.issue_number ?? 0,
    workflow_epoch: record?.workflow_epoch ?? '',
  };
}

/**
 * Read an output markdown file; oversize is a validation failure (null +
 * flag).
 */
async function readOutputCapped(
  paths: WorkspacePaths,
  taskId: string,
  name: 'plan.md' | 'report.md',
): Promise<{ content: string | null; error: string | null }> {
  try {
    return { content: await readOutputMarkdown(paths, taskId, name), error: null };
  } catch (err) {
    if (err instanceof OversizedFileError) {
      return { content: null, error: errorMessage(err) };
    }
    throw err;
  }
}

/**
 * Verify the task's input files still hash to the snapshot recorded at
 * preparation time. Returns the detail when the binding is broken; null
 * when it holds.
 */
async function inputBindingFailure(
  paths: WorkspacePaths,
  taskId: string,
  task: TaskFile,
  record: TaskRecord,
): Promise<string | null> {
  if (record.input_snapshot_sha256 === undefined) {
    return 'the driver-state record carries no input snapshot (stale state; re-run `gateflow run`)';
  }
  const taskMd = await readInputMarkdown(paths, taskId, 'task.md');
  if (taskMd === null) {
    return 'task.md is missing or empty — the task inputs were modified';
  }
  let plan: string | null = null;
  if (task.mode === 'execute') {
    plan = await readInputMarkdown(paths, taskId, 'plan.md');
    if (plan === null) {
      return 'plan.md is missing or empty — the approved plan input was modified';
    }
  }
  const feedback = await readInputMarkdown(paths, taskId, 'feedback.md');
  const snapshot = inputSnapshotSha256({ task: taskMd, plan, feedback });
  if (snapshot !== record.input_snapshot_sha256) {
    return 'the input files no longer match the snapshot recorded at preparation time (refusing to sync from modified inputs)';
  }
  return null;
}

/**
 * Locate the tracker comment for a task: the record's id first, then a
 * marker+task-id scan (crash recovery). Returns the comment list too so
 * callers avoid a second round-trip.
 */
function resolveTrackerFrom(
  comments: CommentDetail[],
  taskId: string,
  record: TaskRecord | null,
): CommentDetail | null {
  if (record?.tracker_comment_id !== undefined) {
    const found = comments.find((comment) => comment.id === record.tracker_comment_id);
    if (found !== undefined) return found;
  }
  return findTrackerComment(comments, taskId);
}

/**
 * Sync one task: task.json check → driver-state check → result validation →
 * INPUT BINDING → PREFLIGHT → acceptance observation (published → accepted)
 * → replay check → mode-specific, operation-reconciled publication + record.
 */
export async function syncTask(
  deps: DriverDeps,
  repositoryInfo: RepositoryInfo,
  taskId: string,
): Promise<SyncOutcome> {
  const paths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);
  const now = deps.now ?? (() => new Date());
  const nowIso = now().toISOString();

  // (1) Unknown task ids are rejected.
  const task = await readTaskFile(paths, taskId);
  if (task === null) {
    return {
      taskId,
      action: 'rejected',
      detail: 'no valid task.json for this id (unknown task — run `gateflow run` first)',
    };
  }

  // (2) Driver-state prerequisite.
  const state = await readDriverState(paths);
  const record = getTaskRecord(state, taskId);
  if (record === null) {
    return {
      taskId,
      action: 'rejected',
      detail: 'no driver-state record for this task (never prepared here — run `gateflow run` first)',
    };
  }

  // (3) Validation before any sync. Human-only values die here. (The replay
  // guard runs AFTER the acceptance observation so a published-but-
  // unconfirmed record can still advance to `accepted`; a rejected
  // validation performs no GitHub write either way.)
  const rawResult = await readResultJson(paths, taskId);
  if (rawResult !== null && rawResult.error !== null) {
    deps.log.warning(`rejected ${taskId}: unparseable result.json — ${rawResult.error}`);
    return { taskId, action: 'rejected', detail: `unparseable result.json: ${rawResult.error}` };
  }
  let result: ResultFile | null = null;
  if (rawResult !== null) {
    const checked = validateResultForTask(rawResult.raw, { taskId, mode: task.mode });
    if (!checked.ok) {
      const detail = checked.errors.join('; ');
      deps.log.warning(`rejected ${taskId}: invalid result.json — ${detail}`);
      return { taskId, action: 'rejected', detail: `invalid result.json: ${detail}` };
    }
    result = checked.value;
  }

  // (4) Input binding: the agent must not have modified its inputs.
  const binding = await inputBindingFailure(paths, taskId, task, record);
  if (binding !== null) {
    deps.log.warning(`rejected ${taskId}: ${binding}`);
    return { taskId, action: 'rejected', detail: binding };
  }

  // (5) PREFLIGHT: current-task authorization before any GitHub write.
  const preflight = await runPreflight(deps.client, repositoryInfo, task, {
    gateLogins: new Set(deps.config.gateLogins.map((login) => login.toLowerCase())),
    trustedHumans: new Set([
      repositoryInfo.owner.toLowerCase(),
      ...deps.config.trustedHumans.map((login) => login.toLowerCase()),
    ]),
    repoOwner: repositoryInfo.owner,
  });
  if (!preflight.ok) {
    if (preflight.obsolete) {
      await writeDriverState(paths, {
        ...withTaskRecord(state, {
          ...recordBase(record, taskId),
          status: 'obsolete',
          error: preflight.reason,
          last_sync_at: nowIso,
        }),
      });
      deps.log.warning(`obsolete ${taskId}: ${preflight.reason}`);
      return { taskId, action: 'obsolete', detail: preflight.reason };
    }
    // Fail closed for this cycle (tampering / unprovable state): keep the
    // record as-is so the condition stays visible and re-checked.
    deps.log.warning(`blocked ${taskId} (preflight): ${preflight.reason}`);
    return { taskId, action: 'rejected', detail: `preflight: ${preflight.reason}` };
  }
  const snapshot = preflight.snapshot;

  // (6) Acceptance observation: a `published` record whose Gate acceptance is
  // now visible moves to `accepted`. This is the ONLY path to `accepted`; it
  // reads canonical state (never agent claims) and MUST precede the replay
  // guard — otherwise `published` could never advance.
  //   - Plan: the Gate issued an approval record for THIS task's plan
  //     comment (the only durable signal that the specific plan bytes were
  //     accepted — a feedback-round re-plan never re-fires T1).
  //   - Report: the Gate consumed the completion report (label ai:done).
  if (record.status === 'published' && record.published_comment_id !== undefined) {
    const isPlanAccepted =
      task.mode === 'plan' &&
      snapshot.view.approvals.some(
        (entry) =>
          entry.record.workflow_epoch === snapshot.epoch &&
          entry.record.plan_comment_id === record.published_comment_id,
      );
    const isReportAccepted = task.mode === 'execute' && snapshot.aiState === 'ai:done';
    if (isPlanAccepted || isReportAccepted) {
      await writeDriverState(paths, {
        ...withTaskRecord(state, {
          ...recordBase(record, taskId),
          status: 'accepted',
          last_sync_at: nowIso,
        }),
      });
      return { taskId, action: 'accepted', detail: `Gate accepted the ${task.mode} output (${snapshot.aiState})` };
    }
  }

  // (7) Replay protection: published/accepted records never re-publish;
  // later result.json overwrites are not accepted.
  if (record.status === 'published' || record.status === 'accepted') {
    return {
      taskId,
      action: 'skipped',
      detail: `record already ${record.status} — later result overwrites are not accepted`,
    };
  }

  if (task.mode === 'plan') {
    return syncPlanMode(deps, ref(repositoryInfo, task.issue_number), paths, state, taskId, task, record, result, snapshot, nowIso);
  }
  return syncExecuteMode(deps, ref(repositoryInfo, task.issue_number), paths, state, taskId, task, record, result, snapshot, nowIso);
}

function ref(repositoryInfo: RepositoryInfo, issueNumber: number): IssueRef {
  return { owner: repositoryInfo.owner, repo: repositoryInfo.name, issueNumber };
}

async function persistRecord(
  paths: WorkspacePaths,
  state: DriverStateFile,
  record: TaskRecord,
): Promise<void> {
  await writeDriverState(paths, withTaskRecord(state, record));
}

/**
 * Plan-mode sync: plan publication + plain notices only. The agent's plan.md
 * is passed through verbatim into a Plan comment (T1 trigger).
 */
async function syncPlanMode(
  deps: DriverDeps,
  issueRef: IssueRef,
  paths: WorkspacePaths,
  state: DriverStateFile,
  taskId: string,
  task: TaskFile,
  record: TaskRecord,
  result: ResultFile | null,
  snapshot: SyncSnapshot,
  nowIso: string,
): Promise<SyncOutcome> {
  if (result !== null) {
    if (result.status === 'completed') {
      // State matrix: a plan may only be published while the issue sits in
      // PLANNING or REVIEW (a feedback round re-publishes into REVIEW;
      // anything else is a stale task).
      if (snapshot.aiState !== 'ai:planning' && snapshot.aiState !== 'ai:review') {
        return {
          taskId,
          action: 'unchanged',
          detail: `plan publication requires ai:planning|ai:review, current state is ${snapshot.aiState}`,
        };
      }
      const plan = await readOutputCapped(paths, taskId, 'plan.md');
      if (plan.error !== null) {
        return { taskId, action: 'rejected', detail: `plan.md rejected: ${plan.error}` };
      }
      if (plan.content === null) {
        return { taskId, action: 'rejected', detail: 'status=completed but plan.md is missing or empty' };
      }

      // Operation reconciliation: adopt / conflict / publish.
      const reconciliation = reconcileMarkerComment(snapshot.comments, taskId, plan.content, 'plan');
      if (reconciliation.verdict === 'conflict') {
        await persistRecord(paths, state, {
          ...recordBase(record, taskId),
          status: 'failed',
          error: reconciliation.detail,
          last_sync_at: nowIso,
        });
        deps.log.error(`conflict ${taskId}: ${reconciliation.detail}`);
        return { taskId, action: 'rejected', detail: reconciliation.detail };
      }
      let commentId: number;
      if (reconciliation.verdict === 'adopt') {
        commentId = reconciliation.comment.id;
        deps.log.info(`reconciled ${taskId}: adopting existing plan comment #${commentId}`);
      } else {
        await persistRecord(paths, state, {
          ...recordBase(record, taskId),
          status: 'publishing',
          last_sync_at: nowIso,
        });
        const published = await publishPlanComment(deps.client, issueRef, plan.content, taskId);
        commentId = published.id;
      }
      await persistRecord(paths, state, {
        ...recordBase(record, taskId),
        status: 'published',
        published_comment_id: commentId,
        last_sync_at: nowIso,
        error: null,
      });
      return {
        taskId,
        action: 'plan-published',
        detail: `plan comment #${commentId} published for issue #${issueRef.issueNumber} (awaiting Gate acceptance)`,
      };
    }
    // blocked | question | failed — plain notice, no marker, nothing for the
    // Gate to parse. Notices are non-state-bearing: they never move the
    // record to `published`; the dedup key prevents re-posting every cycle.
    const body = noticeBody('plan', result.status, taskId, result.reason ?? '(no reason given)');
    const key = noticeKey(body);
    if (record.last_notice_key === key) {
      return { taskId, action: 'unchanged', detail: 'notice already posted for this result' };
    }
    await deps.client.addIssueComment(issueRef, body);
    await persistRecord(paths, state, {
      ...recordBase(record, taskId),
      last_notice_key: key,
      last_sync_at: nowIso,
    });
    return { taskId, action: 'notice', detail: `plan ${result.status} notice posted` };
  }

  return {
    taskId,
    action: 'unchanged',
    detail: 'no result.json yet; the agent has not reported a terminal result',
  };
}

/**
 * Execute-mode sync: completion report publication, blocked reporting, and
 * the minimal tracker lifecycle (create on start / Blocked on a blocked
 * result / resume before a report). Every publication is
 * operation-reconciled; `published` ≠ `accepted`.
 */
async function syncExecuteMode(
  deps: DriverDeps,
  issueRef: IssueRef,
  paths: WorkspacePaths,
  state: DriverStateFile,
  taskId: string,
  task: TaskFile,
  record: TaskRecord,
  result: ResultFile | null,
  snapshot: SyncSnapshot,
  nowIso: string,
): Promise<SyncOutcome> {
  if (result !== null) {
    if (result.status === 'completed') {
      // Agent claims need real verification: validation:'failed' is never
      // published as a completion (the claim itself is a Claim — only the
      // Gate transitions to DONE, and `published` ≠ `accepted`).
      if (result.validation !== 'passed') {
        return {
          taskId,
          action: 'rejected',
          detail: `status=completed requires validation="passed", got ${JSON.stringify(result.validation ?? null)}`,
        };
      }
      // State matrix: reports publish from PLANNING-side READY (the tracker
      // is ensured first so the Gate fires T3 before T6 — comment events are
      // processed in creation order), from WORKING, or from BLOCKED (a T5
      // resume edit precedes the report).
      if (
        snapshot.aiState !== 'ai:ready' &&
        snapshot.aiState !== 'ai:working' &&
        snapshot.aiState !== 'ai:blocked'
      ) {
        return {
          taskId,
          action: 'unchanged',
          detail: `completion report requires ai:ready|ai:working|ai:blocked, current state is ${snapshot.aiState}`,
        };
      }
      const report = await readOutputCapped(paths, taskId, 'report.md');
      if (report.error !== null) {
        return { taskId, action: 'rejected', detail: `report.md rejected: ${report.error}` };
      }
      if (report.content === null) {
        return { taskId, action: 'rejected', detail: 'status=completed but report.md is missing or empty' };
      }

      // The report must not be an orphan: a tracker MUST exist before the
      // report publishes, so the issue legally traverses T3 (READY→WORKING)
      // before T6 (WORKING→DONE). A completed claim without a tracker gets
      // a lawful tracker here, never a bare report that cannot trigger DONE.
      let tracker = resolveTrackerFrom(snapshot.comments, taskId, record);
      let trackerId: number | undefined = tracker?.id;
      if (tracker === null) {
        const created = await publishTrackerComment(deps.client, issueRef, {
          taskId,
          issueNumber: issueRef.issueNumber,
        });
        trackerId = created.id;
        tracker = {
          id: created.id,
          user: 'gateflow-driver',
          body: buildTrackerCommentBody({ taskId, issueNumber: issueRef.issueNumber, status: 'In Progress', progressMarkdown: '' }),
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        deps.log.info(`repaired ${taskId}: lawful tracker #${created.id} created before report publication`);
      }

      // Blocked → resume first (T5), so T6's from-state (WORKING) holds.
      if (snapshot.aiState === 'ai:blocked') {
        await updateTracker(deps.client, issueRef, tracker.id, tracker.body, { status: 'In Progress' });
        deps.log.info(`resumed ${taskId}: tracker #${tracker.id} set back to In Progress before the report (T5)`);
      }

      // Operation reconciliation for the REPORT.
      const reconciliation = reconcileMarkerComment(snapshot.comments, taskId, report.content, 'report');
      if (reconciliation.verdict === 'conflict') {
        await persistRecord(paths, state, {
          ...recordBase(record, taskId),
          status: 'failed',
          error: reconciliation.detail,
          last_sync_at: nowIso,
        });
        deps.log.error(`conflict ${taskId}: ${reconciliation.detail}`);
        return { taskId, action: 'rejected', detail: reconciliation.detail };
      }
      let reportId: number;
      if (reconciliation.verdict === 'adopt') {
        reportId = reconciliation.comment.id;
        deps.log.info(`reconciled ${taskId}: adopting existing report comment #${reportId}`);
      } else {
        await persistRecord(paths, state, {
          ...recordBase(record, taskId),
          status: 'publishing',
          last_sync_at: nowIso,
        });
        const published = await publishCompletionReport(deps.client, issueRef, report.content, taskId);
        reportId = published.id;
      }
      await persistRecord(paths, state, {
        ...recordBase(record, taskId),
        status: 'published',
        published_comment_id: reportId,
        tracker_comment_id: trackerId,
        last_sync_at: nowIso,
        error: null,
      });
      return {
        taskId,
        action: 'completed',
        detail: `completion report #${reportId} published for issue #${issueRef.issueNumber} (awaiting Gate acceptance)`,
      };
    }

    // status = blocked | question | failed: reflect Blocked on the tracker
    // (creating it first if the agent jumped straight to a terminal state)
    // and post a plain notice with the reason. Notices don't consume the
    // published token; the notice key makes it post-once.
    if (snapshot.aiState !== 'ai:working' && snapshot.aiState !== 'ai:blocked') {
      return {
        taskId,
        action: 'unchanged',
        detail: `blocked-state reporting requires ai:working|ai:blocked, current state is ${snapshot.aiState}`,
      };
    }
    const pendingBody = noticeBody('execute', result.status, taskId, result.reason ?? '(no reason given)');
    const pendingKey = noticeKey(pendingBody);
    if (record.last_notice_key === pendingKey) {
      return {
        taskId,
        action: 'unchanged',
        detail: 'blocked notice already posted for this task',
      };
    }
    let tracker = resolveTrackerFrom(snapshot.comments, taskId, record);
    let trackerId: number;
    if (tracker !== null) {
      await updateTracker(deps.client, issueRef, tracker.id, tracker.body, { status: 'Blocked' });
      trackerId = tracker.id;
    } else {
      const created = await publishTrackerComment(deps.client, issueRef, {
        taskId,
        issueNumber: issueRef.issueNumber,
      });
      // T3 then T4: create as In Progress, then edit to Blocked so the gate
      // sees the same transition everyone else does.
      const createdBody = buildTrackerCommentBody({
        taskId,
        issueNumber: issueRef.issueNumber,
        status: 'In Progress',
        progressMarkdown: '',
      });
      await updateTracker(deps.client, issueRef, created.id, createdBody, { status: 'Blocked' });
      trackerId = created.id;
    }
    const body = pendingBody;
    await deps.client.addIssueComment(issueRef, body);
    await persistRecord(paths, state, {
      ...recordBase(record, taskId),
      tracker_comment_id: trackerId,
      last_notice_key: noticeKey(body),
      last_sync_at: nowIso,
    });
    return { taskId, action: 'notice', detail: `execute ${result.status}: tracker #${trackerId} set to Blocked, notice posted` };
  }

  // No terminal result yet: create the execution tracker as the visible
  // "work started" signal (T3) when the issue sits in READY.
  if (snapshot.aiState === 'ai:ready') {
    const tracker = resolveTrackerFrom(snapshot.comments, taskId, record);
    if (tracker === null) {
      const created = await publishTrackerComment(deps.client, issueRef, {
        taskId,
        issueNumber: issueRef.issueNumber,
      });
      await persistRecord(paths, state, {
        ...recordBase(record, taskId),
        tracker_comment_id: created.id,
        last_sync_at: nowIso,
      });
      return { taskId, action: 'tracker-created', detail: `tracker comment #${created.id} created (execution started)` };
    }
    // Crash-recovery adoption: a tracker exists on GitHub but the record
    // lost it — adopt the id instead of duplicating the tracker.
    if (record.tracker_comment_id !== tracker.id) {
      await persistRecord(paths, state, {
        ...recordBase(record, taskId),
        tracker_comment_id: tracker.id,
        last_sync_at: nowIso,
      });
      return { taskId, action: 'tracker-created', detail: `recovered existing tracker comment #${tracker.id}` };
    }
  }

  return {
    taskId,
    action: 'unchanged',
    detail: 'no result.json yet; the agent is still working',
  };
}

/**
 * Operation reconciliation for a PLAN or REPORT comment (hardening Phase 5):
 * search by marker + task id. Found + same canonical content → adopt;
 * found + different content → CONFLICT (fail closed, never overwrite, never
 * post a second copy); absent → caller publishes.
 */
function reconcileMarkerComment(
  comments: CommentDetail[],
  taskId: string,
  localContent: string,
  kind: 'plan' | 'report',
): { verdict: 'absent' } | { verdict: 'adopt'; comment: CommentDetail } | { verdict: 'conflict'; detail: string } {
  const mine =
    kind === 'plan'
      ? findPlanComments(comments).filter((plan) => plan.dispatchId === taskId)
      : findCompletionReportComments(comments, taskId);
  if (mine.length === 0) return { verdict: 'absent' };
  const latest = mine[mine.length - 1];
  if (latest === undefined) return { verdict: 'absent' };
  const remoteHash = canonicalPlanContent(latest.body);
  const localHash = canonicalPlanContent(localContent);
  if (remoteHash !== localHash) {
    return {
      verdict: 'conflict',
      detail:
        `remote ${kind} comment #${latest.id} exists for ${taskId} with DIFFERENT ` +
        'content (fail closed: no overwrite, no duplicate)',
    };
  }
  return { verdict: 'adopt', comment: latest };
}

/**
 * Sync every task directory sequentially. Infrastructure errors are logged
 * per task so one broken task cannot starve the others. Returns the
 * outcomes plus the final driver state (for status reporting).
 */
export async function syncAll(
  deps: DriverDeps,
  repositoryInfo: RepositoryInfo,
): Promise<{ outcomes: SyncOutcome[]; state: DriverStateFile }> {
  const paths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);
  const taskIds = await listTaskDirs(paths.tasks);
  const outcomes: SyncOutcome[] = [];
  for (const taskId of taskIds) {
    try {
      outcomes.push(await syncTask(deps, repositoryInfo, taskId));
    } catch (err) {
      deps.log.error(`sync failed for ${taskId}: ${errorMessage(err)}`);
    }
  }
  return { outcomes, state: await readDriverState(paths) };
}

/** Explicit retry: drop the driver-state record so `run` may re-prepare. */
export async function clearTask(paths: WorkspacePaths, taskId: string): Promise<boolean> {
  const state = await readDriverState(paths);
  if (getTaskRecord(state, taskId) === null) {
    return false;
  }
  await writeDriverState(paths, withoutTaskRecord(state, taskId));
  return true;
}
