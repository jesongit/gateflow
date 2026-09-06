/**
 * GitHub API access, wrapped behind one narrow interface (docs/protocol.md
 * section 6 / plan section 14: business logic must not scatter raw API calls).
 *
 * - `GitHubClient` is the seam the gate codes against; tests substitute it
 *   with an in-memory mock, so no test ever touches the real GitHub API.
 * - `createGitHubClient` adapts an Octokit instance (as provided by
 *   @actions/github's context) to that interface. The Octokit shape is typed
 *   structurally (`OctokitLike`) to stay decoupled from octokit internals.
 */
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
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
    };
    reactions: {
      createForIssueComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        content: ReactionContent;
      }): Promise<unknown>;
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
}

/** Creates the single GitHubClient used by a gate run. */
export function createGitHubClient(octokit: OctokitLike): GitHubClient {
  return new OctokitGitHubClient(octokit);
}
