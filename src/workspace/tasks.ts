/**
 * Task directory construction and reading (protocol schema 3).
 *
 * ONE directory per task holds driver-written inputs and agent-written
 * outputs. There is no inbox/outbox split anymore; the security boundary is
 * the driver-private input snapshot hash (see inputSnapshotSha256): before
 * syncing, the Driver recomputes the hash of the input files as they are NOW
 * on disk and refuses to sync when an agent modified them.
 *
 * All writes are atomic: content goes to a sibling temp file in the same
 * directory, is flushed, and is then renamed over the target. On Windows a
 * rename over an existing file can fail transiently with EPERM/EACCES/EBUSY,
 * so the rename retries after unlinking the target.
 *
 * Ready-marker convention: when (re)building a task directory, task.json is
 * written LAST. An agent only starts working once task.json parses and
 * current.json points at the task.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { CurrentPointer, ResultFile, TaskFile } from './protocol';
import { taskDir } from './paths';
import type { WorkspacePaths } from './paths';
import { MAX_FILE_BYTES, OversizedFileError, validateCurrent, validateTaskFile } from './validation';

/** A full task build payload: everything one task projects to disk. */
export interface TaskBuild {
  taskFile: TaskFile;
  /** Full task.md content. */
  task: string;
  /** Full plan.md INPUT content, execute tasks only (null for plan tasks). */
  plan: string | null;
  /** Full feedback.md content, null when there is no feedback to project. */
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
 * (Re)build tasks/<task.task_id>/ atomically: task.md, plan.md (execute
 * tasks), feedback.md (when present), and finally task.json as the ready
 * marker. Existing files are overwritten; a missing directory is created.
 * Only ever called with IDENTICAL content for the same task id (the caller
 * refuses changed-input rebuilds), so an overwrite can never clobber a
 * running task's inputs with different bytes.
 */
export async function writeTaskDir(paths: WorkspacePaths, build: TaskBuild): Promise<void> {
  const dir = taskDir(paths, build.taskFile.task_id);
  await mkdir(dir, { recursive: true });
  await atomicWriteText(nodePath.join(dir, 'task.md'), build.task);
  if (build.plan !== null) {
    await atomicWriteText(nodePath.join(dir, 'plan.md'), build.plan);
  }
  if (build.feedback !== null) {
    await atomicWriteText(nodePath.join(dir, 'feedback.md'), build.feedback);
  }
  // Ready-marker convention: task.json is the LAST file written.
  await atomicWriteJson(nodePath.join(dir, 'task.json'), build.taskFile);
}

/** Hex sha256 digest of a UTF-8 string (used for snapshots and plan hashes). */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Frozen input snapshot hash (schema 3): sha256 over the canonical JSON of
 * the task's INPUT content — task.md, the execute-mode plan.md input, and
 * feedback.md (null when absent). In plan mode plan.md is the agent's OUTPUT
 * and is never part of the snapshot. The Driver stores this hash in its
 * private state at preparation time; a sync whose on-disk inputs hash
 * differently is refused instead of silently publishing from tampered input.
 */
export function inputSnapshotSha256(content: { task: string; plan: string | null; feedback: string | null }): string {
  return sha256Hex(
    JSON.stringify({ task: content.task, plan: content.plan, feedback: content.feedback }),
  );
}

/**
 * Read and validate tasks/<taskId>/task.json.
 * Returns null when the id is invalid, the file is missing, unparseable or
 * fails schema validation (the ready marker is not satisfied).
 */
export async function readTaskFile(paths: WorkspacePaths, taskId: string): Promise<TaskFile | null> {
  let file: string;
  try {
    file = nodePath.join(taskDir(paths, taskId), 'task.json');
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
  const parsed = validateTaskFile(raw);
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

/** Atomically write .gateflow/current.json. */
export async function writeCurrent(paths: WorkspacePaths, pointer: CurrentPointer): Promise<void> {
  await atomicWriteJson(paths.current, pointer);
}

/**
 * Read a UTF-8 file from a task directory, rejecting symlinks-ish content
 * only by size. Returns null when missing or empty; throws
 * OversizedFileError when the file exceeds MAX_FILE_BYTES (checked on the
 * stat size before reading). `name` is restricted to the protocol file set.
 */
async function readTaskFileByName(
  paths: WorkspacePaths,
  taskId: string,
  name: 'task.md' | 'plan.md' | 'feedback.md' | 'report.md',
): Promise<string | null> {
  let file: string;
  try {
    file = nodePath.join(taskDir(paths, taskId), name);
  } catch {
    return null;
  }
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    size = info.size;
  } catch {
    return null;
  }
  if (size > MAX_FILE_BYTES) {
    throw new OversizedFileError(file, size, MAX_FILE_BYTES);
  }
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  if (content.length === 0) return null;
  return content;
}

/** Read the CURRENT content of an input file (for snapshot re-verification). */
export function readInputMarkdown(
  paths: WorkspacePaths,
  taskId: string,
  name: 'task.md' | 'plan.md' | 'feedback.md',
): Promise<string | null> {
  return readTaskFileByName(paths, taskId, name);
}

/** Read the agent-written output content (plan.md / report.md). */
export function readOutputMarkdown(
  paths: WorkspacePaths,
  taskId: string,
  name: 'plan.md' | 'report.md',
): Promise<string | null> {
  return readTaskFileByName(paths, taskId, name);
}

/**
 * Read the raw result.json of a task, distinguishing "absent" (null) from
 * "present but unparseable/oversized" ({ raw: null, error }) — an
 * unparseable machine file is a validation failure (rejected), never a
 * silent no-op.
 */
export async function readResultJson(
  paths: WorkspacePaths,
  taskId: string,
): Promise<{ raw: unknown; error: string | null } | null> {
  let file: string;
  try {
    file = nodePath.join(taskDir(paths, taskId), 'result.json');
  } catch {
    return null;
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null; // absent (or unreadable) → treated as absent
  }
  // Size bound before JSON.parse: a hostile agent must not be able to force
  // arbitrarily large allocations through a machine file.
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    return { raw: null, error: `result.json exceeds the ${MAX_FILE_BYTES}-byte limit` };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null) {
      // JSON.parse('null') succeeds but `null` is never a valid machine file
      // object; treat it as malformed instead of "absent".
      return { raw: null, error: 'result.json is not a JSON object' };
    }
    return { raw: parsed, error: null };
  } catch (err) {
    return { raw: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Convenience type re-export for callers that inspect a parsed result. */
export type { ResultFile };
