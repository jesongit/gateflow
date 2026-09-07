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

/** The EXACT inbox path the launch prompt must name (hardening §9). */
const INBOX_PATH = 'D:/code/demo/.gateflow/inbox/gf_r123_i42_consumer_02/dispatch.json';

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
    const runner = vi.fn(async (_cmd: string, _args: string[], _env: Record<string, string>) => {});
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
    expect(result).toEqual({ state: 'notified', detail: 'manual' });

    const suggestion = suggested.join('\n');
    expect(suggestion).toContain('zcode "');
    // Hardening §9: the suggestion names the exact dispatch inbox path.
    expect(suggestion).toContain(INBOX_PATH);
    expect(suggestion).toContain('gf_r123_i42_consumer_02');

    const notice = lines.join('\n');
    expect(notice).toContain('gateflow-agent');
    expect(notice).toContain(INBOX_PATH);
  });

  it('notify() with autoStart true launches with the EXPLICIT allowlist env and the exact inbox path', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[], _env: Record<string, string>) => {});
    const adapter = new ZCodeActivationAdapter({
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
    expect(args[0]).toContain(INBOX_PATH);
    expect(args[0]).not.toContain('current.json');
    expect(args[0]).toContain('gateflow-agent');
    // Hardening §8: the child env is the allowlist build — no driver secrets.
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['MY_TOOL_VAR']).toBeUndefined();
    expect(env['PATH']).toBe(DRIVER_ENV['PATH']);
    expect(result.state).toBe('started');
    expect(result.detail).toContain('auto-started');
    expect(lines).toHaveLength(0);
  });

  it('a credential-shaped env_passthrough request fails closed: state "failed", nothing spawned', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[], _env: Record<string, string>) => {});
    const adapter = new ZCodeActivationAdapter({
      command: GOOD_CMD,
      autoStart: true,
      runner,
      manual,
      envSource: DRIVER_ENV,
      envPassthrough: ['GITHUB_TOKEN'],
    });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(result.state).toBe('failed');
    expect(result.detail).toContain('GITHUB_TOKEN');
    expect(runner).not.toHaveBeenCalled();
    expect(lines).toHaveLength(0);
  });

  it('notify() never throws when the runner rejects — falls back to the manual notice', async () => {
    const { manual, lines } = spyManual();
    const runner = vi.fn(async (_cmd: string, _args: string[], _env: Record<string, string>) => {
      throw new Error('spawn failed');
    });
    const adapter = new ZCodeActivationAdapter({
      command: GOOD_CMD,
      autoStart: true,
      runner,
      manual,
    });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(result).toEqual({ state: 'notified', detail: 'manual' });
    expect(lines.join('\n')).toContain('gf_r123_i42_consumer_02');
  });

  it('cancel() answers explicitly: a detached one-shot launch is unsupported', async () => {
    const adapter = new ZCodeActivationAdapter({ command: BAD_CMD });

    const result = await adapter.cancel('gf_r123_i42_consumer_02');

    expect(result.state).toBe('unsupported');
    expect(result.detail.length).toBeGreaterThan(0);
  });
});
