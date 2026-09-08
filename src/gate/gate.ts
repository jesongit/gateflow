/**
 * The deterministic gate: Event -> Permission -> Current State -> Command /
 * Marker -> Validate -> Transition (docs/protocol.md sections 2, 3, 4, 7, 8).
 *
 * Hard rules enforced here:
 *  - Commands are a Trusted Human monopoly. Any of the five frozen commands
 *    from anyone else (including Trusted Agents) receives the 👎 reaction
 *    ("invalid owner command") and is otherwise ignored: no comment, no label
 *    write, no API read.
 *  - A command that fails its state precondition is a logged no-op WITHOUT a
 *    reaction (Phase 1 feedback convention). A successfully accepted command
 *    (effect performed, or legal hand-off to the Consumer) gets the ✅
 *    reaction. Reactions are best-effort feedback: never permission, never
 *    load-bearing; their failure is logged and ignored.
 *  - Markers are structural hints, never permission. SINCE V1.1 (hardening
 *    plan Phase 1) a marker-triggered transition (T1 / T3 / T6) requires ALL
 *    of: a valid marker (unique, owning its line), a publisher in Trusted
 *    Human ∪ Trusted Agent, a re-read state matching the transition's `from`,
 *    AND a valid DISPATCH AUTHORIZATION CHAIN (src/gate/authorization.ts +
 *    src/protocol/workflow-chain.ts): the source comment must belong to the
 *    current epoch's authorized dispatch chain — current consumer dispatch
 *    for plans, current executor dispatch + sha256-bound approval record for
 *    trackers and reports. Fake markers, old-round comments and orphan
 *    reports are logged no-ops.
 *  - SCHEMA 2 AUTHORIZATION (docs/plans/v1_hardening_decisions.md §4): the
 *    durable authorization facts are GATE-ISSUED RECORDS, never the human's
 *    command comments alone:
 *      /ai-plan (T0)        -> workflow_epoch record (created_by: gate),
 *                              written BEFORE the PLANNING label (V1.1
 *                              Phase 3: record-first, adopt by deterministic
 *                              operation id, no epoch -> no migration);
 *      /approve <plan-id>   -> approval record binding repo/issue/epoch/
 *                              plan-comment-id/plan-sha256/approver, written
 *                              AND verified BEFORE the T2 label swap;
 *      /choose, /change     -> feedback_accepted record (idempotent by
 *                              operation id) — the Consumer-revision source.
 *  - V1.1 TRANSITION RECORDS (hardening plan Phase 4): every accepted T1..T6
 *    migration is persisted as a gate_transition record BEFORE the label
 *    swap (record-first, same fail-closed convention): epoch, dispatch,
 *    source_comment_id, from/to. These records — not the bare label state —
 *    are what a Driver receipt's `accepted` must bind to (Phase 5).
 *  - V1.1 EPOCH TRUST (Phase 2): the current epoch resolves ONLY through
 *    workflow-chain.resolveCurrentEpoch: strict parsing, repository/issue
 *    binding, issuer class checks (created_by gate|driver_bootstrap) and
 *    operation-id conflict detection. Forged or transplanted epoch records
 *    fail the whole event closed.
 *  - An EDIT of the tracker marker comment while the issue sits in WORKING /
 *    BLOCKED is the T4 / T5 channel — now also dispatch-chain-bound (V1.1
 *    §4.4): only the tracker of the CURRENT executor chain can move states.
 *  - Identity config is resolved through the SHARED resolver
 *    (src/protocol/identity.ts, Phase 9) and validated against the API
 *    before ANY transition; failure fails the run (fail closed, GF-H10).
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
import { parseCommand, type ApproveArgs, type ChangeArgs, type ChooseArgs, type ParsedCommand } from '../protocol/commands';
import { validatePlanCommentForApproval } from './approvals';
import { detectCommentMarker, inspectCommentMarkers, parseIssueSchemaBlock } from './markers';
import { isLegalTransition, readSnapshot, type WorkflowSnapshot } from './states';
import { parseTrackerStatus } from './tracker';
import { parseLoginList } from './permissions';
import { resolveIdentities, identitySetHas, type EffectiveIdentities } from '../protocol/identity';
import {
  resolveAuthorizationContext,
  validateConsumerSource,
  validateExecutorSource,
  type WorkflowAuthorizationContext,
} from './authorization';
import { GATE_VERSION } from './version';
import {
  approvalOperationId,
  approvalRecordsConflict,
  buildRecordBody,
  bootstrapEpochOperationId,
  extractEpochCommandCommentId,
  feedbackOperationId,
  gateEpochOperationId,
  parseRecord,
  parseRecords,
  transitionOperationId,
  type ApprovalRecord as ApprovalRecordPayload,
  type FeedbackAcceptedRecord as FeedbackAcceptedRecordPayload,
  type GateRecord,
  type GateTransitionRecord,
  type TransitionId,
  type WorkflowEpochRecord,
} from '../protocol/records';
import {
  currentPlanOf,
  dispatchIdOf,
  findEpochRecordByOperationId,
  hasTrackerForDispatch,
  parseTransitionRecords,
} from '../protocol/workflow-chain';
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
  /**
   * Issue body when the event carries one (issues.* events). Only parsed for
   * the schema metadata block (observability); optional because comment
   * events and simplified callers legitimately omit it.
   */
  issueBody?: string | undefined;
  /** Raw `trusted-humans` action input (comma-separated allowlist). */
  trustedHumansInput: string;
  /** Raw `trusted-agents` action input (V0 default: empty). */
  trustedAgentsInput: string;
  /**
   * Raw `bootstrap-drivers` action input (V1.1 Phase 2): explicit allowlist
   * of identities allowed to issue `driver_bootstrap` epoch records. Empty
   * = default rule (the owner of a personal repository).
   */
  bootstrapDriversInput?: string;
  /**
   * Raw `require-explicit-humans` action input ("true"/"false"; default
   * true). When true, an Organization-owned repository without an explicit
   * trusted-humans allowlist fails the run (GF-H10).
   */
  requireExplicitHumansInput?: string;
}

/** Comment actions that carry a command or marker. */
const COMMAND_ACTIONS: ReadonlySet<string> = new Set(['created', 'edited']);

/** Issuer sets the whole gate run resolves once and shares. */
interface GateIdentityScope {
  identities: EffectiveIdentities;
  gateIssuers: ReadonlySet<string>;
  bootstrapIssuers: ReadonlySet<string>;
  gateLogin: string;
  gateUserId: number;
}

/** Runs the gate for one event. Resolves normally unless infrastructure fails. */
export async function runGate(
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  // Identity-config validation comes FIRST and is fail-closed (GF-H10): the
  // owner type is verified against the API, never against the event payload,
  // and the effective identity sets come from the SHARED resolver (Phase 9).
  const identity = await client.getRepoIdentity({ owner: input.repoOwner, repo: input.repo });
  const resolution = resolveIdentities({
    owner: identity.owner,
    ownerType: identity.ownerType,
    trustedHumans: parseLoginList(input.trustedHumansInput),
    trustedAgents: parseLoginList(input.trustedAgentsInput),
    bootstrapDrivers: parseLoginList(input.bootstrapDriversInput ?? ''),
    requireExplicitHumans: input.requireExplicitHumansInput !== 'false',
  });
  if (!resolution.ok) {
    log.warning(resolution.reason);
    throw new Error(`gate identity configuration rejected: ${resolution.reason}`);
  }

  if (input.eventName === 'issue_comment') {
    if (input.eventAction === undefined || !COMMAND_ACTIONS.has(input.eventAction)) {
      log.info(`issue_comment.${input.eventAction ?? 'unknown'}: nothing to do.`);
      return;
    }
    const gateIdentity = await client.getAuthenticatedUser();
    const scope: GateIdentityScope = {
      identities: resolution.identities,
      gateIssuers: new Set([gateIdentity.login.trim().toLowerCase()]),
      bootstrapIssuers: resolution.identities.bootstrapDrivers,
      gateLogin: gateIdentity.login,
      gateUserId: gateIdentity.id,
    };
    await handleComment(input, client, log, scope);
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
      // Observability only: the Producer schema block (kind / maturity_hint)
      // is metadata for the Consumer, NEVER a transition or permission input.
      const schema = parseIssueSchemaBlock(input.issueBody);
      if (schema.status === 'valid') {
        log.info(
          `issues.opened on #${input.issueNumber}: no auto-labeling. Producer schema block: ` +
            `kind=${schema.metadata.kind}, maturity_hint=${schema.metadata.maturityHint} ` +
            '(metadata only, no transition). Producer-created issues already carry ' +
            'ai:planning (T0); external issues stay plain until a Trusted Human runs /ai-plan.',
        );
      } else if (schema.status === 'invalid') {
        log.warning(
          `issues.opened on #${input.issueNumber}: issue body schema block invalid ` +
            `(${schema.reason}); treated as a plain issue. No auto-labeling, no transition.`,
        );
      } else {
        log.info(
          `issues.opened on #${input.issueNumber}: no auto-labeling. No schema block. ` +
            'External issues stay plain until a Trusted Human runs /ai-plan.',
        );
      }
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
  scope: GateIdentityScope,
): Promise<void> {
  const ref = issueRef(input);

  // 1) Strict command parse. Normal comments yield null and fall through to
  //    marker detection; neither path touches the API until a rule matches.
  const parsed = parseCommand(input.commentBody);
  if (parsed !== null) {
    await handleCommand(parsed, input, ref, client, log, scope);
    return;
  }
  await handleMarkerComment(input, ref, client, log, scope);
}

/** A parsed command: permission -> closed check -> re-read state -> apply. */
async function handleCommand(
  parsed: ParsedCommand,
  input: GateInput,
  ref: IssueRef,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
): Promise<void> {
  // 2) Permission BEFORE any API read: commands are a Trusted Human monopoly.
  //    Everyone else (including Trusted Agents) gets the 👎 feedback and is
  //    otherwise ignored (protocol section 2.3, Phase 2 feedback channel).
  if (!identitySetHas(scope.identities.humans, input.actor)) {
    const kind = identitySetHas(scope.identities.agents, input.actor) ? 'trusted agent' : 'actor';
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
      accepted = await applyAiPlan(ref, snapshot, input, client, log, scope);
      break;
    case COMMANDS.approve:
      accepted = await applyApprove(ref, snapshot, parsed.args, input, client, log, scope);
      break;
    case COMMANDS.choose:
      accepted = await applyChoose(ref, snapshot, parsed.args, input, client, log, scope);
      break;
    case COMMANDS.change:
      accepted = await applyChange(ref, snapshot, parsed.args, input, client, log, scope);
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
 * marker validity, publisher identity, the re-read state AND the dispatch
 * authorization chain ALL check out; markers alone never prove anything
 * (protocol section 4, V1.1 Phase 1).
 */
async function handleMarkerComment(
  input: GateInput,
  ref: IssueRef,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
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

  // Producer APPEND: bookkeeping only, never a transition.
  if (marker === MARKERS.append) {
    log.info(
      `append marker on #${ref.issueNumber} by "${input.actor}": discussion appended, ` +
        'recorded only, no transition.',
    );
    return;
  }

  // Publisher must be Trusted Human ∪ Trusted Agent (protocol 4.3). Everyone
  // else's markers are plain text: markers are never permission. Trusted
  // Human and Trusted Agent stay separate checks; either may publish.
  const isHuman = identitySetHas(scope.identities.humans, input.actor);
  const isAgent = identitySetHas(scope.identities.agents, input.actor);
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
      await applyPlanMarker(ref, snapshot, input, publisher, client, log, scope);
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
          input,
          publisher,
          client,
          log,
          scope,
        );
        return;
      }
      await applyTrackerCreateMarker(ref, snapshot, input, publisher, client, log, scope);
      return;
    }
    case MARKERS.completionReport:
      await applyCompletionMarker(ref, snapshot, input, publisher, client, log, scope);
      return;
  }
}

/**
 * Shared marker-path precondition: the issue must hold exactly one ai:*
 * label in the transition's `from` state. Returns false (with a logged
 * reason) when the state precondition fails.
 */
function markerStatePrecondition(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  transitionId: string,
  description: string,
  publisherKind: string,
  actor: string,
  fromState: State,
  log: GateLogger,
): boolean {
  if (snapshot.status !== 'in-workflow') {
    log.warning(
      `Invalid ${transitionId} marker on #${ref.issueNumber}: issue is not in the workflow ` +
        '(no ai:* label); no transition.',
    );
    return false;
  }
  if (snapshot.state !== fromState) {
    log.warning(
      `Invalid ${transitionId} marker on #${ref.issueNumber} (${description} by ${publisherKind} ` +
        `"${actor}"): requires state ${fromState}, current state is ${snapshot.state} ` +
        `(${snapshot.label}); no transition.`,
    );
    return false;
  }
  if (!isLegalTransition(fromState, transitionTargetOf(transitionId, fromState))) {
    log.warning(`Frozen transition table rejects ${transitionId}; no transition.`);
    return false;
  }
  return true;
}

/** T1 / T3 / T6 target of the frozen transition table. */
function transitionTargetOf(transitionId: string, from: State): State {
  switch (transitionId) {
    case 'T1':
      return STATES.review;
    case 'T3':
      return STATES.working;
    case 'T6':
      return STATES.done;
    case 'T4':
      return STATES.blocked;
    case 'T5':
      return STATES.working;
    case 'T2':
      return STATES.ready;
    default:
      return from;
  }
}

/**
 * T1 (Plan → REVIEW), V1.1: the plan comment must belong to a CURRENT
 * consumer dispatch of the current epoch (dispatch binding, epoch match,
 * revision == the epoch's current consumer round). The transition record is
 * persisted BEFORE the label swap (record-first, fail closed).
 */
async function applyPlanMarker(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  input: GateInput,
  publisher: string,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
): Promise<void> {
  if (
    !markerStatePrecondition(
      ref, snapshot, 'T1', 'plan published', publisher, input.actor, STATES.planning, log,
    )
  ) {
    return;
  }
  if (snapshot.status !== 'in-workflow') {
    return; // markerStatePrecondition guarantees this; keeps narrowing honest
  }
  if (input.commentId === undefined) {
    log.warning('T1: event carries no comment id; the source object cannot be anchored — no transition.');
    return;
  }
  const comments = await client.listComments(ref);
  const contextResolution = resolveAuthorizationContext({
    comments,
    repositoryId: input.repositoryId,
    issueNumber: ref.issueNumber,
    gateIssuers: scope.gateIssuers,
    bootstrapIssuers: scope.bootstrapIssuers,
  });
  if (!contextResolution.ok) {
    log.warning(`Invalid T1 on #${ref.issueNumber}: ${contextResolution.reason}; no transition.`);
    return;
  }
  const context = contextResolution.context;
  const planComment = currentPlanOf(comments);
  if (planComment === null || planComment.id !== input.commentId) {
    log.warning(
      `Invalid T1 on #${ref.issueNumber}: the commented plan is not the current plan comment; ` +
        'no transition.',
    );
    return;
  }
  const chain = validateConsumerSource({
    context,
    planComment,
    comments,
    trustedHumans: scope.identities.humans,
  });
  if (!chain.ok) {
    log.warning(
      `Invalid T1 on #${ref.issueNumber} (plan published by ${publisher} "${input.actor}"): ` +
        `${chain.reason}; no transition.`,
    );
    return;
  }
  await commitTransition(
    ref,
    {
      repositoryId: input.repositoryId,
      issueNumber: ref.issueNumber,
      epoch: context.epoch,
      dispatchId: dispatchIdOf(planComment),
      transition: 'T1',
      fromLabel: LABELS.planning,
      toLabel: LABELS.review,
      sourceCommentId: input.commentId,
    },
    comments,
    snapshot.label,
    client,
    log,
    scope,
    `plan accepted (dispatch ${dispatchIdOf(planComment) ?? '?'}, plan comment ${planComment.id})`,
  );
}

/**
 * T3 (Tracker → WORKING), V1.1: the tracker must belong to the CURRENT
 * executor chain (dispatch binding + current plan + sha256-bound approval).
 */
async function applyTrackerCreateMarker(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  input: GateInput,
  publisher: string,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
): Promise<void> {
  if (
    !markerStatePrecondition(
      ref, snapshot, 'T3', 'execution tracker created', publisher, input.actor, STATES.ready, log,
    )
  ) {
    return;
  }
  if (input.commentId === undefined) {
    log.warning('T3: event carries no comment id; the source object cannot be anchored — no transition.');
    return;
  }
  await authorizeExecutorTransition(
    ref,
    snapshot,
    input,
    publisher,
    'T3',
    LABELS.ready,
    LABELS.working,
    'execution tracker created',
    { requireTracker: false },
    client,
    log,
    scope,
  );
}

/**
 * T6 (Report → DONE), V1.1: the report must belong to the CURRENT executor
 * chain AND its own dispatch must have produced the tracker (no orphan
 * reports; plan §4.5 "Report.tracker_comment_id" binding via dispatch).
 */
async function applyCompletionMarker(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  input: GateInput,
  publisher: string,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
): Promise<void> {
  if (
    !markerStatePrecondition(
      ref, snapshot, 'T6', 'completion report published', publisher, input.actor, STATES.working, log,
    )
  ) {
    return;
  }
  if (input.commentId === undefined) {
    log.warning('T6: event carries no comment id; the source object cannot be anchored — no transition.');
    return;
  }
  await authorizeExecutorTransition(
    ref,
    snapshot,
    input,
    publisher,
    'T6',
    LABELS.working,
    LABELS.done,
    'completion report published',
    { requireTracker: true },
    client,
    log,
    scope,
  );
}

/**
 * Shared T3 / T6 machinery: resolve authorization context, run the executor
 * chain validation on the source comment, optionally require the dispatch's
 * tracker (T6), then persist the transition record and swap labels.
 */
async function authorizeExecutorTransition(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  input: GateInput,
  publisher: string,
  transitionId: TransitionId,
  fromLabel: string,
  toLabel: string,
  description: string,
  opts: { requireTracker: boolean },
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
): Promise<void> {
  if (input.commentId === undefined || snapshot.status !== 'in-workflow') {
    return; // guarded by the caller (markerStatePrecondition); keeps TS honest
  }
  const comments = await client.listComments(ref);
  const contextResolution = resolveAuthorizationContext({
    comments,
    repositoryId: input.repositoryId,
    issueNumber: ref.issueNumber,
    gateIssuers: scope.gateIssuers,
    bootstrapIssuers: scope.bootstrapIssuers,
  });
  if (!contextResolution.ok) {
    log.warning(`Invalid ${transitionId} on #${ref.issueNumber}: ${contextResolution.reason}; no transition.`);
    return;
  }
  const context: WorkflowAuthorizationContext = contextResolution.context;
  const sourceComment = comments.find((comment) => comment.id === input.commentId);
  if (sourceComment === undefined) {
    log.warning(
      `Invalid ${transitionId} on #${ref.issueNumber}: source comment ${input.commentId} not found ` +
        'on the issue; no transition.',
    );
    return;
  }
  const chain = validateExecutorSource({
    context,
    sourceComment,
    comments,
    trustedHumans: scope.identities.humans,
    repoOwner: input.repoOwner,
    gateIssuers: scope.gateIssuers,
  });
  if (!chain.ok) {
    log.warning(
      `Invalid ${transitionId} on #${ref.issueNumber} (${description} by ${publisher} ` +
        `"${input.actor}"): ${chain.reason}; no transition.`,
    );
    return;
  }
  if (opts.requireTracker && !hasTrackerForDispatch(comments, chain.dispatchId)) {
    log.warning(
      `Invalid ${transitionId} on #${ref.issueNumber}: no execution tracker exists for dispatch ` +
        `${chain.dispatchId} (orphan report); no transition.`,
    );
    return;
  }
  await commitTransition(
    ref,
    {
      repositoryId: input.repositoryId,
      issueNumber: ref.issueNumber,
      epoch: context.epoch,
      dispatchId: chain.dispatchId,
      transition: transitionId,
      fromLabel,
      toLabel,
      sourceCommentId: input.commentId,
    },
    comments,
    snapshot.label,
    client,
    log,
    scope,
    `${description} (dispatch ${chain.dispatchId}, plan ${chain.planCommentId}, ` +
      `approval #${chain.approvalCommentId})`,
  );
}

/**
 * V1.1 Phase 4: persist (or adopt) the gate_transition record for an
 * authorized migration, THEN swap the labels (record-first: a failed record
 * write means NO migration — exactly the T2 approval-record convention).
 * A transition record that already exists for the same operation id is
 * adopted (crash between record and label); a CONFLICTING one fails closed.
 * Returns false (with a logged reason) when the migration must NOT happen.
 */
async function commitTransition(
  ref: IssueRef,
  spec: {
    repositoryId: number;
    issueNumber: number;
    epoch: string;
    dispatchId: string | null;
    transition: TransitionId;
    fromLabel: string;
    toLabel: string;
    sourceCommentId: number;
  },
  comments: ReadonlyArray<{ id: number; user: string; body: string }>,
  currentLabel: string,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
  description: string,
): Promise<boolean> {
  const record: GateTransitionRecord = {
    schema: 2,
    kind: 'gate_transition',
    repository_id: spec.repositoryId,
    issue_number: spec.issueNumber,
    workflow_epoch: spec.epoch,
    dispatch_id: spec.dispatchId,
    transition: spec.transition,
    from_label: spec.fromLabel,
    to_label: spec.toLabel,
    source_comment_id: spec.sourceCommentId,
    gate_login: scope.gateLogin,
    gate_user_id: scope.gateUserId,
    gate_version: GATE_VERSION,
    created_at: new Date().toISOString(),
    operation_id: transitionOperationId(
      spec.repositoryId,
      spec.issueNumber,
      spec.epoch,
      spec.transition,
      spec.sourceCommentId,
    ),
  };
  const { records: existingTransitions } = parseTransitionRecords(comments);
  const sameOperation = existingTransitions.filter(
    (entry) => entry.record.operation_id === record.operation_id,
  );
  if (sameOperation.length > 0) {
    const first = sameOperation[0];
    const divergent = sameOperation.find(
      (entry) =>
        entry.record.workflow_epoch !== record.workflow_epoch ||
        entry.record.dispatch_id !== record.dispatch_id ||
        entry.record.transition !== record.transition ||
        entry.record.from_label !== record.from_label ||
        entry.record.to_label !== record.to_label ||
        entry.record.source_comment_id !== record.source_comment_id,
    );
    if (first === undefined || divergent !== undefined) {
      log.warning(
        `Invalid ${spec.transition} on #${ref.issueNumber}: conflicting gate_transition ` +
          'record(s) for the same operation id — failing closed, no transition.',
      );
      return false;
    }
    log.info(
      `Transition record #${first.commentId} already exists for ${record.operation_id}; ` +
        'adopting it (crash recovery: record persisted, label swap did not complete).',
    );
  } else {
    const published = await publishRecord(client, ref, record, log);
    if (!published.ok) {
      log.warning(
        `Invalid ${spec.transition} on #${ref.issueNumber}: transition record publish failed ` +
          `(${published.reason}); the migration is NOT performed (record-first, fail closed).`,
      );
      return false;
    }
    log.info(`Transition record #${published.commentId} persisted for ${record.operation_id}.`);
  }

  await client.addLabels(ref, [spec.toLabel]);
  await client.removeLabel(ref, currentLabel);
  log.info(
    `${spec.transition} on #${ref.issueNumber}: ${currentLabel} -> ${spec.toLabel} ` +
      `(${spec.fromLabel} -> ${spec.toLabel}, ${description}).`,
  );
  return true;
}

/**
 * T0: outside -> PLANNING — V1.1 Phase 3 record-first ordering: the round's
 * workflow_epoch record (created_by: gate) is created (or adopted by its
 * deterministic operation id `epoch:<repo>:<issue>:c<command>`) BEFORE the
 * ai:planning label is applied. No epoch record → NO PLANNING (fail closed):
 * a new round can never run without its epoch, and can never inherit the
 * previous round's epoch. A redelivered /ai-plan event re-derives the same
 * operation id and adopts the existing record (no second epoch, Phase 3
 * acceptance); an epoch record that conflicts under the same operation id
 * fails closed (Phase 2 §5.4).
 */
async function applyAiPlan(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
): Promise<boolean> {
  if (snapshot.status === 'ambiguous') {
    log.warning(
      `Invalid /ai-plan on #${ref.issueNumber}: issue carries multiple ai:* labels ` +
        `[${snapshot.labels.join(', ')}] (protocol violation); no transition.`,
    );
    return false;
  }
  if (snapshot.status !== 'outside') {
    log.warning(
      `Invalid /ai-plan on #${ref.issueNumber}: issue already in workflow ` +
        `(label ${snapshot.label}); no transition.`,
    );
    return false;
  }
  if (!isLegalTransition(null, STATES.planning)) {
    log.warning('Frozen transition table rejects T0; no transition.');
    return false;
  }
  if (input.commentId === undefined) {
    log.warning(
      `Invalid /ai-plan on #${ref.issueNumber}: event carries no comment id, so the epoch ` +
        'operation cannot be anchored deterministically; no record, no transition.',
    );
    return false;
  }

  // Record-first: resolve-or-mint the round epoch.
  const operationId = gateEpochOperationId(input.repositoryId, ref.issueNumber, input.commentId);
  let comments: Array<{ id: number; user: string; body: string }>;
  try {
    comments = await client.listComments(ref);
  } catch (err) {
    log.warning(
      `Invalid /ai-plan on #${ref.issueNumber}: cannot read comments for the epoch lookup ` +
        `(fail closed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  const existingEpoch = findEpochRecordByOperationId(comments, operationId);
  if (!existingEpoch.found && existingEpoch.conflict) {
    log.warning(
      `Invalid /ai-plan on #${ref.issueNumber}: CONFLICTING workflow_epoch records for ` +
        `${operationId} (fail closed); no transition.`,
    );
    return false;
  }
  let epoch: string;
  if (existingEpoch.found) {
    epoch = existingEpoch.record.workflow_epoch;
    log.info(
      `Epoch record #${existingEpoch.commentId} already exists for ${operationId}; adopting ` +
        `epoch ${epoch} (idempotent T0 recovery).`,
    );
  } else {
    const record: WorkflowEpochRecord = {
      schema: 2,
      kind: 'workflow_epoch',
      repository_id: input.repositoryId,
      issue_number: ref.issueNumber,
      workflow_epoch: newWorkflowEpoch(),
      created_by: 'gate',
      created_at: new Date().toISOString(),
      issued_by: scope.gateLogin,
      operation_id: operationId,
    };
    const published = await publishRecord(client, ref, record, log);
    if (!published.ok) {
      log.warning(
        `Invalid /ai-plan on #${ref.issueNumber}: epoch record publish failed ` +
          `(${published.reason}). NO epoch → NO PLANNING (fail closed, V1.1 Phase 3): ` +
          're-run /ai-plan to retry the record write.',
      );
      return false;
    }
    epoch = record.workflow_epoch;
    log.info(
      `Epoch ${epoch} persisted as record comment #${published.commentId} ` +
        `(created_by gate, issued by ${scope.gateLogin}).`,
    );
  }

  // Only now the label migration.
  await client.addLabels(ref, [LABELS.planning]);
  log.info(`T0 on #${ref.issueNumber}: added ${LABELS.planning} (PLANNING), epoch ${epoch}.`);
  return true;
}

/**
 * Publishes a Gate record comment and VERIFIES the remote content matches
 * (docs/plans/v1_hardening_decisions.md §4: "确认记录可读取且内容匹配").
 * Never throws: infrastructure failures come back as { ok: false } so the
 * caller can no-op without a reaction and without any label migration.
 * If the comment WAS created but the response was lost (timeout after POST),
 * re-running the command reuses the record by operation id — the recovery
 * path never duplicates authorization objects (Phase 6).
 */
async function publishRecord(
  client: GitHubClient,
  ref: IssueRef,
  record: GateRecord,
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
 * T2: REVIEW -> READY by persisting a Gate-issued APPROVAL RECORD and only
 * then swapping labels (schema 2, docs/plans/v1_hardening_decisions.md §4.2).
 *
 * Sequence (frozen — the durable authorization fact is the RECORD, never the
 * human's command comment):
 *  1. unchanged state preconditions (single ai:* label, REVIEW, legal T2);
 *  2. validate the referenced plan comment (exists / valid marker / CURRENT
 *     plan — approvals.ts);
 *  3. compute `plan_sha256` with the FROZEN canonicalization;
 *  4. read the current epoch through the V1.1 trusted resolution
 *     (resolveCurrentEpoch: issuer classes, repo/issue binding, conflicts);
 *  5. build the approval record (repo/issue/epoch/plan/hash/approver/gate);
 *  6. reuse-or-conflict check over existing records with the same operation
 *     id: identical content -> reuse (crash recovery), divergent content
 *     (e.g. the plan was edited after an earlier approval) -> FAIL CLOSED;
 *  7. publish + verify the record;
 *  8. persist the T2 gate_transition record (V1.1 Phase 4, record-first);
 *  9. only now perform the add-then-remove label swap.
 *
 * A failure in steps 4–8 is a logged no-op WITHOUT a reaction and WITHOUT any
 * label migration. A record that persisted while the label swap failed
 * recovers by re-running the command (steps 6/8 adopt the records).
 */
async function applyApprove(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  args: ApproveArgs,
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
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
  // V1.1: full trust resolution (issuer classes, conflicts).
  const epoch = await readCurrentEpoch(ref, input, allComments, scope, log);
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
  const record: ApprovalRecordPayload = {
    schema: 2,
    kind: 'approval',
    repository_id: input.repositoryId,
    issue_number: ref.issueNumber,
    workflow_epoch: epoch.epoch,
    plan_comment_id: args.planCommentId,
    plan_sha256: planSha256(referencedComment.body),
    approval_command_comment_id: input.commentId,
    approved_by_id: input.actorId ?? 0,
    approved_by_login: input.actor,
    gate_login: scope.gateLogin,
    gate_user_id: scope.gateUserId,
    created_at: new Date().toISOString(),
    operation_id: approvalOperationId(
      input.repositoryId,
      ref.issueNumber,
      epoch.epoch,
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

  // V1.1 Phase 4: persist the T2 transition record BEFORE the label swap.
  const transition = await commitTransition(
    ref,
    {
      repositoryId: input.repositoryId,
      issueNumber: ref.issueNumber,
      epoch: epoch.epoch,
      dispatchId: null,
      transition: 'T2',
      fromLabel: LABELS.review,
      toLabel: LABELS.ready,
      sourceCommentId: input.commentId,
    },
    allComments,
    snapshot.label,
    client,
    log,
    scope,
    `approval accepted (plan ${inspection.planCommentId}, approved by ${input.actor})`,
  );
  if (!transition) {
    return false;
  }
  // commitTransition performed the add-then-remove label swap (add first, so
  // a concurrent reader always sees exactly one ai:* label). Only NOW is T2
  // accepted with its reaction.
  log.info(
    `T2 on #${ref.issueNumber}: ${LABELS.review} -> ${LABELS.ready} ` +
      `(REVIEW -> READY approving plan comment ${inspection.planCommentId}, ` +
      `sha256-bound approval record).`,
  );
  return true;
}

/**
 * Current epoch of an issue through the V1.1 trusted resolution (Phase 2):
 * strict parsing, repository/issue binding, created_by issuer class checks
 * and operation-id conflict detection. ANY violation fails closed.
 */
async function readCurrentEpoch(
  ref: IssueRef,
  input: GateInput,
  prefetchedComments: ReadonlyArray<{ id: number; user: string; body: string }>,
  scope: GateIdentityScope,
  log: GateLogger,
): Promise<{ ok: true; epoch: string; commentId: number } | { ok: false; reason: string }> {
  const resolution = resolveAuthorizationContext({
    comments: prefetchedComments,
    repositoryId: input.repositoryId,
    issueNumber: ref.issueNumber,
    gateIssuers: scope.gateIssuers,
    bootstrapIssuers: scope.bootstrapIssuers,
  });
  if (!resolution.ok) {
    return { ok: false, reason: resolution.reason };
  }
  return {
    ok: true,
    epoch: resolution.context.epoch,
    commentId: resolution.context.epochRecordCommentId,
  };
}

/**
 * Schema 2 acceptance channel shared by /choose and /change: after the frozen
 * format + REVIEW + identity preconditions pass, the gate persists a
 * feedback_accepted record (docs/plans/v1_hardening_decisions.md §4.3).
 * These records — not the raw comment count — are what Consumer revisions
 * are built from: rejected, duplicated, foreign-epoch and plain-text comments
 * never produce one. Idempotent by operation id; a publish failure is a
 * logged no-op WITHOUT a reaction (the acceptance did not happen).
 */
async function acceptFeedbackEvent(
  ref: IssueRef,
  feedbackKind: 'choose' | 'change',
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
): Promise<boolean> {
  if (input.commentId === undefined) {
    log.warning(
      `/${feedbackKind} on #${ref.issueNumber}: event carries no comment id; the accepted ` +
        'event cannot be anchored — fail closed, no record, no reaction.',
    );
    return false;
  }
  const allComments = await client.listComments(ref);
  const epoch = await readCurrentEpoch(ref, input, allComments, scope, log);
  if (!epoch.ok) {
    log.warning(`/${feedbackKind} on #${ref.issueNumber}: ${epoch.reason}; no record, no reaction.`);
    return false;
  }
  const operationId = feedbackOperationId(
    input.repositoryId,
    ref.issueNumber,
    epoch.epoch,
    input.commentId,
  );
  const { records, invalid } = parseRecords('feedback_accepted', allComments);
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
  const record: FeedbackAcceptedRecordPayload = {
    schema: 2,
    kind: 'feedback_accepted',
    repository_id: input.repositoryId,
    issue_number: ref.issueNumber,
    workflow_epoch: epoch.epoch,
    event_id: `fe${input.commentId}`,
    feedback_comment_id: input.commentId,
    feedback_kind: feedbackKind,
    gate_login: scope.gateLogin,
    gate_user_id: scope.gateUserId,
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
      `${input.commentId}, epoch ${epoch.epoch}).`,
  );
  return true;
}

/**
 * /choose: a Trusted Human decision on an open question of the current plan.
 * The gate validates the strict format (done in commands.ts) and the REVIEW
 * precondition, persists the accepted-event record and forwards the arguments
 * verbatim to the Consumer as untrusted data. NO state migration (protocol
 * 3.2 / 3.3).
 */
async function applyChoose(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  args: ChooseArgs,
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
): Promise<boolean> {
  if (snapshot.status === 'ambiguous') {
    log.warning(
      `Invalid /choose on #${ref.issueNumber}: issue carries multiple ai:* labels ` +
        `[${snapshot.labels.join(', ')}] (protocol violation); ignored.`,
    );
    return false;
  }
  if (snapshot.status !== 'in-workflow' || snapshot.state !== STATES.review) {
    log.warning(
      `Invalid /choose on #${ref.issueNumber}: /choose requires ${STATES.review} ` +
        `(${LABELS.review}), current state is ${describeSnapshot(snapshot)}; ` +
        'ignored, not forwarded to the Consumer.',
    );
    return false;
  }
  const accepted = await acceptFeedbackEvent(ref, 'choose', input, client, log, scope);
  if (accepted) {
    log.info(
      `/choose on #${ref.issueNumber} accepted (REVIEW): question "${args.questionId}", ` +
        `choice "${args.choice}" forwarded to the Consumer as untrusted data; no state migration.`,
    );
  }
  return accepted;
}

/**
 * /change: a Trusted Human change request against the current plan. Same
 * policy as /choose: format + REVIEW precondition, accepted-event record,
 * free text forwarded verbatim as untrusted data, NO state migration.
 */
async function applyChange(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  args: ChangeArgs,
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
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
        'ignored, not forwarded to the Consumer.',
    );
    return false;
  }
  const accepted = await acceptFeedbackEvent(ref, 'change', input, client, log, scope);
  if (accepted) {
    log.info(
      `/change on #${ref.issueNumber} accepted (REVIEW): change request forwarded to the ` +
        `Consumer as untrusted data, text preserved verbatim: "${args.text}"; no state migration.`,
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
 * T4 / T5: a tracker comment edit while the issue sits in WORKING / BLOCKED.
 * V1.1 (plan §4.4): the edited tracker must belong to the CURRENT executor
 * chain (dispatch binding + epoch + current plan + valid approval) — an old
 * round's tracker can never influence the new round. After the chain check,
 * the gate deterministically parses the tracker's `**Status:**` machine value
 * (protocol section 2.1; parsing rules in tracker.ts):
 *   WORKING  + "Blocked"     -> T4: ai:working  -> ai:blocked
 *   BLOCKED  + "In Progress" -> T5: ai:blocked -> ai:working
 * Everything else is a logged no-op, in particular:
 *  - "Completed" NEVER triggers a transition from any state: completion is
 *    triggered exclusively by the completion-report marker (T6);
 *  - same-value edits ("In Progress" while WORKING, "Blocked" while BLOCKED)
 *    make duplicate event deliveries idempotent;
 *  - a missing or non-machine Status value is never guessed at.
 */
async function applyTrackerStatusEdit(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  input: GateInput,
  publisherKind: string,
  client: GitHubClient,
  log: GateLogger,
  scope: GateIdentityScope,
): Promise<void> {
  if (snapshot.status !== 'in-workflow') {
    log.warning(
      `Tracker status edit on #${ref.issueNumber}: issue state is ${describeSnapshot(snapshot)}; ` +
        'no transition.',
    );
    return;
  }
  const body = input.commentBody ?? '';
  if (input.commentId === undefined) {
    log.warning('Tracker edit: event carries no comment id; the source cannot be anchored.');
    return;
  }

  const comments = await client.listComments(ref);
  const contextResolution = resolveAuthorizationContext({
    comments,
    repositoryId: input.repositoryId,
    issueNumber: ref.issueNumber,
    gateIssuers: scope.gateIssuers,
    bootstrapIssuers: scope.bootstrapIssuers,
  });
  if (!contextResolution.ok) {
    log.warning(
      `Tracker edit on #${ref.issueNumber} by ${publisherKind} "${input.actor}": ` +
        `${contextResolution.reason}; no transition.`,
    );
    return;
  }
  const sourceComment = comments.find((comment) => comment.id === input.commentId);
  if (sourceComment === undefined) {
    log.warning(
      `Tracker edit on #${ref.issueNumber}: source comment ${input.commentId} not found on the ` +
        'issue; no transition.',
    );
    return;
  }
  const chain = validateExecutorSource({
    context: contextResolution.context,
    sourceComment,
    comments,
    trustedHumans: scope.identities.humans,
    repoOwner: input.repoOwner,
    gateIssuers: scope.gateIssuers,
  });
  if (!chain.ok) {
    log.warning(
      `Tracker edit on #${ref.issueNumber} by ${publisherKind} "${input.actor}" rejected ` +
        `(not the current executor chain): ${chain.reason}; no transition.`,
    );
    return;
  }

  const inspection = parseTrackerStatus(body);
  if (inspection.kind === 'absent') {
    log.warning(
      `Tracker edit on #${ref.issueNumber} by ${publisherKind} "${actorName(input)}": no parsable ` +
        '**Status:** line; T4 / T5 need the exact machine value (In Progress / Blocked / ' +
        'Completed); no transition.',
    );
    return;
  }
  if (inspection.kind === 'unknown') {
    log.warning(
      `Tracker edit on #${ref.issueNumber} by ${publisherKind} "${actorName(input)}": Status ` +
        `"${inspection.raw}" is not a machine value (In Progress / Blocked / Completed); ` +
        'no transition.',
    );
    return;
  }
  const status = inspection.status;

  if (status === 'Completed') {
    log.info(
      `Tracker edit on #${ref.issueNumber} by ${publisherKind} "${actorName(input)}": Status ` +
        '"Completed" never triggers a transition; completion goes exclusively through the ' +
        'completion-report marker (T6).',
    );
    return;
  }

  if (status === 'Blocked' && snapshot.state === STATES.working) {
    if (!isLegalTransition(STATES.working, STATES.blocked)) {
      log.warning('Frozen transition table rejects T4; no transition.');
      return;
    }
    await commitTransition(
      ref,
      {
        repositoryId: input.repositoryId,
        issueNumber: ref.issueNumber,
        epoch: contextResolution.context.epoch,
        dispatchId: chain.dispatchId,
        transition: 'T4',
        fromLabel: LABELS.working,
        toLabel: LABELS.blocked,
        sourceCommentId: input.commentId,
      },
      comments,
      snapshot.label,
      client,
      log,
      scope,
      `tracker Status "Blocked" edited by ${publisherKind} "${actorName(input)}"`,
    );
    return;
  }

  if (status === 'In Progress' && snapshot.state === STATES.blocked) {
    if (!isLegalTransition(STATES.blocked, STATES.working)) {
      log.warning('Frozen transition table rejects T5; no transition.');
      return;
    }
    await commitTransition(
      ref,
      {
        repositoryId: input.repositoryId,
        issueNumber: ref.issueNumber,
        epoch: contextResolution.context.epoch,
        dispatchId: chain.dispatchId,
        transition: 'T5',
        fromLabel: LABELS.blocked,
        toLabel: LABELS.working,
        sourceCommentId: input.commentId,
      },
      comments,
      snapshot.label,
      client,
      log,
      scope,
      `tracker Status "In Progress" edited by ${publisherKind} "${actorName(input)}"`,
    );
    return;
  }

  // Same-value edits: the event is a duplicate delivery or a routine progress
  // update that already matches the current state.
  log.info(
    `Tracker edit on #${ref.issueNumber} by ${publisherKind} "${actorName(input)}": Status ` +
      `"${status}" already matches the current state ${snapshot.state} (${snapshot.label}); ` +
      'no transition.',
  );
}

function actorName(input: GateInput): string {
  return input.actor;
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
