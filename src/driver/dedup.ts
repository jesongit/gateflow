/**
 * dispatch_id deduplication over the Driver-local receipts cache (docs/
 * workspace-protocol.md §3 + §2.6, frozen).
 *
 * Rules:
 * - no receipt → dispatch is allowed (fresh dispatch or post-retry).
 * - receipt dispatched | syncing | synced → NEVER re-dispatch (synced also
 *   blocks result replay at the sync layer, docs §8.4).
 * - receipt failed with attempts < maxAttempts → automatic retry allowed;
 *   at/after the ceiling → no dispatch without an explicit
 *   `gateflow driver retry <dispatch_id>`.
 *
 * Receipts are a rebuildable cache (docs §2.6): clearing one never destroys
 * official state — GitHub stays the single source of truth.
 */
import { unlink } from 'node:fs/promises';

import type { Receipt } from '../workspace/protocol';
import { validateDispatchDirName } from '../workspace/validation';
import type { WorkspacePaths } from '../workspace/paths';

/** Verdict on whether a dispatch_id may be (re)dispatched right now. */
export function shouldDispatch(
  existing: Receipt | null,
  maxAttempts: number,
): { ok: boolean; reason: string } {
  if (existing === null) {
    return { ok: true, reason: 'new' };
  }
  switch (existing.status) {
    case 'dispatched':
    case 'syncing':
      return { ok: false, reason: 'already-dispatched' };
    case 'synced':
      return { ok: false, reason: 'synced' };
    case 'failed':
      if (existing.attempts < maxAttempts) {
        return { ok: true, reason: 'retry' };
      }
      return { ok: false, reason: 'retry-limit' };
  }
}

/**
 * Delete receipts/<dispatchId>.json so the next cycle may re-dispatch.
 * Returns false when the id is invalid (hostile input) or the receipt does
 * not exist; never throws on absence.
 */
export async function clearReceipt(paths: WorkspacePaths, dispatchId: string): Promise<boolean> {
  if (!validateDispatchDirName(dispatchId)) {
    return false;
  }
  try {
    await unlink(`${paths.receipts}/${dispatchId}.json`);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}
