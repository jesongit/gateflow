/**
 * Shared Workflow Authorization Chain (hardening plan V1.1 Phase 1 §4.6 —
 * "不要让 Driver 和 Gate 各自实现一套").
 *
 * ONE module answers the only question that matters for every state-relevant
 * decision on both sides:
 *
 *   > Does this source object belong to the CURRENTLY AUTHORIZED execution
 *   > chain — current epoch, current plan, valid approval, matching dispatch?
 *
 * Consumers:
 *  - the GATE (src/gate/authorization.ts): every marker-triggered transition
 *    (T1 / T3 / T4 / T5 / T6) and every record-anchoring command;
 *  - the DRIVER (discovery intents, sync/dispatch preflight): the exact same
 *    semantics, re-validated independently ("Driver Preflight != Gate
 *    Authorization" — the Driver may pre-block, the Gate must re-prove).
 *
 * Fail-closed contract: every function returns `{ ok: false, reason }` (with
 * `conflict: true` where the failure is definitive tampering) instead of
 * throwing. Only genuine infrastructure failures propagate at the callers.
 */
import { detectCommentMarker } from '../gate/markers';
import { MARKERS } from '../gate/protocol';
import { planSha256 } from './plan';
import {
  extractEpochCommandCommentId,
  parseRecord,
  parseRecords,
  recordKindOf,
  approvalRecordsConflict,
  epochRecordsConflict,
  type ApprovalRecord,
  type FeedbackAcceptedRecord,
  type GateTransitionRecord,
  type ParsedRecord,
  type TransitionId,
  type WorkflowEpochRecord,
} from './records';
import { parseDispatchId, type ParsedDispatchId } from '../workspace/protocol';
import { isFeedbackCommand } from './commands';

/** Minimal comment projection both runtimes already have. */
export interface ChainComment {
  id: number;
  user: string;
  body: string;
}

export type ChainVerdict = { ok: true } | { ok: false; reason: string; conflict: boolean };

export type EpochResolution =
  | { ok: true; epoch: string; commentId: number; record: WorkflowEpochRecord }
  | { ok: false; reason: string; conflict: boolean };

/** Inputs for resolving an issue's CURRENT epoch with full trust checks. */
export interface EpochResolutionInput {
  comments: ReadonlyArray<ChainComment>;
  repositoryId: number;
  issueNumber: number;
  /**
   * Logins allowed to have authored `created_by: "gate"` epoch records
   * (the Gate identities; the Driver configures this as `gateLogins`).
   */
  gateIssuers: ReadonlySet<string>;
  /**
   * Logins allowed to have authored `created_by: "driver_bootstrap"` epoch
   * records (the explicit Bootstrap Driver identities).
   */
  bootstrapIssuers: ReadonlySet<string>;
}

function loginIn(set: ReadonlySet<string>, login: string): boolean {
  return set.has(login.trim().toLowerCase());
}

/**
 * V1.1 Phase 2 (Epoch Record Trust): resolve the CURRENT epoch of an issue.
 *
 * An epoch record counts ONLY when ALL of the following hold:
 *  - it parses strictly (unparsable epoch records fail closed — tampering);
 *  - `repository_id` / `issue_number` match the issue it sits on (a record
 *    transplanted from another issue is a forgery, never "another round");
 *  - its issuer matches `created_by`: `gate` records must be authored by a
 *    Gate identity, `driver_bootstrap` records by a configured Bootstrap
 *    Driver. A plain user or a Trusted Agent can therefore never forge the
 *    round identity (Phase 2 acceptance);
 *  - records sharing one operation id agree on the epoch value (otherwise:
 *    conflict, fail closed — never "latest wins", Phase 2 §5.4).
 *
 * The current epoch is the surviving record with the HIGHEST comment id.
 */
export function resolveCurrentEpoch(input: EpochResolutionInput): EpochResolution {
  const { records, invalid } = parseRecords('workflow_epoch', input.comments);
  if (invalid.length > 0) {
    return {
      ok: false,
      conflict: false,
      reason:
        `unparsable workflow_epoch record(s) on #${input.issueNumber} (fail closed): ` +
        invalid.map((entry) => `#${entry.commentId} (${entry.reason})`).join(', '),
    };
  }
  const accepted: Array<ParsedRecord<WorkflowEpochRecord>> = [];
  for (const entry of records) {
    const { record, comment } = entry;
    if (record.repository_id !== input.repositoryId || record.issue_number !== input.issueNumber) {
      return {
        ok: false,
        conflict: false,
        reason:
          `workflow_epoch record #${entry.commentId} binds repository ${record.repository_id} ` +
          `issue #${record.issue_number}, but sits on repository ${input.repositoryId} ` +
          `issue #${input.issueNumber} (transplanted record — fail closed)`,
      };
    }
    const issuerOk =
      record.created_by === 'gate'
        ? loginIn(input.gateIssuers, comment.user)
        : loginIn(input.bootstrapIssuers, comment.user);
    if (!issuerOk) {
      return {
        ok: false,
        conflict: false,
        reason:
          `workflow_epoch record #${entry.commentId} (created_by ${record.created_by}) was ` +
          `authored by "${comment.user}", who is not an allowed issuer for that class ` +
          '(forged epoch — fail closed)',
      };
    }
    accepted.push(entry);
  }
  const conflict = epochRecordsConflict(accepted);
  if (conflict.conflict) {
    return { ok: false, conflict: true, reason: conflict.reason ?? 'conflicting epoch records' };
  }
  const latest = accepted[accepted.length - 1];
  if (latest === undefined) {
    return { ok: false, conflict: false, reason: `no workflow_epoch record on #${input.issueNumber}` };
  }
  return {
    ok: true,
    epoch: latest.record.workflow_epoch,
    commentId: latest.commentId,
    record: latest.record,
  };
}

/**
 * Find the epoch record that a given operation id (gate T0 `c<comment>` or
 * `bootstrap` form) already produced, for the search-then-adopt recovery
 * path (Phase 3 + Phase 6). With `expectedEpoch` set, an existing record
 * naming a DIFFERENT epoch resolves to `{ conflict: true }`. Returns the
 * record when found and consistent; `{ conflict: true }` when the same
 * operation id carries divergent epochs (fail closed); not found otherwise.
 */
export function findEpochRecordByOperationId(
  comments: ReadonlyArray<ChainComment>,
  operationId: string,
  expectedEpoch?: string,
): { found: true; record: WorkflowEpochRecord; commentId: number } | { found: false; conflict: boolean } {
  const { records, invalid } = parseRecords('workflow_epoch', comments);
  if (invalid.length > 0) {
    return { found: false, conflict: false };
  }
  const matches = records.filter((entry) => entry.record.operation_id === operationId);
  const first = matches[0];
  if (first === undefined) {
    return { found: false, conflict: false };
  }
  if (matches.some((entry) => entry.record.workflow_epoch !== first.record.workflow_epoch)) {
    return { found: false, conflict: true };
  }
  if (expectedEpoch !== undefined && first.record.workflow_epoch !== expectedEpoch) {
    return { found: false, conflict: true };
  }
  return { found: true, record: first.record, commentId: first.commentId };
}

/**
 * The CURRENT plan = the LAST valid plan-marker comment of the issue
 * (comment-id order). Null when the issue has no plan yet.
 */
export function currentPlanOf(comments: ReadonlyArray<ChainComment>): ChainComment | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    if (comment !== undefined && detectCommentMarker(comment.body) === MARKERS.plan) {
      return comment;
    }
  }
  return null;
}

/** Trusted-human membership over a resolved (lowercased) set. */
function isTrustedAuthor(comment: ChainComment, trustedHumans: ReadonlySet<string>): boolean {
  return trustedHumans.has(comment.user.trim().toLowerCase());
}

/**
 * ACCEPTED feedback events of `epoch`: Gate-issued feedback_accepted records
 * whose command comment still exists, still parses as the anchored
 * /choose or /change it records, and is authored by a trusted human.
 * Rejected, duplicated, foreign-epoch and edited-away commands never count —
 * the Consumer revision comes from THIS sequence, never from comment counts
 * (plan Phase 8, "Consumer revision 改为基于 Accepted Feedback Sequence").
 */
export function acceptedFeedbackOfEpoch(input: {
  comments: ReadonlyArray<ChainComment>;
  epoch: string;
  trustedHumans: ReadonlySet<string>;
}): Array<{ record: FeedbackAcceptedRecord; comment: ChainComment }> {
  const { records } = parseRecords('feedback_accepted', input.comments);
  const byId = new Map(input.comments.map((comment) => [comment.id, comment]));
  const accepted: Array<{ record: FeedbackAcceptedRecord; comment: ChainComment }> = [];
  for (const entry of records) {
    const { record } = entry;
    if (record.workflow_epoch !== input.epoch) continue;
    const comment = byId.get(record.feedback_comment_id);
    if (comment === undefined) continue;
    if (!isTrustedAuthor(comment, input.trustedHumans)) continue;
    if (!isFeedbackCommand(comment.body.trim(), record.feedback_kind)) continue;
    accepted.push({ record, comment });
  }
  return accepted;
}

/** Consumer dispatch round (`01`, `02`, ...) for an accepted-feedback count. */
export function consumerRoundOf(acceptedFeedbackCount: number): string {
  return String(1 + acceptedFeedbackCount).padStart(2, '0');
}

/**
 * Extracts and parses the dispatch binding embedded in a protocol object
 * comment (`<!-- gateflow:dispatch-id: ... -->`). Null when absent/junk.
 */
export function dispatchBindingOf(comment: ChainComment): ParsedDispatchId | null {
  const match = /<!--\s*gateflow:dispatch-id:\s*(\S+)\s*-->/.exec(comment.body);
  const id = match?.[1];
  if (id === undefined) return null;
  return parseDispatchId(id);
}

/** The dispatch id string embedded in a comment; null when absent. */
export function dispatchIdOf(comment: ChainComment): string | null {
  const match = /<!--\s*gateflow:dispatch-id:\s*(\S+)\s*-->/.exec(comment.body);
  return match?.[1] ?? null;
}

/** Shared grammar/epoch/issue checks for any dispatch-bound source object. */
function dispatchBindingFailures(
  binding: ParsedDispatchId,
  opts: { repositoryId: number; issueNumber: number; epoch: string; role: 'consumer' | 'executor' },
): string | null {
  if (binding.repositoryId !== opts.repositoryId || binding.issueNumber !== opts.issueNumber) {
    return (
      `dispatch binding targets repository ${binding.repositoryId} issue ` +
      `#${binding.issueNumber}, not this issue`
    );
  }
  if (binding.role !== opts.role) {
    return `dispatch binding role is ${binding.role}, expected ${opts.role}`;
  }
  if (`wf_${binding.epochCode}` !== opts.epoch) {
    return `dispatch binding epoch (wf_${binding.epochCode}) is not the current epoch (${opts.epoch})`;
  }
  return null;
}

/**
 * T1 authorization (Phase 1 §4.2): a Plan comment may move PLANNING → REVIEW
 * only when it belongs to a CURRENT consumer dispatch of the current epoch.
 * In every state where T1 can fire (PLANNING) the consumer round of the
 * current epoch is `01` (feedback acceptance requires REVIEW and a new epoch
 * starts a new round), so the revision binding is exact and race-free.
 */
export function validateConsumerPlanSource(input: {
  planComment: ChainComment;
  epoch: string;
  repositoryId: number;
  issueNumber: number;
  acceptedFeedbackCount: number;
}): ChainVerdict {
  const binding = dispatchBindingOf(input.planComment);
  if (binding === null) {
    return {
      ok: false,
      conflict: false,
      reason: 'plan comment carries no gateflow dispatch-id comment (no authorized consumer dispatch)',
    };
  }
  const failure = dispatchBindingFailures(binding, {
    repositoryId: input.repositoryId,
    issueNumber: input.issueNumber,
    epoch: input.epoch,
    role: 'consumer',
  });
  if (failure !== null) {
    return { ok: false, conflict: false, reason: failure };
  }
  const expectedRevision = consumerRoundOf(input.acceptedFeedbackCount);
  if (binding.revision !== expectedRevision) {
    return {
      ok: false,
      conflict: false,
      reason: `plan dispatch revision ${binding.revision} is not the current consumer round ${expectedRevision}`,
    };
  }
  return { ok: true };
}

/** Everything the executor-chain check needs (supplied fresh by the caller). */
export interface ExecutorChainInput {
  /** The tracker / report comment being authorized. */
  sourceComment: ChainComment;
  epoch: string;
  repositoryId: number;
  issueNumber: number;
  comments: ReadonlyArray<ChainComment>;
  /** Logins allowed to have authored approval records (Gate identities). */
  gateIssuers: ReadonlySet<string>;
  /** Trusted humans for the /approve anchor re-validation. */
  trustedHumans: ReadonlySet<string>;
  repoOwner: string;
}

export type ApprovalBindingVerdict =
  | { ok: true; planCommentId: number; planSha256: string; approvalCommentId: number }
  | { ok: false; reason: string; conflict: boolean };

export interface ApprovalBindingInput {
  epoch: string;
  repositoryId: number;
  issueNumber: number;
  comments: ReadonlyArray<ChainComment>;
  /** Logins allowed to have authored approval records (Gate identities). */
  gateIssuers: ReadonlySet<string>;
  /** Trusted humans for the /approve anchor re-validation. */
  trustedHumans: ReadonlySet<string>;
  repoOwner: string;
}

/**
 * The approval binding WITHOUT a source object (V1.1): the CURRENT plan must
 * exist and a Gate-issued approval RECORD must bind (epoch, plan id, exact
 * plan_sha256) with an intact human /approve anchor and no record conflict.
 * This is what the Driver's executor-intent derivation and preflight
 * re-validate — and what the executor-chain check (below) reuses for T3-T6.
 */
export function validateApprovalBinding(input: ApprovalBindingInput): ApprovalBindingVerdict {
  const plan = currentPlanOf(input.comments);
  if (plan === null) {
    return { ok: false, conflict: false, reason: 'no plan comment on the issue (no current plan)' };
  }
  const hash = planSha256(plan.body);
  const { records: approvals, invalid } = parseRecords('approval', input.comments);
  if (invalid.length > 0) {
    return {
      ok: false,
      conflict: false,
      reason:
        'unparsable approval record(s) present (fail closed): ' +
        invalid.map((entry) => `#${entry.commentId} (${entry.reason})`).join(', '),
    };
  }
  const candidates = approvals.filter((entry) => {
    const record = entry.record;
    return (
      loginIn(input.gateIssuers, entry.comment.user) &&
      record.workflow_epoch === input.epoch &&
      record.plan_comment_id === plan.id &&
      record.plan_sha256 === hash &&
      approvalAnchorFailure(record, input.comments, input.trustedHumans, input.repoOwner) === null
    );
  });
  if (candidates.length === 0) {
    return {
      ok: false,
      conflict: false,
      reason: `no valid Gate-issued approval record binds (epoch ${input.epoch}, plan ${plan.id}, sha256)`,
    };
  }
  const conflict = approvalRecordsConflict(candidates);
  if (conflict.conflict) {
    return { ok: false, conflict: true, reason: conflict.reason ?? 'conflicting approval records' };
  }
  const approval = candidates[candidates.length - 1];
  if (approval === undefined) {
    return { ok: false, conflict: false, reason: 'no approval record' };
  }
  return {
    ok: true,
    planCommentId: plan.id,
    planSha256: hash,
    approvalCommentId: approval.commentId,
  };
}

export type ExecutorChainVerdict =
  | {
      ok: true;
      dispatchId: string;
      planCommentId: number;
      planSha256: string;
      approvalCommentId: number;
    }
  | { ok: false; reason: string; conflict: boolean };

/**
 * Executor chain authorization (Phase 1 §4.3, §4.4, §4.5): a Tracker or
 * Completion Report may drive T3/T4/T5/T6 only when its dispatch binding
 * names the CURRENT executor chain:
 *
 *   current epoch + role executor + revision p<current plan id>
 *   + a Gate-issued approval RECORD binding (epoch, plan id, exact
 *     plan_sha256) whose human /approve anchor is still intact
 *   + no conflicting approval records.
 *
 * An old-round tracker, a fake marker, an approval-less READY or a plan
 * edited after its approval ALL fail here — this is where attacks die.
 */
export function validateExecutorChainSource(input: ExecutorChainInput): ExecutorChainVerdict {
  const binding = dispatchBindingOf(input.sourceComment);
  if (binding === null) {
    return {
      ok: false,
      conflict: false,
      reason: 'source comment carries no gateflow dispatch-id comment (no authorized executor dispatch)',
    };
  }
  const bindingFailure = dispatchBindingFailures(binding, {
    repositoryId: input.repositoryId,
    issueNumber: input.issueNumber,
    epoch: input.epoch,
    role: 'executor',
  });
  if (bindingFailure !== null) {
    return { ok: false, conflict: false, reason: bindingFailure };
  }

  const approvalBinding = validateApprovalBinding({
    epoch: input.epoch,
    repositoryId: input.repositoryId,
    issueNumber: input.issueNumber,
    comments: input.comments,
    gateIssuers: input.gateIssuers,
    trustedHumans: input.trustedHumans,
    repoOwner: input.repoOwner,
  });
  if (!approvalBinding.ok) {
    return {
      ok: false,
      conflict: approvalBinding.conflict,
      reason: approvalBinding.reason,
    };
  }
  if (binding.revision !== `p${approvalBinding.planCommentId}`) {
    return {
      ok: false,
      conflict: false,
      reason:
        `dispatch revision ${binding.revision} does not bind the current plan comment ` +
        `${approvalBinding.planCommentId}`,
    };
  }
  const dispatchId = dispatchIdOf(input.sourceComment);
  if (dispatchId === null) {
    return { ok: false, conflict: false, reason: 'source comment carries no dispatch id' };
  }
  return {
    ok: true,
    dispatchId,
    planCommentId: approvalBinding.planCommentId,
    planSha256: approvalBinding.planSha256,
    approvalCommentId: approvalBinding.approvalCommentId,
  };
}

/**
 * Whether a tracker comment exists for `dispatchId` (marker + dispatch-id
 * match). Used by the report acceptance path: a completion report may only
 * be accepted when its own executor chain produced the tracker (Phase 1 §4.5
 * — the report must not be an orphan).
 */
export function hasTrackerForDispatch(
  comments: ReadonlyArray<ChainComment>,
  dispatchId: string,
): boolean {
  return comments.some(
    (comment) =>
      detectCommentMarker(comment.body) === MARKERS.executionTracker &&
      dispatchIdOf(comment) === dispatchId,
  );
}

/**
 * Independent re-validation of an approval RECORD's human anchor (moved here
 * from the Driver layer so Gate and Driver share ONE copy): the record's
 * `approval_command_comment_id` must reference a comment that STILL EXISTS on
 * the issue, is an anchored `/approve <plan_comment_id>` by a TRUSTED HUMAN,
 * and whose author matches the record's `approved_by_login`. Returns the
 * failure reason, or null when the anchor holds.
 */
export function approvalAnchorFailure(
  record: ApprovalRecord,
  comments: ReadonlyArray<ChainComment>,
  trustedHumans: ReadonlySet<string>,
  repoOwner: string,
): string | null {
  const command = comments.find((entry) => entry.id === record.approval_command_comment_id);
  if (command === undefined) {
    return `approval command comment ${record.approval_command_comment_id} no longer exists`;
  }
  const match = /^\/approve (\d+)$/.exec(command.body.trim());
  if (match === null || Number.parseInt(match[1] ?? '', 10) !== record.plan_comment_id) {
    return `approval command comment ${command.id} is not an anchored "/approve ${record.plan_comment_id}"`;
  }
  if (!isTrustedAuthor(command, trustedHumans) && command.user.trim().toLowerCase() !== repoOwner.trim().toLowerCase()) {
    return `approval command comment ${command.id} author "${command.user}" is not a trusted human`;
  }
  if (command.user.trim().toLowerCase() !== record.approved_by_login.trim().toLowerCase()) {
    return `approval record approver "${record.approved_by_login}" does not match command author "${command.user}"`;
  }
  return null;
}

/**
 * Suspect-record scan shared by both runtimes: records of the given kinds
 * that fail strict parsing OR whose author is not an allowed issuer. Any
 * entry means potential tampering — callers fail closed on the issue.
 */
export function suspectRecordsOf(
  comments: ReadonlyArray<ChainComment>,
  kind: 'workflow_epoch' | 'approval' | 'feedback_accepted' | 'gate_transition',
  allowedIssuers: ReadonlySet<string>,
): Array<{ commentId: number; reason: string }> {
  const suspect: Array<{ commentId: number; reason: string }> = [];
  for (const comment of comments) {
    if (recordKindOf(comment.body) !== kind) continue;
    const parsed = parseRecord(comment.id, comment.body);
    if (!parsed.ok) {
      suspect.push({ commentId: comment.id, reason: parsed.reason });
      continue;
    }
    if (!loginIn(allowedIssuers, comment.user)) {
      suspect.push({
        commentId: comment.id,
        reason: `${kind} record authored by untrusted identity "${comment.user}"`,
      });
    }
  }
  return suspect;
}

/** Convenience: all gate_transition records parsed from a comment list. */
export function parseTransitionRecords(
  comments: ReadonlyArray<ChainComment>,
): {
  records: Array<ParsedRecord<GateTransitionRecord>>;
  invalid: Array<{ commentId: number; reason: string }>;
} {
  return parseRecords('gate_transition', comments);
}

/**
 * Whether a Gate transition record proves the acceptance of a SPECIFIC
 * source object (Phase 5 receipt rule): epoch + dispatch + transition +
 * source_comment_id must ALL match. This — never a bare label observation —
 * is what moves a Driver receipt to `accepted`.
 */
export function transitionMatchesReceipt(
  record: GateTransitionRecord,
  opts: { epoch: string; dispatchId: string | null; transition: TransitionId; sourceCommentId: number },
): boolean {
  return (
    record.workflow_epoch === opts.epoch &&
    record.transition === opts.transition &&
    record.source_comment_id === opts.sourceCommentId &&
    record.dispatch_id === opts.dispatchId
  );
}

/**
 * Extracts the command comment id from a gate epoch operation id
 * (`epoch:<r>:<i>:c<id>`); null for the bootstrap form.
 */
export function epochCommandCommentIdOf(operationId: string): number | null {
  return extractEpochCommandCommentId(operationId);
}
