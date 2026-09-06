import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ManualActivationAdapter } from './manual';
import type {
  ActivationAdapter,
  ActivationCapabilities,
  ActivationDispatch,
  ActivationResult,
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
   * Injectable launch primitive (default wraps `execFile`, detached + unref +
   * stdio 'ignore') so tests never spawn anything real.
   */
  runner?: (cmd: string, args: string[]) => Promise<void>;
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

/** One-line prompt handed to the client CLI (also shown to humans). */
function buildLaunchPrompt(dispatch: ActivationDispatch, workspaceRoot: string): string {
  return (
    `GateFlow dispatch ${dispatch.dispatchId} is ready ` +
    `(issue #${dispatch.issueNumber}, role ${dispatch.role}, repo ${dispatch.repository}). ` +
    `Load the gateflow-agent skill, then read .gateflow/current.json under ` +
    `${workspaceRoot} and process the dispatch.`
  );
}

/**
 * Default detached launcher: resolve failure of the `runner` contract is
 * reported via rejection so `notify()` can fall back to manual. Resolves as
 * soon as the OS accepted the spawn — the client lifecycle is not our concern.
 *
 * Implementation note: `spawn` (never a shell — `shell` defaults to false)
 * is used because `stdio: 'ignore'` is required for a true fire-and-forget
 * launch (no pipe can fill up and block the client); `detached: true` +
 * `unref()` let the client outlive the Driver process.
 */
function defaultRunner(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
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
  private readonly runner: (cmd: string, args: string[]) => Promise<void>;
  private readonly manual: ManualActivationAdapter;

  constructor(options: ChatGPTActivationAdapterOptions = {}) {
    this.command = options.command ?? 'chatgpt';
    this.autoStart = options.autoStart === true;
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
   * capability probe passes. Every other path — and any failure at all —
   * delegates to the injected ManualActivationAdapter. NEVER throws.
   */
  async notify(dispatch: ActivationDispatch, workspaceRoot: string): Promise<ActivationResult> {
    try {
      if (this.autoStart === true && (await this.probe()).available) {
        await this.runner(this.command, [buildLaunchPrompt(dispatch, workspaceRoot)]);
        return { notified: true, detail: `auto-started via '${this.command}'` };
      }
    } catch {
      // Swallowed on purpose: activation failure must never break the Driver.
      // Fall through to the manual notice below.
    }
    return this.manual.notify(dispatch, workspaceRoot);
  }

  /** Trivial no-op: a detached one-shot launch cannot be cancelled remotely. */
  async cancel(_dispatchId: string): Promise<void> {
    /* intentional no-op */
  }
}
