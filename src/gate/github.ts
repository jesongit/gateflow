/**
 * GitHub API access, wrapped behind one narrow interface (docs/protocol.md
 * section 6 / plan section 14: business logic must not scatter raw API calls).
 *
 * - `GitHubClient` is the seam the gate codes against; tests substitute it
 *   with an in-memory mock, so no test ever touches the real GitHub API.
 * - `createGitHubClient` adapts an Octokit instance (as provided by
 *   @actions/github's context) to that interface. The Octokit shape is typed
 *   structurally (`OctokitLike`) to stay decoupled from octokit internals.
 *
 * V1 additions (plan-ID approval hardening): `getComment` and `listComments`
 * give the gate read access to issue comments so the /approve target can be
 * validated against the issue's plan-marker comment history. Both are
 * read-only; the gate still never edits plan comments.
 */
import type { GateComment } from './approvals';

/** Identifies the target issue of every API call in a gate run. */
export interface IssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
}

/** Reaction contents used by the gate. Phase 2 wires them as feedback. */
export type ReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'confused'
  | 'heart'
  | 'hooray'
  | 'rocket'
  | 'eyes';

/** Minimal issue information the gate needs, freshly read from the API. */
export interface IssueInfo {
  state: string;
  labels: string[];
}

/** The authenticated identity behind the gate's token (the Gate identity). */
export interface AuthenticatedUser {
  id: number;
  login: string;
}

/** Repository + owner identity, used for the Organization permission rule. */
export interface RepoIdentity {
  owner: string;
  ownerType: string;
  /** Repository database id; 0 when the API omits it. */
  id: number;
}

/** The only GitHub operations the gate is allowed to perform. */
export interface GitHubClient {
  /** Fetches the issue (state + labels) via the API. */
  getIssue(ref: IssueRef): Promise<IssueInfo>;
  /**
   * Re-reads the issue's current labels via the API. The gate MUST call this
   * immediately before any state migration and never trust the event payload
   * snapshot (protocol section 7).
   */
  getLabels(ref: IssueRef): Promise<string[]>;
  /** Adds labels to the issue (no-op for an empty list). */
  addLabels(ref: IssueRef, labels: string[]): Promise<void>;
  /** Removes one label; removing an already-absent label is a success. */
  removeLabel(ref: IssueRef, label: string): Promise<void>;
  /** Adds a reaction to an issue comment (Phase 2 feedback channel). */
  addReaction(ref: IssueRef, commentId: number, content: ReactionContent): Promise<void>;
  /** Edits an issue comment body (reserved for later phases). */
  editComment(ref: IssueRef, commentId: number, body: string): Promise<void>;
  /**
   * Fetches a single issue comment by id (V1 approval validation). Returns
   * null when the comment does not exist (404); any other failure propagates
   * as an infrastructure error.
   */
  getComment(ref: IssueRef, commentId: number): Promise<GateComment | null>;
  /**
   * Lists ALL comments of the issue, id-ascending (V1 approval validation:
   * the chronological order establishes which plan marker is the current
   * plan). Paginates at 100 per page, at most 10 pages (1000 comments —
   * protocol comments per issue stay far below this in practice).
   */
  listComments(ref: IssueRef): Promise<GateComment[]>;
  /**
   * Publishes a new issue comment (schema 2: Gate-issued records — epoch /
   * approval / feedback_accepted). Returns the created comment id.
   */
  addComment(ref: IssueRef, body: string): Promise<{ id: number }>;
  /**
   * The authenticated user behind the gate's token. This is the GATE IDENTITY
   * written into every record the gate issues (docs/plans/
   * v1_hardening_decisions.md §3): authorization records issued by any other
   * identity are untrusted by construction.
   */
  getAuthenticatedUser(): Promise<AuthenticatedUser>;
  /**
   * Repository + owner identity via the API (owner TYPE included). The
   * Organization rule (hardening GF-H10) must verify the owner type against
   * the API, never against the event payload.
   */
  getRepoIdentity(ref: { owner: string; repo: string }): Promise<RepoIdentity>;
}

/** Structural subset of Octokit used by the adapter below. */
export interface OctokitLike {
  rest: {
    issues: {
      get(params: {
        owner: string;
        repo: string;
        issue_number: number;
      }): Promise<{ data: { state?: string; labels?: ReadonlyArray<string | { name?: string | null }> } }>;
      listLabelsOnIssue(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
      }): Promise<{ data: ReadonlyArray<{ name?: string | null }> }>;
      addLabels(params: {
        owner: string;
        repo: string;
        issue_number: number;
        labels: string[];
      }): Promise<unknown>;
      removeLabel(params: {
        owner: string;
        repo: string;
        issue_number: number;
        name: string;
      }): Promise<unknown>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<{ data: { id?: number } }>;
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
      getComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
      }): Promise<{
        data: {
          id?: number;
          user?: { login?: string } | null;
          body?: string | null;
        };
      }>;
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: ReadonlyArray<{
          id?: number;
          user?: { login?: string } | null;
          body?: string | null;
        }>;
      }>;
    };
    reactions: {
      createForIssueComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        content: ReactionContent;
      }): Promise<unknown>;
    };
    users: {
      getAuthenticated(params: {}): Promise<{
        data: { id?: number; login?: string };
      }>;
    };
    repos: {
      get(params: { owner: string; repo: string }): Promise<{
        data: { id?: number; owner?: { login?: string; type?: string } };
      }>;
    };
  };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: unknown }).status === 404
  );
}

function labelNames(labels: ReadonlyArray<string | { name?: string | null }> | undefined): string[] {
  if (!labels) {
    return [];
  }
  const names: string[] = [];
  for (const label of labels) {
    const name = typeof label === 'string' ? label : (label.name ?? '');
    if (name.length > 0) {
      names.push(name);
    }
  }
  return names;
}

/** Maps a raw REST comment object onto the minimal GateComment shape. */
function toGateComment(raw: {
  id?: number;
  user?: { login?: string } | null;
  body?: string | null;
}): GateComment {
  return {
    id: raw.id ?? 0,
    user: raw.user?.login ?? 'unknown',
    body: raw.body ?? '',
  };
}

/** Octokit-backed GitHubClient; a single client instance serves the whole run. */
export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: OctokitLike;

  constructor(octokit: OctokitLike) {
    this.octokit = octokit;
  }

  async getIssue(ref: IssueRef): Promise<IssueInfo> {
    const { data } = await this.octokit.rest.issues.get({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
    });
    return { state: data.state ?? 'unknown', labels: labelNames(data.labels) };
  }

  async getLabels(ref: IssueRef): Promise<string[]> {
    const { data } = await this.octokit.rest.issues.listLabelsOnIssue({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      per_page: 100,
    });
    return data.map((label) => label.name ?? '').filter((name) => name.length > 0);
  }

  async addLabels(ref: IssueRef, labels: string[]): Promise<void> {
    if (labels.length === 0) {
      return;
    }
    await this.octokit.rest.issues.addLabels({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      labels: [...labels],
    });
  }

  async removeLabel(ref: IssueRef, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        name: label,
      });
    } catch (err) {
      // A concurrent serialized run (or a manual cleanup) may already have
      // removed the label; that race is a success for us. Anything else
      // (auth, network, rate limit) is an infrastructure error -> rethrow.
      if (isNotFound(err)) {
        return;
      }
      throw err;
    }
  }

  async addReaction(ref: IssueRef, commentId: number, content: ReactionContent): Promise<void> {
    await this.octokit.rest.reactions.createForIssueComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: commentId,
      content,
    });
  }

  async editComment(ref: IssueRef, commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: commentId,
      body,
    });
  }

  async getComment(ref: IssueRef, commentId: number): Promise<GateComment | null> {
    try {
      const { data } = await this.octokit.rest.issues.getComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: commentId,
      });
      return toGateComment(data);
    } catch (err) {
      // A referenced comment that no longer exists (deleted, or an id from
      // another repository) is a validation failure of the /approve target,
      // not an infrastructure error: the gate treats null as "not found".
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  async listComments(ref: IssueRef): Promise<GateComment[]> {
    const comments: GateComment[] = [];
    // 100 per page, at most 10 pages: the protocol keeps comment counts per
    // issue far below 1000; the cap guards against runaway pagination.
    const perPage = 100;
    const maxPages = 10;
    for (let page = 1; page <= maxPages; page += 1) {
      const { data } = await this.octokit.rest.issues.listComments({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: perPage,
        page,
      });
      for (const raw of data) {
        comments.push(toGateComment(raw));
      }
      if (data.length < perPage) {
        break;
      }
    }
    // Chronological order by comment id is the plan-revision order the
    // approval validation relies on; do not trust the API sort parameter.
    comments.sort((a, b) => a.id - b.id);
    return comments;
  }

  async addComment(ref: IssueRef, body: string): Promise<{ id: number }> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      body,
    });
    return { id: data.id ?? 0 };
  }

  async getAuthenticatedUser(): Promise<AuthenticatedUser> {
    const { data } = await this.octokit.rest.users.getAuthenticated({});
    return { id: data.id ?? 0, login: data.login ?? 'unknown' };
  }

  async getRepoIdentity(ref: { owner: string; repo: string }): Promise<RepoIdentity> {
    const { data } = await this.octokit.rest.repos.get({ owner: ref.owner, repo: ref.repo });
    return {
      owner: data.owner?.login ?? ref.owner,
      ownerType: data.owner?.type ?? 'unknown',
      id: data.id ?? 0,
    };
  }
}

/** Creates the single GitHubClient used by a gate run. */
export function createGitHubClient(octokit: OctokitLike): GitHubClient {
  return new OctokitGitHubClient(octokit);
}
