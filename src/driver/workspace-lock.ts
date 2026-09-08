/**
 * Workspace locks (hardening Phase 7.3, docs/plans/v1_hardening_decisions.md
 * §9; V1.1 Phase 7重构: "Executor Lock 不再依赖固定时间自动失效").
 *
 * FROZEN LIMITS (kept honest):
 * - These are LOCAL locks (same machine, same workspace directory). They
 *   constrain same-machine processes only; they are NOT a cross-machine
 *   mutex. Multi-device setups must designate a single controlled writer or
 *   add an external coordinator — never assume the lock travels.
 * - Conflicts QUEUE (the dispatch is skipped with a reason and retried on a
 *   later cycle); there is no preemption and no agent registry.
 *
 * V1.1 SEMANTICS (Phase 7 — a desktop Agent outlives its Driver process, so
 * "the Driver died" must NEVER mean "the Executor stopped"):
 *
 * - `driver` locks (one Driver instance per machine/workspace) are RUNTIME
 *   locks: staleness = holder pid is dead (process.kill(pid, 0)) or the lock
 *   is older than MAX_LOCK_AGE_MS. A stale driver lock is stolen once.
 *   `refreshLock` (heartbeat) keeps long cycles from aging out.
 *
 * - `executor` locks (one active Executor per worktree) are WORKSPACE locks
 *   with NO time-based staleness:
 *     · a LIVE holder  → busy (queue);
 *     · a DEAD holder  → `workspace-conflict` — the Driver crashed but the
 *       desktop Agent may still be working; the lock is NOT stolen
 *       automatically (plan: "Driver crash 不自动释放", "固定时间不会自动
 *       抢占");
 *     · the ONLY release paths are (a) the SAME process holding it (normal
 *       terminal receipt handling), or (b) the explicit human command
 *       `gateflow driver unlock <dispatch_id>` — the human has confirmed the
 *       old client stopped (fail-safe default: unprovable state → conflict).
 *
 * Implementation: O_EXCL lock files under `.gateflow/driver/locks/` with
 * { pid, holder, kind, acquired_at, heartbeat_at, dispatch_id?, ... } JSON.
 * Every failure mode answers explicitly to the caller.
 */
import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { WorkspacePaths } from '../workspace/paths';

/** Lock file guarding the single active Executor of one worktree. */
export function executorLockFile(paths: WorkspacePaths): string {
  return nodePath.join(paths.locks, 'executor.lock');
}

/** Lock file guarding the single Driver instance of one machine/workspace. */
export function driverLockFile(paths: WorkspacePaths): string {
  return nodePath.join(paths.locks, 'driver.lock');
}

/** Holder name recorded in every lock we create. */
export const DRIVER_LOCK_HOLDER = 'gateflow-driver';

/** Which staleness semantics a lock file follows (V1.1 Phase 7, frozen). */
export type LockKind = 'driver' | 'executor';

export interface LockContents {
  pid: number;
  holder: string;
  /** Which staleness semantics apply (driver = runtime, executor = workspace). */
  kind: LockKind;
  acquired_at: string;
  /** Last keep-alive write (long syncs); a DRIVER-lock staleness input only. */
  heartbeat_at?: string;
  /** Executor locks record the dispatch they guard; driver locks don't. */
  dispatch_id?: string;
  /** Executor locks record the workflow epoch of the guarded dispatch. */
  workflow_epoch?: string;
  /** Executor locks record the workspace root they guard. */
  workspace?: string;
}

/** Steal a stale DRIVER lock whose holder cannot possibly still be alive. */
export const MAX_LOCK_AGE_MS = 6 * 60 * 60 * 1000;

export type LockAcquireResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      holder: LockContents | null;
      /**
       * Why acquisition failed: `busy` (a live process holds it — queue),
       * `workspace-conflict` (an executor lock whose holder is unprovable —
       * requires the explicit human unlock), or `error` (I/O).
       */
      failure: 'busy' | 'workspace-conflict' | 'error';
    };

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
    // Schema-1 locks predate `kind`; they behaved like driver locks.
    const { kind, ...rest } = candidate as LockContents;
    return { ...rest, kind: typeof kind === 'string' ? kind : 'driver' };
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

export interface AcquireOptions {
  /** Executor locks record the dispatch they guard. */
  dispatchId?: string;
  /** Executor locks record the guarded dispatch's workflow epoch. */
  workflowEpoch?: string;
  /** Executor locks record the guarded workspace root. */
  workspace?: string;
  /**
   * Staleness semantics; default `driver`. Executor locks are NEVER stale by
   * age or by a dead holder pid (V1.1 Phase 7).
   */
  kind?: LockKind;
}

/**
 * Acquire `file` for `holder`. Returns `ok: false` (with the holder) when a
 * lock is in force — the caller queues or reports a conflict, never
 * preempts. A stale DRIVER lock (dead pid or past MAX_LOCK_AGE_MS) is stolen
 * once; an EXECUTOR lock is never stolen automatically.
 */
export async function acquireLock(
  file: string,
  holder: string,
  opts: AcquireOptions = {},
  now: () => Date = () => new Date(),
): Promise<LockAcquireResult> {
  const kind: LockKind = opts.kind ?? 'driver';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const at = now().toISOString();
    const contents: LockContents = {
      pid: process.pid,
      holder,
      kind,
      acquired_at: at,
      heartbeat_at: at,
      ...(opts.dispatchId !== undefined ? { dispatch_id: opts.dispatchId } : {}),
      ...(opts.workflowEpoch !== undefined ? { workflow_epoch: opts.workflowEpoch } : {}),
      ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    };
    let fd;
    try {
      fd = await open(file, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        return {
          ok: false,
          reason: `lock file could not be created: ${(err as Error).message}`,
          holder: null,
          failure: 'error',
        };
      }
      // EEXIST: inspect the current holder.
      const existing = await readLock(file);
      if (existing === null) {
        // Unreadable/corrupt lock file: for an executor lock this is an
        // unprovable state — fail safe, never steal (V1.1 Phase 7).
        if (kind === 'executor') {
          return {
            ok: false,
            reason:
              'workspace-conflict: executor lock exists but cannot be read; the state of the ' +
              'previous executor is unknown — run `gateflow driver unlock` after confirming ' +
              'the old client stopped (fail safe)',
            holder: null,
            failure: 'workspace-conflict',
          };
        }
      } else if (kind === 'executor') {
        if (isAlive(existing.pid)) {
          return {
            ok: false,
            reason: `workspace busy: executor lock held by ${existing.holder} pid ${existing.pid}`,
            holder: existing,
            failure: 'busy',
          };
        }
        return {
          ok: false,
          reason:
            `workspace-conflict: executor lock holder pid ${existing.pid} is gone, but the ` +
            'desktop Agent it started may still be running (a Driver process ending does not ' +
            'mean the Agent stopped). Confirm the old client stopped, then run ' +
            '`gateflow driver unlock` to release explicitly (V1.1 Phase 7, fail safe)',
          holder: existing,
          failure: 'workspace-conflict',
        };
      } else {
        // Driver runtime lock: pid + age staleness.
        const age = await lockAgeMs(file, now().getTime());
        if (isAlive(existing.pid) && age <= MAX_LOCK_AGE_MS) {
          return {
            ok: false,
            reason: `workspace busy: driver lock held by ${existing.holder} pid ${existing.pid}`,
            holder: existing,
            failure: 'busy',
          };
        }
      }
      // Steal the stale driver lock and retry once.
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
  return { ok: false, reason: 'workspace busy: lock held by a live process', holder: await readLock(file), failure: 'busy' };
}

/**
 * Release `file` only when it still belongs to `holder` + `pid` (never delete
 * another process's lock). Returns whether a lock was actually removed.
 */
export async function releaseLock(file: string, holder: string, dispatchId?: string): Promise<boolean> {
  const existing = await readLock(file);
  if (existing === null) return false;
  if (existing.pid !== process.pid || existing.holder !== holder) return false;
  if (dispatchId !== undefined && existing.dispatch_id !== dispatchId) return false;
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

/** Overwrite `file` with refreshed contents (keep-alive for long syncs). */
export async function refreshLock(file: string, now: () => Date = () => new Date()): Promise<void> {
  const existing = await readLock(file);
  if (existing === null || existing.pid !== process.pid) return;
  const at = now().toISOString();
  await writeFile(
    file,
    JSON.stringify({ ...existing, acquired_at: at, heartbeat_at: at }, null, 2) + '\n',
    'utf8',
  );
}

export type ExplicitReleaseResult =
  | { ok: true; holder: LockContents }
  | { ok: false; reason: string };

/**
 * EXPLICIT human release of an executor lock (V1.1 Phase 7): removes the
 * lock when it guards `dispatchId`, whatever process holds it. This is the
 * recovery path for `workspace-conflict` AFTER the human confirmed the old
 * client stopped — the CLI surfaces it as `gateflow driver unlock`. Never
 * call from automated code paths.
 */
export async function forceReleaseExecutorLock(
  file: string,
  dispatchId: string,
): Promise<ExplicitReleaseResult> {
  const existing = await readLock(file);
  if (existing === null) {
    return { ok: false, reason: 'no executor lock present — nothing to release' };
  }
  if (existing.dispatch_id !== dispatchId) {
    return {
      ok: false,
      reason:
        `executor lock guards dispatch ${existing.dispatch_id ?? '(unknown)'}, not ${dispatchId} ` +
        '(refusing to release a different dispatch\'s lock)',
    };
  }
  try {
    await unlink(file);
  } catch (err) {
    return { ok: false, reason: `could not remove the lock file: ${(err as Error).message}` };
  }
  return { ok: true, holder: existing };
}
