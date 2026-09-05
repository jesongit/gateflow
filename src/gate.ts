/**
 * The deterministic gate: Event -> Permission -> Current State -> Command ->
 * Validate -> Transition (docs/protocol.md sections 2, 3, 7, 8).
 *
 * Hard rules enforced here:
 *  - The event actor must be a Trusted Human for any command; everyone else
 *    (including Trusted Agents) is silently ignored.
 *  - The current state is derived from labels re-read via the GitHub API
 *    immediately before every migration; the event payload snapshot is never
 *    trusted (protocol section 7).
 *  - Any invalid command/state combination is a logged no-op. The gate never
 *    throws for protocol/business reasons; only genuine infrastructure
 *    failures (API unreachable, auth errors, ...) propagate to the caller.
 *  - Phase 1 handles /ai-plan (T0), /approve (T2) and /cancel (exit);
 *    /choose and /change plus marker-triggered transitions (T1/T3/T6) and
 *    reaction feedback arrive in later phases.
 */
import { COMMANDS, LABELS, STATES } from './protocol';
import { parseCommand, type GateCommand } from './commands';
import { isLegalTransition, readSnapshot, type WorkflowSnapshot } from './states';
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
  /** Raw `trusted-humans` action input (comma-separated allowlist). */
  trustedHumansInput: string;
  /** Raw `trusted-agents` action input (V0 default: empty). */
  trustedAgentsInput: string;
}

/** Comment actions that carry a command. */
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
 * them performs a migration in Phase 1: opened does not auto-label, closed is
 * a validated silent stop, reopened is not handled in V0.
 */
async function handleIssueEvent(
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  switch (input.eventAction) {
    case 'opened':
      log.info(
        `issues.opened on #${input.issueNumber}: no auto-labeling. Producer-created issues ` +
          'already carry ai:planning (T0); external issues stay plain until a Trusted Human runs /ai-plan.',
      );
      return;
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

/** issue_comment.created / edited: the only command-carrying path. */
async function handleComment(
  input: GateInput,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  // 1) Strict command parse. Normal comments (and /choose, /change until
  //    Phase 2) yield null and must not touch the API at all.
  const command = parseCommand(input.commentBody);
  if (command === null) {
    log.info(
      `Comment on #${input.issueNumber} by "${input.actor}" is not a workflow command: ignored, no API writes.`,
    );
    return;
  }

  // 2) Permission: commands are a Trusted Human monopoly. Trusted Agents and
  //    everyone else are silently ignored (no reaction, no comment, no writes).
  if (!isTrustedHuman(input.actor, input.repoOwner, input.trustedHumansInput)) {
    const kind = isTrustedAgent(input.actor, input.trustedAgentsInput) ? 'trusted agent' : 'actor';
    log.info(
      `Command ${command} from non-Trusted-Human ${kind} "${input.actor}" on #${input.issueNumber}: silently ignored.`,
    );
    return;
  }

  // 3) Validate the issue itself; closed issues are terminal for commands too.
  const ref = issueRef(input);
  const issue = await client.getIssue(ref);
  if (issue.state === 'closed') {
    log.info(
      `Command ${command} on closed issue #${input.issueNumber}: closed issues are terminal, ignored.`,
    );
    return;
  }

  // 4) Current state: RE-READ labels from the API right before deciding.
  //    The event payload snapshot is never trusted (protocol section 7).
  const labels = await client.getLabels(ref);
  const snapshot = readSnapshot(labels);

  // 5) Validate + 6) transition.
  switch (command) {
    case COMMANDS.aiPlan:
      await applyAiPlan(ref, snapshot, client, log);
      return;
    case COMMANDS.approve:
      await applyApprove(ref, snapshot, client, log);
      return;
    case COMMANDS.cancel:
      await applyCancel(ref, snapshot, client, log);
      return;
    default: {
      // Exhaustiveness guard for future commands.
      const unreachable: never = command;
      log.warning(`Unhandled command ${String(unreachable)}: ignored.`);
      return;
    }
  }
}

/** T0: outside -> PLANNING by adding ai:planning. */
async function applyAiPlan(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  if (snapshot.status === 'ambiguous') {
    log.warning(
      `Invalid /ai-plan on #${ref.issueNumber}: issue carries multiple ai:* labels ` +
        `[${snapshot.labels.join(', ')}] (protocol violation); no transition.`,
    );
    return;
  }
  if (snapshot.status !== 'outside') {
    log.warning(
      `Invalid /ai-plan on #${ref.issueNumber}: issue already in workflow ` +
        `(label ${snapshot.label}); no transition.`,
    );
    return;
  }
  if (!isLegalTransition(null, STATES.planning)) {
    log.warning('Frozen transition table rejects T0; no transition.');
    return;
  }
  await client.addLabels(ref, [LABELS.planning]);
  log.info(`T0 on #${ref.issueNumber}: added ${LABELS.planning} (PLANNING).`);
}

/** T2: REVIEW -> READY by adding ai:ready and removing ai:review. */
async function applyApprove(
  ref: IssueRef,
  snapshot: WorkflowSnapshot,
  client: GitHubClient,
  log: GateLogger,
): Promise<void> {
  if (snapshot.status === 'ambiguous') {
    log.warning(
      `Invalid /approve on #${ref.issueNumber}: issue carries multiple ai:* labels ` +
        `[${snapshot.labels.join(', ')}] (protocol violation); no transition.`,
    );
    return;
  }
  if (snapshot.status !== 'in-workflow') {
    log.warning(
      `Invalid /approve on #${ref.issueNumber}: issue is not in the workflow (no ai:* label); ` +
        'run /ai-plan first; no transition.',
    );
    return;
  }
  if (snapshot.state !== STATES.review) {
    log.warning(
      `Invalid /approve on #${ref.issueNumber}: /approve requires ${STATES.review} ` +
        `(${LABELS.review}), current state is ${snapshot.state} (${snapshot.label}); no transition.`,
    );
    return;
  }
  if (!isLegalTransition(STATES.review, STATES.ready)) {
    log.warning('Frozen transition table rejects T2; no transition.');
    return;
  }
  // Add-then-remove keeps the issue holding exactly one ai:* label even if a
  // reader observes it between the two calls.
  await client.addLabels(ref, [LABELS.ready]);
  await client.removeLabel(ref, LABELS.review);
  log.info(
    `T2 on #${ref.issueNumber}: ${LABELS.review} -> ${LABELS.ready} (REVIEW -> READY, plan approved).`,
  );
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
): Promise<void> {
  if (snapshot.status === 'outside') {
    log.warning(
      `Invalid /cancel on #${ref.issueNumber}: issue has no ai:* label, nothing to cancel.`,
    );
    return;
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
}

function issueRef(input: GateInput): IssueRef {
  return { owner: input.repoOwner, repo: input.repo, issueNumber: input.issueNumber };
}

/** Exported for tests: the set of commands the Phase 1 gate routes. */
export const PHASE1_COMMANDS: readonly GateCommand[] = [
  COMMANDS.aiPlan,
  COMMANDS.approve,
  COMMANDS.cancel,
];
