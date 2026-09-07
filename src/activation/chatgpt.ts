import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ManualActivationAdapter } from './manual';
import { buildAgentEnv } from './env';
import type {
  ActivationAdapter,
  ActivationCapabilities,
  ActivationDispatch,
  ActivationResult,
  CancelResult,
} from './types';

const execFileAsync = promisify(execFile);

/**
 * FROZEN PRINCIPLE (plan §19): use the client only if a stable external
 * launch capability exists (the CLI is on PATH); otherwise fall back to
 * manual activation. No GUI coordinate clicking, no fragile UI automation,
 * no private APIs.
 */
export interface ChatGPTActivationAdapterOptions {
  /** Executable to probe/launch. Defaults to 'chatgpt'. */
  command?: string;
  /** Opt-in auto launch. Defaults to false — spawning only on explicit config. */
  autoStart?: boolean;
  /**
   * Additional env var names passed to the spawned client (hardening §8).
   * The Driver environment is NEVER inherited wholesale: the child gets the
   * buildAgentEnv allowlist plus these names, with secret keys always stripped.
   */
  envPassthrough?: readonly string[];
  /** Driver environment source (defaults to process.env; injectable). */
  envSource?: Readonly<Record<string, string | undefined>>;
  /**
   * Injectable launch primitive (default wraps `spawn`, detached + unref +
   * stdio 'ignore') so tests never spawn anything real.
   */
  runner?: (cmd: string, args: string[], env: Record<string, string>) => Promise<void>;
  /** Injected manual delegate used for every fallback notice. */
  manual?: ManualActivationAdapter;
}

/**
 * Shell-free `which`-like capability check: `where <cmd>` on win32, `which
 * <cmd>` elsewhere, via `execFile` (never a shell). Kept local to this file
 * because the frozen `src/activation/` layout has no shared-helper module.
 */
async function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(checker, [command]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The EXACT dispatch path the agent must process (hardening §9): prompts
 * never point at `.gateflow/current.json` — that file is a manual UI pointer
 * only and may name a different dispatch by the time the agent reads it.
 */
export function buildLaunchPrompt(dispatch: ActivationDispatch, workspaceRoot: string): string {
  return (
    `GateFlow dispatch ${dispatch.dispatchId} is ready ` +
    `(issue #${dispatch.issueNumber}, role ${dispatch.role}, repo ${dispatch.repository}). ` +
    `Load the gateflow-agent skill, then read exactly ` +
    `${workspaceRoot}/.gateflow/inbox/${dispatch.dispatchId}/dispatch.json ` +
    `and process ONLY that dispatch; write all output to the matching outbox directory.`
  );
}

/**
 * Default detached launcher with an EXPLICIT child environment (hardening
 * §8): `env` is the buildAgentEnv allowlist product, never the Driver's
 * process.env. `spawn` (never a shell — `shell` defaults to false) with
 * `stdio: 'ignore'` gives a true fire-and-forget launch; `detached: true` +
 * `unref()` let the client outlive the Driver process.
 */
function defaultRunner(cmd: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.unref();
    child.once('error', (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.once('spawn', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}

export class ChatGPTActivationAdapter implements ActivationAdapter {
  readonly name = 'chatgpt';

  private readonly command: string;
  private readonly autoStart: boolean;
  private readonly envPassthrough: readonly string[];
  private readonly envSource: Readonly<Record<string, string | undefined>>;
  private readonly runner: (cmd: string, args: string[], env: Record<string, string>) => Promise<void>;
  private readonly manual: ManualActivationAdapter;

  constructor(options: ChatGPTActivationAdapterOptions = {}) {
    this.command = options.command ?? 'chatgpt';
    this.autoStart = options.autoStart === true;
    this.envPassthrough = options.envPassthrough ?? [];
    this.envSource = options.envSource ?? process.env;
    this.runner = options.runner ?? defaultRunner;
    this.manual = options.manual ?? new ManualActivationAdapter();
  }

  /** Capability check: is the configured command executable on PATH? */
  async probe(): Promise<ActivationCapabilities> {
    const exists = await commandExists(this.command);
    if (!exists) {
      return {
        available: false,
        detail:
          `command '${this.command}' not found on PATH — no stable external ` +
          'launch capability; fall back to manual activation',
      };
    }
    return {
      available: true,
      detail: `stable external launch capability: '${this.command}' found on PATH`,
    };
  }

  /**
   * Auto-start only when explicitly configured (`autoStart === true`) AND the
   * capability probe passes. The child environment is the explicit allowlist
   * build (secret-shaped passthrough keys fail closed via
   * CredentialInPassthroughError). Every other path — and any failure at
   * all — delegates to the injected ManualActivationAdapter. NEVER throws.
   */
  async notify(dispatch: ActivationDispatch, workspaceRoot: string): Promise<ActivationResult> {
    if (this.autoStart === true && (await this.probe()).available) {
      try {
        const env = buildAgentEnv(this.envPassthrough, this.envSource);
        await this.runner(this.command, [buildLaunchPrompt(dispatch, workspaceRoot)], env);
        // A process started — that is all we may claim. No ack channel
        // exists, so this is `started`, never "the agent accepted the task".
        return { state: 'started', detail: `auto-started via '${this.command}'` };
      } catch (err) {
        if (err instanceof Error && err.name === 'CredentialInPassthroughError') {
          // Fail closed loudly: do not silently fall back with a leaked env.
          return { state: 'failed', detail: err.message };
        }
        // Swallowed on purpose: activation failure must never break the
        // Driver. Fall through to the manual notice below.
      }
    }
    const manual = await this.manual.notify(dispatch, workspaceRoot);
    return manual;
  }

  /** A detached one-shot launch cannot be cancelled: explicit, not silent. */
  async cancel(_dispatchId: string): Promise<CancelResult> {
    return {
      state: 'unsupported',
      detail:
        'detached one-shot launch has no cancellation handle; instruct the running ' +
        'agent session to stop and revoke the dispatch instead',
    };
  }
}
