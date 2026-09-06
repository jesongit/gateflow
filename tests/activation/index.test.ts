import { describe, expect, it } from 'vitest';
import {
  createActivationAdapter,
  resolveAdapterForAgent,
  toActivationDispatch,
} from '../../src/activation';
import { ChatGPTActivationAdapter } from '../../src/activation/chatgpt';
import { ManualActivationAdapter } from '../../src/activation/manual';
import { ZCodeActivationAdapter } from '../../src/activation/zcode';
import type { ActivationAgentConfig, ActivationKind } from '../../src/activation/types';

// Nonexistent on every platform, so win32 (`where`) and POSIX (`which`) behave the same.
const BAD_CMD = 'definitely-not-a-real-cmd-xyz';

const AGENTS: Record<string, ActivationAgentConfig> = {
  'chatgpt-main': { activation: 'chatgpt' },
  'zcode-main': { activation: 'zcode' },
};

describe('createActivationAdapter (factory)', () => {
  it('builds the matching adapter per kind', () => {
    expect(createActivationAdapter('manual')).toBeInstanceOf(ManualActivationAdapter);
    expect(createActivationAdapter('chatgpt')).toBeInstanceOf(ChatGPTActivationAdapter);
    expect(createActivationAdapter('zcode')).toBeInstanceOf(ZCodeActivationAdapter);
  });

  it('never throws for an unknown kind — manual is the safe default', () => {
    const adapter = createActivationAdapter('nonsense' as ActivationKind);
    expect(adapter).toBeInstanceOf(ManualActivationAdapter);
    expect(adapter.name).toBe('manual');
  });

  it('passes command/autoStart options through to the adapter', async () => {
    const adapter = createActivationAdapter('chatgpt', {
      activation: 'chatgpt',
      command: BAD_CMD,
      autoStart: true,
    });

    expect(adapter).toBeInstanceOf(ChatGPTActivationAdapter);
    // The bad command flows into the capability probe.
    await expect(adapter.probe()).resolves.toMatchObject({ available: false });
  });
});

describe('resolveAdapterForAgent (role → agent → activation, with fallback)', () => {
  it('resolves a known agent to its configured adapter', () => {
    expect(resolveAdapterForAgent('chatgpt-main', AGENTS, 'manual').name).toBe('chatgpt');
    expect(resolveAdapterForAgent('zcode-main', AGENTS, 'manual').name).toBe('zcode');
  });

  it('falls back for a missing agent config', () => {
    expect(resolveAdapterForAgent('nobody', AGENTS, 'manual').name).toBe('manual');
    expect(resolveAdapterForAgent('nobody', AGENTS, 'chatgpt').name).toBe('chatgpt');
  });

  it('falls back when the agents record is missing entirely', () => {
    expect(resolveAdapterForAgent('chatgpt-main', undefined, 'manual').name).toBe('manual');
    expect(resolveAdapterForAgent('chatgpt-main', undefined).name).toBe('manual');
  });

  it('falls back for an unknown activation kind at runtime (never throws)', () => {
    const agents: Record<string, ActivationAgentConfig> = {
      broken: { activation: 'telepathy' as ActivationKind },
    };
    expect(resolveAdapterForAgent('broken', agents, 'manual').name).toBe('manual');
    expect(resolveAdapterForAgent('broken', agents, 'zcode').name).toBe('zcode');
  });

  it('defaults to manual even when the fallback itself is garbage', () => {
    const adapter = resolveAdapterForAgent('nobody', undefined, 'carrier-pigeon' as ActivationKind);
    expect(adapter).toBeInstanceOf(ManualActivationAdapter);
  });
});

describe('toActivationDispatch (snake_case protocol → camelCase structural type)', () => {
  it('maps the workspace protocol Dispatch fields', () => {
    const dispatch = toActivationDispatch({
      dispatch_id: 'gf_r123_i42_consumer_01',
      role: 'consumer',
      issue_number: 42,
      repository: 'owner/name',
    });

    expect(dispatch).toEqual({
      dispatchId: 'gf_r123_i42_consumer_01',
      role: 'consumer',
      issueNumber: 42,
      repository: 'owner/name',
    });
  });

  it('keeps the executor role as-is', () => {
    const dispatch = toActivationDispatch({
      dispatch_id: 'gf_r123_i42_executor_p3472198451',
      role: 'executor',
      issue_number: 42,
      repository: 'owner/name',
    });

    expect(dispatch.role).toBe('executor');
    expect(dispatch.dispatchId).toBe('gf_r123_i42_executor_p3472198451');
  });
});
