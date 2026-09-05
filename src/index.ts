/**
 * Entry point of the GateFlow action (Phase 2: full command
 * set, reactions, marker validation).
 *
 * Responsibilities kept deliberately thin:
 *  - bail out safely when not running inside GitHub Actions;
 *  - translate the github-context payload into a GateInput;
 *  - run the deterministic gate (src/gate.ts) against one shared GitHubClient;
 *  - surface only infrastructure failures via setFailed (protocol/business
 *    no-ops are logged, never failed).
 */
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { runGate, type GateInput, type GateLogger } from './gate';
import { createGitHubClient, type GitHubClient } from './github';

export const GATE_VERSION = '0.3.0';

/** Action inputs, read once per call. */
function readInputs(): { trustedHumans: string; trustedAgents: string; token: string } {
  return {
    trustedHumans: core.getInput('trusted-humans'),
    trustedAgents: core.getInput('trusted-agents'),
    token: core.getInput('github-token', { required: true }),
  };
}

/**
 * Builds the GateInput from the current github context.
 * Returns null (with a warning log) when the payload carries no issue,
 * e.g. a misconfigured workflow trigger — that is config noise, not a failure.
 */
export function readGateInput(): GateInput | null {
  const payload = context.payload as {
    action?: string;
    issue?: { number?: number; body?: string; user?: { login?: string } };
    comment?: { id?: number; user?: { login?: string }; body?: string };
    sender?: { login?: string };
  };

  const issueNumber = payload.issue?.number;
  if (typeof issueNumber !== 'number') {
    core.warning(
      `Event ${context.eventName} carries no issue payload; nothing to do. ` +
        'Check the workflow "on:" configuration.',
    );
    return null;
  }

  const actor =
    payload.comment?.user?.login ?? payload.sender?.login ?? payload.issue?.user?.login ?? '';
  const inputs = readInputs();

  return {
    eventName: context.eventName,
    eventAction: payload.action,
    actor,
    repoOwner: context.repo.owner,
    repo: context.repo.repo,
    issueNumber,
    commentId: payload.comment?.id,
    commentBody: payload.comment?.body,
    // Observability only: the gate parses this for the Producer schema block
    // (issues.opened); it never derives state or permissions from it.
    issueBody: payload.issue?.body,
    trustedHumansInput: inputs.trustedHumans,
    trustedAgentsInput: inputs.trustedAgents,
  };
}

/** The logger the gate uses inside Actions (GitHub Actions log). */
function actionsLogger(): GateLogger {
  return {
    info: (message) => core.info(message),
    warning: (message) => core.warning(message),
  };
}

/** Runs one gate invocation. Exported for tests; side-effect free by itself. */
export async function run(client?: GitHubClient): Promise<void> {
  const input = readGateInput();
  if (input === null) {
    return;
  }
  const gh = client ?? createGitHubClient(getOctokit(readInputs().token));
  await runGate(input, gh, actionsLogger());
}

if (process.env.GITHUB_ACTIONS === 'true') {
  run().catch((err: unknown) => {
    // Infrastructure error (API unreachable, auth, missing token): fail loudly.
    // Everything else is handled and logged inside the gate.
    core.setFailed(err instanceof Error ? err.message : String(err));
  });
} else {
  core.info(`gateflow ${GATE_VERSION}: not running inside GitHub Actions, exiting.`);
}
