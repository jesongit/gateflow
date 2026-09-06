/**
 * Workspace path resolution and safe dispatch directory handling.
 *
 * Security constraints (docs/workspace-protocol.md §8, frozen):
 * - Dispatch directory names must match the frozen dispatch_id grammar;
 *   `..`, absolute paths and any other escape are rejected.
 * - Resolved dispatch directories must lexically stay inside the inbox/outbox
 *   roots (path.resolve containment check as a second line of defense).
 */
import { mkdir } from 'node:fs/promises';
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
  /** `.gateflow/receipts/`. */
  receipts: string;
  /** `.gateflow/submit/`. */
  submit: string;
  /** `.gateflow/logs/`. */
  logs: string;
}

/**
 * Resolve the workspace layout under `projectRoot`. `dirName` defaults to
 * `.gateflow` and comes from the driver config `workspace_dir`.
 */
export function resolveWorkspace(projectRoot: string, dirName: string = DEFAULT_WORKSPACE_DIR): WorkspacePaths {
  const root = nodePath.resolve(projectRoot, dirName);
  return {
    root,
    current: nodePath.join(root, 'current.json'),
    inbox: nodePath.join(root, 'inbox'),
    outbox: nodePath.join(root, 'outbox'),
    receipts: nodePath.join(root, 'receipts'),
    submit: nodePath.join(root, 'submit'),
    logs: nodePath.join(root, 'logs'),
  };
}

/** Create every workspace directory (mkdir -p). Idempotent. */
export async function ensureWorkspace(paths: WorkspacePaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.inbox, { recursive: true });
  await mkdir(paths.outbox, { recursive: true });
  await mkdir(paths.receipts, { recursive: true });
  await mkdir(paths.submit, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
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
