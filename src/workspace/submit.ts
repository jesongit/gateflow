/**
 * Producer submit protocol (docs/workspace-protocol.md §9, frozen).
 *
 * A Producer agent writes `.gateflow/submit/TASK.md` plus
 * `.gateflow/submit/submit.json` when the user explicitly asks for a new
 * task. The Driver inspects the directory during Discovery: a valid pair is
 * turned into a GitHub Issue, then the files are moved into
 * `submit/processed-<timestamp>/` to prevent duplicate submissions. A failed
 * validation produces `submit/error.json` and waits for human cleanup.
 */
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { SubmitRequest } from './protocol';
import type { WorkspacePaths } from './paths';
import { atomicWriteJson } from './inbox';
import { validateSubmit } from './schemas';
import type { Validation } from './schemas';
import { MAX_FILE_BYTES } from './validation';

/** Result of inspecting `.gateflow/submit/`. */
export type SubmitInspection =
  | { status: 'empty' }
  | { status: 'invalid'; error: string }
  | { status: 'ready'; request: SubmitRequest; task: string };

const SUBMIT_JSON = 'submit.json';
const SUBMIT_TASK = 'TASK.md';
const SUBMIT_ERROR = 'error.json';

async function readIfExists(file: string): Promise<{ text: string; size: number } | null> {
  let info;
  try {
    info = await stat(file);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  try {
    return { text: await readFile(file, 'utf8'), size: info.size };
  } catch {
    return null;
  }
}

/**
 * Inspect `.gateflow/submit/`:
 * - missing directory or neither file present -> 'empty';
 * - submit.json missing/invalid, TASK.md missing/empty/oversized, or any
 *   pair mismatch -> 'invalid' with a human-readable reason;
 * - otherwise -> 'ready' with the validated request and TASK.md content.
 */
export async function inspectSubmit(paths: WorkspacePaths): Promise<SubmitInspection> {
  const submitJson = await readIfExists(nodePath.join(paths.submit, SUBMIT_JSON));
  const task = await readIfExists(nodePath.join(paths.submit, SUBMIT_TASK));

  if (submitJson === null && task === null) return { status: 'empty' };
  if (submitJson === null) {
    return { status: 'invalid', error: `${SUBMIT_JSON} is missing while ${SUBMIT_TASK} exists` };
  }
  if (task === null) {
    return { status: 'invalid', error: `${SUBMIT_TASK} is missing while ${SUBMIT_JSON} exists` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(submitJson.text) as unknown;
  } catch (err) {
    return {
      status: 'invalid',
      error: `${SUBMIT_JSON} is not valid JSON: ${(err as Error).message}`,
    };
  }
  const parsed: Validation<SubmitRequest> = validateSubmit(raw);
  if (!parsed.ok) {
    return { status: 'invalid', error: `${SUBMIT_JSON} failed validation: ${parsed.errors.join('; ')}` };
  }

  if (task.text.length === 0) {
    return { status: 'invalid', error: `${SUBMIT_TASK} is empty` };
  }
  if (task.size > MAX_FILE_BYTES) {
    return { status: 'invalid', error: `${SUBMIT_TASK} exceeds ${MAX_FILE_BYTES} bytes` };
  }

  return { status: 'ready', request: parsed.value, task: task.text };
}

/**
 * Move the current submission aside so it cannot be processed twice: create
 * `submit/processed-<sanitized ISO timestamp>/` and move every regular file
 * (except error.json, which signals a failed validation awaiting human
 * cleanup) into it. Creates the submit/ directory first when missing.
 * Returns the new directory name.
 */
export async function markSubmitProcessed(paths: WorkspacePaths): Promise<string> {
  await mkdir(paths.submit, { recursive: true });
  // Colons/dots are invalid or awkward in Windows directory names.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dirName = `processed-${stamp}`;
  const targetDir = nodePath.join(paths.submit, dirName);
  await mkdir(targetDir, { recursive: true });

  const entries = await readdir(paths.submit, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue; // keep processed-* siblings untouched
    if (entry.name === SUBMIT_ERROR) continue; // failed submissions wait for humans
    try {
      await rename(nodePath.join(paths.submit, entry.name), nodePath.join(targetDir, entry.name));
    } catch {
      // The file vanished mid-scan; nothing else to do for it.
    }
  }
  return dirName;
}

/** Atomically write `submit/error.json` describing why a submission was rejected. */
export async function writeSubmitError(paths: WorkspacePaths, error: string): Promise<void> {
  await mkdir(paths.submit, { recursive: true });
  await atomicWriteJson(nodePath.join(paths.submit, SUBMIT_ERROR), {
    error,
    created_at: new Date().toISOString(),
  });
}
