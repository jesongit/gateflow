/**
 * Workspace path resolution and safe dispatch directory handling.
 *
 * Security constraints (docs/workspace-protocol.md §8, hardening §8 —
 * docs/plans/v1_hardening_decisions.md):
 * - Dispatch directory names must match the frozen dispatch_id grammar;
 *   `..`, absolute paths and any other escape are rejected.
 * - Resolved dispatch directories must lexically stay inside the inbox/outbox
 *   roots (path.resolve containment check as a second line of defense).
 * - `.gateflow/driver/` is DRIVER-PRIVATE state (receipts, locks, logs): it
 *   is never part of the agent communication face, and on POSIX it is created
 *   with restrictive modes (0o700 dirs / 0o600 files). On Windows, ACL-based
 *   isolation is documented as a Personal-Mode limitation — the protocol is
 *   communication isolation, not an OS sandbox.
 * - Symlink/junction defense: dispatch directories are verified (lstat) to be
 *   real directories before use; a symlink or junction dispatched into the
 *   communication face is rejected instead of followed.
 */
import { lstat, mkdir, readdir } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { DISPATCH_DIR_PATTERN } from './protocol';

/** Default runtime directory name under the project root (config `workspace_dir`). */
export const DEFAULT_WORKSPACE_DIR = '.gateflow';

/** Absolute paths of every Workspace Protocol location inside the runtime dir. */
export interface WorkspacePaths {
  /** `.gateflow/` root. */
  root: string;
  /** `.gateflow/current.json`. */
  current: string;
  /** `.gateflow/inbox/`. */
  inbox: string;
  /** `.gateflow/outbox/`. */
  outbox: string;
  /** `.gateflow/submit/`. */
  submit: string;
  /** `.gateflow/driver/` — Driver-private state root (schema 2). */
  driver: string;
  /** `.gateflow/driver/receipts/`. */
  receipts: string;
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
    inbox: nodePath.join(root, 'inbox'),
    outbox: nodePath.join(root, 'outbox'),
    submit: nodePath.join(root, 'submit'),
    driver,
    receipts: nodePath.join(driver, 'receipts'),
    locks: nodePath.join(driver, 'locks'),
    logs: nodePath.join(driver, 'logs'),
  };
}

/**
 * Create every workspace directory (mkdir -p). Idempotent. Driver-private
 * directories get restrictive modes on POSIX (0o700); on Windows the mode
 * argument is ignored by the OS — the Personal/Secure-Mode boundary is a
 * documented deployment concern, not a protocol guarantee.
 */
export async function ensureWorkspace(paths: WorkspacePaths): Promise<void> {
  const isPosix = process.platform !== 'win32';
  const agentDirMode = isPosix ? 0o755 : undefined;
  const driverDirMode = isPosix ? 0o700 : undefined;
  await mkdir(paths.root, { recursive: true, ...(agentDirMode !== undefined ? { mode: agentDirMode } : {}) });
  await mkdir(paths.inbox, { recursive: true, ...(agentDirMode !== undefined ? { mode: agentDirMode } : {}) });
  await mkdir(paths.outbox, { recursive: true, ...(agentDirMode !== undefined ? { mode: agentDirMode } : {}) });
  await mkdir(paths.submit, { recursive: true, ...(agentDirMode !== undefined ? { mode: agentDirMode } : {}) });
  await mkdir(paths.driver, { recursive: true, ...(driverDirMode !== undefined ? { mode: driverDirMode } : {}) });
  await mkdir(paths.receipts, { recursive: true, ...(driverDirMode !== undefined ? { mode: driverDirMode } : {}) });
  await mkdir(paths.locks, { recursive: true, ...(driverDirMode !== undefined ? { mode: driverDirMode } : {}) });
  await mkdir(paths.logs, { recursive: true, ...(driverDirMode !== undefined ? { mode: driverDirMode } : {}) });
}

/**
 * Throw unless `dispatchId` matches the frozen dispatch_id grammar. This
 * rejects `..` segments, path separators, URL-encoded escapes and absolute
 * paths before anything is joined onto a workspace root.
 */
export function assertDispatchId(dispatchId: string): void {
  if (typeof dispatchId !== 'string' || !DISPATCH_DIR_PATTERN.test(dispatchId)) {
    throw new Error(`invalid dispatch id: ${JSON.stringify(dispatchId)}`);
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

function safeDispatchDir(base: string, dispatchId: string, label: string): string {
  assertDispatchId(dispatchId);
  const dir = nodePath.join(base, dispatchId);
  assertInsideBase(base, dir, label);
  return dir;
}

/**
 * Resolve `inbox/<dispatchId>` for a validated dispatch id.
 * Throws on ids failing DISPATCH_DIR_PATTERN or resolving outside the inbox.
 */
export function inboxDispatchDir(paths: WorkspacePaths, dispatchId: string): string {
  return safeDispatchDir(paths.inbox, dispatchId, 'inbox dispatch dir');
}

/**
 * Resolve `outbox/<dispatchId>` for a validated dispatch id.
 * Throws on ids failing DISPATCH_DIR_PATTERN or resolving outside the outbox.
 */
export function outboxDispatchDir(paths: WorkspacePaths, dispatchId: string): string {
  return safeDispatchDir(paths.outbox, dispatchId, 'outbox dispatch dir');
}

/**
 * Symlink/junction guard (hardening §8, GF-H11): stats the path WITHOUT
 * following links and rejects anything that is not a plain directory.
 * Returns false when the path does not exist.
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
 * Cap on dispatch directories scanned per sync/dispatch cycle (anti-flood:
 * a hostile agent must not be able to force unbounded directory scans or
 * unbounded GitHub writes; docs/plans/v1_hardening_decisions.md §8).
 */
export const MAX_DISPATCH_DIRS = 200;

/**
 * List dispatch-id-shaped directory names inside `base`, sorted, capped at
 * MAX_DISPATCH_DIRS (the SORTED first MAX_DISPATCH_DIRS ids — anti-flood,
 * hardening §8).
 */
export async function listDispatchDirs(base: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && DISPATCH_DIR_PATTERN.test(entry.name)) {
      ids.push(entry.name);
    }
  }
  return ids.sort().slice(0, MAX_DISPATCH_DIRS);
}
