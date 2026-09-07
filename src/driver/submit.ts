/**
 * Producer submit wiring (docs/workspace-protocol.md §9, schema 2): turn a
 * local `.gateflow/submit/` request (TASK.md + submit.json) into a GitHub
 * Issue during every Driver cycle, BEFORE intents are dispatched so new work
 * enters the pipeline first.
 *
 * FROZEN CONSTRAINTS:
 * - A valid request becomes exactly one Issue: title = request.title,
 *   body = TASK.md content + the Producer schema block in the EXACT format
 *   the gate parses (src/gate/markers.ts), labeled `ai:planning` at
 *   creation. That label is issue INITIALIZATION — the producer-created
 *   issue equivalence (the Gate's T0 CREATE path) — and is the ONLY label
 *   write the Driver ever performs; every later transition is Gate-owned.
 * - SCHEMA 2 SUBMIT RECONCILIATION (hardening Phase 5.2, GF-H05): the
 *   submission carries a stable `submission_id` (Driver-injected when the
 *   agent omitted it) and the created issue body embeds
 *   `<!-- gateflow:source-id: submit:<submission_id> -->`. Before ANY
 *   creation — and after EVERY unknown API outcome — the Driver searches the
 *   repository for that source id and ADOPTS the existing issue instead of
 *   re-POSTing. The create-then-crash window therefore self-heals; a title
 *   match is never used (titles collide, source ids don't).
 * - `markSubmitProcessed` runs only after create-or-adopt succeeded, so an
 *   API failure leaves the request in place for the next cycle: a submission
 *   is never silently dropped and never submitted twice.
 * - An invalid request never touches GitHub: it produces (or rewrites)
 *   `submit/error.json` and waits for human cleanup, without being marked
 *   processed.
 *
 * This module imports TYPES from './driver' only (`import type`), so the
 * driver.ts -> submit.ts value import does not create a runtime cycle.
 */
import { resolveWorkspace } from '../workspace/paths';
import { inspectSubmit, markSubmitProcessed, writeSubmitError } from '../workspace/submit';
import { sourceIdComment, findSourceIdInBody, submitOperationId } from '../protocol/records';
import type { SubmitRequest } from '../workspace/protocol';
import type { DriverDeps } from './driver';

/** Result of one `.gateflow/submit/` processing attempt in a cycle. */
export interface SubmitOutcome {
  action: 'empty' | 'created' | 'adopted' | 'invalid' | 'error';
  /** Human-readable explanation for logs and the cycle summary. */
  detail: string;
  /** Set iff action === 'created' | 'adopted'. */
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
 * schema block (gate-parseable, docs/protocol.md 4.1), then the source-id
 * Operation anchor, then a provenance note. Exported for tests.
 */
export function buildSubmitIssueBody(task: string, request: SubmitRequest): string {
  return (
    `${task}\n\n` +
    '<!-- ai-workflow\n' +
    'schema: 2\n' +
    'source: producer\n' +
    `kind: ${request.kind}\n` +
    `maturity_hint: ${request.maturity_hint}\n` +
    '-->' +
    `\n\n${sourceIdComment(submitOperationId(request.submission_id))}` +
    '\n\n> Submitted via GateFlow local submit (.gateflow/submit).\n'
  );
}

/**
 * Search the repository for an issue already carrying this submission's
 * source-id anchor (create-then-crash recovery). Returns the issue number or
 * null. Searches ALL states: a created issue may have been closed meanwhile,
 * and adoption must still win over a duplicate POST.
 */
async function findIssueBySourceId(
  deps: DriverDeps,
  owner: string,
  repo: string,
  operationId: string,
): Promise<number | null> {
  const issues = await deps.client.listIssues({ owner, repo, state: 'all' });
  for (const issue of issues) {
    if (findSourceIdInBody(issue.body) === operationId) {
      return issue.number;
    }
  }
  return null;
}

/**
 * Process `.gateflow/submit/` once (docs/workspace-protocol.md §9):
 * - 'empty'   → no-op;
 * - 'invalid' → (re)write `submit/error.json`, never touch GitHub, never
 *   mark processed (human cleanup required);
 * - 'ready'   → RECONCILE by source id (adopt an existing issue) or create
 *   the Issue via `client.createIssue`, then `markSubmitProcessed`; an API
 *   failure marks nothing and returns 'error' so the next cycle reconciles
 *   first and retries — never a blind second POST.
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
  const operationId = submitOperationId(request.submission_id);
  try {
    // Reconcile FIRST: a previous cycle may have created the issue and died
    // before markSubmitProcessed (or before the API response arrived).
    const existing = await findIssueBySourceId(deps, repositoryInfo.owner, repositoryInfo.repo, operationId);
    if (existing !== null) {
      await markSubmitProcessed(paths);
      deps.log.warning(
        `submit reconciled: issue #${existing} already carries ${operationId}; adopted instead of re-creating`,
      );
      return { action: 'adopted', detail: `adopted existing issue #${existing}`, issueNumber: existing };
    }

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
    // line means the next cycle ADOPTS via the source id (at-least-once +
    // deterministic dedup, hardening Phase 5).
    await markSubmitProcessed(paths);
    deps.log.info(`submit created issue #${number} (${request.kind}/${request.maturity_hint})`);
    return { action: 'created', detail: `issue #${number} created`, issueNumber: number };
  } catch (err) {
    const message = errorMessage(err);
    // Unknown outcome (timeout after POST?) — the request stays unprocessed
    // and the next cycle reconciles by source id before anything else.
    deps.log.error(
      `submit issue creation failed (left unprocessed; next cycle reconciles by ${operationId} first): ${message}`,
    );
    return { action: 'error', detail: message };
  }
}
