/**
 * Driver-private state (`.gateflow/driver/state.json`, protocol schema 3).
 *
 * One file holds every task's synchronization record (the schema-2 per-task
 * receipts, merged). This is a rebuildable cache — GitHub stays the single
 * source of truth — and it is never part of the agent communication face:
 * agents see only `.gateflow/tasks/` and `.gateflow/current.json`.
 *
 * All writes rewrite the whole file atomically. A crash mid-sync rolls the
 * state back to a previous (older) view; every transition re-derives its
 * preconditions from GitHub (preflight + operation reconciliation), so a
 * stale view can never authorize a duplicate publish.
 */
import { readFile } from 'node:fs/promises';

import type { DriverStateFile, TaskRecord, TaskState } from './protocol';
import type { WorkspacePaths } from './paths';
import { atomicWriteJson } from './tasks';
import { validateDriverState } from './validation';

/** An empty state file (also the recovery for a missing/corrupt one). */
export function emptyDriverState(): DriverStateFile {
  return { schema: 3, updated_at: '1970-01-01T00:00:00Z', tasks: {} };
}

/**
 * Read and validate the driver state. Returns an empty state when the file
 * is missing or corrupt: the state is a cache, and sync re-reads GitHub
 * before every decision anyway.
 */
export async function readDriverState(paths: WorkspacePaths): Promise<DriverStateFile> {
  let text: string;
  try {
    text = await readFile(paths.state, 'utf8');
  } catch {
    return emptyDriverState();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyDriverState();
  }
  const parsed = validateDriverState(raw);
  return parsed.ok ? parsed.value : emptyDriverState();
}

/** Atomically persist the driver state. */
export async function writeDriverState(paths: WorkspacePaths, state: DriverStateFile): Promise<void> {
  await atomicWriteJson(paths.state, {
    ...state,
    updated_at: new Date().toISOString(),
  });
}

/** The record for `taskId`, or null when the driver has none. */
export function getTaskRecord(state: DriverStateFile, taskId: string): TaskRecord | null {
  return state.tasks[taskId] ?? null;
}

/** Pure update: returns a new state object with the record replaced/added. */
export function withTaskRecord(state: DriverStateFile, record: TaskRecord): DriverStateFile {
  return { ...state, tasks: { ...state.tasks, [record.task_id]: record } };
}

/** Pure update: removes the record entirely (used by the explicit retry). */
export function withoutTaskRecord(state: DriverStateFile, taskId: string): DriverStateFile {
  const tasks = { ...state.tasks };
  delete tasks[taskId];
  return { ...state, tasks };
}

/**
 * Whether a task may be (re)prepared right now (the schema-2 dedup rules,
 * simplified to the driver-state record):
 * - no record → allowed (fresh task or post-retry);
 * - prepared | publishing | published | accepted → NEVER re-prepare
 *   (`published`/`accepted` also block result replay at the sync layer);
 * - obsolete → the task is dead; a NEW task id (new epoch / revision) will
 *   be derived from canonical state instead — the old id never resurrects;
 * - failed with attempts < maxAttempts → automatic re-prepare allowed; at or
 *   above the ceiling → only an explicit `gateflow retry <task-id>`.
 */
export function shouldPrepare(
  existing: TaskRecord | null,
  maxAttempts: number,
): { ok: boolean; reason: string } {
  if (existing === null) {
    return { ok: true, reason: 'new' };
  }
  switch (existing.status) {
    case 'prepared':
    case 'publishing':
      return { ok: false, reason: 'already-prepared' };
    case 'published':
      return { ok: false, reason: 'published' };
    case 'accepted':
      return { ok: false, reason: 'accepted' };
    case 'obsolete':
      return { ok: false, reason: 'obsolete' };
    case 'failed':
      if (existing.attempts < maxAttempts) {
        return { ok: true, reason: 'retry' };
      }
      return { ok: false, reason: 'retry-limit' };
  }
}

/**
 * Terminal record states (accepted, obsolete, failed) end a task's active
 * life. Kept as a predicate for symmetry with the sync layer.
 */
export function isTerminalTaskState(status: TaskState): boolean {
  return status === 'accepted' || status === 'obsolete' || status === 'failed';
}
