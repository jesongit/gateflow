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
 *  - Markers are structural hints, never permission. A marker-triggered
 *    transition (T1 / T3 / T6) requires ALL of: a valid marker (unique,
 *    owning its line), a publisher in Trusted Human ∪ Trusted Agent, and a
 *    re-read state matching the transition's `from`. Invalid marker comments,
 *    markers from unknown actors, the append marker and the issue-body schema
 *    block never trigger anything.
 *  - An EDIT of the tracker marker comment while the issue sits in WORKING /
 *    BLOCKED is the T4 / T5 channel: the gate deterministically parses the
 *    tracker's `**Status:**` machine value (Blocked -> ai:blocked, In
 *    Progress -> ai:working). "Completed" never transitions: completion goes
 *    exclusively through the completion-report marker (T6). Non-machine
 *    values and missing values are logged no-ops.
 *  - V1 approval hardening (plan phases 9 + protocol v2): /approve is bound
 *    to a specific plan comment ("/approve <plan-comment-id>"). After the
 *    existing permission / open-issue / REVIEW checks, the referenced
 *    comment must exist on this issue, carry a valid plan marker and be the
 *    CURRENT plan (the last valid plan-marker comment, chronological by id).
 *    A failing target is a logged no-op WITHOUT a reaction (state-
 *    precondition convention); a passing one performs T2 exactly as before
 *    and reacts with ✅. The durable Approval Record is the human's own
 *    "/approve <id>" comment; the Driver re-validates it before executor
 *    dispatch (architecture-v1 section 3.3).
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
  type ChooseArgs,
  type ParsedCommand,
} from './commands';
import { validatePlanCommentForApproval } from './approvals';
import { detectCommentMarker, inspectCommentMarkers, parseIssueSchemaBlock } from './markers';
import { isLegalTransition, readSnapshot, type WorkflowSnapshot } from './states';
import { parseTrackerStatus } from './tracker';
import { isTrustedAgent, isTrustedHuman } from './permissions';
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
}

/** Comment actions that carry a command or marker. */
const COMMAND_ACTIONS: ReadonlySet<string> = new Set(['created', 'edited']);

/** Runs the gate for one event. Resolves normally unless infrastructure fails. */
export async function runGate(
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
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
      accepted = await applyAiPlan(ref, snapshot, client, log);
      break;
    case COMMANDS.approve:
      accepted = await applyApprove(ref, snapshot, parsed.args, client, log);
      break;
    case COMMANDS.choose:
      accepted = await applyChoose(ref, snapshot, parsed.args, log);
      break;
    case COMMANDS.change:
      accepted = await applyChange(ref, snapshot, parsed.args, log);
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

/** T0: outside -> PLANNING by adding ai:planning. */
async function applyAiPlan(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
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
  await client.addLabels(ref, [LABELS.planning]);
  log.info(`T0 on #${ref.issueNumber}: added ${LABELS.planning} (PLANNING).`);
  return true;
}

/**
 * T2: REVIEW -> READY by adding ai:ready and removing ai:review.
 *
 * V1: the approval is bound to a specific plan comment. After the unchanged
 * state preconditions (single ai:* label, in REVIEW), the comment named by
 * `/approve <plan-comment-id>` is validated (see approvals.ts): it must
 * exist on this issue, carry a valid plan marker and be the CURRENT plan —
 * the last valid plan-marker comment in chronological (id) order. A failed
 * validation is a logged no-op WITHOUT a reaction; a passed one performs the
 * add-then-remove label swap exactly as before and earns the ✅ reaction.
 */
async function applyApprove(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  args: ApproveArgs,
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

  // V1 plan-ID binding: validate the referenced plan comment before any
  // write. The issue's comment list (id-ascending) establishes both issue
  // membership and which plan marker is the current plan; the id-targeted
  // fetch proves the referenced comment still exists with a valid marker.
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

  // Add-then-remove keeps the issue holding exactly one ai:* label even if a
  // reader observes it between the two calls.
  await client.addLabels(ref, [LABELS.ready]);
  await client.removeLabel(ref, LABELS.review);
  log.info(
    `T2 on #${ref.issueNumber}: ${LABELS.review} -> ${LABELS.ready} ` +
      `(REVIEW -> READY approving plan comment ${inspection.planCommentId}).`,
  );
  return true;
}

/**
 * /choose: a Trusted Human decision on an open question of the current plan.
 * The gate only validates the strict format (done in commands.ts) and the
 * REVIEW precondition; the arguments are forwarded verbatim to the Consumer
 * as untrusted data and NO state migration happens (protocol 3.2 / 3.3).
 */
async function applyChoose(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  args: ChooseArgs,
  log: GateLogger,
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
  log.info(
    `/choose on #${ref.issueNumber} accepted (REVIEW): question "${args.questionId}", ` +
      `choice "${args.choice}" forwarded to the Consumer as untrusted data; no state migration.`,
  );
  return true;
}

/**
 * /change: a Trusted Human change request against the current plan. Same
 * policy as /choose: format + REVIEW precondition only, the free text is
 * forwarded verbatim as untrusted data, NO state migration.
 */
async function applyChange(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  args: ChangeArgs,
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
        'ignored, not forwarded to the Consumer.',
    );
    return false;
  }
  log.info(
    `/change on #${ref.issueNumber} accepted (REVIEW): change request forwarded to the ` +
      `Consumer as untrusted data, text preserved verbatim: "${args.text}"; no state migration.`,
  );
  return true;
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
