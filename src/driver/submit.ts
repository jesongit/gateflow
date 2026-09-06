/**
 * Producer submit wiring (docs/workspace-protocol.md §9, frozen): turn a
 * local `.gateflow/submit/` request (TASK.md + submit.json) into a GitHub
 * Issue during every Driver cycle, BEFORE intents are dispatched so new work
 * enters the pipeline first.
 *
 * FROZEN CONSTRAINTS:
 * - A valid request becomes exactly one Issue: title = request.title,
 *   body = TASK.md content + the Producer schema block in the EXACT format
 *   the gate parses (src/gate/markers.ts), labeled `ai:planning` at
 *   creation. That label is issue INITIALIZATION — the V0 producer-created
 *   issue equivalence (the Gate's T0 CREATE path) — and is the ONLY label
 *   write the Driver ever performs; every later transition is Gate-owned.
 * - `markSubmitProcessed` runs only after a successful create, so an API
 *   failure leaves the request in place and the next cycle retries it: a
 *   submission is never silently dropped and never submitted twice.
 * - An invalid request never touches GitHub: it produces (or rewrites)
 *   `submit/error.json` and waits for human cleanup, without being marked
 *   processed.
 *
 * This module imports TYPES from './driver' only (`import type`), so the
 * driver.ts -> submit.ts value import does not create a runtime cycle.
 */
import { resolveWorkspace } from '../workspace/paths';
import { inspectSubmit, markSubmitProcessed, writeSubmitError } from '../workspace/submit';
import type { SubmitRequest } from '../workspace/protocol';
import type { DriverDeps } from './driver';

/** Result of one `.gateflow/submit/` processing attempt in a cycle. */
export interface SubmitOutcome {
  action: 'empty' | 'created' | 'invalid' | 'error';
  /** Human-readable explanation for logs and the cycle summary. */
  detail: string;
  /** Set iff action === 'created'. */
  issueNumber?: number;
}

/**
 * The single label the Driver ever writes, applied at issue creation only
 * (docs/workspace-protocol.md §9: "直接打 ai:planning，等价 T0 的 Producer
 * CREATE 路径").
 */
const SUBMIT_LABELS: readonly string[] = ['ai:planning'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the created-issue body: TASK.md content verbatim, then the Producer
 * schema block (gate-parseable, docs/protocol.md 4.1), then a provenance
 * note. Exported for tests.
 */
export function buildSubmitIssueBody(task: string, request: SubmitRequest): string {
  return (
    `${task}\n\n` +
    '<!-- ai-workflow\n' +
    'schema: 1\n' +
    'source: producer\n' +
    `kind: ${request.kind}\n` +
    `maturity_hint: ${request.maturity_hint}\n` +
    '-->' +
    '\n\n> Submitted via GateFlow local submit (.gateflow/submit).\n'
  );
}

/**
 * Process `.gateflow/submit/` once (docs/workspace-protocol.md §9):
 * - 'empty'   → no-op;
 * - 'invalid' → (re)write `submit/error.json`, never touch GitHub, never
 *   mark processed (human cleanup required);
 * - 'ready'   → create the Issue via `client.createIssue`, then
 *   `markSubmitProcessed` so the request is never re-submitted; an API
 *   failure marks nothing and returns 'error' so the next cycle retries.
 * Per-request failures are returned, never thrown; the cycle's
 * infrastructure contract (workspace unreadable) still propagates.
 */
export async function processSubmit(
  deps: DriverDeps,
  repositoryInfo: { owner: string; repo: string; id: number },
): Promise<SubmitOutcome> {
  const paths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);
  const inspection = await inspectSubmit(paths);

  if (inspection.status === 'empty') {
    return { action: 'empty', detail: 'no pending submission' };
  }

  if (inspection.status === 'invalid') {
    // Always rewrite so error.json reflects the CURRENT reason (a request
    // that was fixed differently still gets a fresh explanation). No Issue,
    // no markSubmitProcessed — §9 waits for human cleanup.
    await writeSubmitError(paths, inspection.error);
    deps.log.warning(`submit rejected: ${inspection.error}`);
    return { action: 'invalid', detail: inspection.error };
  }

  const { request, task } = inspection;
  try {
    const { number } = await deps.client.createIssue(
      { owner: repositoryInfo.owner, repo: repositoryInfo.repo },
      {
        title: request.title,
        body: buildSubmitIssueBody(task, request),
        labels: [...SUBMIT_LABELS],
      },
    );
    // Only now is the request done: renaming submit/ aside guarantees the
    // issue is never created twice for one submission. A crash before this
    // line means the next cycle retries (at-least-once, §9).
    await markSubmitProcessed(paths);
    deps.log.info(`submit created issue #${number} (${request.kind}/${request.maturity_hint})`);
    return { action: 'created', detail: `issue #${number} created`, issueNumber: number };
  } catch (err) {
    const message = errorMessage(err);
    deps.log.error(`submit issue creation failed (left unprocessed, will retry next cycle): ${message}`);
    return { action: 'error', detail: message };
  }
}
