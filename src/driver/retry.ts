/**
 * Explicit retry (`gateflow driver retry <dispatch_id>`, docs/
 * workspace-protocol.md §3, schema 2): clearing the receipt re-opens the
 * dispatch_id for the next discovery cycle — provided the canonical GitHub
 * state still warrants the intent (labels unchanged). Automatic retries
 * below `max_attempts` need no retry call; they flow through dedup instead.
 *
 * Hardening §9: an executor dispatch holds the per-workspace executor lock
 * for its whole active life. A retry ends that life, so the lock is released
 * together with the receipt — otherwise the re-dispatch would queue behind a
 * lock held by (a previous run of) the Driver itself forever.
 *
 * current.json is deliberately left alone: it is a pointer for agents, not
 * state, and the re-dispatch rebuilds the whole inbox directory anyway.
 */
import { clearReceipt } from './dedup';
import { releaseLock, executorLockFile, DRIVER_LOCK_HOLDER } from './workspace-lock';
import type { WorkspacePaths } from '../workspace/paths';

/**
 * Clear the receipt for `dispatchId` (and release its executor lock, if any)
 * so the next cycle re-dispatches it. Returns whether a receipt was actually
 * cleared. Invalid ids (hostile input, traversal attempts) return false —
 * they never touch the filesystem outside the receipts directory.
 */
export async function retryDispatch(paths: WorkspacePaths, dispatchId: string): Promise<boolean> {
  const cleared = await clearReceipt(paths, dispatchId);
  if (cleared) {
    // Best-effort: only removes the lock when THIS process still holds it
    // for this dispatch (never another process's or another dispatch's).
    await releaseLock(executorLockFile(paths), DRIVER_LOCK_HOLDER, dispatchId);
  }
  return cleared;
}
