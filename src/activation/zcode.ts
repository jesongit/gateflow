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
 * FROZEN PRINCIPLE (plan §20): capability-based, same as the ChatGPT adapter.
 * NO scheduled AI polling ("scheduled task → start AI → AI checks GitHub" is
 * explicitly forbidden — discovery already belongs to the Driver). The ZCode
 * adapter only answers: "the task is known to exist — how do we wake ZCode?".
 */
export interface ZCodeActivationAdapterOptions {
  /** Executable to probe/launch. Defaults to 'zcode'. */
  command?: string;
  /**
   * WHY autoStart DEFAULTS TO FALSE: desktop-app sessions are user-owned.
   * ZCode runs inside the user's editor/app; a background Driver silently
   * launching processes would hijack a workspace the human owns. By default
   * the adapter only SUGGESTS the exact runnable command; the human decides.
   * Auto-launch must be an explicit opt-in via `autoStart: true`.
   */
  autoStart?: boolean;
  /**
   * Injectable launch primitive (default wraps `execFile`, detached + unref +
   * stdio 'ignore') so tests never spawn anything real.
   */
  runner?: (cmd: string, args: string[]) => Promise<void>;
  /** Sink for the suggested-command line. Defaults to process.stdout. */
  out?: (line: string) => void;
  /** Injected manual delegate used for every fallback notice. */
  manual?: ManualActivationAdapter;
}

/**
 * Shell-free `which`-like capability check (same contract as the ChatGPT
 * adapter; kept local because the frozen `src/activation/` layout has no
 * shared-helper module).
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
 * Default detached launcher; rejection reports spawn failure so `notify()`
 * can fall back to manual. Resolves as soon as the OS accepted the spawn.
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

export class ZCodeActivationAdapter implements ActivationAdapter {
  readonly name = 'zcode';

  private readonly command: string;
  private readonly autoStart: boolean;
  private readonly runner: (cmd: string, args: string[]) => Promise<void>;
  private readonly out: (line: string) => void;
  private readonly manual: ManualActivationAdapter;

  constructor(options: ZCodeActivationAdapterOptions = {}) {
    this.command = options.command ?? 'zcode';
    this.autoStart = options.autoStart === true;
    this.runner = options.runner ?? defaultRunner;
    this.out = options.out ?? ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
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
   * Conservative by default (`autoStart` defaults to false, see the options
   * docs): without opt-in we print the exact command the human can run plus
   * the manual instructions, and never spawn anything. With opt-in we mirror
   * the ChatGPT adapter: spawn only when the probe passes; ANY failure falls
   * back to the injected ManualActivationAdapter. NEVER throws.
   */
  async notify(dispatch: ActivationDispatch, workspaceRoot: string): Promise<ActivationResult> {
    if (this.autoStart !== true) {
      const prompt = buildLaunchPrompt(dispatch, workspaceRoot);
      this.out(`GateFlow suggests (run it yourself to activate): ${this.command} "${prompt}"`);
      return this.manual.notify(dispatch, workspaceRoot);
    }
    try {
      if ((await this.probe()).available) {
        await this.runner(this.command, [buildLaunchPrompt(dispatch, workspaceRoot)]);
        return { notified: true, detail: `auto-started via '${this.command}'` };
      }
    } catch {
      // Swallowed on purpose: activation failure must never break the Driver.
    }
    return this.manual.notify(dispatch, workspaceRoot);
  }

  /** Trivial no-op: a detached one-shot launch cannot be cancelled remotely. */
  async cancel(_dispatchId: string): Promise<void> {
    /* intentional no-op */
  }
}
