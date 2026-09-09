/**
 * Workspace lock (the single-writer rule, kept from the hardening plan):
 * one Driver process per machine/workspace at any time.
 *
 * FROZEN LIMITS (kept honest):
 * - This is a LOCAL lock (same machine, same workspace directory). It
 *   constrains same-machine processes only; it is NOT a cross-machine
 *   mutex. Multi-device setups must designate a single controlled writer or
 *   add an external coordinator — never assume the lock travels.
 * - V1 has no executor lock: there is exactly one active task and no
 *   auto-dispatch, so `run`/`sync` mutual exclusion via the driver lock is
 *   sufficient.
 *
 * Implementation: an O_EXCL lock file under `.gateflow/driver/locks/` with
 * { pid, holder, acquired_at } JSON. Stale detection = holder pid is dead
 * (process.kill(pid, 0)) or the lock is older than MAX_LOCK_AGE_MS; a stale
 * lock is stolen once. Every failure mode answers explicitly to the caller.
 */
import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { WorkspacePaths } from '../workspace/paths';

/** Lock file guarding the single Driver instance of one machine/workspace. */
export function driverLockFile(paths: WorkspacePaths): string {
  return nodePath.join(paths.locks, 'driver.lock');
}

/** Holder name recorded in every lock we create. */
export const DRIVER_LOCK_HOLDER = 'gateflow-driver';

export interface LockContents {
  pid: number;
  holder: string;
  acquired_at: string;
}

/** Steal a lock whose holder cannot possibly still be alive after this long. */
export const MAX_LOCK_AGE_MS = 6 * 60 * 60 * 1000;

export type LockAcquireResult =
  | { ok: true }
  | { ok: false; reason: string; holder: LockContents | null };

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

async function readLock(file: string): Promise<LockContents | null> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<LockContents>;
    if (typeof candidate.pid !== 'number' || typeof candidate.holder !== 'string') return null;
    return candidate as LockContents;
  } catch {
    return null;
  }
}

async function lockAgeMs(file: string, nowMs: number): Promise<number> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockContents>;
    const at = typeof parsed.acquired_at === 'string' ? Date.parse(parsed.acquired_at) : NaN;
    if (Number.isNaN(at)) return MAX_LOCK_AGE_MS + 1;
    return nowMs - at;
  } catch {
    return MAX_LOCK_AGE_MS + 1;
  }
}

/**
 * Acquire `file` for `holder`. Returns { ok: false, holder } when a LIVE
 * holder owns the lock (the caller fails with a clear message). A stale
 * lock (dead pid or past MAX_LOCK_AGE_MS) is stolen once — never merely
 * because of its age while the holder process is still alive.
 */
export async function acquireLock(
  file: string,
  holder: string,
  now: () => Date = () => new Date(),
): Promise<LockAcquireResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const contents: LockContents = {
      pid: process.pid,
      holder,
      acquired_at: now().toISOString(),
    };
    let fd;
    try {
      fd = await open(file, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        return { ok: false, reason: `lock file could not be created: ${(err as Error).message}`, holder: null };
      }
      // EEXIST: inspect the current holder.
      const existing = await readLock(file);
      const age = await lockAgeMs(file, now().getTime());
      const stale = existing === null || !isAlive(existing.pid) || age > MAX_LOCK_AGE_MS;
      if (!stale) {
        return { ok: false, reason: 'workspace busy: lock held by a live process', holder: existing };
      }
      // Steal the stale lock and retry once.
      try {
        await unlink(file);
      } catch {
        // another process may have stolen it first; the retry decides
      }
      continue;
    }
    try {
      await fd.writeFile(JSON.stringify(contents, null, 2) + '\n', 'utf8');
    } finally {
      await fd.close();
    }
    return { ok: true };
  }
  return { ok: false, reason: 'workspace busy: lock held by a live process', holder: await readLock(file) };
}

/**
 * Release `file` only when it still belongs to `holder` + `pid` (never
 * delete another process's lock). Returns whether a lock was removed.
 */
export async function releaseLock(file: string, holder: string): Promise<boolean> {
  const existing = await readLock(file);
  if (existing === null) return false;
  if (existing.pid !== process.pid || existing.holder !== holder) return false;
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}
