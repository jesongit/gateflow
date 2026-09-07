/**
 * Activation Adapter contracts.
 *
 * FROZEN PRINCIPLES (docs/architecture-v1.md §2, docs/plans/
 * v1_hardening_decisions.md §9):
 * - Communication and activation are SEPARATE concerns: the Workspace
 *   Protocol owns communication (`.gateflow/` inbox/outbox); this module only
 *   answers "how do we wake a client once the Driver has prepared a dispatch".
 * - ManualActivationAdapter is a FIRST-CLASS citizen, not a fallback hack.
 * - Capability-based: `probe()` detects whether a stable external launch
 *   mechanism exists; when it does not, callers fall back to manual.
 * - NO fragile GUI automation, NO coordinate clicking, NO private APIs.
 * - NO scheduled AI polling — discovery is the Driver's job.
 * - ENV ISOLATION: adapters never pass the Driver's full environment to a
 *   spawned client (buildAgentEnv allowlist; secret keys always stripped).
 * - ACTIVATION SEMANTICS (hardening): `spawn()` success is `started` (a
 *   client PROCESS started) and never a claim that the agent accepted the
 *   task. Without a stable Task/Session ack API the strongest truthful state
 *   is `notified`. Activation failure never advances any workflow state.
 * - CANCEL: cancel() always answers explicitly — `cancelled`, `unsupported`
 *   or `unknown`. A silent no-op must never be presented as "task stopped".
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
 * How far a notify() attempt verifiably got (hardening §9):
 *  - `notified`: the human was instructed, or a notification channel was
 *    used. No claim about any process or session.
 *  - `started`: a client process was verifiably started (OS accepted the
 *    spawn). Still NOT proof the session loaded the dispatch.
 *  - `failed`: the attempt failed; the detail says what happened.
 */
export type ActivationState = 'notified' | 'started' | 'failed';

/** Outcome of a `notify()` attempt. Adapters must NEVER throw. */
export interface ActivationResult {
  state: ActivationState;
  detail: string;
}

/**
 * Outcome of a `cancel()` attempt (hardening §9): an explicit answer, never a
 * silent no-op. `unsupported` = the adapter has no cancellation capability;
 * `unknown` = a cancellation was attempted but its effect cannot be verified.
 */
export type CancelState = 'cancelled' | 'unsupported' | 'unknown';

export interface CancelResult {
  state: CancelState;
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
  /**
   * Best-effort cancellation of a pending activation. MUST answer explicitly
   * (docs/plans/v1_hardening_decisions.md §9) — the default contract is
   * `unsupported` for one-shot launches.
   */
  cancel?(dispatchId: string): Promise<CancelResult>;
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
  /**
   * Additional environment variable names copied into the spawned client's
   * environment (hardening §8). Secret-shaped keys are rejected (fail
   * closed) — the Driver's GitHub token never reaches an agent process.
   */
  envPassthrough?: string[];
}
