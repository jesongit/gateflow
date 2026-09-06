import { describe, expect, it, vi } from 'vitest';
import { ManualActivationAdapter } from '../../src/activation/manual';
import { ZCodeActivationAdapter } from '../../src/activation/zcode';
import type { ActivationDispatch } from '../../src/activation/types';

// Nonexistent on every platform, so win32 (`where`) and POSIX (`which`) behave the same.
const BAD_CMD = 'definitely-not-a-real-cmd-xyz';
// `node` must be on PATH for vitest itself to run, so it is a safe positive probe target.
const GOOD_CMD = 'node';

const DISPATCH: ActivationDispatch = {
  dispatchId: 'gf_r123_i42_consumer_02',
  role: 'consumer',
  issueNumber: 15,
  repository: 'owner/name',
};

function spyManual() {
  const lines: string[] = [];
  const manual = new ManualActivationAdapter({
    out: (line) => {
      lines.push(line);
    },
    bell: () => {},
  });
  return { manual, lines };
}

describe('ZCodeActivationAdapter (capability-based, conservative by default)', () => {
  it('probe() reports unavailable for a command that is not on PATH', async () => {
    const adapter = new ZCodeActivationAdapter({ command: BAD_CMD });
    const caps = await adapter.probe();

    expect(caps.available).toBe(false);
    expect(caps.detail).toContain(BAD_CMD);
    expect(caps.detail).toContain('manual');
  });

  it('defaults to command "zcode" and autoStart false: suggests the exact command instead of spawning', async () => {
    const { manual, lines } = spyManual();
    const suggested: string[] = [];
    const runner = vi.fn(async (_cmd: string, _args: string[]) => {});
    const adapter = new ZCodeActivationAdapter({
      runner,
      manual,
      out: (line) => {
        suggested.push(line);
      },
    });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    // Conservative default: never spawn, only suggest + instruct.
    expect(runner).not.toHaveBeenCalled();
    expect(result).toEqual({ notified: true, detail: 'manual' });

    const suggestion = suggested.join('\n');
    expect(suggestion).toContain('zcode "');
    expect(suggestion).toContain('.gateflow/current.json');
    expect(suggestion).toContain('gf_r123_i42_consumer_02');

    const notice = lines.join('\n');
    expect(notice).toContain('gateflow-agent');
    expect(notice).toContain('.gateflow/current.json');
  });

  it('notify() with autoStart true launches via the runner when the probe passes', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[]) => {});
    const adapter = new ZCodeActivationAdapter({
      command: GOOD_CMD,
      autoStart: true,
      runner,
      manual,
    });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(runner).toHaveBeenCalledTimes(1);
    const [cmd, args] = runner.mock.calls[0] as [string, string[]];
    expect(cmd).toBe(GOOD_CMD);
    expect(args).toHaveLength(1);
    expect(args[0]).toContain('.gateflow/current.json');
    expect(args[0]).toContain('gateflow-agent');
    expect(result.notified).toBe(true);
    expect(result.detail).toContain('auto-started');
    expect(lines).toHaveLength(0);
  });

  it('notify() never throws when the runner rejects — falls back to the manual notice', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[]) => {
      throw new Error('spawn failed');
    });
    const adapter = new ZCodeActivationAdapter({
      command: GOOD_CMD,
      autoStart: true,
      runner,
      manual,
    });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(result).toEqual({ notified: true, detail: 'manual' });
    expect(lines.join('\n')).toContain('gf_r123_i42_consumer_02');
  });

  it('cancel() is a trivial no-op that resolves', async () => {
    const adapter = new ZCodeActivationAdapter({ command: BAD_CMD });

    await expect(adapter.cancel?.('gf_r123_i42_consumer_02')).resolves.toBeUndefined();
  });
});
