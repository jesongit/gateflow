/**
 * Workspace path resolution and safe task directory handling (protocol
 * schema 3).
 *
 * Security constraints (docs/workspace-protocol.md):
 * - Task directory names must match the frozen task_id grammar; `..`,
 *   absolute paths and any other escape are rejected.
 * - Resolved task directories must lexically stay inside `.gateflow/tasks/`
 *   (path.resolve containment check as a second line of defense).
 * - `.gateflow/driver/` is DRIVER-PRIVATE state (state.json, locks, logs): it
 *   is never part of the agent communication face, and on POSIX it is created
 *   with restrictive modes (0o700 dirs). On Windows, ACL-based isolation is
 *   documented as a limitation — the protocol is communication isolation, not
 *   an OS sandbox.
 * - Symlink/junction defense: task directories are verified (lstat) to be
 *   real directories before use; a symlink or junction is rejected instead of
 *   followed.
 */
import { lstat, mkdir, readdir } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { TASK_ID_PATTERN } from './protocol';

/** Default runtime directory name under the project root (config `workspace_dir`). */
export const DEFAULT_WORKSPACE_DIR = '.gateflow';

/** Absolute paths of every Workspace Protocol location inside the runtime dir. */
export interface WorkspacePaths {
  /** `.gateflow/` root. */
  root: string;
  /** `.gateflow/current.json`. */
  current: string;
  /** `.gateflow/tasks/`. */
  tasks: string;
  /** `.gateflow/driver/` — Driver-private state root. */
  driver: string;
  /** `.gateflow/driver/state.json`. */
  state: string;
  /** `.gateflow/driver/locks/`. */
  locks: string;
  /** `.gateflow/driver/logs/`. */
  logs: string;
}

/**
 * Resolve the workspace layout under `projectRoot`. `dirName` defaults to
 * `.gateflow` and comes from the driver config `workspace_dir`.
 */
export function resolveWorkspace(projectRoot: string, dirName: string = DEFAULT_WORKSPACE_DIR): WorkspacePaths {
  const root = nodePath.resolve(projectRoot, dirName);
  const driver = nodePath.join(root, 'driver');
  return {
    root,
    current: nodePath.join(root, 'current.json'),
    tasks: nodePath.join(root, 'tasks'),
    driver,
    state: nodePath.join(driver, 'state.json'),
    locks: nodePath.join(driver, 'locks'),
    logs: nodePath.join(driver, 'logs'),
  };
}

/**
 * Create every workspace directory (mkdir -p). Idempotent. Driver-private
 * directories get restrictive modes on POSIX (0o700); on Windows the mode
 * argument is ignored by the OS.
 */
export async function ensureWorkspace(paths: WorkspacePaths): Promise<void> {
  const isPosix = process.platform !== 'win32';
  const agentDirMode = isPosix ? 0o755 : undefined;
  const driverDirMode = isPosix ? 0o700 : undefined;
  await mkdir(paths.root, { recursive: true, ...(agentDirMode !== undefined ? { mode: agentDirMode } : {}) });
  await mkdir(paths.tasks, { recursive: true, ...(agentDirMode !== undefined ? { mode: agentDirMode } : {}) });
  await mkdir(paths.driver, { recursive: true, ...(driverDirMode !== undefined ? { mode: driverDirMode } : {}) });
  await mkdir(paths.locks, { recursive: true, ...(driverDirMode !== undefined ? { mode: driverDirMode } : {}) });
  await mkdir(paths.logs, { recursive: true, ...(driverDirMode !== undefined ? { mode: driverDirMode } : {}) });
}

/**
 * Throw unless `taskId` matches the frozen task_id grammar. This rejects
 * `..` segments, path separators, URL-encoded escapes and absolute paths
 * before anything is joined onto a workspace root.
 */
export function assertTaskId(taskId: string): void {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`invalid task id: ${JSON.stringify(taskId)}`);
  }
}

/**
 * Lexical containment check: `candidate` must resolve to `base` itself or to
 * a path strictly inside `base`. Defense in depth on top of the id grammar.
 */
function assertInsideBase(base: string, candidate: string, label: string): void {
  const resolvedBase = nodePath.resolve(base);
  const resolved = nodePath.resolve(candidate);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + nodePath.sep)) {
    throw new Error(`${label} escapes workspace: ${candidate}`);
  }
}

function safeTaskDir(base: string, taskId: string, label: string): string {
  assertTaskId(taskId);
  const dir = nodePath.join(base, taskId);
  assertInsideBase(base, dir, label);
  return dir;
}

/**
 * Resolve `tasks/<taskId>` for a validated task id.
 * Throws on ids failing TASK_ID_PATTERN or resolving outside the tasks root.
 */
export function taskDir(paths: WorkspacePaths, taskId: string): string {
  return safeTaskDir(paths.tasks, taskId, 'task dir');
}

/**
 * Symlink/junction guard: stats the path WITHOUT following links and rejects
 * anything that is not a plain directory. Returns false when missing.
 */
export async function isRealDirectory(dir: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(dir);
  } catch {
    return false;
  }
  return info.isDirectory();
}

/**
 * Cap on task directories scanned per sync cycle (anti-flood: a hostile
 * agent must not be able to force unbounded directory scans or unbounded
 * GitHub writes).
 */
export const MAX_TASK_DIRS = 200;

/**
 * List task-id-shaped directory names inside `base`, sorted, capped at
 * MAX_TASK_DIRS (the SORTED first MAX_TASK_DIRS ids — anti-flood).
 */
export async function listTaskDirs(base: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && TASK_ID_PATTERN.test(entry.name)) {
      ids.push(entry.name);
    }
  }
  return ids.sort().slice(0, MAX_TASK_DIRS);
}
