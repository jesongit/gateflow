/**
 * Hardening tests — workspace locks (docs/plans/v1_hardening_decisions.md §9,
 * hardening Phase 7.3): O_EXCL lock files, live-holder queueing, stale-lock
 * stealing, and scoped release.
 */
import { describe, expect, it } from 'vitest';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { acquireLock, releaseLock, MAX_LOCK_AGE_MS } from '../../src/driver/workspace-lock';

async function lockFile(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), 'gateflow-locks-'));
  return { file: nodePath.join(dir, 'test.lock'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const T0 = new Date('2026-09-07T09:00:00Z');

describe('acquireLock / releaseLock', () => {
  it('acquires and releases a free lock; the contents record holder + pid', async () => {
    const { file, cleanup } = await lockFile();
    try {
      expect(await acquireLock(file, 'driver-a', undefined, () => T0)).toEqual({ ok: true });
      const raw = JSON.parse(await readFile(file, 'utf8')) as { pid: number; holder: string; acquired_at: string };
      expect(raw.holder).toBe('driver-a');
      expect(raw.pid).toBe(process.pid);
      expect(raw.acquired_at).toBe(T0.toISOString());

      expect(await releaseLock(file, 'driver-a')).toBe(true);
      // A free lock acquires again.
      expect(await acquireLock(file, 'driver-b', undefined, () => T0)).toEqual({ ok: true });
    } finally {
      await cleanup();
    }
  });

  it('queues when a LIVE foreign process holds the lock', async () => {
    const { file, cleanup } = await lockFile();
    try {
      // Simulate a live foreign holder: a pid that is not ours but alive.
      // process itself is alive; use a child pid we can keep alive briefly —
      // instead, fake "live" by writing a holder whose pid is our own but a
      // different holder name would still be released by name check; the
      // liveness check is what matters, so use pid = process.pid + a holder
      // name mismatch: acquire as a "foreign" writer by pre-writing the file.
      await writeFile(
        file,
        JSON.stringify({ pid: process.pid, holder: 'someone-else', acquired_at: T0.toISOString() }),
        'utf8',
      );
      const result = await acquireLock(file, 'driver-b', undefined, () => T0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/workspace busy/);
        expect(result.holder?.holder).toBe('someone-else');
      }
    } finally {
      await cleanup();
    }
  });

  it('steals a STALE lock (dead pid)', async () => {
    const { file, cleanup } = await lockFile();
    try {
      // PID 999999 on POSIX is out of range for most systems; on Windows,
      // killing a nonexistent pid is also ESRCH. Use an absurd pid plus an
      // old timestamp — either liveness or age makes it stale.
      await writeFile(
        file,
        JSON.stringify({ pid: 999999999, holder: 'dead-process', acquired_at: '2020-01-01T00:00:00Z' }),
        'utf8',
      );
      const result = await acquireLock(file, 'driver-b', undefined, () => T0);
      expect(result).toEqual({ ok: true });
    } finally {
      await cleanup();
    }
  });

  it('steals a lock past MAX_LOCK_AGE_MS even when liveness cannot be proven false', async () => {
    const { file, cleanup } = await lockFile();
    try {
      const recent = new Date(MAX_LOCK_AGE_MS ? T0.getTime() - 1 : 0).toISOString();
      await writeFile(
        file,
        JSON.stringify({ pid: process.pid, holder: 'crashed-holder', acquired_at: recent }),
        'utf8',
      );
      // acquired 1ms before T0: fresh, live → queue...
      const queued = await acquireLock(file, 'driver-b', undefined, () => T0);
      expect(queued.ok).toBe(false);

      // ...but older than MAX_LOCK_AGE_MS → stolen.
      const ancient = new Date(T0.getTime() - MAX_LOCK_AGE_MS - 1000).toISOString();
      await writeFile(
        file,
        JSON.stringify({ pid: process.pid, holder: 'crashed-holder', acquired_at: ancient }),
        'utf8',
      );
      expect(await acquireLock(file, 'driver-b', undefined, () => T0)).toEqual({ ok: true });
    } finally {
      await cleanup();
    }
  });

  it('releaseLock never removes another holder\'s lock and respects dispatch scoping', async () => {
    const { file, cleanup } = await lockFile();
    try {
      await writeFile(
        file,
        JSON.stringify({ pid: process.pid, holder: 'other-driver', dispatch_id: 'x', acquired_at: T0.toISOString() }),
        'utf8',
      );
      // Wrong holder name.
      expect(await releaseLock(file, 'driver-b')).toBe(false);
      // Right holder but wrong dispatch scope.
      expect(await releaseLock(file, 'other-driver', 'y')).toBe(false);
      expect(await readFile(file, 'utf8')).toContain('other-driver');
      // Right holder + right scope.
      expect(await releaseLock(file, 'other-driver', 'x')).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
