import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runReleaseE2E } from '../../scripts/e2e-release.mjs';
import { cleanup } from '../../scripts/e2e/lifecycle.mjs';

const REPOSITORY = 'jesongit/gateflow-release-e2e-cleanup-test';
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;

async function makeContext({ keep = false } = {}) {
  const clone = await mkdtemp(join(tmpdir(), 'gateflow-cleanup-test-'));
  return {
    root: process.cwd(),
    options: { keep, timeoutMs: 5_000 },
    prepareAgentResult: null,
    repository: { fullName: REPOSITORY },
    paths: { clone },
    cleanup: { remoteCreated: true, completed: false },
    log: vi.fn(),
    error: vi.fn(),
    gh: { run: vi.fn() },
  };
}

describe('release E2E cleanup', () => {
  it('keeps the remote repository and resolves when successful deletion lacks delete_repo scope', async () => {
    const context = await makeContext();
    context.gh.run.mockRejectedValue(new Error('delete_repo scope is required'));
    try {
      await expect(cleanup(context, { success: true })).resolves.toEqual({ preserved: true, errors: [] });

      expect(context.error).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('WARNING: 仓库保留、请手动删除'),
      );
      expect(context.error).toHaveBeenNthCalledWith(1, expect.stringContaining(REPOSITORY_URL));
      expect(context.error).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('remote cleanup failed: delete_repo scope is required'),
      );
      expect(context.cleanup.completed).toBe(true);
      await expect(access(context.paths.clone)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(context.paths.clone, { recursive: true, force: true });
    }
  });

  it('retains failure artifacts without attempting remote deletion', async () => {
    const context = await makeContext();
    try {
      await expect(cleanup(context, { success: false })).resolves.toEqual({ preserved: true, errors: [] });

      expect(context.gh.run).not.toHaveBeenCalled();
      expect(context.log).toHaveBeenCalledWith(expect.stringContaining('retaining failure artifacts'));
      await expect(access(context.paths.clone)).resolves.toBeUndefined();
    } finally {
      await rm(context.paths.clone, { recursive: true, force: true });
    }
  });

  it('does not change --keep behavior', async () => {
    const context = await makeContext({ keep: true });
    try {
      await expect(cleanup(context, { success: true })).resolves.toEqual({ preserved: true, errors: [] });

      expect(context.gh.run).not.toHaveBeenCalled();
      expect(context.log).toHaveBeenCalledWith(expect.stringContaining('retaining success artifacts'));
      await expect(access(context.paths.clone)).resolves.toBeUndefined();
    } finally {
      await rm(context.paths.clone, { recursive: true, force: true });
    }
  });

  it('still rejects when a release stage fails', async () => {
    const stageError = new Error('local gate failed');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const gh = {
      run: vi.fn(async (args) => ({
        stdout: args[0] === '--version' ? 'gh version 2.0.0\n' : '',
        stderr: '',
      })),
      text: vi.fn(async (args) => args[0] === 'api' ? 'jesongit' : 'test-token'),
    };
    const runProcess = vi.fn(async (program, args) => {
      if (program === 'git' && args[0] === 'rev-parse') return { stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      if (program === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
      if (program === npm && args[0] === 'run' && args[1] === 'typecheck') throw stageError;
      return { stdout: '', stderr: '' };
    });

    await expect(runReleaseE2E([], {
      root: process.cwd(),
      gh,
      runProcess,
      log: vi.fn(),
      error: vi.fn(),
    })).rejects.toThrow('local gate failed');
  });
});
