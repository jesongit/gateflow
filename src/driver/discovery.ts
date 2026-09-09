/**
 * Discovery: GitHub canonical state → per-issue TaskIntents.
 *
 * FROZEN CONSTRAINTS: the Driver never calls an LLM and never transitions
 * labels — it reads issues/comments and derives what SHOULD be prepared; the
 * driver-state layer decides what actually is. Discovery performs one
 * listComments call per issue and shares it between intent derivation and
 * feedback projection so a cycle is consistently snapshot-based.
 *
 * V1 SIMPLIFICATION: the Driver no longer bootstraps workflow_epoch records.
 * The Gate is the only record issuer; a T0 whose record write failed is
 * healed by re-running /ai-plan (the Gate's PLANNING self-heal path). A
 * planning issue without an epoch record simply derives no intent — fail
 * closed, with a log line.
 */
import type { CommentDetail, DriverGitHubClient, IssueDetail, RepositoryInfo } from '../github/client';
import {
  acceptedFeedbackEvents,
  readIssueRecords,
  type IssueRecordView,
  type HumanFeedbackEntry,
} from '../github/issue-sync';
import type { DriverConfig } from './config';
import { aiLabels, deriveIntents } from './intent';
import type { TaskIntent, IntentContext } from './intent';

/** Everything the preparation layer needs for one issue, computed in one pass. */
export interface Discovery {
  issue: IssueDetail;
  /**
   * The raw comment snapshot the intents were derived from, so preparation
   * can extract the approved Plan body without a second GitHub round-trip.
   */
  comments: CommentDetail[];
  /** Intents to prepare for this issue (0..1 in practice, but list-typed). */
  intents: TaskIntent[];
  /** ACCEPTED feedback events of the current epoch, ascending by comment id. */
  feedback: HumanFeedbackEntry[];
  /** Record view (epoch, approvals, feedback, suspect) for this snapshot. */
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
 * Discover work for ONE issue: list comments once, compute the trusted-human
 * set (config.trustedHumans + repo owner — the owner is always trusted) and
 * derive intents + accepted feedback from the snapshot.
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
  const comments: CommentDetail[] = await client.listComments(ref);
  const gateLogins = new Set(config.gateLogins.map((login) => login.toLowerCase()));
  const records = readIssueRecords(comments, gateLogins);

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
 * skipped by aiLabels/deriveIntents semantics. A per-issue failure (odd
 * GitHub payload, simulated outage) is reported through `log.error` and
 * skips only that issue — one bad issue never aborts the cycle.
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
