/**
 * The deterministic gate: Event -> Permission -> Current State -> Command /
 * Marker -> Validate -> Transition (docs/protocol.md sections 2, 3, 4, 7, 8).
 *
 * Hard rules enforced here:
 *  - Commands are a Trusted Human monopoly. Any of the four frozen commands
 *    (/ai-plan, /approve, /change, /cancel) from anyone else (including
 *    Trusted Agents) receives the 👎 reaction ("invalid owner command") and is
 *    otherwise ignored: no comment, no label write, no API read.
 *  - A command that fails its state precondition is a logged no-op WITHOUT a
 *    reaction (Phase 1 feedback convention). A successfully accepted command
 *    (effect performed, or legal hand-off to the planner) gets the ✅
 *    reaction. Reactions are best-effort feedback: never permission, never
 *    load-bearing; their failure is logged and ignored.
 *  - Markers are structural hints, never permission. A marker-triggered
 *    transition (T1 / T3 / T6) requires ALL of: a valid marker (unique,
 *    owning its line), a publisher in Trusted Human ∪ Trusted Agent, and a
 *    re-read state matching the transition's `from`. Invalid marker comments,
 *    markers from unknown actors and plain text never trigger anything.
 *  - An EDIT of the tracker marker comment while the issue sits in WORKING /
 *    BLOCKED is the T4 / T5 channel: the gate deterministically parses the
 *    tracker's `**Status:**` machine value (Blocked -> ai:blocked, In
 *    Progress -> ai:working). "Completed" never transitions: completion goes
 *    exclusively through the completion-report marker (T6). Non-machine
 *    values and missing values are logged no-ops.
 *  - SCHEMA 2 AUTHORIZATION (docs/plans/v1_hardening_decisions.md §4): the
 *    durable authorization facts are GATE-ISSUED RECORDS, never the human's
 *    command comments alone:
 *      /ai-plan (T0)        -> workflow_epoch record (V1: the Gate is the
 *                              only record issuer; re-running /ai-plan in
 *                              PLANNING without a record re-issues it);
 *      /approve <plan-id>   -> approval record binding repo/issue/epoch/
 *                              plan-comment-id/plan-sha256/approver, written
 *                              AND verified BEFORE the T2 label swap;
 *      /change              -> feedback_accepted record (idempotent by
 *                              operation id) — the planner-revision source.
 *    The Driver independently re-validates these records before dispatch and
 *    sync. A record write failure is a logged no-op WITHOUT a reaction and
 *    WITHOUT any label migration; a record write that succeeded while the
 *    label swap failed recovers through the record (re-running the command
 *    reuses the existing record by operation id).
 *  - Identity config is validated against the API before ANY transition:
 *    owner type via repos.get (never the event payload), Organization repos
 *    require an explicit trusted-humans allowlist, Human/Agent allowlists
 *    must never overlap (src/gate/identity.ts, GF-H10). Failure fails the
 *    run (fail closed).
 *  - The current state is derived from labels re-read via the GitHub API
 *    immediately before every migration; the event payload snapshot is never
 *    trusted (protocol section 7).
 *  - The gate never throws for protocol/business reasons; only genuine
 *    infrastructure failures (API unreachable, auth errors, ...) propagate
 *    to the caller.
 */
import {
  COMMANDS,
  LABELS,
  MARKERS,
  STATES,
  STATE_TO_LABEL,
  type State,
} from './protocol';
import {
  parseCommand,
  type ApproveArgs,
  type ChangeArgs,
  type ParsedCommand,
} from './commands';
import { validatePlanCommentForApproval } from './approvals';
import { detectCommentMarker, inspectCommentMarkers } from './markers';
import { isLegalTransition, readSnapshot, type WorkflowSnapshot } from './states';
import { parseTrackerStatus } from './tracker';
import { isTrustedAgent, isTrustedHuman, parseLoginList } from './permissions';
import { validateIdentityConfig } from './identity';
import {
  approvalOperationId,
  approvalRecordsConflict,
  buildRecordBody,
  epochOperationId,
  feedbackOperationId,
  parseRecord,
  parseRecords,
  type ApprovalRecord as ApprovalRecordPayload,
  type FeedbackAcceptedRecord as FeedbackAcceptedRecordPayload,
  type WorkflowEpochRecord,
} from '../protocol/records';
import { newWorkflowEpoch } from '../protocol/epoch';
import { planSha256 } from '../protocol/plan';
import type { GitHubClient, IssueRef } from './github';

/** Minimal logging seam; the action entry binds it to @actions/core. */
export interface GateLogger {
  info(message: string): void;
  warning(message: string): void;
}

/** Everything the gate needs to know about one event. */
export interface GateInput {
  /** GitHub event name, e.g. "issues" or "issue_comment". */
  eventName: string;
  /** Event action, e.g. "created" / "edited" / "closed" / "opened". */
  eventAction: string | undefined;
  /** Login of the acting user (comment.user.login for comment events). */
  actor: string;
  /**
   * Numeric id of the acting user (comment.user.id). Used for the approval
   * record's `approved_by_id`; 0-tolerant (recorded as 0 with a warning when
   * the payload omits it).
   */
  actorId?: number;
  /** Repository database id (payload.repository.id); embedded in records. */
  repositoryId: number;
  /** Repository owner login (github.event.repository.owner.login). */
  repoOwner: string;
  repo: string;
  issueNumber: number;
  /** Present for issue_comment events. */
  commentId: number | undefined;
  commentBody: string | undefined;
  /** Raw `trusted-humans` action input (comma-separated allowlist). */
  trustedHumansInput: string;
  /** Raw `trusted-agents` action input (V0 default: empty). */
  trustedAgentsInput: string;
  /**
   * Raw `require-explicit-humans` action input ("true"/"false"; default
   * true). When true, an Organization-owned repository without an explicit
   * trusted-humans allowlist fails the run (GF-H10).
   */
  requireExplicitHumansInput?: string;
}

/** Comment actions that carry a command or marker. */
const COMMAND_ACTIONS: ReadonlySet<string> = new Set(['created', 'edited']);

/** Runs the gate for one event. Resolves normally unless infrastructure fails. */
export async function runGate(
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  // Identity-config validation comes FIRST and is fail-closed (GF-H10): the
  // owner type is verified against the API, never against the event payload.
  const identity = await client.getRepoIdentity({ owner: input.repoOwner, repo: input.repo });
  const verdict = validateIdentityConfig({
    owner: identity.owner,
    ownerType: identity.ownerType,
    trustedHumans: parseLoginList(input.trustedHumansInput),
    trustedAgents: parseLoginList(input.trustedAgentsInput),
    requireExplicitHumans: input.requireExplicitHumansInput !== 'false',
  });
  if (!verdict.ok) {
    log.warning(verdict.reason);
    throw new Error(`gate identity configuration rejected: ${verdict.reason}`);
  }

  if (input.eventName === 'issue_comment') {
    if (input.eventAction === undefined || !COMMAND_ACTIONS.has(input.eventAction)) {
      log.info(`issue_comment.${input.eventAction ?? 'unknown'}: nothing to do.`);
      return;
    }
    await handleComment(input, client, log);
    return;
  }

  if (input.eventName === 'issues') {
    await handleIssueEvent(input, client, log);
    return;
  }

  log.warning(`Unsupported event "${input.eventName}": ignored.`);
}

/**
 * issues.* events. Per the frozen event matrix (protocol section 8) none of
 * them performs a migration: opened does not auto-label (the schema block is
 * logged as observability metadata only), closed is a validated silent stop,
 * reopened is not handled in V0.
 */
async function handleIssueEvent(
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  switch (input.eventAction) {
    case 'opened': {
      // No auto-labeling: work enters the workflow exclusively via a Trusted
      // Human running /ai-plan (V1: there is no Producer lifecycle).
      log.info(
        `issues.opened on #${input.issueNumber}: no auto-labeling. ` +
          'The issue stays plain until a Trusted Human runs /ai-plan.',
      );
      return;
    }
    case 'labeled':
      log.info(`issues.labeled on #${input.issueNumber}: observed, no transition.`);
      return;
    case 'closed': {
      // Validate (the issue must exist / be readable), then silently end:
      // closing is terminal and never triggers a state transition.
      const issue = await client.getIssue(issueRef(input));
      log.info(
        `issues.closed on #${input.issueNumber} (state: ${issue.state}): closed issues are ` +
          'terminal; no transition performed.',
      );
      return;
    }
    case 'reopened':
      log.info(
        `issues.reopened on #${input.issueNumber}: not handled in V0. Residual ai:* labels ` +
          'can be cleared by a Trusted Human with /cancel.',
      );
      return;
    default:
      log.info(`issues.${input.eventAction ?? 'unknown'} on #${input.issueNumber}: ignored.`);
      return;
  }
}

/** issue_comment.created / edited: the command + marker path. */
async function handleComment(
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  const ref = issueRef(input);

  // 1) Strict command parse. Normal comments yield null and fall through to
  //    marker detection; neither path touches the API until a rule matches.
  const parsed = parseCommand(input.commentBody);
  if (parsed !== null) {
    await handleCommand(parsed, input, ref, client, log);
    return;
  }
  await handleMarkerComment(input, ref, client, log);
}

/** A parsed command: permission -> closed check -> re-read state -> apply. */
async function handleCommand(
  parsed: ParsedCommand,
  input: GateInput,
  ref: IssueRef,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  // 2) Permission BEFORE any API read: commands are a Trusted Human monopoly.
  //    Everyone else (including Trusted Agents) gets the 👎 feedback and is
  //    otherwise ignored (protocol section 2.3, Phase 2 feedback channel).
  if (!isTrustedHuman(input.actor, input.repoOwner, input.trustedHumansInput)) {
    const kind = isTrustedAgent(input.actor, input.trustedAgentsInput) ? 'trusted agent' : 'actor';
    log.info(
      `Command ${parsed.command} from non-Trusted-Human ${kind} "${input.actor}" on ` +
        `#${ref.issueNumber}: rejected (invalid owner command), silently ignored.`,
    );
    await react(client, ref, input.commentId, '-1', log);
    return;
  }

  // 3) Validate the issue itself; closed issues are terminal for commands too.
  const issue = await client.getIssue(ref);
  if (issue.state === 'closed') {
    log.info(
      `Command ${parsed.command} on closed issue #${ref.issueNumber}: closed issues are terminal, ignored.`,
    );
    return;
  }

  // 4) Current state: RE-READ labels from the API right before deciding.
  //    The event payload snapshot is never trusted (protocol section 7).
  const labels = await client.getLabels(ref);
  const snapshot = readSnapshot(labels);

  // 5) Validate + 6) transition (or legal hand-off); ✅ on acceptance.
  let accepted = false;
  switch (parsed.command) {
    case COMMANDS.aiPlan:
      accepted = await applyAiPlan(ref, snapshot, input, client, log);
      break;
    case COMMANDS.approve:
      accepted = await applyApprove(ref, snapshot, parsed.args, input, client, log);
      break;
    case COMMANDS.change:
      accepted = await applyChange(ref, snapshot, parsed.args, input, client, log);
      break;
    case COMMANDS.cancel:
      accepted = await applyCancel(ref, snapshot, client, log);
      break;
  }
  if (accepted) {
    await react(client, ref, input.commentId, '+1', log);
  }
}

/**
 * Marker path of a comment. A marker can trigger T1 / T3 / T6, but only when
 * marker validity, publisher identity and the re-read state ALL check out;
 * markers alone never prove anything (protocol section 4).
 */
async function handleMarkerComment(
  input: GateInput,
  ref: IssueRef,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  const inspection = inspectCommentMarkers(input.commentBody);
  if (inspection.kind === 'none') {
    log.info(
      `Comment on #${ref.issueNumber} by "${input.actor}" is not a workflow command or marker: ` +
        'ignored, no API writes.',
    );
    return;
  }
  if (inspection.kind === 'invalid') {
    log.warning(
      `Invalid marker comment on #${ref.issueNumber} by "${input.actor}" (${inspection.reason}): ` +
        'a marker must be unique and occupy a line of its own; ignored (anti-spoofing), no transition.',
    );
    return;
  }
  const marker = inspection.marker;

  // Publisher must be Trusted Human ∪ Trusted Agent (protocol 4.3). Everyone
  // else's markers are plain text: markers are never permission. Trusted
  // Human and Trusted Agent stay separate checks; either may publish.
  const isHuman = isTrustedHuman(input.actor, input.repoOwner, input.trustedHumansInput);
  const isAgent = isTrustedAgent(input.actor, input.trustedAgentsInput);
  if (!isHuman && !isAgent) {
    log.warning(
      `Marker ${marker} on #${ref.issueNumber} by unknown actor "${input.actor}": markers are ` +
        'structural hints, never permission; treated as plain text, no transition.',
    );
    return;
  }
  const publisher = isHuman ? 'trusted human' : 'trusted agent';

  const issue = await client.getIssue(ref);
  if (issue.state === 'closed') {
    log.info(
      `Marker ${marker} on closed issue #${ref.issueNumber}: closed issues are terminal, ignored.`,
    );
    return;
  }

  const labels = await client.getLabels(ref);
  const snapshot = readSnapshot(labels);

  switch (marker) {
    case MARKERS.plan:
      await applyMarkerTransition(
        ref,
        snapshot,
        STATES.planning,
        STATES.review,
        'T1',
        'plan published',
        publisher,
        input.actor,
        client,
        log,
      );
      return;
    case MARKERS.executionTracker: {
      // A tracker comment EDIT while the issue sits in WORKING / BLOCKED is
      // the T4 / T5 channel: the gate deterministically parses the tracker's
      // Status machine value. Tracker creation (and any tracker edit while
      // READY, e.g. after a missed creation event) stays the T3 path below.
      if (
        input.eventAction === 'edited' &&
        snapshot.status === 'in-workflow' &&
        (snapshot.state === STATES.working || snapshot.state === STATES.blocked)
      ) {
        await applyTrackerStatusEdit(
          ref,
          snapshot,
          input.commentBody ?? '',
          publisher,
          input.actor,
          client,
          log,
        );
        return;
      }
      await applyMarkerTransition(
        ref,
        snapshot,
        STATES.ready,
        STATES.working,
        'T3',
        'execution tracker created',
        publisher,
        input.actor,
        client,
        log,
      );
      return;
    }
    case MARKERS.completionReport:
      await applyMarkerTransition(
        ref,
        snapshot,
        STATES.working,
        STATES.done,
        'T6',
        'completion report published',
        publisher,
        input.actor,
        client,
        log,
      );
      return;
  }
}

/**
 * T0: outside -> PLANNING by adding ai:planning, then persisting the round's
 * workflow_epoch record (schema 2, docs/plans/v1_hardening_decisions.md
 * §4.1). The epoch is fresh CSPRNG randomness — never derived from
 * timestamps, comment counts or labels.
 *
 * SELF-HEAL (V1: the Gate is the ONLY record issuer): a T0 whose label was
 * applied but whose epoch-record write failed would otherwise leave the issue
 * stuck in PLANNING with no epoch (and therefore no Driver intents) forever.
 * Re-running /ai-plan in that exact situation — PLANNING, zero epoch records,
 * no unparsable records — re-issues the epoch record and heals the round.
 * Any other in-workflow state is still rejected.
 */
async function applyAiPlan(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<boolean> {
  if (snapshot.status === 'ambiguous') {
    log.warning(
      `Invalid /ai-plan on #${ref.issueNumber}: issue carries multiple ai:* labels ` +
        `[${snapshot.labels.join(', ')}] (protocol violation); no transition.`,
    );
    return false;
  }
  if (snapshot.status === 'in-workflow') {
    if (snapshot.state !== STATES.planning) {
      log.warning(
        `Invalid /ai-plan on #${ref.issueNumber}: issue already in workflow ` +
          `(label ${snapshot.label}); no transition.`,
      );
      return false;
    }
    return await healPlanningEpoch(ref, input, client, log);
  }
  if (!isLegalTransition(null, STATES.planning)) {
    log.warning('Frozen transition table rejects T0; no transition.');
    return false;
  }
  await client.addLabels(ref, [LABELS.planning]);
  log.info(`T0 on #${ref.issueNumber}: added ${LABELS.planning} (PLANNING).`);

  // Schema 2: persist the new round's epoch. The label is already applied, so
  // a failed record write is recoverable: re-running /ai-plan heals a
  // PLANNING issue without an epoch record (the self-heal path above).
  const published = await issueEpochRecord(ref, input, client, log);
  if (!published.ok) {
    log.warning(
      `Epoch record publish failed after T0 on #${ref.issueNumber}; re-run /ai-plan to heal. ` +
        `Reason: ${published.reason}`,
    );
  }
  return true;
}

/**
 * The PLANNING-state recovery path of /ai-plan. Fail closed on unparsable
 * epoch records (tampering); heal ONLY a genuinely record-less round.
 */
async function healPlanningEpoch(
  ref: IssueRef,
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<boolean> {
  let comments: Array<{ id: number; body: string }>;
  try {
    comments = await client.listComments(ref);
  } catch (err) {
    log.warning(
      `/ai-plan self-heal on #${ref.issueNumber}: cannot list comments: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
  const { records, invalid } = parseRecords('workflow_epoch', comments);
  if (invalid.length > 0) {
    log.warning(
      `Invalid /ai-plan on #${ref.issueNumber}: unparsable workflow_epoch record(s) present ` +
        `(fail closed): ${invalid.map((e) => `#${e.commentId} (${e.reason})`).join(', ')}.`,
    );
    return false;
  }
  if (records.length > 0) {
    log.warning(
      `Invalid /ai-plan on #${ref.issueNumber}: issue already in workflow (PLANNING, epoch ` +
        `${records[records.length - 1]?.record.workflow_epoch}); no transition.`,
    );
    return false;
  }
  const published = await issueEpochRecord(ref, input, client, log);
  if (!published.ok) {
    log.warning(
      `/ai-plan self-heal on #${ref.issueNumber} failed (${published.reason}); ` + 'no reaction.',
    );
    return false;
  }
  log.info(
    `/ai-plan self-heal on #${ref.issueNumber}: re-issued the missing epoch record ` +
      `#${published.commentId} for epoch ${published.epoch}; no state migration (T0 already done).`,
  );
  return true;
}

/**
 * Mint + publish a fresh workflow_epoch record. Never throws: infrastructure
 * failures come back as { ok: false } so the caller can log a no-op.
 */
async function issueEpochRecord(
  ref: IssueRef,
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<{ ok: true; commentId: number; epoch: string } | { ok: false; reason: string }> {
  try {
    const identity = await client.getAuthenticatedUser();
    const epoch = newWorkflowEpoch();
    const record: WorkflowEpochRecord = {
      schema: 2,
      kind: 'workflow_epoch',
      repository_id: input.repositoryId,
      issue_number: ref.issueNumber,
      workflow_epoch: epoch,
      created_at: new Date().toISOString(),
      issued_by: identity.login,
      operation_id: epochOperationId(input.repositoryId, ref.issueNumber, epoch),
    };
    const published = await publishRecord(client, ref, record, log);
    if (!published.ok) return published;
    return { ok: true, commentId: published.commentId, epoch };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Publishes a Gate record comment and VERIFIES the remote content matches
 * (docs/plans/v1_hardening_decisions.md §4: "确认记录可读取且内容匹配").
 * Never throws: infrastructure failures come back as { ok: false } so the
 * caller can no-op without a reaction and without any label migration.
 * If the comment WAS created but the response was lost (timeout after POST),
 * re-running the command reuses the record by operation id — the recovery
 * path never duplicates authorization objects.
 */
async function publishRecord(
  client: GitHubClient,
  ref: IssueRef,
  record: WorkflowEpochRecord | ApprovalRecordPayload | FeedbackAcceptedRecordPayload,
  log: GateLogger,
): Promise<{ ok: true; commentId: number } | { ok: false; reason: string }> {
  const body = buildRecordBody(record);
  let createdId: number;
  try {
    const created = await client.addComment(ref, body);
    createdId = created.id;
  } catch (err) {
    return {
      ok: false,
      reason: `record publish failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    const remote = await client.getComment(ref, createdId);
    if (remote === null) {
      return { ok: false, reason: 'record publish could not be confirmed (comment missing)' };
    }
    const parsed = parseRecord(createdId, remote.body);
    if (!parsed.ok || JSON.stringify(parsed.record) !== JSON.stringify(record)) {
      return { ok: false, reason: 'record publish confirmed but content mismatch — failing closed' };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `record verification failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, commentId: createdId };
}

/**
 * Current epoch of an issue = the workflow_epoch record with the highest
 * comment id. ANY unparsable epoch record fails closed (append-only records:
 * an unparsable one signals tampering). Optionally reuses a prefetched
 * comment list to avoid a second round-trip.
 */
async function readCurrentEpoch(
  client: GitHubClient,
  ref: IssueRef,
  prefetchedComments?: Array<{ id: number; body: string }>,
): Promise<
  | { ok: true; record: WorkflowEpochRecord; commentId: number }
  | { ok: false; reason: string }
> {
  let comments = prefetchedComments;
  if (comments === undefined) {
    try {
      comments = await client.listComments(ref);
    } catch (err) {
      return {
        ok: false,
        reason: `cannot list comments for the epoch lookup: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const { records, invalid } = parseRecords('workflow_epoch', comments);
  if (invalid.length > 0) {
    return {
      ok: false,
      reason:
        `unparsable workflow_epoch record(s) on #${ref.issueNumber} (fail closed): ` +
        invalid.map((entry) => `#${entry.commentId} (${entry.reason})`).join(', '),
    };
  }
  const latest = records[records.length - 1];
  if (latest === undefined) {
    return { ok: false, reason: `no workflow_epoch record on #${ref.issueNumber}` };
  }
  return { ok: true, record: latest.record, commentId: latest.commentId };
}

/**
 * T2: REVIEW -> READY by persisting a Gate-issued APPROVAL RECORD and only
 * then swapping labels (schema 2, docs/plans/v1_hardening_decisions.md §4.2).
 *
 * Sequence (frozen — the durable authorization fact is the RECORD, never the
 * human's command comment):
 *  1. unchanged state preconditions (single ai:* label, REVIEW, legal T2);
 *  2. validate the referenced plan comment (exists / valid marker / CURRENT
 *     plan — approvals.ts);
 *  3. compute `plan_sha256` with the FROZEN canonicalization;
 *  4. read the current epoch (any unparsable epoch record fails closed);
 *  5. build the approval record (repo/issue/epoch/plan/hash/approver/gate);
 *  6. reuse-or-conflict check over existing records with the same operation
 *     id: identical content -> reuse (crash recovery), divergent content
 *     (e.g. the plan was edited after an earlier approval) -> FAIL CLOSED;
 *  7. publish + verify the record;
 *  8. only now perform the add-then-remove label swap.
 *
 * A failure in steps 4–7 is a logged no-op WITHOUT a reaction and WITHOUT any
 * label migration. A record that persisted while the label swap failed
 * recovers by re-running the command (step 6 reuses the record).
 */
async function applyApprove(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  args: ApproveArgs,
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<boolean> {
  if (snapshot.status === 'ambiguous') {
    log.warning(
      `Invalid /approve on #${ref.issueNumber}: issue carries multiple ai:* labels ` +
        `[${snapshot.labels.join(', ')}] (protocol violation); no transition.`,
    );
    return false;
  }
  if (snapshot.status !== 'in-workflow') {
    log.warning(
      `Invalid /approve on #${ref.issueNumber}: issue is not in the workflow (no ai:* label); ` +
        'run /ai-plan first; no transition.',
    );
    return false;
  }
  if (snapshot.state !== STATES.review) {
    log.warning(
      `Invalid /approve on #${ref.issueNumber}: /approve requires ${STATES.review} ` +
        `(${LABELS.review}), current state is ${snapshot.state} (${snapshot.label}); no transition.`,
    );
    return false;
  }
  if (!isLegalTransition(STATES.review, STATES.ready)) {
    log.warning('Frozen transition table rejects T2; no transition.');
    return false;
  }

  // Plan-ID binding: validate the referenced plan comment before any write.
  // The issue's comment list (id-ascending) establishes both issue membership
  // and which plan marker is the current plan; the id-targeted fetch proves
  // the referenced comment still exists with a valid marker.
  const allComments = await client.listComments(ref);
  const planMarkerComments = allComments.filter(
    (comment) => detectCommentMarker(comment.body) === MARKERS.plan,
  );
  const referencedComment = await client.getComment(ref, args.planCommentId);
  const inspection = validatePlanCommentForApproval({
    planCommentId: args.planCommentId,
    referencedComment,
    planMarkerComments,
  });
  if (inspection.status === 'invalid') {
    log.warning(
      `Invalid /approve on #${ref.issueNumber}: referenced plan comment ` +
        `${args.planCommentId} rejected (${inspection.reason}); the approval must name the ` +
        'current plan comment; no transition, no reaction.',
    );
    return false;
  }
  if (referencedComment === null) {
    // Unreachable (inspection 'valid' implies the comment exists); keeps
    // null-safety honest for the hash computation below.
    return false;
  }

  // Schema 2: bind repo/issue/epoch/plan/hash into a Gate-issued record.
  const epoch = await readCurrentEpoch(client, ref, allComments);
  if (!epoch.ok) {
    log.warning(`Invalid /approve on #${ref.issueNumber}: ${epoch.reason}; no record, no transition.`);
    return false;
  }
  if (input.commentId === undefined) {
    log.warning(
      `Invalid /approve on #${ref.issueNumber}: event carries no comment id, so the approval ` +
        'command cannot be anchored in a record; no transition, no reaction.',
    );
    return false;
  }
  if (input.actorId === undefined) {
    log.warning(
      `/approve on #${ref.issueNumber}: payload carries no actor id; recording approved_by_id 0.`,
    );
  }
  const identity = await client.getAuthenticatedUser();
  const record: ApprovalRecordPayload = {
    schema: 2,
    kind: 'approval',
    repository_id: input.repositoryId,
    issue_number: ref.issueNumber,
    workflow_epoch: epoch.record.workflow_epoch,
    plan_comment_id: args.planCommentId,
    plan_sha256: planSha256(referencedComment.body),
    approval_command_comment_id: input.commentId,
    approved_by_id: input.actorId ?? 0,
    approved_by_login: input.actor,
    gate_login: identity.login,
    gate_user_id: identity.id,
    created_at: new Date().toISOString(),
    operation_id: approvalOperationId(
      input.repositoryId,
      ref.issueNumber,
      epoch.record.workflow_epoch,
      args.planCommentId,
    ),
  };

  // Reuse-or-conflict over existing records with this operation id.
  const { records: approvalRecords, invalid: unparsableApprovals } = parseRecords(
    'approval',
    allComments,
  );
  if (unparsableApprovals.length > 0) {
    log.warning(
      `Invalid /approve on #${ref.issueNumber}: unparsable approval record(s) present ` +
        `(fail closed): ${unparsableApprovals.map((e) => `#${e.commentId} (${e.reason})`).join(', ')}.`,
    );
    return false;
  }
  const sameOperation = approvalRecords.filter(
    (entry) => entry.record.operation_id === record.operation_id,
  );
  if (sameOperation.length > 0) {
    const conflict = approvalRecordsConflict(sameOperation);
    const first = sameOperation[0];
    const matchesCurrent =
      first !== undefined &&
      first.record.plan_sha256 === record.plan_sha256 &&
      first.record.approved_by_login.toLowerCase() === record.approved_by_login.toLowerCase() &&
      first.record.approved_by_id === record.approved_by_id;
    if (conflict.conflict || !matchesCurrent) {
      log.warning(
        `Invalid /approve on #${ref.issueNumber}: approval record(s) for ${record.operation_id} ` +
          (conflict.conflict ? `CONFLICT (${conflict.reason ?? 'divergent content'})` : 'bind a different plan content') +
          '. A Plan comment whose content changed after an approval stays burned: re-plan ' +
          '(publish a new Plan comment) and approve that one instead. No transition, no reaction.',
      );
      return false;
    }
    log.info(
      `Valid approval record #${first.commentId} already exists for ${record.operation_id}; ` +
        'reusing it (crash recovery: record persisted, label swap did not complete).',
    );
  } else {
    const published = await publishRecord(client, ref, record, log);
    if (!published.ok) {
      log.warning(
        `Invalid /approve on #${ref.issueNumber}: approval record publish failed ` +
          `(${published.reason}); the authorization is NOT granted, no label migration, no reaction.`,
      );
      return false;
    }
    log.info(
      `Approval record #${published.commentId} persisted for ${record.operation_id} ` +
        `(plan ${args.planCommentId}, sha256 ${record.plan_sha256}, approved by ${input.actor}).`,
    );
  }

  // Add-then-remove keeps the issue holding exactly one ai:* label even if a
  // reader observes it between the two calls. Only NOW is T2 performed.
  await client.addLabels(ref, [LABELS.ready]);
  await client.removeLabel(ref, LABELS.review);
  log.info(
    `T2 on #${ref.issueNumber}: ${LABELS.review} -> ${LABELS.ready} ` +
      `(REVIEW -> READY approving plan comment ${inspection.planCommentId}, ` +
      `sha256-bound approval record).`,
  );
  return true;
}

/**
 * Schema 2 acceptance channel for /change: after the frozen format + REVIEW +
 * identity preconditions pass, the gate persists a feedback_accepted record
 * (docs/plans/v1_hardening_decisions.md §4.3). These records — not the raw
 * comment count — are what planner revisions are built from: rejected,
 * duplicated, foreign-epoch and plain-text comments never produce one.
 * Idempotent by operation id; a publish failure is a logged no-op WITHOUT a
 * reaction (the acceptance did not happen).
 */
async function acceptFeedbackEvent(
  ref: IssueRef,
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<boolean> {
  const feedbackKind = 'change' as const;
  if (input.commentId === undefined) {
    log.warning(
      `/${feedbackKind} on #${ref.issueNumber}: event carries no comment id; the accepted ` +
        'event cannot be anchored — fail closed, no record, no reaction.',
    );
    return false;
  }
  const epoch = await readCurrentEpoch(client, ref);
  if (!epoch.ok) {
    log.warning(`/${feedbackKind} on #${ref.issueNumber}: ${epoch.reason}; no record, no reaction.`);
    return false;
  }
  const operationId = feedbackOperationId(
    input.repositoryId,
    ref.issueNumber,
    epoch.record.workflow_epoch,
    input.commentId,
  );
  const comments = await client.listComments(ref);
  const { records, invalid } = parseRecords('feedback_accepted', comments);
  if (invalid.length > 0) {
    log.warning(
      `/${feedbackKind} on #${ref.issueNumber}: unparsable feedback record(s) present ` +
        `(fail closed): ${invalid.map((e) => `#${e.commentId} (${e.reason})`).join(', ')}.`,
    );
    return false;
  }
  if (records.some((entry) => entry.record.operation_id === operationId)) {
    log.info(
      `Feedback record for ${operationId} already exists; acceptance is idempotent.`,
    );
    return true;
  }
  const identity = await client.getAuthenticatedUser();
  const record: FeedbackAcceptedRecordPayload = {
    schema: 2,
    kind: 'feedback_accepted',
    repository_id: input.repositoryId,
    issue_number: ref.issueNumber,
    workflow_epoch: epoch.record.workflow_epoch,
    event_id: `fe${input.commentId}`,
    feedback_comment_id: input.commentId,
    feedback_kind: feedbackKind,
    gate_login: identity.login,
    gate_user_id: identity.id,
    created_at: new Date().toISOString(),
    operation_id: operationId,
  };
  const published = await publishRecord(client, ref, record, log);
  if (!published.ok) {
    log.warning(
      `/${feedbackKind} on #${ref.issueNumber}: feedback record publish failed ` +
        `(${published.reason}); the event is NOT accepted, no reaction.`,
    );
    return false;
  }
  log.info(
    `Feedback event accepted (record #${published.commentId}, ${feedbackKind} on comment ` +
      `${input.commentId}, epoch ${epoch.record.workflow_epoch}).`,
  );
  return true;
}

/**
 * /change: a Trusted Human change request (or free-form decision) against the
 * current plan. V1 merges /choose into this single feedback channel. The gate
 * validates the format + REVIEW precondition, persists the accepted-event
 * record and forwards the text verbatim to the planner as untrusted data.
 * NO state migration (protocol 3.2 / 3.3).
 */
async function applyChange(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  args: ChangeArgs,
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<boolean> {
  if (snapshot.status === 'ambiguous') {
    log.warning(
      `Invalid /change on #${ref.issueNumber}: issue carries multiple ai:* labels ` +
        `[${snapshot.labels.join(', ')}] (protocol violation); ignored.`,
    );
    return false;
  }
  if (snapshot.status !== 'in-workflow' || snapshot.state !== STATES.review) {
    log.warning(
      `Invalid /change on #${ref.issueNumber}: /change requires ${STATES.review} ` +
        `(${LABELS.review}), current state is ${describeSnapshot(snapshot)}; ` +
        'ignored, not forwarded to the planner.',
    );
    return false;
  }
  const accepted = await acceptFeedbackEvent(ref, input, client, log);
  if (accepted) {
    log.info(
      `/change on #${ref.issueNumber} accepted (REVIEW): change request forwarded to the ` +
        `planner as untrusted data, text preserved verbatim: "${args.text}"; no state migration.`,
    );
  }
  return accepted;
}

/**
 * /cancel: exit the workflow from any ai:* state (including BLOCKED and the
 * terminal DONE) by removing ALL ai:* labels. The issue is NOT closed.
 * Cancel is not a row of the transition table; its precondition is simply
 * "at least one ai:* label present".
 */
async function applyCancel(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  client: GitHubClient,
  log: GateLogger,
): Promise<boolean> {
  if (snapshot.status === 'outside') {
    log.warning(
      `Invalid /cancel on #${ref.issueNumber}: issue has no ai:* label, nothing to cancel.`,
    );
    return false;
  }
  const labelsToRemove =
    snapshot.status === 'in-workflow' ? [snapshot.label] : [...snapshot.labels];
  for (const label of labelsToRemove) {
    await client.removeLabel(ref, label);
  }
  log.info(
    `/cancel on #${ref.issueNumber}: removed ${labelsToRemove.length} ai:* label(s) ` +
      `[${labelsToRemove.join(', ')}]; workflow exited, issue left open.`,
  );
  return true;
}

/**
 * Shared T1 / T3 / T6 machinery: validates the re-read state against the
 * marker's required `from` state, checks the frozen transition table and
 * swaps the ai:* label (add first, then remove — same ordering as T2 so a
 * concurrent reader always sees at least the old or the new single label).
 */
async function applyMarkerTransition(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  fromState: State,
  toState: State,
  transitionId: string,
  description: string,
  publisherKind: string,
  actor: string,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  if (snapshot.status !== 'in-workflow') {
    log.warning(
      `Invalid ${transitionId} marker on #${ref.issueNumber}: issue is not in the workflow ` +
        '(no ai:* label); no transition.',
    );
    return;
  }
  if (snapshot.state !== fromState) {
    log.warning(
      `Invalid ${transitionId} marker on #${ref.issueNumber} (${description} by ${publisherKind} ` +
        `"${actor}"): requires state ${fromState}, current state is ${snapshot.state} ` +
        `(${snapshot.label}); no transition.`,
    );
    return;
  }
  if (!isLegalTransition(fromState, toState)) {
    log.warning(`Frozen transition table rejects ${transitionId}; no transition.`);
    return;
  }
  const toLabel = STATE_TO_LABEL[toState];
  await client.addLabels(ref, [toLabel]);
  await client.removeLabel(ref, snapshot.label);
  log.info(
    `${transitionId} on #${ref.issueNumber}: ${snapshot.label} -> ${toLabel} ` +
      `(${fromState} -> ${toState}, ${description} by ${publisherKind} "${actor}").`,
  );
}

/**
 * T4 / T5: a tracker comment edit while the issue sits in WORKING / BLOCKED.
 * The gate deterministically parses the tracker's `**Status:**` machine value
 * (protocol section 2.1; parsing rules in tracker.ts / 实现备注):
 *   WORKING  + "Blocked"     -> T4: ai:working  -> ai:blocked
 *   BLOCKED  + "In Progress" -> T5: ai:blocked -> ai:working
 * Everything else is a logged no-op, in particular:
 *  - "Completed" NEVER triggers a transition from any state: completion is
 *    triggered exclusively by the completion-report marker (T6);
 *  - same-value edits ("In Progress" while WORKING, "Blocked" while BLOCKED)
 *    make duplicate event deliveries idempotent;
 *  - a missing or non-machine Status value is never guessed at.
 * The caller guarantees a trusted publisher and a fresh re-read (the same
 * checks T1 / T3 / T6 go through); the label swap re-reads nothing again.
 */
async function applyTrackerStatusEdit(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  body: string,
  publisherKind: string,
  actor: string,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  if (snapshot.status !== 'in-workflow') {
    log.warning(
      `Tracker status edit on #${ref.issueNumber}: issue state is ${describeSnapshot(snapshot)}; ` +
        'no transition.',
    );
    return;
  }

  const inspection = parseTrackerStatus(body);
  if (inspection.kind === 'absent') {
    log.warning(
      `Tracker edit on #${ref.issueNumber} by ${publisherKind} "${actor}": no parsable ` +
        '**Status:** line; T4 / T5 need the exact machine value (In Progress / Blocked / ' +
        'Completed); no transition.',
    );
    return;
  }
  if (inspection.kind === 'unknown') {
    log.warning(
      `Tracker edit on #${ref.issueNumber} by ${publisherKind} "${actor}": Status ` +
        `"${inspection.raw}" is not a machine value (In Progress / Blocked / Completed); ` +
        'no transition.',
    );
    return;
  }
  const status = inspection.status;

  if (status === 'Completed') {
    log.info(
      `Tracker edit on #${ref.issueNumber} by ${publisherKind} "${actor}": Status "Completed" ` +
        'never triggers a transition; completion goes exclusively through the completion-report ' +
        'marker (T6).',
    );
    return;
  }

  if (status === 'Blocked' && snapshot.state === STATES.working) {
    if (!isLegalTransition(STATES.working, STATES.blocked)) {
      log.warning('Frozen transition table rejects T4; no transition.');
      return;
    }
    // Add-then-remove ordering, same as every other label swap.
    await client.addLabels(ref, [LABELS.blocked]);
    await client.removeLabel(ref, snapshot.label);
    log.info(
      `T4 on #${ref.issueNumber}: ${snapshot.label} -> ${LABELS.blocked} ` +
        `(WORKING -> BLOCKED, tracker Status "Blocked" edited by ${publisherKind} "${actor}").`,
    );
    return;
  }

  if (status === 'In Progress' && snapshot.state === STATES.blocked) {
    if (!isLegalTransition(STATES.blocked, STATES.working)) {
      log.warning('Frozen transition table rejects T5; no transition.');
      return;
    }
    await client.addLabels(ref, [LABELS.working]);
    await client.removeLabel(ref, snapshot.label);
    log.info(
      `T5 on #${ref.issueNumber}: ${snapshot.label} -> ${LABELS.working} ` +
        `(BLOCKED -> WORKING, tracker Status "In Progress" edited by ${publisherKind} "${actor}").`,
    );
    return;
  }

  // Same-value edits: the event is a duplicate delivery or a routine progress
  // update that already matches the current state.
  log.info(
    `Tracker edit on #${ref.issueNumber} by ${publisherKind} "${actor}": Status "${status}" ` +
      `already matches the current state ${snapshot.state} (${snapshot.label}); no transition.`,
  );
}

/**
 * Best-effort reaction feedback: "+1" = accepted (✅), "-1" = invalid owner
 * command (👎). Reactions are never load-bearing: failures (and missing
 * comment ids) are logged and ignored so they cannot affect the main flow.
 */
async function react(
  client: GitHubClient,
  ref: IssueRef,
  commentId: number | undefined,
  content: '+1' | '-1',
  log: GateLogger,
): Promise<void> {
  if (commentId === undefined) {
    log.warning(
      `Cannot add ${content} reaction on #${ref.issueNumber}: event carries no comment id.`,
    );
    return;
  }
  try {
    await client.addReaction(ref, commentId, content);
  } catch (err) {
    log.warning(
      `Adding ${content} reaction on comment ${commentId} failed (ignored): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

function describeSnapshot(snapshot: WorkflowSnapshot): string {
  switch (snapshot.status) {
    case 'outside':
      return 'not in the workflow (no ai:* label)';
    case 'ambiguous':
      return `ambiguous (multiple ai:* labels: ${snapshot.labels.join(', ')})`;
    case 'in-workflow':
      return `${snapshot.state} (${snapshot.label})`;
  }
}

function issueRef(input: GateInput): IssueRef {
  return { owner: input.repoOwner, repo: input.repo, issueNumber: input.issueNumber };
}
