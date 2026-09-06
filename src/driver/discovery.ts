/**
 * Discovery: GitHub canonical state → per-issue DispatchIntents (docs/
 * architecture-v1.md §3, §5).
 *
 * FROZEN CONSTRAINTS: the Driver never calls an LLM and never transitions
 * labels — it reads issues/comments and derives what SHOULD be dispatched;
 * the dedup/receipt layer decides what actually is. Discovery performs one
 * listComments call per issue and shares it between intent derivation and
 * feedback projection so a cycle is consistently snapshot-based.
 */
import type { CommentDetail, DriverGitHubClient, IssueDetail } from '../github/client';
import { findHumanFeedbackCommands } from '../github/issue-sync';
import type { HumanFeedbackEntry } from '../github/issue-sync';
import type { DriverConfig } from './config';
import { aiLabels, deriveIntents } from './intent';
import type { DispatchIntent } from './intent';

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
  /** Trusted-human feedback commands (/change, /choose), ascending by id. */
  feedback: HumanFeedbackEntry[];
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
 * set (config.trustedHumans + repo owner — the owner is always trusted, docs/
 * architecture-v1.md §4) and derive intents + feedback from the snapshot.
 */
export async function discoverIssue(
  client: DriverGitHubClient,
  repository: string,
  issue: IssueDetail,
  config: DriverConfig,
): Promise<Discovery> {
  const slug = parseRepositorySlug(repository);
  if (slug === null) {
    throw new Error(`invalid repository slug: ${JSON.stringify(repository)}`);
  }
  const ref = { owner: slug.owner, repo: slug.name, issueNumber: issue.number };
  const comments: CommentDetail[] = await client.listComments(ref);
  const trustedHumans = new Set(config.trustedHumans);
  return {
    issue,
    comments,
    intents: deriveIntents(issue, comments, trustedHumans, slug.owner),
    feedback: findHumanFeedbackCommands(comments, trustedHumans, slug.owner),
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
  log?: { error(msg: string): void },
): Promise<Discovery[]> {
  const slug = parseRepositorySlug(repository);
  if (slug === null) {
    throw new Error(`invalid repository slug: ${JSON.stringify(repository)}`);
  }
  const issues = await client.listOpenIssues({ owner: slug.owner, repo: slug.name });
  const discoveries: Discovery[] = [];
  for (const issue of issues) {
    if (aiLabels(issue.labels).length !== 1) continue;
    try {
      discoveries.push(await discoverIssue(client, repository, issue, config));
    } catch (err) {
      log?.error(`discovery failed for issue #${issue.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return discoveries;
}
