/**
 * Activation Adapter contracts.
 *
 * FROZEN PRINCIPLES (docs/architecture-v1.md §2, plan §17-20):
 * - Communication and activation are SEPARATE concerns: the Workspace
 *   Adapter/Protocol owns communication (`.gateflow/` inbox/outbox); this
 *   module only answers "how do we wake a client once the Driver has prepared
 *   a dispatch".
 * - ManualActivationAdapter is a FIRST-CLASS citizen, not a fallback hack.
 * - Capability-based: `probe()` detects whether a stable external launch
 *   mechanism exists; when it does not, callers fall back to manual.
 * - NO fragile GUI automation, NO coordinate clicking, NO private APIs.
 * - NO scheduled AI polling — discovery is the Driver's job.
 *
 * This module stays decoupled from `src/workspace` / `src/github` / `src/gate`
 * (parallel WIP): the dispatch is modeled here as a minimal structural type.
 */

/**
 * Minimal structural view of a dispatch needed for activation.
 *
 * Note: camelCase here on purpose — the workspace protocol's snake_case
 * `Dispatch` is converted by `toActivationDispatch()` in `index.ts`, so this
 * module never imports from `src/workspace`.
 */
export interface ActivationDispatch {
  dispatchId: string;
  role: 'consumer' | 'executor';
  issueNumber: number;
  repository: string;
}

/**
 * Result of a capability probe. `available: false` is a normal, expected
 * outcome that means "use the fallback (manual) adapter" — never an error.
 */
export interface ActivationCapabilities {
  available: boolean;
  detail: string;
}

/**
 * Outcome of a `notify()` attempt. Adapters must NEVER throw: failure is
 * expressed as `notified: false` plus a human-readable `detail`.
 */
export interface ActivationResult {
  notified: boolean;
  detail: string;
}

/** How to wake a client after a dispatch is prepared (probe / notify / cancel). */
export interface ActivationAdapter {
  readonly name: string;
  /** Detect whether a stable external launch mechanism exists. */
  probe(): Promise<ActivationCapabilities>;
  /**
   * Wake the client (or, for the manual adapter, instruct the human) about a
   * prepared dispatch. `workspaceRoot` is the target repository root that
   * contains `.gateflow/`.
   */
  notify(dispatch: ActivationDispatch, workspaceRoot: string): Promise<ActivationResult>;
  /** Best-effort cancellation of a pending activation (optional). */
  cancel?(dispatchId: string): Promise<void>;
}

/** Adapter kinds allowed in `gateflow.config.yml` (`activation:` values, §10). */
export type ActivationKind = 'manual' | 'chatgpt' | 'zcode';

/**
 * Per-agent activation config from `gateflow.config.yml` `agents.<name>` (§10).
 * The config contract is role → agent → activation, with a fallback.
 */
export interface ActivationAgentConfig {
  activation: ActivationKind;
  /** Opt-in: allow the adapter to launch the client process itself. */
  autoStart?: boolean;
  /** Executable name used for probing / launching (adapter-specific default). */
  command?: string;
}
