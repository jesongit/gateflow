/**
 * Outbox reading (agent writes, Driver reads) and Driver-local receipts.
 *
 * Raw reads only parse JSON; semantic validation lives in validation.ts so
 * the Driver can log and skip invalid files without crashing. Content
 * Markdown files (PLAN.md / PROGRESS.md / REPORT.md) are capped at
 * MAX_FILE_BYTES (512 KB) per the frozen anti-oversized rule (docs §5.7).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { Receipt, ResultFile, StatusFile } from './protocol';
import type { WorkspacePaths } from './paths';
import { outboxDispatchDir } from './paths';
import { atomicWriteJson } from './inbox';
import { MAX_FILE_BYTES, OversizedFileError, validateDispatchDirName } from './validation';
import { validateReceipt } from './schemas';

export { OversizedFileError } from './validation';

/** Markdown files the Driver may read from an outbox directory. */
export type OutboxMarkdownName = 'PLAN.md' | 'PROGRESS.md' | 'REPORT.md';

async function readOutboxJson(paths: WorkspacePaths, dispatchId: string, fileName: string): Promise<unknown | null> {
  let file: string;
  try {
    file = nodePath.join(outboxDispatchDir(paths, dispatchId), fileName);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Read raw outbox status.json. No semantic validation here — run
 * validation.validateOutboxStatus before trusting the value.
 * Returns null when missing or unparseable.
 */
export async function readOutboxStatus(paths: WorkspacePaths, dispatchId: string): Promise<StatusFile | null> {
  const raw = await readOutboxJson(paths, dispatchId, 'status.json');
  return raw === null ? null : (raw as StatusFile);
}

/**
 * Read raw outbox result.json. No semantic validation here — run
 * validation.validateOutboxResult before trusting the value.
 * Returns null when missing or unparseable.
 */
export async function readOutboxResult(paths: WorkspacePaths, dispatchId: string): Promise<ResultFile | null> {
  const raw = await readOutboxJson(paths, dispatchId, 'result.json');
  return raw === null ? null : (raw as ResultFile);
}

/**
 * Read a Markdown content file from the outbox. `name` is restricted at the
 * type level to PLAN.md | PROGRESS.md | REPORT.md. Returns null when the
 * file is missing or empty; throws OversizedFileError when the file exceeds
 * MAX_FILE_BYTES (checked on the stat size before reading).
 */
export async function readOutboxMarkdown(
  paths: WorkspacePaths,
  dispatchId: string,
  name: OutboxMarkdownName,
): Promise<string | null> {
  let file: string;
  try {
    file = nodePath.join(outboxDispatchDir(paths, dispatchId), name);
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

/**
 * List dispatch ids that have an outbox directory. Only names matching the
 * frozen dispatch_id grammar are returned; junk directories are ignored.
 */
export async function listOutboxDispatchIds(paths: WorkspacePaths): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(paths.outbox, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && validateDispatchDirName(entry.name)) {
      ids.push(entry.name);
    }
  }
  return ids.sort();
}

function receiptFile(paths: WorkspacePaths, dispatchId: string): string {
  return nodePath.join(paths.receipts, `${dispatchId}.json`);
}

/**
 * Read and validate receipts/<dispatchId>.json.
 * Returns null when the id is invalid, the file is missing, unparseable or
 * fails schema validation. Receipts are a rebuildable cache, so loss is
 * never fatal.
 */
export async function readReceipt(paths: WorkspacePaths, dispatchId: string): Promise<Receipt | null> {
  if (!validateDispatchDirName(dispatchId)) return null;
  let text: string;
  try {
    text = await readFile(receiptFile(paths, dispatchId), 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = validateReceipt(raw);
  return parsed.ok ? parsed.value : null;
}

/** Atomically write receipts/<dispatchId>.json. Throws on invalid ids. */
export async function writeReceipt(paths: WorkspacePaths, receipt: Receipt): Promise<void> {
  if (!validateDispatchDirName(receipt.dispatch_id)) {
    throw new Error(`invalid dispatch id: ${JSON.stringify(receipt.dispatch_id)}`);
  }
  await atomicWriteJson(receiptFile(paths, receipt.dispatch_id), receipt);
}

/** List all valid receipts currently on disk, sorted by dispatch_id. */
export async function listReceipts(paths: WorkspacePaths): Promise<Receipt[]> {
  let entries;
  try {
    entries = await readdir(paths.receipts, { withFileTypes: true });
  } catch {
    return [];
  }
  const receipts: Receipt[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const dispatchId = entry.name.slice(0, -'.json'.length);
    const receipt = await readReceipt(paths, dispatchId);
    if (receipt !== null) receipts.push(receipt);
  }
  return receipts.sort((a, b) => a.dispatch_id.localeCompare(b.dispatch_id));
}
