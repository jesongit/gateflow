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
 *    Driver interprets them, and SINCE V1.1 the current epoch resolves ONLY
 *    through the SHARED workflow chain (src/protocol/workflow-chain.ts,
 *    hardening Phase 1 §4.6): issuer classes, repository/issue binding and
 *    operation-id conflicts are validated identically on both sides.
 *  - Human command matching for the FEEDBACK.md projection (/choose,
 *    /change) uses the SHARED command grammar (src/protocol/commands.ts,
 *    hardening Phase 8 — no driver-local regex table anymore). Acceptance
 *    (revision counting) is decided by Gate-issued feedback records, never
 *    by the raw comment count.
 *
 * Publishing (side-effectful): the Driver publishes protocol comments and
 * edits ONLY its own tracker comment. Labels, issue fields, and other
 * people's comments are never written from here — every state transition
 * belongs to the Gate (docs/architecture-v1.md section 6).
 */
import { detectCommentMarker } from '../gate/markers';
import { MARKERS } from '../gate/protocol';
import { isFeedbackCommand } from '../protocol/commands';
import {
  parseRecords,
  type ApprovalRecord,
  type FeedbackAcceptedRecord,
  type GateTransitionRecord,
  type WorkflowEpochRecord,
} from '../protocol/records';
import {
  acceptedFeedbackOfEpoch,
  approvalAnchorFailure,
  resolveCurrentEpoch,
} from '../protocol/workflow-chain';
import type { CommentDetail, DriverGitHubClient, IssueRef } from './client';
import {
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

/** A trusted-human feedback command comment. */
export interface HumanFeedbackEntry {
  comment: CommentDetail;
  kind: 'change' | 'choose';
}

/** Case-insensitive membership test against a login allowlist. */
export function isKnownLogin(login: string, allowlist: ReadonlySet<string>): boolean {
  return allowlist.has(login.trim().toLowerCase());
}

/**
 * Trusted-author check: login compare is case-insensitive; the repo owner
 * is always trusted (docs/architecture-v1.md section 4).
 */
export function isTrustedAuthor(
  comment: { user: string },
  trustedHumans: ReadonlySet<string>,
  repoOwner: string,
): boolean {
  const login = comment.user.trim().toLowerCase();
  if (login === repoOwner.trim().toLowerCase()) {
    return true;
  }
  return trustedHumans.has(login);
}

/**
 * Candidate human feedback commands (/choose, /change) for FEEDBACK.md
 * projection: whole-comment, anchored matches by trusted humans, using the
 * SHARED grammar (Phase 8). These are CANDIDATES only — discovery
 * intersects them with Gate-issued feedback_accepted records before counting
 * revisions or projecting.
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
    if (isFeedbackCommand(trimmed, 'choose')) {
      entries.push({ comment, kind: 'choose' });
      continue;
    }
    if (isFeedbackCommand(trimmed, 'change')) {
      entries.push({ comment, kind: 'change' });
    }
  }
  return entries;
}

/**
 * Independent re-validation of an approval RECORD's human anchor (schema 2,
 * docs/plans/v1_hardening_decisions.md §4.2; implementation lives ONCE in
 * src/protocol/workflow-chain.ts since V1.1 — Gate and Driver share it).
 * Returns the reason when the anchor fails; null when it holds.
 */
export function approvalRecordAnchorFailure(
  record: ApprovalRecord,
  comments: CommentDetail[],
  trustedHumans: ReadonlySet<string>,
  repoOwner: string,
): string | null {
  return approvalAnchorFailure(record, comments, trustedHumans, repoOwner);
}

/** Everything the Driver knows about one issue's Gate-issued records. */
export interface IssueRecordView {
  /**
   * Current epoch — resolved through the SHARED chain validator when the
   * issue identity is known (readIssueRecordsForIssue, V1.1 Phase 2). Null
   * when absent or UNRESOLVABLE (resolution failures also appear in
   * `suspect` so callers fail closed).
   */
  epoch: { record: WorkflowEpochRecord; commentId: number } | null;
  /** Approval records authored by a trusted Gate identity (id-ascending). */
  approvals: Array<{ commentId: number; record: ApprovalRecord }>;
  /** feedback_accepted records authored by a trusted Gate identity. */
  feedback: Array<{ commentId: number; record: FeedbackAcceptedRecord }>;
  /**
   * Gate-issued gate_transition records authored by a trusted Gate identity
   * (V1.1 Phase 4; id-ascending). The receipt-acceptance evidence.
   */
  transitions: Array<{ commentId: number; record: GateTransitionRecord }>;
  /**
   * Records that carry a record marker but fail strict parsing, whose author
   * is NOT in the Gate allowlist, or whose epoch resolution failed (conflict,
   * forged issuer, transplanted repo/issue binding). Any entry here means
   * potential tampering: callers fail closed on the affected kind.
   */
  suspect: Array<{ commentId: number; reason: string }>;
}

/**
 * Parse + authorize the Gate records of one issue comment list (schema 2,
 * docs/plans/v1_hardening_decisions.md §4). `gateLogins` is the Driver-side
 * allowlist of identities allowed to have authored approval / feedback /
 * transition / gate-epoch records. `bootstrapIssuers` (V1.1 Phase 2) is the
 * explicit allowlist for `driver_bootstrap` epoch records — when omitted,
 * bootstrap records are NOT trusted (fail closed).
 *
 * This list-only variant cannot validate the epoch record's
 * repository/issue binding (it does not know the issue identity); the
 * issue-bound variant below (`readIssueRecordsForIssue`) is the strict
 * entry point new driver code must use.
 */
export function readIssueRecords(
  comments: CommentDetail[],
  gateLogins: ReadonlySet<string>,
  bootstrapIssuers: ReadonlySet<string> = new Set(),
): IssueRecordView {
  const suspect: Array<{ commentId: number; reason: string }> = [];

  const epoch = parseRecords('workflow_epoch', comments);
  const approvals = parseRecords('approval', comments);
  const feedback = parseRecords('feedback_accepted', comments);
  const transitions = parseRecords('gate_transition', comments);
  for (const invalid of [
    ...epoch.invalid,
    ...approvals.invalid,
    ...feedback.invalid,
    ...transitions.invalid,
  ]) {
    suspect.push({ commentId: invalid.commentId, reason: invalid.reason });
  }

  const trusted = (entry: { comment: { user: string } }): boolean =>
    isKnownLogin(entry.comment.user, gateLogins);

  const trustedApprovals = approvals.records
    .filter(trusted)
    .map((entry) => ({ commentId: entry.commentId, record: entry.record }));
  const trustedFeedback = feedback.records
    .filter(trusted)
    .map((entry) => ({ commentId: entry.commentId, record: entry.record }));
  const trustedTransitions = transitions.records
    .filter(trusted)
    .map((entry) => ({ commentId: entry.commentId, record: entry.record }));

  // Records with a VALID body but an UNTRUSTED author are forgeries: they
  // are excluded above AND flagged so callers can fail closed.
  for (const entry of approvals.records) {
    if (!trusted(entry)) {
      suspect.push({
        commentId: entry.commentId,
        reason: `approval record authored by untrusted identity "${entry.comment.user}"`,
      });
    }
  }
  for (const entry of feedback.records) {
    if (!trusted(entry)) {
      suspect.push({
        commentId: entry.commentId,
        reason: `feedback record authored by untrusted identity "${entry.comment.user}"`,
      });
    }
  }
  for (const entry of transitions.records) {
    if (!trusted(entry)) {
      suspect.push({
        commentId: entry.commentId,
        reason: `gate_transition record authored by untrusted identity "${entry.comment.user}"`,
      });
    }
  }

  // Epoch issuer classes (V1.1 Phase 2): `gate` records must come from the
  // gate allowlist, `driver_bootstrap` records from the bootstrap allowlist.
  // Violations are forgeries: flagged AND excluded from the epoch resolution.
  const epochCandidates = epoch.records.filter((entry) => {
    const allowed =
      entry.record.created_by === 'gate'
        ? isKnownLogin(entry.comment.user, gateLogins)
        : isKnownLogin(entry.comment.user, bootstrapIssuers);
    if (!allowed) {
      suspect.push({
        commentId: entry.commentId,
        reason:
          `workflow_epoch record (created_by ${entry.record.created_by}) authored by ` +
          `"${entry.comment.user}", who is not an allowed issuer for that class`,
      });
    }
    return allowed;
  });

  const latestEpochRecord = epochCandidates[epochCandidates.length - 1] ?? null;

  return {
    epoch:
      latestEpochRecord === null
        ? null
        : { record: latestEpochRecord.record, commentId: latestEpochRecord.commentId },
    approvals: trustedApprovals,
    feedback: trustedFeedback,
    transitions: trustedTransitions,
    suspect,
  };
}

/**
 * Strict issue-bound variant of readIssueRecords (V1.1): additionally runs
 * the SHARED resolveCurrentEpoch so a record transplanted from another
 * repository/issue, a forged issuer class or a conflicting operation id
 * fails the whole view closed (suspect entries + epoch null). New driver
 * code (preflight / discovery / intents) uses THIS entry point.
 */
export function readIssueRecordsForIssue(
  comments: CommentDetail[],
  opts: {
    repositoryId: number;
    issueNumber: number;
    gateLogins: ReadonlySet<string>;
    bootstrapIssuers: ReadonlySet<string>;
  },
): IssueRecordView {
  const view = readIssueRecords(comments, opts.gateLogins, opts.bootstrapIssuers);
  const resolution = resolveCurrentEpoch({
    comments,
    repositoryId: opts.repositoryId,
    issueNumber: opts.issueNumber,
    gateIssuers: opts.gateLogins,
    bootstrapIssuers: opts.bootstrapIssuers,
  });
  if (!resolution.ok) {
    // "No epoch record at all" is a NORMAL pre-bootstrap state (Producer
    // submissions, post-T0 record loss) — not tampering. Every OTHER
    // resolution failure (unparsable, forged issuer, transplanted binding,
    // operation-id conflict) IS suspect and fails the issue closed.
    const plainAbsence = resolution.reason.startsWith('no workflow_epoch record');
    return {
      epoch: null,
      approvals: [],
      feedback: [],
      transitions: [],
      suspect: plainAbsence
        ? view.suspect
        : [
            ...view.suspect,
            { commentId: -1, reason: `workflow_epoch resolution failed: ${resolution.reason}` },
          ],
    };
  }
  return { ...view, epoch: { record: resolution.record, commentId: resolution.commentId } };
}

/**
 * Accepted feedback events of the CURRENT epoch: gate-issued records whose
 * referenced command comment still exists as an anchored /choose or /change
 * by a trusted human. Rejected, duplicated (no record), old-epoch and
 * edited-away commands never count (hardening Phase 3.2; SHARED
 * implementation in workflow-chain since V1.1).
 */
export function acceptedFeedbackEvents(
  view: IssueRecordView,
  comments: CommentDetail[],
  trustedHumans: ReadonlySet<string>,
  repoOwner: string,
): HumanFeedbackEntry[] {
  if (view.epoch === null) return [];
  const humansWithOwner = new Set(trustedHumans);
  humansWithOwner.add(repoOwner.trim().toLowerCase());
  const accepted = acceptedFeedbackOfEpoch({
    comments,
    epoch: view.epoch.record.workflow_epoch,
    trustedHumans: humansWithOwner,
  });
  return accepted.map((entry) => ({
    comment: entry.comment as CommentDetail,
    kind: entry.record.feedback_kind,
  }));
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
    if (trimmed.startsWith('**Status:**')) {
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
 * NOTE (V1.1): the fallback for a body whose current status cannot be parsed
 * is 'In Progress'; the gate only reacts to tracker edits while the issue
 * sits in WORKING / BLOCKED and never transitions on an unchanged value, so
 * this fallback cannot cause a transition. 'Completed' is never
 * Driver-writable.
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
