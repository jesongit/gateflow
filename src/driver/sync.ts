/**
 * Outbox → GitHub sync engine — the security-critical path (docs/
 * architecture-v1.md §3, workspace-protocol.md §5, §8, hardening Phases 4+5).
 *
 * FROZEN CONSTRAINTS enforced here, in order, for EVERY dispatch:
 * 1. UNKNOWN DISPATCH IDS ARE REJECTED (docs §8.3): an outbox directory with
 *    no valid inbox dispatch.json is never synced, no matter what it
 *    contains.
 * 2. REPLAY PROTECTION (docs §8.4): a receipt with status `published` or
 *    `accepted` means the result was already published; later overwrites of
 *    result.json are ignored (`skipped`).
 * 3. VALIDATION BEFORE ANY SYNC (docs §5): status.json and result.json must
 *    pass the frozen validators — schema, dispatch_id/role agreement, role
 *    whitelists and the human-only blacklist (`approve` / `ready` / `cancel`
 *    / `human-close` can never enter GitHub through an agent file).
 *    Invalid → `rejected`: log, never throw, never sync.
 * 4. PREFLIGHT BEFORE ANY STATE-RELEVANT WRITE (hardening Phase 4.1): the
 *    unified `runPreflight` re-reads canonical state and validates the
 *    dispatch's epoch/plan/approval binding. Obsolete dispatches (cancel,
 *    new epoch, plan change, closed issue) are refused and marked
 *    `obsolete`; unprovable states fail closed for this cycle.
 * 5. OPERATION RECONCILIATION (hardening Phase 5): every publish first
 *    searches for an existing remote object by its Operation identity —
 *    found + same content → adopt; found + different content → CONFLICT
 *    (receipt failed, never overwrite); absent → publish, confirm, then
 *    persist the receipt. API timeouts reconcile next cycle, never blind-retry.
 * 6. CONTENT FILES ARE PASSTHROUGH ONLY; NO STATE TRANSITIONS: the Driver
 *    publishes protocol comments — the Gate alone moves labels. `published`
 *    (remote object confirmed) and `accepted` (Gate observed the state
 *    migration) are distinct receipt states; an Agent's completed claim is
 *    never DONE.
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
  findPlanComments,
  findCompletionReportComments,
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
import { OversizedFileError, MAX_FILE_BYTES, validateOutboxResult, validateOutboxStatus } from '../workspace/validation';
import { canonicalPlanContent } from '../protocol/plan';
import { transitionMatchesReceipt } from '../protocol/workflow-chain';
import { runPreflight, type SyncSnapshot } from './preflight';
import { bootstrapIssuersFor } from './discovery';
import { releaseLock, executorLockFile, DRIVER_LOCK_HOLDER } from './workspace-lock';
import type { Dispatch } from '../workspace/protocol';
import type { DriverDeps } from './driver';

/** All sync actions (see module header + docs/workspace-protocol.md §3). */
export type SyncAction =
  | 'plan-published'
  | 'tracker-created'
  | 'tracker-updated'
  | 'blocked'
  | 'resumed'
  | 'completed'
  | 'accepted'
  | 'notice'
  | 'skipped'
  | 'rejected'
  | 'obsolete'
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

/** sha256 prefix identifying one notice payload (Operation dedup key). */
function noticeKey(body: string): string {
  return sha256Hex(body).slice(0, 16);
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

/**
 * Terminal receipt states release the per-worktree executor lock (hardening
 * §9): accepted, obsolete, or failed (failed keeps context but the dispatch
 * needs explicit retry; holding the workspace hostage on a failed dispatch
 * would queue everything behind it forever).
 */
async function releaseExecutorLockIfTerminal(
  paths: WorkspacePaths,
  dispatch: { role: string; dispatch_id: string },
  status: Receipt['status'],
): Promise<void> {
  if (dispatch.role !== 'executor') return;
  if (status === 'accepted' || status === 'obsolete' || status === 'failed') {
    await releaseLock(executorLockFile(paths), DRIVER_LOCK_HOLDER, dispatch.dispatch_id);
  }
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
function resolveTrackerFrom(
  comments: CommentDetail[],
  dispatchId: string,
  receipt: Receipt | null,
): CommentDetail | null {
  if (receipt?.tracker_comment_id !== undefined) {
    const found = comments.find((comment) => comment.id === receipt.tracker_comment_id);
    if (found !== undefined) return found;
  }
  return findTrackerComment(comments, dispatchId);
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
  // Size bound before JSON.parse (docs §5.7): a hostile agent must not be
  // able to force arbitrarily large allocations through a machine file.
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    return { raw: null, error: `${fileName} exceeds the ${MAX_FILE_BYTES}-byte limit` };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null) {
      // JSON.parse('null') succeeds but `null` is never a valid machine file
      // object; treat it as malformed instead of "absent" (docs §5 rule 1).
      return { raw: null, error: `${fileName} is not a JSON object` };
    }
    return { raw: parsed, error: null };
  } catch (err) {
    return { raw: null, error: errorMessage(err) };
  }
}

/**
 * Sync one dispatch directory: inbox check → validation → PREFLIGHT →
 * acceptance observation (published → accepted) → replay check →
 * role-specific, operation-reconciled publication + receipt.
 */
export async function syncDispatch(
  deps: DriverDeps,
  repositoryInfo: RepositoryInfo,
  dispatchId: string,
): Promise<SyncOutcome> {
  const paths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);
  const now = deps.now ?? (() => new Date());
  const nowIso = now().toISOString();

  // (1) Unknown dispatch ids are rejected (docs §8.3).
  const inboxDispatch = await readInboxDispatch(paths, dispatchId);
  if (inboxDispatch === null) {
    return {
      dispatchId,
      action: 'rejected',
      detail: 'no valid inbox dispatch.json for this id (unknown dispatch, docs §8.3)',
    };
  }
  const role = inboxDispatch.role;

  // (2) Validation before any sync (docs §5). Human-only values die here.
  //     (The replay guard runs AFTER the acceptance observation so a
  //     published-but-unconfirmed receipt can still advance to `accepted`;
  //     a rejected validation here performs no GitHub write either way.)
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
  const receipt = await readReceipt(paths, dispatchId);

  // (3) PREFLIGHT: current-task authorization before any GitHub write.
  const preflight = await runPreflight(deps.client, repositoryInfo, inboxDispatch, {
    gateLogins: new Set(deps.config.gateLogins.map((login) => login.toLowerCase())),
    bootstrapIssuers: bootstrapIssuersFor(deps.config, repositoryInfo),
    trustedHumans: new Set([
      repositoryInfo.owner.toLowerCase(),
      ...deps.config.trustedHumans.map((login) => login.toLowerCase()),
    ]),
    repoOwner: repositoryInfo.owner,
  });
  if (!preflight.ok) {
    if (preflight.obsolete) {
      await writeReceipt(paths, {
        ...receiptBase(receipt, dispatchId),
        status: 'obsolete',
        error: preflight.reason,
        last_sync_at: nowIso,
      });
      await releaseExecutorLockIfTerminal(paths, inboxDispatch, 'obsolete');
      deps.log.warning(`obsolete ${dispatchId}: ${preflight.reason}`);
      return { dispatchId, action: 'obsolete', detail: preflight.reason };
    }
    // Fail closed for this cycle (tampering / unprovable state): keep the
    // receipt as-is so the condition stays visible and re-checked.
    deps.log.warning(`blocked ${dispatchId} (preflight): ${preflight.reason}`);
    return { dispatchId, action: 'rejected', detail: `preflight: ${preflight.reason}` };
  }
  const snapshot = preflight.snapshot;

  // (4) Acceptance observation: a `published` receipt whose Gate acceptance
  // is now visible moves to `accepted`. This is the ONLY path to `accepted`,
  // it reads canonical state (never agent claims), and it MUST precede the
  // replay guard — otherwise `published` could never advance.
  //   - Consumer plan: the Gate issued an approval record for THIS dispatch's
  //     plan comment (the only durable signal that the specific plan bytes
  //     were accepted — a feedback-round re-plan never re-fires T1).
  //   - Executor report (V1.1 Phase 5, STRICT): the Gate published a
  //     gate_transition record whose source_comment_id IS the report comment
  //     this dispatch published, bound to this epoch and dispatch. A bare
  //     `ai:done` label is NEVER acceptance: `Issue == ai:done → accepted`
  //     is forbidden. An old report (or a superseded epoch/dispatch) never
  //     matches and is handled by the preflight's obsolete logic above.
  if (receipt?.status === 'published' && receipt.published_comment_id !== undefined) {
    // Consumer plan: the Gate issued an approval record for the plan comment
    // THIS dispatch published (the only durable signal that the specific plan
    // bytes were accepted — a feedback-round re-plan never re-fires T1).
    const isConsumerPlanAccepted =
      role === 'consumer' &&
      snapshot.view.approvals.some(
        (entry) =>
          entry.record.workflow_epoch === snapshot.epoch &&
          entry.record.plan_comment_id === receipt.published_comment_id,
      );
    const isExecutorReportAccepted =
      role === 'executor' &&
      snapshot.view.transitions.some(({ record }) =>
        transitionMatchesReceipt(record, {
          epoch: snapshot.epoch,
          dispatchId: inboxDispatch.dispatch_id,
          transition: 'T6',
          sourceCommentId: receipt.published_comment_id ?? -1,
        }),
      );
    if (isConsumerPlanAccepted || isExecutorReportAccepted) {
      await writeReceipt(paths, {
        ...receiptBase(receipt, dispatchId),
        status: 'accepted',
        last_sync_at: nowIso,
      });
      await releaseExecutorLockIfTerminal(paths, inboxDispatch, 'accepted');
      return { dispatchId, action: 'accepted', detail: `Gate accepted the ${role} output (${snapshot.aiState})` };
    }
  }

  // (5) Result replay protection (docs §8.4): published/accepted receipts
  // never re-publish; later result.json overwrites are not accepted.
  if (receipt?.status === 'published' || receipt?.status === 'accepted') {
    return {
      dispatchId,
      action: 'skipped',
      detail: `receipt already ${receipt.status} — later result overwrites are not accepted (docs §8.4)`,
    };
  }

  if (role === 'consumer') {
    return syncConsumer(deps, ref(repositoryInfo, inboxDispatch.issue_number), paths, dispatchId, receipt, status, result, snapshot, nowIso);
  }
  return syncExecutor(deps, ref(repositoryInfo, inboxDispatch.issue_number), paths, dispatchId, inboxDispatch, receipt, status, result, snapshot, nowIso);
}

function ref(repositoryInfo: RepositoryInfo, issueNumber: number): IssueRef {
  return { owner: repositoryInfo.owner, repo: repositoryInfo.name, issueNumber };
}

/**
 * Operation reconciliation for a PLAN or REPORT comment (hardening Phase 5.3):
 * search by marker + dispatch id. Found + same canonical content → adopt;
 * found + different content → CONFLICT (fail closed, never overwrite, never
 * post a second copy); absent → caller publishes.
 */
function reconcileMarkerComment(
  comments: CommentDetail[],
  dispatchId: string,
  localContent: string,
  kind: 'plan' | 'report',
): { verdict: 'absent' } | { verdict: 'adopt'; comment: CommentDetail } | { verdict: 'conflict'; detail: string } {
  const mine =
    kind === 'plan'
      ? findPlanComments(comments).filter((plan) => plan.dispatchId === dispatchId)
      : findCompletionReportComments(comments, dispatchId);
  if (mine.length === 0) return { verdict: 'absent' };
  const latest = mine[mine.length - 1];
  if (latest === undefined) return { verdict: 'absent' };
  const remoteHash = canonicalPlanContent(latest.body);
  const localHash = canonicalPlanContent(localContent);
  if (remoteHash !== localHash) {
    return {
      verdict: 'conflict',
      detail:
        `remote ${kind} comment #${latest.id} exists for ${dispatchId} with DIFFERENT ` +
        'content (fail closed: no overwrite, no duplicate)',
    };
  }
  return { verdict: 'adopt', comment: latest };
}

/** Consumer sync (docs §3.1/§3.2): plan publication + plain notices only. */
async function syncConsumer(
  deps: DriverDeps,
  issueRef: IssueRef,
  paths: WorkspacePaths,
  dispatchId: string,
  receipt: Receipt | null,
  status: StatusFile | null,
  result: ResultFile | null,
  snapshot: SyncSnapshot,
  nowIso: string,
): Promise<SyncOutcome> {
  if (result !== null) {
    if (result.result === 'plan_ready') {
      // State matrix: a consumer plan may only be published while the issue
      // sits in PLANNING or REVIEW (a feedback round re-publishes into
      // REVIEW; anything else is a stale dispatch).
      if (snapshot.aiState !== 'ai:planning' && snapshot.aiState !== 'ai:review') {
        return {
          dispatchId,
          action: 'unchanged',
          detail: `plan publication requires ai:planning|ai:review, current state is ${snapshot.aiState}`,
        };
      }
      const plan = await readMarkdownCapped(paths, dispatchId, 'PLAN.md');
      if (plan.error !== null) {
        return { dispatchId, action: 'rejected', detail: `PLAN.md rejected: ${plan.error}` };
      }
      if (plan.content === null) {
        return { dispatchId, action: 'rejected', detail: 'result=plan_ready but PLAN.md is missing or empty' };
      }

      // Operation reconciliation: adopt / conflict / publish.
      const reconciliation = reconcileMarkerComment(snapshot.comments, dispatchId, plan.content, 'plan');
      if (reconciliation.verdict === 'conflict') {
        await writeReceipt(paths, {
          ...receiptBase(receipt, dispatchId),
          status: 'failed',
          error: reconciliation.detail,
          last_sync_at: nowIso,
        });
        deps.log.error(`conflict ${dispatchId}: ${reconciliation.detail}`);
        return { dispatchId, action: 'rejected', detail: reconciliation.detail };
      }
      let commentId: number;
      if (reconciliation.verdict === 'adopt') {
        commentId = reconciliation.comment.id;
        deps.log.info(`reconciled ${dispatchId}: adopting existing plan comment #${commentId}`);
      } else {
        await writeReceipt(paths, { ...receiptBase(receipt, dispatchId), status: 'publishing', last_sync_at: nowIso });
        const published = await publishPlanComment(deps.client, issueRef, plan.content, dispatchId);
        commentId = published.id;
      }
      await writeReceipt(paths, {
        ...receiptBase(receipt, dispatchId),
        status: 'published',
        published_comment_id: commentId,
        last_sync_at: nowIso,
        error: null,
      });
      return {
        dispatchId,
        action: 'plan-published',
        detail: `plan comment #${commentId} published for issue #${issueRef.issueNumber} (awaiting Gate acceptance)`,
      };
    }
    // question | failed — plain notice, no marker, nothing for the Gate to
    // parse. Notices are non-state-bearing: they never move the receipt to
    // `published`; the dedup key prevents re-posting every cycle.
    const body = noticeBody('consumer', result.result, dispatchId, result.reason ?? '(no reason given)');
    const key = noticeKey(body);
    if (receipt?.last_notice_key === key) {
      return { dispatchId, action: 'unchanged', detail: 'notice already posted for this result' };
    }
    await deps.client.addIssueComment(issueRef, body);
    await writeReceipt(paths, {
      ...receiptBase(receipt, dispatchId),
      last_notice_key: key,
      last_sync_at: nowIso,
    });
    return { dispatchId, action: 'notice', detail: `consumer ${result.result} notice posted` };
  }

  if (status !== null && status.state === 'blocked') {
    // Status notices are non-terminal: they must NOT move the receipt to
    // `published` — that token is reserved for a confirmed remote protocol
    // object — otherwise a blocked echo would swallow the dispatch's later
    // legitimate plan_ready result. The notice key makes it post-once.
    const body = noticeBody('consumer', 'blocked', dispatchId, status.summary ?? status.phase ?? '(blocked, no summary)');
    const key = noticeKey(body);
    if (receipt?.last_notice_key === key) {
      return {
        dispatchId,
        action: 'unchanged',
        detail: 'consumer blocked notice already posted for this dispatch',
      };
    }
    await deps.client.addIssueComment(issueRef, body);
    await writeReceipt(paths, {
      ...receiptBase(receipt, dispatchId),
      last_notice_key: key,
      last_sync_at: nowIso,
    });
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
 * debounced progress edits (progress_sync_seconds, docs §10). Every
 * publication is operation-reconciled; `published` ≠ `accepted`.
 */
async function syncExecutor(
  deps: DriverDeps,
  issueRef: IssueRef,
  paths: WorkspacePaths,
  dispatchId: string,
  inboxDispatch: Dispatch,
  receipt: Receipt | null,
  status: StatusFile | null,
  result: ResultFile | null,
  snapshot: SyncSnapshot,
  nowIso: string,
): Promise<SyncOutcome> {
  const now = deps.now ?? (() => new Date());

  if (result !== null) {
    if (result.result === 'completed') {
      // Agent claims need real verification: validation:'failed' is never
      // published as a completion (docs §2.4; the claim itself is a Claim —
      // only the Gate transitions to DONE, and `published` ≠ `accepted`).
      if (result.validation !== 'passed') {
        return {
          dispatchId,
          action: 'rejected',
          detail: `result=completed requires validation="passed", got ${JSON.stringify(result.validation ?? null)}`,
        };
      }
      // State matrix: reports publish only from WORKING (T6's from-state).
      if (snapshot.aiState !== 'ai:working') {
        return {
          dispatchId,
          action: 'unchanged',
          detail: `completion report requires ai:working, current state is ${snapshot.aiState}`,
        };
      }
      const report = await readMarkdownCapped(paths, dispatchId, 'REPORT.md');
      if (report.error !== null) {
        return { dispatchId, action: 'rejected', detail: `REPORT.md rejected: ${report.error}` };
      }
      if (report.content === null) {
        return { dispatchId, action: 'rejected', detail: 'result=completed but REPORT.md is missing or empty' };
      }

      // The report must not be an orphan: a tracker MUST exist before the
      // report publishes, so the issue legally traverses T3 (READY→WORKING)
      // before T6 (WORKING→DONE). A completed claim without a tracker gets
      // a lawful tracker here (docs §4.3: "补齐合法 Tracker"), never a bare
      // report that cannot trigger DONE.
      let tracker = resolveTrackerFrom(snapshot.comments, dispatchId, receipt);
      let trackerId: number | undefined = tracker?.id;
      if (tracker === null) {
        const progress = await readMarkdownCapped(paths, dispatchId, 'PROGRESS.md');
        const created = await publishTrackerComment(deps.client, issueRef, {
          dispatchId,
          issueNumber: issueRef.issueNumber,
          progressMarkdown: progress.content ?? '',
        });
        trackerId = created.id;
        await writeReceipt(paths, {
          ...receiptBase(receipt, dispatchId),
          status: receipt?.status ?? 'dispatched',
          tracker_comment_id: created.id,
          last_sync_at: nowIso,
        });
        deps.log.info(`repaired ${dispatchId}: lawful tracker #${created.id} created before report publication`);
      }

      // Operation reconciliation for the REPORT.
      const reconciliation = reconcileMarkerComment(
        snapshot.comments,
        dispatchId,
        report.content,
        'report',
      );
      if (reconciliation.verdict === 'conflict') {
        await writeReceipt(paths, {
          ...receiptBase(receipt, dispatchId),
          status: 'failed',
          error: reconciliation.detail,
          last_sync_at: nowIso,
        });
        await releaseExecutorLockIfTerminal(paths, inboxDispatch, 'failed');
        deps.log.error(`conflict ${dispatchId}: ${reconciliation.detail}`);
        return { dispatchId, action: 'rejected', detail: reconciliation.detail };
      }
      let reportId: number;
      if (reconciliation.verdict === 'adopt') {
        reportId = reconciliation.comment.id;
        deps.log.info(`reconciled ${dispatchId}: adopting existing report comment #${reportId}`);
      } else {
        await writeReceipt(paths, { ...receiptBase(receipt, dispatchId), status: 'publishing', last_sync_at: nowIso });
        const published = await publishCompletionReport(deps.client, issueRef, report.content, dispatchId);
        reportId = published.id;
      }
      await writeReceipt(paths, {
        ...receiptBase(receipt, dispatchId),
        status: 'published',
        published_comment_id: reportId,
        tracker_comment_id: trackerId,
        last_sync_at: nowIso,
        error: null,
      });
      return {
        dispatchId,
        action: 'completed',
        detail: `completion report #${reportId} published for issue #${issueRef.issueNumber} (awaiting Gate acceptance)`,
      };
    }

    // result = blocked | question | failed: reflect Blocked on the tracker
    // (creating it first if the agent jumped straight to a terminal state)
    // and post a plain notice with the reason. Notices don't consume the
    // published token; the tracker edit is a state-relevant write the
    // preflight already authorized against the current state matrix.
    if (snapshot.aiState !== 'ai:working' && snapshot.aiState !== 'ai:blocked') {
      return {
        dispatchId,
        action: 'unchanged',
        detail: `blocked-state reporting requires ai:working|ai:blocked, current state is ${snapshot.aiState}`,
      };
    }
    const { tracker } = await resolveTracker(deps, issueRef, dispatchId, receipt);
    let trackerId: number;
    if (tracker !== null) {
      await updateTracker(deps.client, issueRef, tracker.id, tracker.body, { status: 'Blocked' });
      trackerId = tracker.id;
    } else {
      const progress = await readMarkdownCapped(paths, dispatchId, 'PROGRESS.md');
      const created = await publishTrackerComment(deps.client, issueRef, {
        dispatchId,
        issueNumber: issueRef.issueNumber,
        progressMarkdown: progress.content ?? '',
      });
      // T3 then T4: create as In Progress, then edit to Blocked so the gate
      // sees the same transition everyone else does.
      const createdBody = buildTrackerCommentBody({
        dispatchId,
        issueNumber: issueRef.issueNumber,
        status: 'In Progress',
        progressMarkdown: progress.content ?? '',
      });
      await updateTracker(deps.client, issueRef, created.id, createdBody, { status: 'Blocked' });
      trackerId = created.id;
    }
    const body = noticeBody('executor', result.result, dispatchId, result.reason ?? '(no reason given)');
    await deps.client.addIssueComment(issueRef, body);
    await writeReceipt(paths, {
      ...receiptBase(receipt, dispatchId),
      status: receipt?.status ?? 'dispatched',
      tracker_comment_id: trackerId,
      last_notice_key: noticeKey(body),
      last_sync_at: nowIso,
    });
    return { dispatchId, action: 'notice', detail: `executor ${result.result}: tracker #${trackerId} set to Blocked, notice posted` };
  }

  // No terminal result: tracker lifecycle over status.json.
  if (status === null) {
    return { dispatchId, action: 'unchanged', detail: 'no status.json or result.json in the outbox yet' };
  }

  // State matrix for tracker lifecycle writes: T4/T5 exist only between
  // WORKING and BLOCKED; creation is meaningful in READY (T3) or WORKING
  // (a missed creation event).
  const trackerStateAllowed =
    status.state === 'blocked'
      ? snapshot.aiState === 'ai:working' || snapshot.aiState === 'ai:blocked'
      : snapshot.aiState === 'ai:ready' || snapshot.aiState === 'ai:working' || snapshot.aiState === 'ai:blocked';
  if (!trackerStateAllowed) {
    return {
      dispatchId,
      action: 'unchanged',
      detail: `tracker lifecycle requires ai:ready|ai:working|ai:blocked, current state is ${snapshot.aiState}`,
    };
  }

  const progress = await readMarkdownCapped(paths, dispatchId, 'PROGRESS.md');
  if (progress.error !== null) {
    return { dispatchId, action: 'rejected', detail: `PROGRESS.md rejected: ${progress.error}` };
  }
  const progressMd = progress.content;
  const progressSha = progressMd === null ? null : sha256Hex(progressMd);

  const { tracker } = await resolveTracker(deps, issueRef, dispatchId, receipt);

  if (tracker === null) {
    // Fresh tracker (T3 trigger). Always created 'In Progress'; an immediate
    // Blocked edit (T4) follows when the agent already reported blocked.
    const created = await publishTrackerComment(deps.client, issueRef, {
      dispatchId,
      issueNumber: issueRef.issueNumber,
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
        issueNumber: issueRef.issueNumber,
        status: 'In Progress',
        progressMarkdown: progressMd ?? '',
      });
      await updateTracker(deps.client, issueRef, created.id, createdBody, { status: 'Blocked' });
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
    await updateTracker(deps.client, issueRef, tracker.id, tracker.body, { status: 'Blocked' });
    await writeReceipt(paths, { ...receiptBase(receipt, dispatchId), tracker_comment_id: tracker.id, last_sync_at: nowIso });
    return { dispatchId, action: 'blocked', detail: `tracker #${tracker.id} set to Blocked` };
  }

  if (status.state === 'working' && findTrackerStatus(tracker.body) === 'Blocked') {
    // T5: blocked → working again.
    await updateTracker(deps.client, issueRef, tracker.id, tracker.body, {
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
      await updateTracker(deps.client, issueRef, tracker.id, tracker.body, {
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
 * Locate the tracker comment for a dispatch (fresh comment fetch): the
 * receipt's id first, then a marker+dispatch-id scan (crash recovery).
 */
async function resolveTracker(
  deps: DriverDeps,
  issueRef: IssueRef,
  dispatchId: string,
  receipt: Receipt | null,
): Promise<{ comments: CommentDetail[]; tracker: CommentDetail | null }> {
  const comments = await deps.client.listComments(issueRef);
  return { comments, tracker: resolveTrackerFrom(comments, dispatchId, receipt) };
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
