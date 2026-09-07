import { ChatGPTActivationAdapter } from './chatgpt';
import { ManualActivationAdapter } from './manual';
import { ZCodeActivationAdapter } from './zcode';
import type {
  ActivationAdapter,
  ActivationAgentConfig,
  ActivationDispatch,
  ActivationKind,
} from './types';

export { ManualActivationAdapter } from './manual';
export { ChatGPTActivationAdapter } from './chatgpt';
export { ZCodeActivationAdapter } from './zcode';
export { buildAgentEnv, CredentialInPassthroughError } from './env';
export type {
  ActivationAdapter,
  ActivationAgentConfig,
  ActivationCapabilities,
  ActivationDispatch,
  ActivationKind,
  ActivationResult,
  ActivationState,
  CancelResult,
  CancelState,
} from './types';

/**
 * Build the adapter for a config-declared activation kind.
 *
 * FROZEN PRINCIPLES: 'manual' is the safe default for any unknown/garbage
 * kind — config must never be able to crash the Driver here. Manual is a
 * first-class choice, not a degraded mode.
 */
export function createActivationAdapter(
  kind: ActivationKind,
  opts?: ActivationAgentConfig,
): ActivationAdapter {
  switch (kind) {
    case 'chatgpt':
      return new ChatGPTActivationAdapter({
        command: opts?.command,
        autoStart: opts?.autoStart,
        envPassthrough: opts?.envPassthrough,
      });
    case 'zcode':
      return new ZCodeActivationAdapter({
        command: opts?.command,
        autoStart: opts?.autoStart,
        envPassthrough: opts?.envPassthrough,
      });
    case 'manual':
    default:
      return new ManualActivationAdapter();
  }
}

function isActivationKind(value: unknown): value is ActivationKind {
  return value === 'manual' || value === 'chatgpt' || value === 'zcode';
}

/**
 * Config contract from docs/workspace-protocol.md §10: role → agent →
 * activation, with a fallback.
 *
 * - Missing agent config → `fallback` adapter (default 'manual').
 * - Unknown `activation` kind → `fallback` adapter.
 * - Unknown/invalid `fallback` → 'manual'.
 * - NEVER throws, whatever the (runtime) config contains.
 */
export function resolveAdapterForAgent(
  agentName: string,
  agents: Record<string, ActivationAgentConfig> | undefined,
  fallback: ActivationKind = 'manual',
): ActivationAdapter {
  const config = agents?.[agentName];
  const requested = isActivationKind(config?.activation) ? config.activation : undefined;
  const kind = requested ?? (isActivationKind(fallback) ? fallback : 'manual');
  return createActivationAdapter(kind, config);
}

/**
 * Convert the workspace protocol's snake_case `Dispatch` into this module's
 * camelCase structural type, keeping `src/activation` decoupled from
 * `src/workspace` (no import in this direction, ever).
 */
export function toActivationDispatch(d: {
  dispatch_id: string;
  role: 'consumer' | 'executor';
  issue_number: number;
  repository: string;
}): ActivationDispatch {
  return {
    dispatchId: d.dispatch_id,
    role: d.role,
    issueNumber: d.issue_number,
    repository: d.repository,
  };
}
