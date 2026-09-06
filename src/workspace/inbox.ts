/**
 * Inbox construction and reading (Driver writes, agent reads).
 *
 * All writes are atomic: content goes to a sibling temp file in the same
 * directory, is flushed, and is then renamed over the target. On Windows a
 * rename over an existing file can fail transiently with EPERM/EACCES/EBUSY,
 * so the rename retries after unlinking the target (docs §6, frozen).
 *
 * Ready-marker convention (docs §6): when (re)building an inbox directory,
 * dispatch.json is written LAST. An agent only starts working once
 * current.json points at the dispatch and dispatch.json parses.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { CurrentPointer, Dispatch, WorkspaceContext } from './protocol';
import { inboxDispatchDir } from './paths';
import type { WorkspacePaths } from './paths';
import { validateContext, validateCurrent, validateDispatch } from './schemas';

/** Inabox build payload: everything a single dispatch projects to disk. */
export interface InboxBuild {
  dispatch: Dispatch;
  context: WorkspaceContext;
  /** Full TASK.md content. */
  task: string;
  /** Full PLAN.md content, executors only (null for consumers). */
  plan: string | null;
  /** Full FEEDBACK.md content, null when there is no feedback to project. */
  feedback: string | null;
}

const RENAME_MAX_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempPathFor(file: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${file}.tmp-${process.pid.toString(36)}-${random}`;
}

/**
 * Rename `tmp` over `target`, retrying on the Windows-specific failures.
 * Removes the temp file on ultimate failure so no litter is left behind.
 */
async function renameOverExisting(tmp: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const recoverable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!recoverable || attempt >= RENAME_MAX_ATTEMPTS) {
        try {
          await unlink(tmp);
        } catch {
          // best-effort cleanup only
        }
        throw err;
      }
      try {
        await unlink(target);
      } catch {
        // target may not exist yet; the retry rename will tell us
      }
      await sleep(10 * attempt);
    }
  }
}

/** Atomically write UTF-8 text content to `file` (temp file, then rename). */
export async function atomicWriteText(file: string, content: string): Promise<void> {
  await mkdir(nodePath.dirname(file), { recursive: true });
  const tmp = tempPathFor(file);
  // writeFile creates, fills and closes the temp file; the rename below is
  // the only step visible to concurrent readers of the target path.
  await writeFile(tmp, content, 'utf8');
  await renameOverExisting(tmp, file);
}

/** Atomically write a JSON document (2-space indent, trailing newline). */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * (Re)build inbox/<dispatch.dispatch_id>/ atomically: TASK.md, PLAN.md
 * (when present), FEEDBACK.md (when present), context.json, and finally
 * dispatch.json as the ready marker. Existing files are overwritten;
 * a missing dispatch directory is created.
 */
export async function writeInbox(paths: WorkspacePaths, build: InboxBuild): Promise<void> {
  const dir = inboxDispatchDir(paths, build.dispatch.dispatch_id);
  await mkdir(dir, { recursive: true });
  await atomicWriteText(nodePath.join(dir, 'TASK.md'), build.task);
  if (build.plan !== null) {
    await atomicWriteText(nodePath.join(dir, 'PLAN.md'), build.plan);
  }
  if (build.feedback !== null) {
    await atomicWriteText(nodePath.join(dir, 'FEEDBACK.md'), build.feedback);
  }
  await atomicWriteJson(nodePath.join(dir, 'context.json'), build.context);
  // Ready-marker convention (§6): dispatch.json is the LAST file written.
  await atomicWriteJson(nodePath.join(dir, 'dispatch.json'), build.dispatch);
}

/** Atomically write .gateflow/current.json. */
export async function writeCurrent(paths: WorkspacePaths, pointer: CurrentPointer): Promise<void> {
  await atomicWriteJson(paths.current, pointer);
}

/**
 * Read and validate inbox/<dispatchId>/dispatch.json.
 * Returns null when the id is invalid, the file is missing, unparseable or
 * fails schema validation (the ready marker is not satisfied).
 */
export async function readInboxDispatch(paths: WorkspacePaths, dispatchId: string): Promise<Dispatch | null> {
  let file: string;
  try {
    file = nodePath.join(inboxDispatchDir(paths, dispatchId), 'dispatch.json');
  } catch {
    return null;
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = validateDispatch(raw);
  return parsed.ok ? parsed.value : null;
}

/**
 * Read and validate .gateflow/current.json.
 * Returns null when missing, unparseable or invalid.
 */
export async function readCurrent(paths: WorkspacePaths): Promise<CurrentPointer | null> {
  let text: string;
  try {
    text = await readFile(paths.current, 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = validateCurrent(raw);
  return parsed.ok ? parsed.value : null;
}

/** Hex sha256 digest of a UTF-8 string (used for plan_sha256 anchors). */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
