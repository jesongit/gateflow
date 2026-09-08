/**
 * Pure event-payload → GateInput extraction (V1.1 Phase 10, "Event Fixture
 * Integration"): the ONE place a GitHub webhook payload is translated into
 * the gate's input, with NO dependency on the @actions/runtime context. The
 * action entry (src/index.ts) binds it to `context`; the event-fixture test
 * suite (tests/events) feeds recorded payloads through the exact same code.
 *
 * Returns null when the payload carries no issue number — a misconfigured
 * workflow trigger is config noise, never a gate failure.
 */
import type { GateInput } from './gate';

/** Minimal shape of the webhook payload pieces this extractor reads. */
export interface GatePayloadShape {
  action?: string;
  repository?: { id?: number };
  issue?: { number?: number; body?: string; user?: { login?: string; id?: number } };
  comment?: { id?: number; user?: { login?: string; id?: number }; body?: string };
  sender?: { login?: string; id?: number };
}

/** The non-payload inputs (action inputs + repo coordinates). */
export interface GateInputOverrides {
  actor?: string | undefined;
  repoOwner: string;
  repo: string;
  trustedHumansInput: string;
  trustedAgentsInput: string;
  bootstrapDriversInput?: string;
  requireExplicitHumansInput?: string;
}

/**
 * Builds a GateInput from an injected eventName + payload. Pure function:
 * never throws, never touches the environment.
 */
export function gateInputFromPayload(
  eventName: string,
  payload: GatePayloadShape,
  overrides: GateInputOverrides,
): GateInput | null {
  const issueNumber = payload.issue?.number;
  if (typeof issueNumber !== 'number') {
    return null;
  }

  const commentUser = payload.comment?.user;
  const actor =
    overrides.actor ??
    commentUser?.login ??
    payload.sender?.login ??
    payload.issue?.user?.login ??
    '';

  return {
    eventName,
    eventAction: payload.action,
    actor,
    actorId: commentUser?.id ?? payload.sender?.id ?? payload.issue?.user?.id,
    repositoryId: payload.repository?.id ?? 0,
    repoOwner: overrides.repoOwner,
    repo: overrides.repo,
    issueNumber,
    commentId: payload.comment?.id,
    commentBody: payload.comment?.body,
    // Observability only: the gate parses this for the Producer schema block
    // (issues.opened); it never derives state or permissions from it.
    issueBody: payload.issue?.body,
    trustedHumansInput: overrides.trustedHumansInput,
    trustedAgentsInput: overrides.trustedAgentsInput,
    bootstrapDriversInput: overrides.bootstrapDriversInput ?? '',
    requireExplicitHumansInput: overrides.requireExplicitHumansInput ?? 'true',
  };
}
