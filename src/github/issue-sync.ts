/**
 * Driver use cases over the GitHub access layer (docs/architecture-v1.md
 * section 5: "Issue/评论读、Plan/Tracker/Report 评论发布").
 *
 * Discovery (pure functions over comment lists):
 *  - Plan / tracker / completion-report comments are recognized ONLY via
 *    detectCommentMarker (../gate/markers), i.e. the marker must own its
 *    line, must be the comment's single marker, and occurrences inside code
 *    fences never count — exactly the semantics the gate itself applies.
 *  - Human command matching (/choose, /change, /approve) is REIMPLEMENTED
 *    here with the same anchored, case-sensitive, whole-trimmed-body rules
 *    as the gate (src/gate/commands.ts, docs/protocol.md section 3.1). We
 *    deliberately do NOT import gate/commands.ts; if the frozen protocol
 *    ever changes, mirror the change in both places.
 *
 * Publishing (side-effectful): the Driver publishes protocol comments and
 * edits ONLY its own tracker comment. Labels, issue fields, and other
 * people's comments are never written from here — every state transition
 * belongs to the Gate (docs/architecture-v1.md section 6).
 */
import { detectCommentMarker } from '../gate/markers';
import { MARKERS } from '../gate/protocol';
import type { CommentDetail, DriverGitHubClient, IssueRef } from './client';
import {
  STATUS_LINE_PATTERN,
  buildCompletionReportBody,
  buildPlanCommentBody,
  buildTrackerCommentBody,
  findDispatchIdInComment,
  findTrackerStatus,
} from './comments';

/** A plan-marker comment with its embedded dispatch id (null if absent). */
export interface PlanComment extends CommentDetail {
  dispatchId: string | null;
}

/**
 * Returns every valid plan-marker comment, in comment order. Plan-marker
 * text inside code fences, inline text, or duplicate markers never counts
 * (detectCommentMarker semantics).
 */
export function findPlanComments(comments: CommentDetail[]): PlanComment[] {
  const plans: PlanComment[] = [];
  for (const comment of comments) {
    if (detectCommentMarker(comment.body) === MARKERS.plan) {
      plans.push({ ...comment, dispatchId: findDispatchIdInComment(comment.body) });
    }
  }
  return plans;
}

/** The most recent plan comment (the "Current Plan" candidate), or null. */
export function findLatestPlanComment(comments: CommentDetail[]): PlanComment | null {
  return findPlanComments(comments).at(-1) ?? null;
}

/**
 * The execution-tracker comment belonging to `dispatchId` (marker comment
 * whose dispatch-id matches), or null. Driver crash recovery re-finds its
 * tracker this way (docs/workspace-protocol.md section 2.6).
 */
export function findTrackerComment(
  comments: CommentDetail[],
  dispatchId: string,
): CommentDetail | null {
  for (const comment of comments) {
    if (detectCommentMarker(comment.body) !== MARKERS.executionTracker) {
      continue;
    }
    if (findDispatchIdInComment(comment.body) === dispatchId) {
      return comment;
    }
  }
  return null;
}

/** All completion-report comments belonging to `dispatchId`, in order. */
export function findCompletionReportComments(
  comments: CommentDetail[],
  dispatchId: string,
): CommentDetail[] {
  const reports: CommentDetail[] = [];
  for (const comment of comments) {
    if (detectCommentMarker(comment.body) !== MARKERS.completionReport) {
      continue;
    }
    if (findDispatchIdInComment(comment.body) === dispatchId) {
      reports.push(comment);
    }
  }
  return reports;
}

// Anchored patterns over the TRIMMED body (docs/protocol.md section 3.1):
// the whole comment must be the command. `.` never matches a newline, so
// multi-line bodies can never match; the trailing `$` forbids trailing
// content. Matching is case-sensitive on purpose ("/CHANGE" is not a
// command). Reimplemented locally — see the file header.
const CHOOSE_PATTERN = /^\/choose (\S+) (\S+)$/;
const CHANGE_PATTERN = /^\/change (.+)$/;

/** A trusted-human feedback command comment. */
export interface HumanFeedbackEntry {
  comment: CommentDetail;
  kind: 'change' | 'choose';
}

/**
 * Trusted-author check: login compare is case-insensitive; the repo owner
 * is always trusted (docs/architecture-v1.md section 4).
 */
function isTrustedAuthor(
  comment: CommentDetail,
  trustedHumans: ReadonlySet<string>,
  repoOwner: string,
): boolean {
  const login = comment.user.toLowerCase();
  if (login === repoOwner.toLowerCase()) {
    return true;
  }
  for (const human of trustedHumans) {
    if (human.toLowerCase() === login) {
      return true;
    }
  }
  return false;
}

/**
 * Human feedback commands (/choose, /change) for FEEDBACK.md projection.
 * Only whole-comment, anchored matches by trusted humans count; anything
 * else is a normal comment and is silently ignored.
 */
export function findHumanFeedbackCommands(
  comments: CommentDetail[],
  trustedHumans: ReadonlySet<string>,
  repoOwner: string,
): HumanFeedbackEntry[] {
  const entries: HumanFeedbackEntry[] = [];
  for (const comment of comments) {
    if (!isTrustedAuthor(comment, trustedHumans, repoOwner)) {
      continue;
    }
    const trimmed = comment.body.trim();
    if (CHOOSE_PATTERN.exec(trimmed) !== null) {
      entries.push({ comment, kind: 'choose' });
      continue;
    }
    if (CHANGE_PATTERN.exec(trimmed) !== null) {
      entries.push({ comment, kind: 'change' });
    }
  }
  return entries;
}

/** A trusted-human /approve record pointing at a plan comment id. */
export interface ApprovalRecord {
  comment: CommentDetail;
  planCommentId: number;
}

// V1: /approve takes the plan COMMENT id it approves (architecture 3.3).
const APPROVE_PATTERN = /^\/approve (\d+)$/;

/**
 * Approval records for the Driver's independent pre-dispatch validation
 * (docs/architecture-v1.md section 3.3): anchored `/approve <id>` comments
 * by trusted humans only. V1 semantics: the id references a plan comment.
 */
export function findApprovalRecords(
  comments: CommentDetail[],
  trustedHumans: ReadonlySet<string>,
  repoOwner: string,
): ApprovalRecord[] {
  const records: ApprovalRecord[] = [];
  for (const comment of comments) {
    if (!isTrustedAuthor(comment, trustedHumans, repoOwner)) {
      continue;
    }
    const match = APPROVE_PATTERN.exec(comment.body.trim());
    if (match === null) {
      continue;
    }
    const planCommentId = Number.parseInt(match[1] ?? '', 10);
    if (Number.isNaN(planCommentId)) {
      continue; // defensive: \d+ already guarantees a parseable integer
    }
    records.push({ comment, planCommentId });
  }
  return records;
}

/** Publishes a Plan comment (marker T1 trigger); resolves to its comment id. */
export async function publishPlanComment(
  client: DriverGitHubClient,
  ref: IssueRef,
  planMarkdown: string,
  dispatchId: string,
): Promise<{ id: number }> {
  return client.addIssueComment(ref, buildPlanCommentBody(planMarkdown, dispatchId));
}

/** Options for creating an Execution Tracker comment. */
export interface TrackerPublishOptions {
  dispatchId: string;
  issueNumber: number;
  progressMarkdown: string;
}

/**
 * Creates the Execution Tracker comment. The status is always
 * 'In Progress' at creation — 'Blocked' is reached exclusively through a
 * later updateTracker edit (gate transitions T3 then T4).
 */
export async function publishTrackerComment(
  client: DriverGitHubClient,
  ref: IssueRef,
  opts: TrackerPublishOptions,
): Promise<{ id: number }> {
  const body = buildTrackerCommentBody({
    dispatchId: opts.dispatchId,
    issueNumber: opts.issueNumber,
    status: 'In Progress',
    progressMarkdown: opts.progressMarkdown,
  });
  return client.addIssueComment(ref, body);
}

/** Partial update of an existing tracker comment. */
export interface TrackerUpdateOptions {
  status?: 'In Progress' | 'Blocked';
  progressMarkdown?: string;
}

/**
 * Extracts the "progress tail": everything AFTER the FIRST `**Status:**`
 * line outside ``` fences, verbatim. Returns '' when the body carries no
 * status line outside fences. The tail is re-rendered through
 * buildTrackerCommentBody (which normalizes line endings and trims), so
 * byte-preservation does not apply here — deterministic rebuild does.
 */
function extractProgressTail(body: string): string {
  const lines = body.split(/\r?\n/);
  let insideFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed.startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      continue;
    }
    if (STATUS_LINE_PATTERN.test(trimmed)) {
      return lines.slice(i + 1).join('\n');
    }
  }
  return '';
}

/**
 * Deterministically rebuilds and edits the Driver's tracker comment:
 * marker + dispatch-id comment + `**Status:** <resolved>` + progress.
 * Marker, dispatch-id and Status lines always remain intact.
 *
 *  - status: opts.status, else the body's current machine status, else
 *    'In Progress'. ('Completed' is not Driver-writable and falls back to
 *    'In Progress' — the gate only reacts to tracker edits while the issue
 *    sits in WORKING / BLOCKED, so this fallback cannot cause a transition.)
 *  - progress: opts.progressMarkdown (an explicit '' clears it), else the
 *    existing tail after the current Status line, else ''.
 *
 * Throws when the current body carries no dispatch-id comment: rebuilding
 * without it would silently detach the tracker from its dispatch.
 */
export async function updateTracker(
  client: DriverGitHubClient,
  ref: IssueRef,
  commentId: number,
  currentBody: string,
  opts: TrackerUpdateOptions,
): Promise<void> {
  const dispatchId = findDispatchIdInComment(currentBody);
  if (dispatchId === null) {
    throw new Error(
      `tracker comment ${commentId} carries no gateflow dispatch-id comment; refusing to rebuild it`,
    );
  }
  const current = findTrackerStatus(currentBody);
  const status: 'In Progress' | 'Blocked' =
    opts.status ?? (current === 'Blocked' ? 'Blocked' : 'In Progress');
  const progressMarkdown = opts.progressMarkdown ?? extractProgressTail(currentBody);
  const body = buildTrackerCommentBody({
    dispatchId,
    issueNumber: ref.issueNumber,
    status,
    progressMarkdown,
  });
  await client.updateIssueComment(ref, commentId, body);
}

/**
 * Publishes a Completion Report comment (marker T6 trigger); resolves to
 * its comment id.
 */
export async function publishCompletionReport(
  client: DriverGitHubClient,
  ref: IssueRef,
  reportMarkdown: string,
  dispatchId: string,
): Promise<{ id: number }> {
  return client.addIssueComment(ref, buildCompletionReportBody(reportMarkdown, dispatchId));
}
