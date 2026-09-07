/**
 * Hardening tests — agent environment isolation (docs/plans/
 * v1_hardening_decisions.md §8, hardening Phase 6.2 / GF-H10 credential fix):
 * the spawned client environment is an allowlist product; secret-shaped keys
 * are stripped even when explicitly requested (fail closed).
 */
import { describe, expect, it } from 'vitest';

import { buildAgentEnv, CredentialInPassthroughError } from '../../src/activation/env';

const SOURCE: Record<string, string | undefined> = {
  PATH: '/usr/bin',
  HOME: '/home/octo',
  TEMP: '/tmp',
  GITHUB_TOKEN: 'ghp_supersecret',
  GH_TOKEN: 'also-secret',
  GATEFLOW_WEBHOOK_SECRET: 'webhook-secret',
  CUSTOM_CLIENT_VAR: 'needed-by-client',
};

describe('buildAgentEnv', () => {
  it('copies base-allowlisted keys and drops everything else by default', () => {
    const env = buildAgentEnv([], SOURCE);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/octo');
    expect(env.TEMP).toBe('/tmp');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CUSTOM_CLIENT_VAR).toBeUndefined();
  });

  it('copies configured passthrough keys that are present', () => {
    const env = buildAgentEnv(['CUSTOM_CLIENT_VAR'], SOURCE);
    expect(env.CUSTOM_CLIENT_VAR).toBe('needed-by-client');
  });

  it('NEVER copies secret keys — even when passthrough requests them — and fails closed instead', () => {
    expect(() => buildAgentEnv(['GITHUB_TOKEN'], SOURCE)).toThrow(CredentialInPassthroughError);
    expect(() => buildAgentEnv(['gh_token'], SOURCE)).toThrow(CredentialInPassthroughError); // case-insensitive
    expect(() => buildAgentEnv(['GATEFLOW_WEBHOOK_SECRET'], SOURCE)).toThrow(CredentialInPassthroughError);
  });

  it('denies secret keys from the source even with broad passthrough', () => {
    const env = buildAgentEnv(['PATH', 'HOME', 'CUSTOM_CLIENT_VAR'], SOURCE);
    expect(Object.values(env)).not.toContain('ghp_supersecret');
    expect(Object.values(env)).not.toContain('webhook-secret');
  });

  it('prefers explicit evidence of absence: missing keys stay missing', () => {
    const env = buildAgentEnv(['DISPLAY', 'CUSTOM_CLIENT_VAR'], SOURCE);
    expect(env.DISPLAY).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(['CUSTOM_CLIENT_VAR', 'HOME', 'PATH', 'TEMP']);
  });
});
