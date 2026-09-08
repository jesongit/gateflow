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
 *  - reads the issue's Gate-issued records ONCE per cycle through the SHARED
 *    issue-bound record view (V1.1 Phase 1 §4.6) and fails the issue closed
 *    on suspect records (unparsable / untrusted author / forged epoch);
 *  - bootstraps a workflow_epoch record for planning issues that lack one
 *    (V1.1 Phase 2: `created_by: "driver_bootstrap"`, ONLY when the Driver
 *    identity is an explicit bootstrap issuer) so Producer-submitted issues
 *    and post-T0 record failures self-heal. Bootstrapping is idempotent via
 *    the deterministic `epoch:<repo>:<issue>:bootstrap` operation id: a
 *    timeout after create is resolved by search-and-adopt on the next cycle
 *    (Phase 3/6), never by minting a second epoch.
 */
import type { CommentDetail, DriverGitHubClient, IssueDetail, RepositoryInfo } from '../github/client';
import {
  acceptedFeedbackEvents,
  readIssueRecordsForIssue,
  type IssueRecordView,
  type HumanFeedbackEntry,
} from '../github/issue-sync';
import {
  buildRecordBody,
  bootstrapEpochOperationId,
  type WorkflowEpochRecord,
} from '../protocol/records';
import { findEpochRecordByOperationId } from '../protocol/workflow-chain';
import { bootstrapDriverSetOf } from '../protocol/identity';
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
  /** Record view (epoch, approvals, feedback, transitions, suspect) for this cycle. */
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
 * The Bootstrap Driver issuer set of one repository (V1.1 Phase 2): explicit
 * `bootstrap_drivers` config; default = the owner of a personal (User-type,
 * API-verified) repository; empty for anything else (fail closed).
 */
export function bootstrapIssuersFor(
  config: DriverConfig,
  repositoryInfo: Pick<RepositoryInfo, 'owner' | 'ownerType'>,
): ReadonlySet<string> {
  return bootstrapDriverSetOf({
    owner: repositoryInfo.owner,
    ownerType: repositoryInfo.ownerType,
    bootstrapDrivers: config.bootstrapDrivers,
  });
}

/**
 * Driver-side epoch bootstrap (schema 2 + V1.1 Phase 2/3): a planning issue
 * WITHOUT any epoch record gets one issued by an explicit Bootstrap Driver
 * identity (Producer-submitted issues, or a gate T0 whose record write
 * failed). Bootstrapping NEVER touches issues with suspect epoch records —
 * those fail closed — and never runs when the Driver identity itself is not
 * an allowed bootstrap issuer.
 */
async function bootstrapEpochIfNeeded(
  client: DriverGitHubClient,
  ref: { owner: string; repo: string; issueNumber: number },
  repositoryInfo: RepositoryInfo,
  issue: IssueDetail,
  records: IssueRecordView,
  comments: ReadonlyArray<CommentDetail>,
  bootstrapIssuers: ReadonlySet<string>,
): Promise<CommentDetail[] | null> {
  const labels = aiLabels(issue.labels);
  if (!(labels.length === 1 && labels[0] === 'ai:planning')) return null;
  if (records.epoch !== null) return null;
  // Fail closed on suspect records: never bootstrap over possible tampering.
  if (records.suspect.length > 0) return null;
  const identity = await client.getAuthenticatedUser();
  if (!bootstrapIssuers.has(identity.login.trim().toLowerCase())) {
    return null; // not an allowed bootstrap issuer: the gate must issue the epoch
  }
  const operationId = bootstrapEpochOperationId(repositoryInfo.id, issue.number);
  // Search-then-adopt (Phase 6): a previous attempt may have persisted the
  // record but lost the response — adopt instead of minting a second epoch.
  const existing = findEpochRecordByOperationId(comments, operationId);
  if (!existing.found && existing.conflict) {
    return null; // conflicting bootstrap epochs: fail closed, gate/operator decides
  }
  if (!existing.found) {
    const record: WorkflowEpochRecord = {
      schema: 2,
      kind: 'workflow_epoch',
      repository_id: repositoryInfo.id,
      issue_number: issue.number,
      workflow_epoch: newWorkflowEpoch(),
      created_by: 'driver_bootstrap',
      created_at: new Date().toISOString(),
      issued_by: identity.login,
      operation_id: operationId,
    };
    await client.addIssueComment(ref, buildRecordBody(record));
  }
  // Re-read so this cycle's intents already carry the (new or adopted) epoch.
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
  const gateLogins = new Set(config.gateLogins.map((login) => login.trim().toLowerCase()));
  const bootstrapIssuers = bootstrapIssuersFor(config, repositoryInfo);
  let records = readIssueRecordsForIssue(comments, {
    repositoryId: repositoryInfo.id,
    issueNumber: issue.number,
    gateLogins,
    bootstrapIssuers,
  });

  const bootstrapped = await bootstrapEpochIfNeeded(
    client,
    ref,
    repositoryInfo,
    issue,
    records,
    comments,
    bootstrapIssuers,
  );
  if (bootstrapped !== null) {
    comments = bootstrapped;
    records = readIssueRecordsForIssue(comments, {
      repositoryId: repositoryInfo.id,
      issueNumber: issue.number,
      gateLogins,
      bootstrapIssuers,
    });
  }

  const ctx: IntentContext = {
    repositoryId: repositoryInfo.id,
    repoOwner: slug.owner,
    trustedHumans: new Set([slug.owner.toLowerCase(), ...config.trustedHumans.map((h) => h.toLowerCase())]),
    gateLogins,
    bootstrapIssuers,
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
