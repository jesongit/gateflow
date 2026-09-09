/**
 * Local workspace locks.
 *
 * There are two deliberately small contracts:
 *  - `driver.lock` protects the Driver's single-writer run/sync pass;
 *  - `executor.lock` identifies one execute-mode task writing a workspace.
 *
 * These are local filesystem locks. They are not a distributed mutex and do
 * not coordinate processes on another machine. In particular, an executor
 * lock failure is a conflict/unknown state for the caller to report; this
 * module never starts, queues, or replaces another Executor.
 */
import { open, readFile, unlink } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { WorkspacePaths } from '../workspace/paths';
import { parseTaskId } from '../workspace/protocol';

/** Lock file guarding the single Driver instance of one machine/workspace. */
export function driverLockFile(paths: WorkspacePaths): string {
  return nodePath.join(paths.locks, 'driver.lock');
}

/** Lock file guarding the single execute-mode writer of one workspace. */
export function executorLockFile(paths: WorkspacePaths): string {
  return nodePath.join(paths.locks, 'executor.lock');
}

/** Holder names recorded in the respective lock files. */
export const DRIVER_LOCK_HOLDER = 'gateflow-driver';
export const EXECUTOR_LOCK_HOLDER = 'gateflow-executor';

/**
 * Lock metadata. `task_id` is present only in an Executor lock. Keeping it
 * optional preserves the existing Driver lock file shape while making the
 * Executor binding explicit and machine-readable.
 */
export interface LockContents {
  pid: number;
  holder: string;
  acquired_at: string;
  task_id?: string;
}

/** The required metadata for an execute-mode workspace lock. */
export interface ExecutorLockContents extends LockContents {
  task_id: string;
}

/**
 * Retained as a source-compatible export for callers that imported the old
 * constant. It is intentionally NOT used for stale detection: a live
 * process owns its lock regardless of age.
 */
export const MAX_LOCK_AGE_MS = 6 * 60 * 60 * 1000;

export type LockAcquireResult =
  | { ok: true }
  | { ok: false; reason: string; holder: LockContents | null };

export type ExecutorLockAcquireResult =
  | { ok: true }
  | { ok: false; reason: string; holder: ExecutorLockContents | null };

type LockState =
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'invalid'; raw: string; pid: number | null }
  | { kind: 'valid'; raw: string; contents: LockContents };

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but is not ours (still alive).
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function candidatePid(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseLock(raw: string): LockState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'invalid', raw, pid: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'invalid', raw, pid: null };
  }

  const candidate = parsed as {
    pid?: unknown;
    holder?: unknown;
    acquired_at?: unknown;
    task_id?: unknown;
  };
  const pid = candidatePid(candidate.pid);
  const holder = typeof candidate.holder === 'string' ? candidate.holder : null;
  const acquiredAt = typeof candidate.acquired_at === 'string' ? candidate.acquired_at : null;
  const taskId = candidate.task_id;
  const taskIdValid = taskId === undefined || (typeof taskId === 'string' && taskId.length > 0);
  const acquiredAtValid = acquiredAt !== null && !Number.isNaN(Date.parse(acquiredAt));

  if (pid === null || holder === null || holder.trim().length === 0 || !acquiredAtValid || !taskIdValid) {
    return { kind: 'invalid', raw, pid };
  }
  return {
    kind: 'valid',
    raw,
    contents: {
      pid,
      holder,
      acquired_at: acquiredAt,
      ...(typeof taskId === 'string' ? { task_id: taskId } : {}),
    },
  };
}

async function readLockState(file: string): Promise<LockState> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return {
      kind: 'unreadable',
      reason: `lock file could not be read: ${(err as Error).message}`,
    };
  }
  return parseLock(raw);
}

async function readValidLock(file: string): Promise<LockContents | null> {
  const state = await readLockState(file);
  return state.kind === 'valid' ? state.contents : null;
}

/**
 * Remove only the exact lock snapshot that was inspected. The second read
 * prevents a stale-lock cleanup from deleting a replacement acquired between
 * inspection and cleanup. Filesystem races can still only be made best-effort
 * without an external coordinator, so callers remain fail-closed on failure.
 */
async function unlinkObserved(file: string, observedRaw: string): Promise<boolean> {
  const current = await readLockState(file);
  if (current.kind === 'missing') return true;
  if (current.kind === 'unreadable' || current.raw !== observedRaw) return false;
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

function executorTaskId(taskId: string): boolean {
  const parsed = parseTaskId(taskId);
  return (
    parsed !== null &&
    Number.isSafeInteger(parsed.repositoryId) &&
    parsed.repositoryId > 0 &&
    Number.isSafeInteger(parsed.issueNumber) &&
    parsed.issueNumber > 0 &&
    parsed.mode === 'execute' &&
    /^p\d+$/.test(parsed.revision)
  );
}

function lockHolder(state: LockState): LockContents | null {
  return state.kind === 'valid'
    ? state.contents
    : state.kind === 'invalid' && state.pid !== null
      ? { pid: state.pid, holder: 'unknown', acquired_at: '' }
      : null;
}

/**
 * Acquire a lock file with Driver semantics.
 *
 * A valid lock is reclaimable only when its recorded PID is dead. A live PID
 * is busy forever; `MAX_LOCK_AGE_MS` is not consulted. A structurally corrupt
 * lock is reclaimable because it carries no trustworthy ownership claim, but
 * an OS read error is unknown and therefore fails closed.
 */
export async function acquireLock(
  file: string,
  holder: string,
  now: () => Date = () => new Date(),
): Promise<LockAcquireResult> {
  if (holder.trim().length === 0) {
    return { ok: false, reason: 'lock holder must be non-empty', holder: null };
  }
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

      const existing = await readLockState(file);
      if (existing.kind === 'missing') continue;
      if (existing.kind === 'unreadable') {
        return { ok: false, reason: existing.reason, holder: null };
      }
      if (existing.kind === 'valid' && isAlive(existing.contents.pid)) {
        return { ok: false, reason: 'workspace busy: lock held by a live process', holder: existing.contents };
      }
      if (existing.kind === 'invalid' && existing.pid !== null && isAlive(existing.pid)) {
        return {
          ok: false,
          reason: 'workspace lock metadata is corrupt but its recorded process is live; refusing to reclaim it',
          holder: lockHolder(existing),
        };
      }
      // A valid lock with a dead PID, or an invalid/corrupt lock, can be
      // recovered. Age is deliberately irrelevant to the valid-lock branch.
      if (await unlinkObserved(file, existing.raw)) continue;
      return {
        ok: false,
        reason: 'workspace lock changed while recovering it; refusing to guess ownership',
        holder: lockHolder(existing),
      };
    }
    try {
      await fd.writeFile(JSON.stringify(contents, null, 2) + '\n', 'utf8');
    } finally {
      await fd.close();
    }
    return { ok: true };
  }
  return { ok: false, reason: 'workspace busy: lock could not be recovered safely', holder: await readValidLock(file) };
}

/**
 * Acquire the single Executor slot for one schema-3 execute task.
 *
 * The lock body always includes `task_id`; plan tasks and old
 * consumer/executor-shaped ids are rejected before any file operation. A
 * malformed lock is not automatically treated as free: only a malformed
 * lock that still exposes a dead, safe-to-reclaim PID may be recovered. An
 * unreadable or otherwise owner-unknown lock remains in place and returns a
 * fail-closed result, so a second Executor is never started on guesswork.
 */
export async function acquireExecutorLock(
  file: string,
  taskId: string,
  now: () => Date = () => new Date(),
): Promise<ExecutorLockAcquireResult> {
  if (!executorTaskId(taskId)) {
    return { ok: false, reason: `invalid execute task_id for Executor lock: ${JSON.stringify(taskId)}`, holder: null };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const contents: ExecutorLockContents = {
      pid: process.pid,
      holder: EXECUTOR_LOCK_HOLDER,
      task_id: taskId,
      acquired_at: now().toISOString(),
    };
    let fd;
    try {
      fd = await open(file, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        return { ok: false, reason: `executor lock could not be created: ${(err as Error).message}`, holder: null };
      }

      const existing = await readLockState(file);
      if (existing.kind === 'missing') continue;
      if (existing.kind === 'unreadable') {
        return { ok: false, reason: `executor lock state is unknown: ${existing.reason}`, holder: null };
      }

      const existingExecutor =
        existing.kind === 'valid' &&
        typeof existing.contents.task_id === 'string' &&
        executorTaskId(existing.contents.task_id)
          ? (existing.contents as ExecutorLockContents)
          : null;
      if (existingExecutor !== null) {
        if (isAlive(existingExecutor.pid)) {
          return { ok: false, reason: 'executor workspace busy: a live Executor holds the lock', holder: existingExecutor };
        }
        if (await unlinkObserved(file, existing.raw)) continue;
        return { ok: false, reason: 'executor lock changed while recovering it; refusing to guess ownership', holder: existingExecutor };
      }

      // A lock without valid Executor metadata is not safe to overwrite. It
      // may be a partially-written live lock, a Driver lock at the wrong path,
      // or an unknown older protocol. Recover only when a trustworthy PID is
      // present and demonstrably dead; otherwise leave it untouched.
      if (existing.kind === 'valid' && isAlive(existing.contents.pid)) {
        return {
          ok: false,
          reason: 'executor lock state is unknown or belongs to another writer; refusing to start a second Executor',
          holder: null,
        };
      }
      if (existing.kind === 'invalid' && (existing.pid === null || isAlive(existing.pid))) {
        return {
          ok: false,
          reason: 'executor lock state is unknown or corrupt; refusing to start a second Executor',
          holder: null,
        };
      }
      if (await unlinkObserved(file, existing.raw)) continue;
      return { ok: false, reason: 'executor lock changed while recovering it; refusing to guess ownership', holder: null };
    }
    try {
      await fd.writeFile(JSON.stringify(contents, null, 2) + '\n', 'utf8');
    } finally {
      await fd.close();
    }
    return { ok: true };
  }
  return { ok: false, reason: 'executor workspace busy: lock could not be recovered safely', holder: null };
}

/**
 * Release a Driver lock only when it still belongs to this process and the
 * exact holder string supplied at acquire time.
 */
export async function releaseLock(file: string, holder: string): Promise<boolean> {
  const existing = await readLockState(file);
  if (existing.kind !== 'valid') return false;
  if (existing.contents.pid !== process.pid || existing.contents.holder !== holder) return false;
  return unlinkObserved(file, existing.raw);
}

/**
 * Release an Executor lock only when process, holder and task identity all
 * match. A different task in the same process cannot release this lock.
 */
export async function releaseExecutorLock(file: string, taskId: string): Promise<boolean> {
  if (!executorTaskId(taskId)) return false;
  const existing = await readLockState(file);
  if (existing.kind !== 'valid') return false;
  if (
    existing.contents.pid !== process.pid ||
    existing.contents.holder !== EXECUTOR_LOCK_HOLDER ||
    existing.contents.task_id !== taskId
  ) {
    return false;
  }
  return unlinkObserved(file, existing.raw);
}
