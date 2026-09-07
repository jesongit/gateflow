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

/** The EXACT inbox path the launch prompt must name (hardening §9). */
const INBOX_PATH = 'D:/code/demo/.gateflow/inbox/gf_r123_i42_executor_p99/dispatch.json';

/**
 * Driver environment stand-in: PATH survives the allowlist build, while the
 * Driver's GitHub token (and any other non-allowlisted key) must never reach
 * the spawned agent environment.
 */
const DRIVER_ENV: Record<string, string> = {
  PATH: '/usr/local/bin',
  GITHUB_TOKEN: 'ghs_driver_super_secret',
  MY_TOOL_VAR: 'custom-value',
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
    const runner = vi.fn(async (_cmd: string, _args: string[], _env: Record<string, string>) => {});
    const adapter = new ChatGPTActivationAdapter({ command: GOOD_CMD, runner, manual });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(runner).not.toHaveBeenCalled();
    expect(result).toEqual({ state: 'notified', detail: 'manual' });
    const notice = lines.join('\n');
    expect(notice).toContain('gf_r123_i42_executor_p99');
    expect(notice).toContain('gateflow-agent');
    expect(notice).toContain(INBOX_PATH);
    expect(notice).toContain('never .gateflow/current.json');
  });

  it('notify() with autoStart true launches with the EXPLICIT allowlist env and the exact inbox path', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[], _env: Record<string, string>) => {});
    const adapter = new ChatGPTActivationAdapter({
      command: GOOD_CMD,
      autoStart: true,
      runner,
      manual,
      envSource: DRIVER_ENV,
    });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(runner).toHaveBeenCalledTimes(1);
    const [cmd, args, env] = runner.mock.calls[0] as [string, string[], Record<string, string>];
    expect(cmd).toBe(GOOD_CMD);
    expect(args).toHaveLength(1);
    // Hardening §9: the prompt names the exact dispatch, never current.json.
    expect(args[0]).toContain(INBOX_PATH);
    expect(args[0]).not.toContain('current.json');
    expect(args[0]).toContain('gateflow-agent');
    expect(args[0]).toContain('gf_r123_i42_executor_p99');
    // Hardening §8: the child env is the allowlist build, never process.env —
    // the Driver's GitHub token and unrelated keys are stripped.
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['MY_TOOL_VAR']).toBeUndefined();
    expect(env['PATH']).toBe(DRIVER_ENV['PATH']);
    expect(result.state).toBe('started');
    expect(result.detail).toContain('auto-started');
    expect(lines).toHaveLength(0);
  });

  it('env_passthrough copies requested keys into the child env but never secret-shaped ones', async () => {
    const runner = vi.fn(async (_cmd: string, _args: string[], _env: Record<string, string>) => {});
    const adapter = new ChatGPTActivationAdapter({
      command: GOOD_CMD,
      autoStart: true,
      runner,
      envSource: DRIVER_ENV,
      envPassthrough: ['MY_TOOL_VAR'],
    });

    await adapter.notify(DISPATCH, 'D:/code/demo');

    const env = runner.mock.calls[0]?.[2] as Record<string, string>;
    expect(env['MY_TOOL_VAR']).toBe('custom-value');
    expect(env['GITHUB_TOKEN']).toBeUndefined(); // denylist always wins
  });

  it('a credential-shaped env_passthrough request fails closed: state "failed", nothing spawned', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[], _env: Record<string, string>) => {});
    const adapter = new ChatGPTActivationAdapter({
      command: GOOD_CMD,
      autoStart: true,
      runner,
      manual,
      envSource: DRIVER_ENV,
      envPassthrough: ['GITHUB_TOKEN'],
    });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    // Fail closed loudly: no spawn, no silent fallback with a leaked env.
    expect(result.state).toBe('failed');
    expect(result.detail).toContain('GITHUB_TOKEN');
    expect(runner).not.toHaveBeenCalled();
    expect(lines).toHaveLength(0);
  });

  it('notify() with autoStart true falls back to manual when the probe fails', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[], _env: Record<string, string>) => {});
    const adapter = new ChatGPTActivationAdapter({
      command: BAD_CMD,
      autoStart: true,
      runner,
      manual,
    });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(runner).not.toHaveBeenCalled();
    expect(result).toEqual({ state: 'notified', detail: 'manual' });
    expect(lines.join('\n')).toContain('gf_r123_i42_executor_p99');
  });

  it('notify() never throws when the runner rejects — falls back to the manual notice', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[], _env: Record<string, string>) => {
      throw new Error('spawn failed');
    });
    const adapter = new ChatGPTActivationAdapter({
      command: GOOD_CMD,
      autoStart: true,
      runner,
      manual,
    });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(result).toEqual({ state: 'notified', detail: 'manual' });
    expect(lines.join('\n')).toContain('gateflow-agent');
  });

  it('cancel() answers explicitly: a detached one-shot launch is unsupported', async () => {
    const adapter = new ChatGPTActivationAdapter({ command: BAD_CMD });

    const result = await adapter.cancel('gf_r123_i42_executor_p99');

    expect(result.state).toBe('unsupported');
    expect(result.detail.length).toBeGreaterThan(0);
  });
});
