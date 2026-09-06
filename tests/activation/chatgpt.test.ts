import { describe, expect, it, vi } from 'vitest';
import { ChatGPTActivationAdapter } from '../../src/activation/chatgpt';
import { ManualActivationAdapter } from '../../src/activation/manual';
import type { ActivationDispatch } from '../../src/activation/types';

// Nonexistent on every platform, so win32 (`where`) and POSIX (`which`) behave the same.
const BAD_CMD = 'definitely-not-a-real-cmd-xyz';
// `node` must be on PATH for vitest itself to run, so it is a safe positive probe target.
const GOOD_CMD = 'node';

const DISPATCH: ActivationDispatch = {
  dispatchId: 'gf_r123_i42_executor_p99',
  role: 'executor',
  issueNumber: 7,
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

describe('ChatGPTActivationAdapter (capability-based)', () => {
  it('probe() reports unavailable for a command that is not on PATH', async () => {
    const adapter = new ChatGPTActivationAdapter({ command: BAD_CMD });
    const caps = await adapter.probe();

    expect(caps.available).toBe(false);
    expect(caps.detail).toContain(BAD_CMD);
    expect(caps.detail).toContain('manual');
  });

  it('probe() reports available when the command exists on PATH', async () => {
    const adapter = new ChatGPTActivationAdapter({ command: GOOD_CMD });
    const caps = await adapter.probe();

    expect(caps.available).toBe(true);
    expect(caps.detail).toContain(GOOD_CMD);
  });

  it('notify() with autoStart unset never spawns and delegates to manual', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[]) => {});
    const adapter = new ChatGPTActivationAdapter({ command: GOOD_CMD, runner, manual });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(runner).not.toHaveBeenCalled();
    expect(result).toEqual({ notified: true, detail: 'manual' });
    const notice = lines.join('\n');
    expect(notice).toContain('gf_r123_i42_executor_p99');
    expect(notice).toContain('gateflow-agent');
    expect(notice).toContain('.gateflow/current.json');
  });

  it('notify() with autoStart true launches via the configured command and mentions current.json', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[]) => {});
    const adapter = new ChatGPTActivationAdapter({
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
    expect(args[0]).toContain('gf_r123_i42_executor_p99');
    expect(result.notified).toBe(true);
    expect(result.detail).toContain('auto-started');
    expect(lines).toHaveLength(0);
  });

  it('notify() with autoStart true falls back to manual when the probe fails', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[]) => {});
    const adapter = new ChatGPTActivationAdapter({
      command: BAD_CMD,
      autoStart: true,
      runner,
      manual,
    });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(runner).not.toHaveBeenCalled();
    expect(result).toEqual({ notified: true, detail: 'manual' });
    expect(lines.join('\n')).toContain('gf_r123_i42_executor_p99');
  });

  it('notify() never throws when the runner rejects — falls back to the manual notice', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[]) => {
      throw new Error('spawn failed');
    });
    const adapter = new ChatGPTActivationAdapter({
      command: GOOD_CMD,
      autoStart: true,
      runner,
      manual,
    });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(result).toEqual({ notified: true, detail: 'manual' });
    expect(lines.join('\n')).toContain('gateflow-agent');
  });

  it('cancel() is a trivial no-op that resolves', async () => {
    const adapter = new ChatGPTActivationAdapter({ command: BAD_CMD });

    await expect(adapter.cancel?.('gf_r123_i42_executor_p99')).resolves.toBeUndefined();
  });
});
