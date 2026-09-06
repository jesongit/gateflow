/**
 * Config loading/resolution tests (src/driver/config.ts, docs §10): missing
 * file → defaults, version pinning, strict types, repository resolution
 * order config → env → git remote.
 */
import { describe, expect, it } from 'vitest';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { ConfigError, defaultConfig, loadConfig, parseGitRemoteRepository, resolveRepository } from '../../src/driver/config';

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'gateflow-cfg-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('loadConfig', () => {
  it('missing file → all §10 defaults', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const config = await loadConfig(root);
      expect(config).toEqual(defaultConfig());
      expect(config.driver).toEqual({
        pollIntervalSeconds: 30,
        workspaceDir: '.gateflow',
        progressSyncSeconds: 60,
        maxAttempts: 3,
      });
      expect(config.activation.fallback).toBe('manual');
      expect(config.routing).toEqual({});
    } finally {
      await cleanup();
    }
  });

  it('parses a full config and maps snake_case keys', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      await writeFile(
        nodePath.join(root, 'gateflow.config.yml'),
        [
          'version: 1',
          "repository: octo/example",
          'driver:',
          '  poll_interval_seconds: 15',
          '  workspace_dir: .gateflow-custom',
          '  progress_sync_seconds: 45',
          '  max_attempts: 5',
          'trusted_humans:',
          '  - alice',
          '  - bob',
          'routing:',
          '  consumer: chatgpt-main',
          '  executor: zcode-main',
          'agents:',
          '  chatgpt-main: { activation: chatgpt }',
          '  zcode-main: { activation: zcode, autoStart: true, command: zcode }',
          'activation:',
          '  fallback: manual',
          'totally_unknown_key: 42', // ignored, docs §10
        ].join('\n'),
        'utf8',
      );
      const config = await loadConfig(root);
      expect(config.repository).toBe('octo/example');
      expect(config.driver).toEqual({
        pollIntervalSeconds: 15,
        workspaceDir: '.gateflow-custom',
        progressSyncSeconds: 45,
        maxAttempts: 5,
      });
      expect(config.trustedHumans).toEqual(['alice', 'bob']);
      expect(config.routing).toEqual({ consumer: 'chatgpt-main', executor: 'zcode-main' });
      expect(config.agents['chatgpt-main']).toEqual({ activation: 'chatgpt' });
      expect(config.agents['zcode-main']).toEqual({ activation: 'zcode', autoStart: true, command: 'zcode' });
      expect(config.activation).toEqual({ fallback: 'manual' });
    } finally {
      await cleanup();
    }
  });

  it('missing sections fall back to their defaults', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      await writeFile(nodePath.join(root, 'gateflow.config.yml'), 'version: 1\n', 'utf8');
      const config = await loadConfig(root);
      expect(config).toEqual(defaultConfig());
    } finally {
      await cleanup();
    }
  });

  it('unknown/unsupported version → ConfigError', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      await writeFile(nodePath.join(root, 'gateflow.config.yml'), 'version: 2\n', 'utf8');
      await expect(loadConfig(root)).rejects.toThrow(ConfigError);
      await expect(loadConfig(root)).rejects.toThrow(/version/);
    } finally {
      await cleanup();
    }
  });

  it('missing version → ConfigError', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      await writeFile(nodePath.join(root, 'gateflow.config.yml'), 'repository: octo/example\n', 'utf8');
      await expect(loadConfig(root)).rejects.toThrow(ConfigError);
    } finally {
      await cleanup();
    }
  });

  it('invalid value types → ConfigError with a clear message', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      await writeFile(
        nodePath.join(root, 'gateflow.config.yml'),
        ['version: 1', 'driver:', '  poll_interval_seconds: "soon"', 'trusted_humans: alice'].join('\n'),
        'utf8',
      );
      const err = await loadConfig(root).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/poll_interval_seconds/);
      expect((err as ConfigError).message).toMatch(/trusted_humans/);
    } finally {
      await cleanup();
    }
  });

  it('malformed repository and unknown activation kind → ConfigError', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      await writeFile(
        nodePath.join(root, 'gateflow.config.yml'),
        ['version: 1', 'repository: just-a-name', 'agents:', '  x: { activation: teleport }'].join('\n'),
        'utf8',
      );
      const err = await loadConfig(root).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/repository/);
      expect((err as ConfigError).message).toMatch(/agents\.x\.activation/);
    } finally {
      await cleanup();
    }
  });

  it('invalid YAML syntax → ConfigError', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      await writeFile(nodePath.join(root, 'gateflow.config.yml'), 'version: 1\n\tbad:\n  - [unclosed', 'utf8');
      await expect(loadConfig(root)).rejects.toThrow(ConfigError);
    } finally {
      await cleanup();
    }
  });
});

describe('resolveRepository', () => {
  const configWith = (repository?: string) => ({
    ...defaultConfig(),
    ...(repository !== undefined ? { repository } : {}),
  });

  it('config.repository wins over env and git remote', () => {
    expect(
      resolveRepository(configWith('cfg/repo'), { GATEFLOW_REPOSITORY: 'env/repo' }, 'https://github.com/git/remote.git'),
    ).toBe('cfg/repo');
  });

  it('env GATEFLOW_REPOSITORY is the second fallback', () => {
    expect(resolveRepository(configWith(), { GATEFLOW_REPOSITORY: 'env/repo' }, null)).toBe('env/repo');
  });

  it('parses https GitHub remotes (with/without .git, trailing slash)', () => {
    expect(resolveRepository(configWith(), {}, 'https://github.com/octo/hello.git')).toBe('octo/hello');
    expect(resolveRepository(configWith(), {}, 'https://github.com/octo/hello')).toBe('octo/hello');
    expect(resolveRepository(configWith(), {}, 'http://github.com/octo/hello/')).toBe('octo/hello');
  });

  it('parses git@ SSH remotes', () => {
    expect(resolveRepository(configWith(), {}, 'git@github.com:octo/hello.git')).toBe('octo/hello');
  });

  it('URL shape matters, host does not; junk yields null', () => {
    // Same GitHub URL shape on another host still parses (host-agnostic).
    expect(parseGitRemoteRepository('https://gitlab.com/octo/hello.git')).toBe('octo/hello');
    expect(parseGitRemoteRepository('notaurl')).toBeNull();
    expect(parseGitRemoteRepository('')).toBeNull();
    expect(parseGitRemoteRepository(null)).toBeNull();
  });

  it('nothing resolvable → ConfigError with actionable message', () => {
    expect(() => resolveRepository(configWith(), {}, null)).toThrow(ConfigError);
    expect(() => resolveRepository(configWith(), {}, null)).toThrow(/GATEFLOW_REPOSITORY|repository/);
  });

  it('a malformed slug from env → ConfigError', () => {
    expect(() => resolveRepository(configWith(), { GATEFLOW_REPOSITORY: 'no-slash' }, null)).toThrow(/owner\/name/);
  });
});
