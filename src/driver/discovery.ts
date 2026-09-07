/**
 * Discovery: GitHub canonical state → per-issue DispatchIntents (docs/
 * architecture-v1.md §3, §5).
 *
 * FROZEN CONSTRAINTS: the Driver never calls an LLM and never transitions
 * labels — it reads issues/comments and derives what SHOULD be dispatched;
 * the dedup/receipt layer decides what actually is. Discovery performs one
 * listComments call per issue and shares it between intent derivation and
 * feedback projection so a cycle is consistently snapshot-based.
 *
 * Schema 2 (hardening): discovery also
 *  - reads the issue's Gate-issued records ONCE per cycle and fails the
 *    issue closed on suspect records (unparsable / untrusted author);
 *  - bootstraps a workflow_epoch record for planning issues that lack one
 *    (Driver-issued epoch, docs/plans/v1_hardening_decisions.md §4.1) so
 *    Producer-submitted issues and post-T0 record failures self-heal.
 */
import type { CommentDetail, DriverGitHubClient, IssueDetail, RepositoryInfo } from '../github/client';
import {
  acceptedFeedbackEvents,
  findHumanFeedbackCommands,
  readIssueRecords,
  type IssueRecordView,
  type HumanFeedbackEntry,
} from '../github/issue-sync';
import {
  buildRecordBody,
  epochOperationId,
  type WorkflowEpochRecord,
} from '../protocol/records';
import { newWorkflowEpoch } from '../protocol/epoch';
import type { DriverConfig } from './config';
import { aiLabels, deriveIntents } from './intent';
import type { DispatchIntent, IntentContext } from './intent';

/** Everything the dispatch layer needs for one issue, computed in one pass. */
export interface Discovery {
  issue: IssueDetail;
  /**
   * The raw comment snapshot the intents were derived from, so dispatch can
   * extract the approved Plan body without a second GitHub round-trip.
   */
  comments: CommentDetail[];
  /** Intents to dispatch for this issue (0..1 in practice, but list-typed). */
  intents: DispatchIntent[];
  /** ACCEPTED feedback events of the current epoch, ascending by comment id. */
  feedback: HumanFeedbackEntry[];
  /** Record view (epoch, approvals, feedback, suspect) for this cycle. */
  records: IssueRecordView;
}

/** Split an `owner/name` repository slug; null when malformed. */
export function parseRepositorySlug(repository: string): { owner: string; name: string } | null {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository.trim());
  if (match === null) return null;
  const owner = match[1];
  const name = match[2];
  if (owner === undefined || name === undefined) return null;
  return { owner, name };
}

/**
 * Driver-side epoch bootstrap (schema 2): a planning issue WITHOUT any epoch
 * record gets one issued by the Driver identity (Producer-submitted issues,
 * or a gate T0 whose record write failed). Bootstrapping is idempotent and
 * never touches issues with suspect epoch records — those fail closed.
 * Returns the fresh comment snapshot after a successful bootstrap, or null
 * when no bootstrap happened.
 */
async function bootstrapEpochIfNeeded(
  client: DriverGitHubClient,
  ref: { owner: string; repo: string; issueNumber: number },
  repositoryInfo: RepositoryInfo,
  issue: IssueDetail,
  records: IssueRecordView,
): Promise<CommentDetail[] | null> {
  const labels = aiLabels(issue.labels);
  if (!(labels.length === 1 && labels[0] === 'ai:planning')) return null;
  if (records.epoch !== null) return null;
  if (records.suspect.some((entry) => entry.reason.includes('workflow_epoch'))) return null;
  const identity = await client.getAuthenticatedUser();
  const epoch = newWorkflowEpoch();
  const record: WorkflowEpochRecord = {
    schema: 2,
    kind: 'workflow_epoch',
    repository_id: repositoryInfo.id,
    issue_number: issue.number,
    workflow_epoch: epoch,
    created_at: new Date().toISOString(),
    issued_by: identity.login,
    operation_id: epochOperationId(repositoryInfo.id, issue.number, epoch),
  };
  await client.addIssueComment(ref, buildRecordBody(record));
  // Re-read so this cycle's intents already carry the new epoch.
  return client.listComments(ref);
}

/**
 * Discover work for ONE issue: list comments once, compute the trusted-human
 * set (config.trustedHumans + repo owner — the owner is always trusted,
 * docs/architecture-v1.md §4) and derive intents + accepted feedback from
 * the snapshot.
 */
export async function discoverIssue(
  client: DriverGitHubClient,
  repository: string,
  issue: IssueDetail,
  config: DriverConfig,
  repositoryInfo: RepositoryInfo,
): Promise<Discovery> {
  const slug = parseRepositorySlug(repository);
  if (slug === null) {
    throw new Error(`invalid repository slug: ${JSON.stringify(repository)}`);
  }
  const ref = { owner: slug.owner, repo: slug.name, issueNumber: issue.number };
  let comments: CommentDetail[] = await client.listComments(ref);
  const gateLogins = new Set(config.gateLogins.map((login) => login.toLowerCase()));
  let records = readIssueRecords(comments, gateLogins);

  const bootstrapped = await bootstrapEpochIfNeeded(client, ref, repositoryInfo, issue, records);
  if (bootstrapped !== null) {
    comments = bootstrapped;
    records = readIssueRecords(comments, gateLogins);
  }

  const ctx: IntentContext = {
    repositoryId: repositoryInfo.id,
    repoOwner: slug.owner,
    trustedHumans: new Set([slug.owner.toLowerCase(), ...config.trustedHumans.map((h) => h.toLowerCase())]),
    gateLogins,
  };

  return {
    issue,
    comments,
    intents: deriveIntents(issue, comments, ctx),
    // Only Gate-ACCEPTED feedback events are projected; raw command comments
    // alone are never enough (hardening Phase 3.2).
    feedback: acceptedFeedbackEvents(records, comments, ctx.trustedHumans, slug.owner),
    records,
  };
}

/**
 * Discover work across ALL open issues with exactly one `ai:*` label.
 * Issues are processed sequentially (predictable API usage, deterministic
 * comment id ordering assumptions). Issues with 0 or >1 ai: labels are
 * skipped logless by aiLabels/deriveIntents semantics. A per-issue failure
 * (odd GitHub payload, simulated outage) is reported through `log.error`
 * and skips only that issue — one bad issue never aborts the cycle.
 */
export async function discoverWork(
  client: DriverGitHubClient,
  repository: string,
  config: DriverConfig,
  repositoryInfo: RepositoryInfo,
  log?: { error(msg: string): void },
): Promise<Discovery[]> {
  const slug = parseRepositorySlug(repository);
  if (slug === null) {
    throw new Error(`invalid repository slug: ${JSON.stringify(repository)}`);
  }
  const issues = await client.listIssues({ owner: slug.owner, repo: slug.name });
  const discoveries: Discovery[] = [];
  for (const issue of issues) {
    if (aiLabels(issue.labels).length !== 1) continue;
    try {
      discoveries.push(await discoverIssue(client, repository, issue, config, repositoryInfo));
    } catch (err) {
      log?.error(`discovery failed for issue #${issue.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return discoveries;
}
