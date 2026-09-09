import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  acquireExecutorLock,
  acquireLock,
  EXECUTOR_LOCK_HOLDER,
  executorLockFile,
  releaseExecutorLock,
  releaseLock,
  DRIVER_LOCK_HOLDER,
} from '../../src/driver/workspace-lock';
import { makeWorkspace } from './helpers';

const NOW = () => new Date('2026-09-09T00:00:00.000Z');
const EXECUTE_TASK = 'gf_r123_i7_w000000000001_execute_p42';
const PLAN_TASK = 'gf_r123_i7_w000000000001_plan_01';

describe('Driver workspace lock', () => {
  it('does not reclaim a live lock merely because its timestamp is old', async () => {
    const fixture = await makeWorkspace();
    try {
      const file = fixture.paths.locks + '/driver.lock';
      await writeFile(
        file,
        JSON.stringify({
          pid: process.pid,
          holder: 'another-driver',
          acquired_at: '2000-01-01T00:00:00.000Z',
        }),
        'utf8',
      );

      const result = await acquireLock(file, DRIVER_LOCK_HOLDER, NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.holder?.pid).toBe(process.pid);
      expect(JSON.parse(await readFile(file, 'utf8')).holder).toBe('another-driver');
    } finally {
      await fixture.cleanup();
    }
  });

  it('recovers a lock whose valid holder process is dead', async () => {
    const fixture = await makeWorkspace();
    try {
      const file = fixture.paths.locks + '/driver.lock';
      await writeFile(
        file,
        JSON.stringify({
          pid: 999999999,
          holder: 'dead-driver',
          acquired_at: '2000-01-01T00:00:00.000Z',
        }),
        'utf8',
      );

      expect((await acquireLock(file, DRIVER_LOCK_HOLDER, NOW)).ok).toBe(true);
      expect(await releaseLock(file, DRIVER_LOCK_HOLDER)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('recovers structurally corrupt Driver lock metadata', async () => {
    const fixture = await makeWorkspace();
    try {
      const file = fixture.paths.locks + '/driver.lock';
      await writeFile(file, '{not-json', 'utf8');
      expect((await acquireLock(file, DRIVER_LOCK_HOLDER, NOW)).ok).toBe(true);
      expect(await releaseLock(file, DRIVER_LOCK_HOLDER)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('release validates the process and holder and never deletes another lock', async () => {
    const fixture = await makeWorkspace();
    try {
      const file = fixture.paths.locks + '/driver.lock';
      expect((await acquireLock(file, DRIVER_LOCK_HOLDER, NOW)).ok).toBe(true);
      expect(await releaseLock(file, 'wrong-holder')).toBe(false);
      expect(await releaseLock(file, DRIVER_LOCK_HOLDER)).toBe(true);
      expect(await releaseLock(file, DRIVER_LOCK_HOLDER)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('Executor workspace lock', () => {
  it('binds the lock to one schema-3 execute task and rejects old role ids', async () => {
    const fixture = await makeWorkspace();
    try {
      const file = executorLockFile(fixture.paths);
      expect((await acquireExecutorLock(file, EXECUTE_TASK, NOW)).ok).toBe(true);
      const contents = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      expect(contents).toMatchObject({
        pid: process.pid,
        holder: EXECUTOR_LOCK_HOLDER,
        task_id: EXECUTE_TASK,
      });
      expect((await acquireExecutorLock(file, PLAN_TASK, NOW)).ok).toBe(false);
      expect((await acquireExecutorLock(file, 'gf_r123_i7_w000000000001_executor_p42', NOW)).ok).toBe(false);
      expect(await releaseExecutorLock(file, PLAN_TASK)).toBe(false);
      expect(await releaseExecutorLock(file, EXECUTE_TASK)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses a second live Executor even when the existing lock is old', async () => {
    const fixture = await makeWorkspace();
    try {
      const file = executorLockFile(fixture.paths);
      await writeFile(
        file,
        JSON.stringify({
          pid: process.pid,
          holder: EXECUTOR_LOCK_HOLDER,
          task_id: EXECUTE_TASK,
          acquired_at: '2000-01-01T00:00:00.000Z',
        }),
        'utf8',
      );
      const result = await acquireExecutorLock(file, 'gf_r123_i7_w000000000001_execute_p43', NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.holder).toMatchObject({ task_id: EXECUTE_TASK });
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not start an Executor when lock state is corrupt and ownership is unknown', async () => {
    const fixture = await makeWorkspace();
    try {
      const file = executorLockFile(fixture.paths);
      await writeFile(file, '{not-json', 'utf8');
      const result = await acquireExecutorLock(file, EXECUTE_TASK, NOW);
      expect(result.ok).toBe(false);
      expect(await readFile(file, 'utf8')).toBe('{not-json');
    } finally {
      await fixture.cleanup();
    }
  });

  it('can recover a malformed lock only when its exposed PID is dead', async () => {
    const fixture = await makeWorkspace();
    try {
      const file = executorLockFile(fixture.paths);
      await writeFile(file, JSON.stringify({ pid: 999999999 }), 'utf8');
      expect((await acquireExecutorLock(file, EXECUTE_TASK, NOW)).ok).toBe(true);
      expect(await releaseExecutorLock(file, EXECUTE_TASK)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
