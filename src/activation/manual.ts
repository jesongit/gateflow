import type {
  ActivationAdapter,
  ActivationCapabilities,
  ActivationDispatch,
  ActivationResult,
  CancelResult,
} from './types';

/**
 * ManualActivationAdapter — a FIRST-CLASS activation path, not a fallback hack
 * (frozen principle, plan §18).
 *
 * The loop it implements is the backbone of the Workspace architecture:
 *
 *   Driver prepares dispatch → OS/CLI notice → human opens the project in
 *   ChatGPT/ZCode → agent loads the gateflow-agent skill → agent reads the
 *   EXACT `.gateflow/inbox/<dispatch-id>/dispatch.json` → agent starts working.
 *
 * As long as this loop closes, the architecture holds; automatic launch
 * adapters are merely optimizations on top of it.
 */
export interface ManualActivationAdapterOptions {
  /** Sink for notice lines (called once per line). Defaults to process.stdout. */
  out?: (line: string) => void;
  /** Terminal bell hook. Defaults to writing `\x07` to stdout, best-effort. */
  bell?: () => void;
}

export class ManualActivationAdapter implements ActivationAdapter {
  readonly name = 'manual';

  private readonly out: (line: string) => void;
  private readonly bell: () => void;

  constructor(options: ManualActivationAdapterOptions = {}) {
    this.out = options.out ?? ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
    this.bell = options.bell ?? (() => {
      try {
        process.stdout.write('\x07');
      } catch {
        // Best-effort by design: a bell must never break activation.
      }
    });
  }

  /** A human is the most reliable activation mechanism there is. */
  async probe(): Promise<ActivationCapabilities> {
    return { available: true, detail: 'human activation — always available' };
  }

  async notify(dispatch: ActivationDispatch, workspaceRoot: string): Promise<ActivationResult> {
    const lines = [
      '============================================================',
      'GateFlow: dispatch ready — human activation required',
      '------------------------------------------------------------',
      `Dispatch   : ${dispatch.dispatchId}`,
      `Role       : ${dispatch.role}`,
      `Issue      : #${dispatch.issueNumber}`,
      `Repository : ${dispatch.repository}`,
      `Workspace  : ${workspaceRoot}`,
      '------------------------------------------------------------',
      'Steps:',
      '  1. Open the project in ChatGPT / ZCode.',
      '  2. Tell the agent to load the gateflow-agent skill.',
      `  3. The agent reads exactly ${workspaceRoot}/.gateflow/inbox/${dispatch.dispatchId}/dispatch.json`,
      '     and processes ONLY that dispatch (never .gateflow/current.json —',
      '     that file is a manual UI pointer, not task identity).',
      '============================================================',
    ];
    for (const line of lines) {
      this.out(line);
    }
    this.bell();
    return { state: 'notified', detail: 'manual' };
  }

  /**
   * There is no session handle to cancel: the human activated the client.
   * The answer is explicit (hardening §9) — cancel support is `unsupported`,
   * and stopping the agent is a human/Skill-level action.
   */
  async cancel(_dispatchId: string): Promise<CancelResult> {
    return {
      state: 'unsupported',
      detail:
        'manual activation has no session handle; ask the running agent to stop and let ' +
        'the Driver refuse the dispatch\'s outbox (revocation happens at sync time)',
    };
  }
}
