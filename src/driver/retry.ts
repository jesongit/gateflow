/**
 * Explicit retry (`gateflow driver retry <dispatch_id>`, docs/
 * workspace-protocol.md §3, frozen): clearing the receipt re-opens the
 * dispatch_id for the next discovery cycle — provided the canonical GitHub
 * state still warrants the intent (labels unchanged). Automatic retries
 * below `max_attempts` need no retry call; they flow through dedup instead.
 *
 * current.json is deliberately left alone: it is a pointer for agents, not
 * state, and the re-dispatch rebuilds the whole inbox directory anyway.
 */
import { clearReceipt } from './dedup';
import type { WorkspacePaths } from '../workspace/paths';

/**
 * Clear the receipt for `dispatchId` so the next cycle re-dispatches it.
 * Returns whether a receipt was actually cleared. Invalid ids (hostile
 * input, traversal attempts) return false — they never touch the filesystem
 * outside the receipts directory.
 */
export async function retryDispatch(paths: WorkspacePaths, dispatchId: string): Promise<boolean> {
  return clearReceipt(paths, dispatchId);
}
