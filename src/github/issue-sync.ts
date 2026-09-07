/**
 * Driver use cases over the GitHub access layer (docs/architecture-v1.md
 * section 5: "Issue/评论读、Plan/Tracker/Report 评论发布").
 *
 * Discovery (pure functions over comment lists):
 *  - Plan / tracker / completion-report comments are recognized ONLY via
 *    detectCommentMarker (../gate/markers), i.e. the marker must own its
 *    line, must be the comment's single marker, and occurrences inside code
 *    fences never count — exactly the semantics the gate itself applies.
 *  - Authorization facts come from Gate-issued RECORDS (schema 2, shared
 *    parser in ../protocol/records): readIssueRecords is the ONE place the
 *    Driver interprets them. No second copy of the record grammar exists.
 *  - Human command matching for the FEEDBACK.md projection (/choose,
 *    /change) is REIMPLEMENTED here with the same anchored, case-sensitive,
 *    whole-trimmed-body rules as the gate (src/gate/commands.ts,
 *    docs/protocol.md section 3.1). We deliberately do NOT import
 *    gate/commands.ts; if the frozen protocol ever changes, mirror the
 *    change in both places. Acceptance (revision counting) is decided by
 *    Gate-issued feedback records, never by the raw comment count.
 *
 * Publishing (side-effectful): the Driver publishes protocol comments and
 * edits ONLY its own tracker comment. Labels, issue fields, and other
 * people's comments are never written from here — every state transition
 * belongs to the Gate (docs/architecture-v1.md section 6).
 */
import { detectCommentMarker } from '../gate/markers';
import { MARKERS } from '../gate/protocol';
import {
  parseRecords,
  type ApprovalRecord,
  type FeedbackAcceptedRecord,
  type WorkflowEpochRecord,
} from '../protocol/records';
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
// command). Used ONLY for the FEEDBACK.md projection and for cross-checking
// that an accepted-feedback record still anchors to a real human command —
// acceptance itself is decided by Gate-issued records (schema 2).
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
 * Candidate human feedback commands (/choose, /change) for FEEDBACK.md
 * projection: whole-comment, anchored matches by trusted humans. These are
 * CANDIDATES only — discovery intersects them with Gate-issued
 * feedback_accepted records before counting revisions or projecting.
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

/** Case-insensitive membership test against a login allowlist. */
export function isKnownLogin(login: string, allowlist: ReadonlySet<string>): boolean {
  return allowlist.has(login.toLowerCase());
}

// V1: /approve takes the plan COMMENT id it approves (architecture 3.3).
const APPROVE_PATTERN = /^\/approve (\d+)$/;

/**
 * Independent re-validation of an approval RECORD's human anchor (schema 2,
 * docs/plans/v1_hardening_decisions.md §4.2): the record's
 * `approval_command_comment_id` must reference a comment that STILL EXISTS on
 * the issue, is an anchored `/approve <plan_comment_id>` by a TRUSTED HUMAN,
 * and whose author matches the record's `approved_by_login`. This binds every
 * record to a real, revocable human command — deleting or replacing the
 * command comment invalidates the record even though the record itself still
 * parses. Returns the reason when the anchor fails; null when it holds.
 */
export function approvalRecordAnchorFailure(
  record: ApprovalRecord,
  comments: CommentDetail[],
  trustedHumans: ReadonlySet<string>,
  repoOwner: string,
): string | null {
  const command = comments.find((entry) => entry.id === record.approval_command_comment_id);
  if (command === undefined) {
    return `approval command comment ${record.approval_command_comment_id} no longer exists`;
  }
  const match = APPROVE_PATTERN.exec(command.body.trim());
  if (match === null || Number.parseInt(match[1] ?? '', 10) !== record.plan_comment_id) {
    return `approval command comment ${command.id} is not an anchored "/approve ${record.plan_comment_id}"`;
  }
  if (!isTrustedAuthor(command, trustedHumans, repoOwner)) {
    return `approval command comment ${command.id} author "${command.user}" is not a trusted human`;
  }
  if (command.user.toLowerCase() !== record.approved_by_login.toLowerCase()) {
    return `approval record approver "${record.approved_by_login}" does not match command author "${command.user}"`;
  }
  return null;
}

/** Everything the Driver knows about one issue's Gate-issued records. */
export interface IssueRecordView {
  /** Current epoch = the highest-comment-id epoch record; null when absent. */
  epoch: { record: WorkflowEpochRecordData; commentId: number } | null;
  /** Approval records authored by a trusted Gate identity (id-ascending). */
  approvals: Array<{ commentId: number; record: ApprovalRecordData }>;
  /** feedback_accepted records authored by a trusted Gate identity. */
  feedback: Array<{ commentId: number; record: FeedbackAcceptedRecordData }>;
  /**
   * Records that carry a record marker but fail strict parsing, or whose
   * author is NOT in the Gate allowlist. Any entry here means potential
   * tampering: callers fail closed on the affected kind.
   */
  suspect: Array<{ commentId: number; reason: string }>;
}

type WorkflowEpochRecordData = WorkflowEpochRecord;
type ApprovalRecordData = ApprovalRecord;
type FeedbackAcceptedRecordData = FeedbackAcceptedRecord;

/**
 * Parse + authorize the Gate records of one issue comment list (schema 2,
 * docs/plans/v1_hardening_decisions.md §4). `gateLogins` is the Driver-side
 * allowlist of identities allowed to have authored approval / feedback /
 * epoch records (the Driver bootstrap may ADDITIONALLY issue epoch records,
 * so epoch records may also carry the Driver's own login — the caller adds
 * it to the set for the epoch kind only).
 */
export function readIssueRecords(
  comments: CommentDetail[],
  gateLogins: ReadonlySet<string>,
): IssueRecordView {
  const epoch = parseRecords('workflow_epoch', comments);
  const approvals = parseRecords('approval', comments);
  const feedback = parseRecords('feedback_accepted', comments);
  const suspect: Array<{ commentId: number; reason: string }> = [];
  for (const invalid of [...epoch.invalid, ...approvals.invalid, ...feedback.invalid]) {
    suspect.push({ commentId: invalid.commentId, reason: invalid.reason });
  }

  const latestEpochRecord = epoch.records[epoch.records.length - 1] ?? null;

  const trustedApprovals = approvals.records
    .filter((entry) => isKnownLogin(entry.comment.user, gateLogins))
    .map((entry) => ({ commentId: entry.commentId, record: entry.record }));
  const trustedFeedback = feedback.records
    .filter((entry) => isKnownLogin(entry.comment.user, gateLogins))
    .map((entry) => ({ commentId: entry.commentId, record: entry.record }));

  // Records with a VALID body but an UNTRUSTED author are forgeries: they
  // are excluded above AND flagged so callers can fail closed.
  for (const entry of approvals.records) {
    if (!isKnownLogin(entry.comment.user, gateLogins)) {
      suspect.push({
        commentId: entry.commentId,
        reason: `approval record authored by untrusted identity "${entry.comment.user}"`,
      });
    }
  }
  for (const entry of feedback.records) {
    if (!isKnownLogin(entry.comment.user, gateLogins)) {
      suspect.push({
        commentId: entry.commentId,
        reason: `feedback record authored by untrusted identity "${entry.comment.user}"`,
      });
    }
  }

  return {
    epoch:
      latestEpochRecord === null
        ? null
        : { record: latestEpochRecord.record, commentId: latestEpochRecord.commentId },
    approvals: trustedApprovals,
    feedback: trustedFeedback,
    suspect,
  };
}

/**
 * Accepted feedback events of the CURRENT epoch: gate-issued records whose
 * referenced command comment still exists as an anchored /choose or /change
 * by a trusted human. Rejected, duplicated (no record), old-epoch and
 * edited-away commands never count (hardening Phase 3.2).
 */
export function acceptedFeedbackEvents(
  view: IssueRecordView,
  comments: CommentDetail[],
  trustedHumans: ReadonlySet<string>,
  repoOwner: string,
): HumanFeedbackEntry[] {
  if (view.epoch === null) return [];
  const epoch = view.epoch.record.workflow_epoch;
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const accepted: HumanFeedbackEntry[] = [];
  for (const { record } of view.feedback) {
    if (record.workflow_epoch !== epoch) continue;
    const comment = byId.get(record.feedback_comment_id);
    if (comment === undefined) continue;
    if (!isTrustedAuthor(comment, trustedHumans, repoOwner)) continue;
    const trimmed = comment.body.trim();
    if (record.feedback_kind === 'choose' && CHOOSE_PATTERN.exec(trimmed) === null) continue;
    if (record.feedback_kind === 'change' && CHANGE_PATTERN.exec(trimmed) === null) continue;
    accepted.push({ comment, kind: record.feedback_kind });
  }
  return accepted;
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
