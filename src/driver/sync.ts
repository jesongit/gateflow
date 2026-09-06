/**
 * Outbox → GitHub sync engine — the security-critical path (docs/
 * architecture-v1.md §3, workspace-protocol.md §5, §8).
 *
 * FROZEN CONSTRAINTS enforced here, in order, for EVERY dispatch:
 * 1. UNKNOWN DISPATCH IDS ARE REJECTED (docs §8.3): an outbox directory with
 *    no valid inbox dispatch.json is never synced, no matter what it
 *    contains.
 * 2. REPLAY PROTECTION (docs §8.4): a receipt with status `synced` means the
 *    result was already accepted; later overwrites of result.json are
 *    ignored (`skipped`).
 * 3. VALIDATION BEFORE ANY SYNC (docs §5): status.json and result.json must
 *    pass the frozen validators — schema, dispatch_id/role agreement, role
 *    whitelists and the human-only blacklist (`approve` / `ready` / `cancel`
 *    / `human-close` can never enter GitHub through an agent file).
 *    Invalid → `rejected`: log, never throw, never sync.
 * 4. CONTENT FILES ARE PASSTHROUGH ONLY: PLAN.md / PROGRESS.md / REPORT.md
 *    are published verbatim; the Driver never parses their semantics.
 * 5. NO STATE TRANSITIONS: the Driver publishes protocol comments (plan,
 *    tracker, completion report, plain notices) — the Gate alone moves
 *    labels/states. The Driver never calls an LLM.
 *
 * GitHub errors (network, auth, rate limit) are infrastructure failures and
 * propagate to the caller; only validation/rejected paths return without
 * throwing.
 */
import type { CommentDetail, RepositoryInfo } from '../github/client';
import type { IssueRef } from '../github/client';
import {
  publishCompletionReport,
  publishPlanComment,
  publishTrackerComment,
  findTrackerComment,
  updateTracker,
} from '../github/issue-sync';
import { buildTrackerCommentBody, findTrackerStatus } from '../github/comments';
import { readFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { Receipt, ResultFile, StatusFile } from '../workspace/protocol';
import { resolveWorkspace } from '../workspace/paths';
import type { WorkspacePaths } from '../workspace/paths';
import { outboxDispatchDir } from '../workspace/paths';
import { sha256Hex } from '../workspace/inbox';
import { readInboxDispatch } from '../workspace/inbox';
import {
  listOutboxDispatchIds,
  readOutboxMarkdown,
  readReceipt,
  writeReceipt,
} from '../workspace/outbox';
import { OversizedFileError, validateOutboxResult, validateOutboxStatus } from '../workspace/validation';
import type { DriverDeps } from './driver';

/** All sync actions (see module header + docs/workspace-protocol.md §3). */
export type SyncAction =
  | 'plan-published'
  | 'tracker-created'
  | 'tracker-updated'
  | 'blocked'
  | 'resumed'
  | 'completed'
  | 'notice'
  | 'skipped'
  | 'rejected'
  | 'unchanged';

/** Result of syncing one dispatch directory. */
export type SyncOutcome = {
  dispatchId: string;
  action: SyncAction;
  detail: string;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Plain-text (marker-free) Driver notice; the Gate never parses these. */
function noticeBody(role: string, what: string, dispatchId: string, reason: string): string {
  return `[gateflow] ${role} ${what} (dispatch ${dispatchId}): ${reason}`;
}

/** Receipt skeleton preserving prior cache fields, safe for validation. */
function receiptBase(receipt: Receipt | null, dispatchId: string): Receipt {
  return {
    ...(receipt ?? {}),
    dispatch_id: dispatchId,
    status: receipt?.status ?? 'dispatched',
    attempts: receipt?.attempts ?? 1,
  };
}

/** Read an outbox markdown file; oversize is a validation failure (null + flag). */
async function readMarkdownCapped(
  paths: WorkspacePaths,
  dispatchId: string,
  name: 'PLAN.md' | 'PROGRESS.md' | 'REPORT.md',
): Promise<{ content: string | null; error: string | null }> {
  try {
    return { content: await readOutboxMarkdown(paths, dispatchId, name), error: null };
  } catch (err) {
    if (err instanceof OversizedFileError) {
      return { content: null, error: errorMessage(err) };
    }
    throw err;
  }
}

/**
 * Locate the tracker comment for a dispatch: the receipt's id first, then a
 * marker+dispatch-id scan (crash recovery, docs §2.6). Returns the comment
 * list too so callers avoid a second round-trip.
 */
async function resolveTracker(
  deps: DriverDeps,
  ref: IssueRef,
  dispatchId: string,
  receipt: Receipt | null,
): Promise<{ comments: CommentDetail[]; tracker: CommentDetail | null }> {
  const comments = await deps.client.listComments(ref);
  let tracker: CommentDetail | null = null;
  if (receipt?.tracker_comment_id !== undefined) {
    tracker = comments.find((comment) => comment.id === receipt.tracker_comment_id) ?? null;
  }
  if (tracker === null) {
    tracker = findTrackerComment(comments, dispatchId);
  }
  return { comments, tracker };
}

/** Validate raw outbox JSON; returns [validated, rejectionDetail]. */
function validateOrDetail<T>(
  raw: unknown,
  validate: (raw: unknown, expected: { dispatchId: string; role: 'consumer' | 'executor' }) => { ok: true; value: T } | { ok: false; errors: string[] },
  dispatchId: string,
  role: 'consumer' | 'executor',
): [T | null, string | null] {
  if (raw === null) return [null, null];
  const outcome = validate(raw, { dispatchId, role });
  if (!outcome.ok) {
    return [null, outcome.errors.join('; ')];
  }
  return [outcome.value, null];
}

/**
 * Read a raw outbox JSON file, distinguishing "absent" (null) from "present
 * but unparseable" ({ raw: null, error }) — docs §5 rule 1: unparseable
 * machine files are a validation failure (rejected), never a silent no-op.
 */
async function readOutboxJsonStrict(
  paths: WorkspacePaths,
  dispatchId: string,
  fileName: 'status.json' | 'result.json',
): Promise<{ raw: unknown; error: string | null } | null> {
  let file: string;
  try {
    file = nodePath.join(outboxDispatchDir(paths, dispatchId), fileName);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null; // absent (or unreadable) → treated as absent
  }
  try {
    return { raw: JSON.parse(text) as unknown, error: null };
  } catch (err) {
    return { raw: null, error: errorMessage(err) };
  }
}

/**
 * Sync one dispatch directory: inbox check → replay check → validation →
 * role-specific GitHub publication + receipt update.
 */
export async function syncDispatch(
  deps: DriverDeps,
  repositoryInfo: RepositoryInfo,
  dispatchId: string,
): Promise<SyncOutcome> {
  const paths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);
  const now = deps.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const ref: IssueRef = { owner: repositoryInfo.owner, repo: repositoryInfo.name, issueNumber: 0 };

  // (1) Unknown dispatch ids are rejected (docs §8.3).
  const inboxDispatch = await readInboxDispatch(paths, dispatchId);
  if (inboxDispatch === null) {
    return {
      dispatchId,
      action: 'rejected',
      detail: 'no valid inbox dispatch.json for this id (unknown dispatch, docs §8.3)',
    };
  }
  ref.issueNumber = inboxDispatch.issue_number;
  const role = inboxDispatch.role;

  // (2) Result replay protection (docs §8.4).
  const receipt = await readReceipt(paths, dispatchId);
  if (receipt?.status === 'synced') {
    return {
      dispatchId,
      action: 'skipped',
      detail: 'receipt already synced — later result overwrites are not accepted (docs §8.4)',
    };
  }

  // (3) Validation before any sync (docs §5). Human-only values die here.
  const rawStatus = await readOutboxJsonStrict(paths, dispatchId, 'status.json');
  if (rawStatus !== null && rawStatus.error !== null) {
    deps.log.warning(`rejected ${dispatchId}: unparseable status.json — ${rawStatus.error}`);
    return { dispatchId, action: 'rejected', detail: `unparseable status.json: ${rawStatus.error}` };
  }
  const rawResult = await readOutboxJsonStrict(paths, dispatchId, 'result.json');
  if (rawResult !== null && rawResult.error !== null) {
    deps.log.warning(`rejected ${dispatchId}: unparseable result.json — ${rawResult.error}`);
    return { dispatchId, action: 'rejected', detail: `unparseable result.json: ${rawResult.error}` };
  }
  const [status, statusError] = validateOrDetail(rawStatus?.raw ?? null, validateOutboxStatus, dispatchId, role);
  if (statusError !== null) {
    deps.log.warning(`rejected ${dispatchId}: invalid status.json — ${statusError}`);
    return { dispatchId, action: 'rejected', detail: `invalid status.json: ${statusError}` };
  }
  const [result, resultError] = validateOrDetail(rawResult?.raw ?? null, validateOutboxResult, dispatchId, role);
  if (resultError !== null) {
    deps.log.warning(`rejected ${dispatchId}: invalid result.json — ${resultError}`);
    return { dispatchId, action: 'rejected', detail: `invalid result.json: ${resultError}` };
  }

  if (role === 'consumer') {
    return syncConsumer(deps, ref, paths, dispatchId, receipt, status, result, nowIso);
  }
  return syncExecutor(deps, ref, paths, dispatchId, receipt, status, result, nowIso);
}

/** Consumer sync (docs §3.1/§3.2): plan publication + plain notices only. */
async function syncConsumer(
  deps: DriverDeps,
  ref: IssueRef,
  paths: WorkspacePaths,
  dispatchId: string,
  receipt: Receipt | null,
  status: StatusFile | null,
  result: ResultFile | null,
  nowIso: string,
): Promise<SyncOutcome> {
  if (result !== null) {
    if (result.result === 'plan_ready') {
      const plan = await readMarkdownCapped(paths, dispatchId, 'PLAN.md');
      if (plan.error !== null) {
        return { dispatchId, action: 'rejected', detail: `PLAN.md rejected: ${plan.error}` };
      }
      if (plan.content === null) {
        return { dispatchId, action: 'rejected', detail: 'result=plan_ready but PLAN.md is missing or empty' };
      }
      await publishPlanComment(deps.client, ref, plan.content, dispatchId);
      await writeReceipt(paths, { ...receiptBase(receipt, dispatchId), status: 'synced', last_sync_at: nowIso });
      return { dispatchId, action: 'plan-published', detail: `plan comment published for issue #${ref.issueNumber}` };
    }
    // question | failed — plain notice, no marker, nothing for the Gate to parse.
    await deps.client.addIssueComment(
      ref,
      noticeBody('consumer', result.result, dispatchId, result.reason ?? '(no reason given)'),
    );
    await writeReceipt(paths, { ...receiptBase(receipt, dispatchId), status: 'synced', last_sync_at: nowIso });
    return { dispatchId, action: 'notice', detail: `consumer ${result.result} notice posted` };
  }

  if (status !== null && status.state === 'blocked') {
    await deps.client.addIssueComment(
      ref,
      noticeBody('consumer', 'blocked', dispatchId, status.summary ?? status.phase ?? '(blocked, no summary)'),
    );
    await writeReceipt(paths, { ...receiptBase(receipt, dispatchId), status: 'synced', last_sync_at: nowIso });
    return { dispatchId, action: 'notice', detail: 'consumer blocked notice posted' };
  }

  return {
    dispatchId,
    action: 'unchanged',
    detail: 'no terminal result yet; consumer working/failed status is not echoed to GitHub',
  };
}

/**
 * Executor sync (docs §3.4): completion report publication, blocked notices
 * with tracker updates, and the working/blocked tracker lifecycle with
 * debounced progress edits (progress_sync_seconds, docs §10).
 */
async function syncExecutor(
  deps: DriverDeps,
  ref: IssueRef,
  paths: WorkspacePaths,
  dispatchId: string,
  receipt: Receipt | null,
  status: StatusFile | null,
  result: ResultFile | null,
  nowIso: string,
): Promise<SyncOutcome> {
  const now = deps.now ?? (() => new Date());

  if (result !== null) {
    if (result.result === 'completed') {
      // Agent claims need real verification: validation:'failed' is never
      // published as a completion (docs §2.4; the claim itself is a Claim —
      // only the Gate transitions to DONE).
      if (result.validation !== 'passed') {
        return {
          dispatchId,
          action: 'rejected',
          detail: `result=completed requires validation="passed", got ${JSON.stringify(result.validation ?? null)}`,
        };
      }
      const report = await readMarkdownCapped(paths, dispatchId, 'REPORT.md');
      if (report.error !== null) {
        return { dispatchId, action: 'rejected', detail: `REPORT.md rejected: ${report.error}` };
      }
      if (report.content === null) {
        return { dispatchId, action: 'rejected', detail: 'result=completed but REPORT.md is missing or empty' };
      }
      await publishCompletionReport(deps.client, ref, report.content, dispatchId);
      await writeReceipt(paths, { ...receiptBase(receipt, dispatchId), status: 'synced', last_sync_at: nowIso });
      return { dispatchId, action: 'completed', detail: `completion report published for issue #${ref.issueNumber}` };
    }

    // result = blocked | question | failed: reflect Blocked on the tracker
    // (creating it first if the agent jumped straight to a terminal state)
    // and post a plain notice with the reason.
    const { tracker } = await resolveTracker(deps, ref, dispatchId, receipt);
    let trackerId: number;
    if (tracker !== null) {
      await updateTracker(deps.client, ref, tracker.id, tracker.body, { status: 'Blocked' });
      trackerId = tracker.id;
    } else {
      const progress = await readMarkdownCapped(paths, dispatchId, 'PROGRESS.md');
      const created = await publishTrackerComment(deps.client, ref, {
        dispatchId,
        issueNumber: ref.issueNumber,
        progressMarkdown: progress.content ?? '',
      });
      // T3 then T4: create as In Progress, then edit to Blocked so the gate
      // sees the same transition everyone else does.
      const createdBody = buildTrackerCommentBody({
        dispatchId,
        issueNumber: ref.issueNumber,
        status: 'In Progress',
        progressMarkdown: progress.content ?? '',
      });
      await updateTracker(deps.client, ref, created.id, createdBody, { status: 'Blocked' });
      trackerId = created.id;
    }
    await deps.client.addIssueComment(
      ref,
      noticeBody('executor', result.result, dispatchId, result.reason ?? '(no reason given)'),
    );
    await writeReceipt(paths, {
      ...receiptBase(receipt, dispatchId),
      status: 'synced',
      tracker_comment_id: trackerId,
      last_sync_at: nowIso,
    });
    return { dispatchId, action: 'notice', detail: `executor ${result.result}: tracker #${trackerId} set to Blocked, notice posted` };
  }

  // No terminal result: tracker lifecycle over status.json.
  if (status === null) {
    return { dispatchId, action: 'unchanged', detail: 'no status.json or result.json in the outbox yet' };
  }

  const progress = await readMarkdownCapped(paths, dispatchId, 'PROGRESS.md');
  if (progress.error !== null) {
    return { dispatchId, action: 'rejected', detail: `PROGRESS.md rejected: ${progress.error}` };
  }
  const progressMd = progress.content;
  const progressSha = progressMd === null ? null : sha256Hex(progressMd);

  const { tracker } = await resolveTracker(deps, ref, dispatchId, receipt);

  if (tracker === null) {
    // Fresh tracker (T3 trigger). Always created 'In Progress'; an immediate
    // Blocked edit (T4) follows when the agent already reported blocked.
    const created = await publishTrackerComment(deps.client, ref, {
      dispatchId,
      issueNumber: ref.issueNumber,
      progressMarkdown: progressMd ?? '',
    });
    await writeReceipt(paths, {
      ...receiptBase(receipt, dispatchId),
      tracker_comment_id: created.id,
      last_progress_sha256: progressSha ?? sha256Hex(''),
      last_sync_at: nowIso,
    });
    if (status.state === 'blocked') {
      const createdBody = buildTrackerCommentBody({
        dispatchId,
        issueNumber: ref.issueNumber,
        status: 'In Progress',
        progressMarkdown: progressMd ?? '',
      });
      await updateTracker(deps.client, ref, created.id, createdBody, { status: 'Blocked' });
      await writeReceipt(paths, { ...receiptBase(receipt, dispatchId), tracker_comment_id: created.id, last_sync_at: nowIso });
      return { dispatchId, action: 'blocked', detail: `tracker #${created.id} created and set to Blocked` };
    }
    return { dispatchId, action: 'tracker-created', detail: `tracker comment #${created.id} created` };
  }

  // Crash recovery adoption (docs §2.6): a tracker exists on GitHub but the
  // receipt lost it — adopt the id instead of duplicating the tracker.
  if (receipt?.tracker_comment_id !== tracker.id) {
    await writeReceipt(paths, {
      ...receiptBase(receipt, dispatchId),
      tracker_comment_id: tracker.id,
      last_sync_at: nowIso,
    });
    return { dispatchId, action: 'tracker-created', detail: `recovered existing tracker comment #${tracker.id}` };
  }

  if (status.state === 'blocked') {
    await updateTracker(deps.client, ref, tracker.id, tracker.body, { status: 'Blocked' });
    await writeReceipt(paths, { ...receiptBase(receipt, dispatchId), tracker_comment_id: tracker.id, last_sync_at: nowIso });
    return { dispatchId, action: 'blocked', detail: `tracker #${tracker.id} set to Blocked` };
  }

  if (status.state === 'working' && findTrackerStatus(tracker.body) === 'Blocked') {
    // T5: blocked → working again.
    await updateTracker(deps.client, ref, tracker.id, tracker.body, {
      status: 'In Progress',
      ...(progressMd !== null ? { progressMarkdown: progressMd } : {}),
    });
    await writeReceipt(paths, {
      ...receiptBase(receipt, dispatchId),
      tracker_comment_id: tracker.id,
      last_sync_at: nowIso,
      ...(progressSha !== null ? { last_progress_sha256: progressSha } : {}),
    });
    return { dispatchId, action: 'resumed', detail: `tracker #${tracker.id} set back to In Progress` };
  }

  // Debounced progress edits (docs §10): only when the content changed AND
  // the configured window has elapsed since the last tracker write. Only
  // 'working' reaches here: 'blocked' returned above and 'failed' (a mid-run
  // give-up) has no tracker status to express.
  if (status.state === 'working' && progressSha !== null && progressSha !== receipt?.last_progress_sha256) {
    const lastSyncMs = Date.parse(receipt?.last_sync_at ?? '1970-01-01T00:00:00Z');
    const windowMs = deps.config.driver.progressSyncSeconds * 1000;
    if (now().getTime() - lastSyncMs >= windowMs) {
      await updateTracker(deps.client, ref, tracker.id, tracker.body, {
        status: 'In Progress',
        progressMarkdown: progressMd ?? '',
      });
      await writeReceipt(paths, {
        ...receiptBase(receipt, dispatchId),
        tracker_comment_id: tracker.id,
        last_progress_sha256: progressSha,
        last_sync_at: nowIso,
      });
      return { dispatchId, action: 'tracker-updated', detail: `tracker #${tracker.id} progress updated` };
    }
  }

  return {
    dispatchId,
    action: 'unchanged',
    detail: 'tracker is current (progress unchanged or debounce window not elapsed)',
  };
}

/**
 * Sync every outbox dispatch directory sequentially. Infrastructure errors
 * are logged per dispatch so one broken dispatch cannot starve the others.
 */
export async function syncAll(deps: DriverDeps, repositoryInfo: RepositoryInfo): Promise<SyncOutcome[]> {
  const paths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);
  const dispatchIds = await listOutboxDispatchIds(paths);
  const outcomes: SyncOutcome[] = [];
  for (const dispatchId of dispatchIds) {
    try {
      outcomes.push(await syncDispatch(deps, repositoryInfo, dispatchId));
    } catch (err) {
      deps.log.error(`sync failed for ${dispatchId}: ${errorMessage(err)}`);
    }
  }
  return outcomes;
}
