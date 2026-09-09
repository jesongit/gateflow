/**
 * Entry point of the GateFlow action.
 *
 * Responsibilities kept deliberately thin:
 *  - bail out safely when not running inside GitHub Actions;
 *  - translate the github-context payload into a GateInput;
 *  - run the deterministic gate (src/gate/gate.ts) against one shared GitHubClient;
 *  - surface only infrastructure failures via setFailed (protocol/business
 *    no-ops are logged, never failed). Identity-CONFIG rejections (GF-H10)
 *    are deliberate exceptions: a misconfigured identity model fails the run.
 */
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { runGate, type GateInput, type GateLogger } from './gate/gate';
import { createGitHubClient, type GitHubClient } from './gate/github';

export const GATE_VERSION = '1.0.0';

/** Action inputs, read once per call. */
function readInputs(): {
  trustedHumans: string;
  trustedAgents: string;
  requireExplicitHumans: string;
  token: string;
} {
  return {
    trustedHumans: core.getInput('trusted-humans'),
    trustedAgents: core.getInput('trusted-agents'),
    requireExplicitHumans: core.getInput('require-explicit-humans') || 'true',
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
    repository?: { id?: number };
    issue?: { number?: number; body?: string; user?: { login?: string; id?: number } };
    comment?: { id?: number; user?: { login?: string; id?: number }; body?: string };
    sender?: { login?: string; id?: number };
  };

  const issueNumber = payload.issue?.number;
  if (typeof issueNumber !== 'number') {
    core.warning(
      `Event ${context.eventName} carries no issue payload; nothing to do. ` +
        'Check the workflow "on:" configuration.',
    );
    return null;
  }

  const commentUser = payload.comment?.user;
  const actor =
    commentUser?.login ?? payload.sender?.login ?? payload.issue?.user?.login ?? '';
  const actorId = commentUser?.id ?? payload.sender?.id ?? payload.issue?.user?.id;
  const inputs = readInputs();

  return {
    eventName: context.eventName,
    eventAction: payload.action,
    actor,
    actorId,
    repositoryId: payload.repository?.id ?? 0,
    repoOwner: context.repo.owner,
    repo: context.repo.repo,
    issueNumber,
    commentId: payload.comment?.id,
    commentBody: payload.comment?.body,
    trustedHumansInput: inputs.trustedHumans,
    trustedAgentsInput: inputs.trustedAgents,
    requireExplicitHumansInput: inputs.requireExplicitHumans,
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
    // Infrastructure error (API unreachable, auth, missing token) or a
    // fail-closed identity-configuration rejection: fail loudly.
    // Everything else is handled and logged inside the gate.
    core.setFailed(err instanceof Error ? err.message : String(err));
  });
} else {
  core.info(`gateflow ${GATE_VERSION}: not running inside GitHub Actions, exiting.`);
}
