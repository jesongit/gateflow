/**
 * Driver-side GitHub access layer (`src/github/` ！ deliberately independent
 * of the gate's src/gate/github.ts).
 *
 * READ-ONLY + COMMENTS BY DESIGN: the Gate ！ a GitHub Action ！ owns ALL state
 * transitions and every `ai:*` label write. The local Driver therefore has NO
 * label-write, NO issue create/edit/close and NO comment-deletion methods; it
 * may only
 *   - read canonical state (repository identity, issues, comments), and
 *   - publish protocol comments (plan / execution tracker / completion
 *     report) and edit its OWN tracker comment body.
 * Publishing logic itself lives in ./issue-sync.ts; this module is the raw
 * seam the rest of the Driver codes against so no business logic scatters
 * raw API calls.
 *
 * The Octokit instance is typed STRUCTURALLY (`OctokitRest`): only the
 * endpoints used below are declared, so unit tests pass plain fakes and the
 * production code stays decoupled from octokit internals. `createOctokit` is
 * the only place that touches the real `octokit` package; its result is
 * structurally compatible with the seam.
 */
import { Octokit } from 'octokit';

/** Identifies the target issue of every API call. */
export interface IssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
}

/** Repository identity the Driver needs (task ids embed the `id`). */
export interface RepositoryInfo {
  owner: string;
  name: string;
  id: number;
  /**
   * GitHub owner TYPE as verified via the API ("User", "Organization", ...).
   * The Organization fail-closed rule reads this field ！ the configured slug
   * is never used to decide identity semantics.
   */
  ownerType: string;
}

/** Issue projection freshly read from canonical state (GitHub). */
export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  updatedAt: string;
}

/** Issue-comment projection read by the Driver. */
export interface CommentDetail {
  id: number;
  user: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The only GitHub operations the Driver may perform. Note what is MISSING on
 * purpose: no label writes, no issue create/edit/close, no comment deletion,
 * no reactions, no state mutation of any kind ！ those belong exclusively to
 * the Gate.
 */
export interface DriverGitHubClient {
  /** Fetches repository identity (owner login, name, database id, owner type). */
  getRepository(): Promise<RepositoryInfo>;
  /** Fetches one issue; null when it does not exist (404). */
  getIssue(ref: IssueRef): Promise<IssueDetail | null>;
  /** Lists ALL issue comments (paginated internally), ascending by id. */
  listComments(ref: IssueRef): Promise<CommentDetail[]>;
  /** Publishes a new issue comment; returns the created comment id. */
  addIssueComment(ref: IssueRef, body: string): Promise<{ id: number }>;
  /** Edits the body of one existing issue comment (tracker updates). */
  updateIssueComment(ref: IssueRef, commentId: number, body: string): Promise<void>;
  /**
   * Lists the repository's OPEN issues (paginated internally), ascending by
   * issue number. This is the discovery input.
   */
  listIssues(ref: { owner: string; repo: string }): Promise<IssueDetail[]>;
}

/**
 * Structural subset of Octokit used by the adapter below ！ ONLY the endpoints
 * the Driver is allowed to touch. Extra fields on the real Octokit are
 * ignored, missing methods on test fakes are never called.
 */
export interface OctokitRest {
  rest: {
    repos: {
      get(params: {
        owner: string;
        repo: string;
      }): Promise<{
        data: {
          owner?: { login?: string; type?: string };
          name?: string;
          id?: number;
        };
      }>;
    };
    issues: {
      get(params: {
        owner: string;
        repo: string;
        issue_number: number;
      }): Promise<{
        data: {
          number?: number;
          title?: string;
          body?: string | null;
          state?: string;
          labels?: ReadonlyArray<string | { name?: string | null }>;
          updated_at?: string;
        };
      }>;
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page: number;
        page: number;
      }): Promise<{
        data: ReadonlyArray<{
          id?: number;
          user?: { login?: string } | null;
          body?: string | null;
          created_at?: string;
          updated_at?: string;
        }>;
      }>;
      listForRepo(params: {
        owner: string;
        repo: string;
        state: 'open';
        per_page: number;
        page: number;
      }): Promise<{
        data: ReadonlyArray<{
          number?: number;
          title?: string;
          body?: string | null;
          state?: string;
          labels?: ReadonlyArray<string | { name?: string | null }>;
          updated_at?: string;
        }>;
      }>;
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
    };
  };
}

/** Repository context a client needs to resolve getRepository(). */
export interface RepositoryContext {
  owner: string;
  repo: string;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: unknown }).status === 404
  );
}

/** Normalizes GitHub's mixed label forms (string or {name}), dropping empties. */
function labelNames(
  labels: ReadonlyArray<string | { name?: string | null }> | undefined,
): string[] {
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

const COMMENTS_PER_PAGE = 100;
/** Hard cap so a pathological pagination loop cannot run forever. */
const MAX_COMMENT_PAGES = 10;
const ISSUES_PER_PAGE = 100;
/** Hard cap for issue-list pagination (mirrors MAX_COMMENT_PAGES). */
const MAX_ISSUE_PAGES = 10;

/** Octokit-backed DriverGitHubClient; one instance serves the whole Driver. */
class OctokitDriverClient implements DriverGitHubClient {
  private readonly octokit: OctokitRest;
  private readonly repository?: RepositoryContext;

  constructor(octokit: OctokitRest, repository?: RepositoryContext) {
    this.octokit = octokit;
    this.repository = repository;
  }

  async getRepository(): Promise<RepositoryInfo> {
    const target = this.repository;
    if (!target) {
      // getRepository() takes no arguments by contract, so the Driver must
      // supply its configured repository (owner/name) at construction time.
      throw new Error(
        'getRepository() requires repository context: pass { owner, repo } as the second argument of createDriverGitHubClient()',
      );
    }
    const { data } = await this.octokit.rest.repos.get({
      owner: target.owner,
      repo: target.repo,
    });
    return {
      owner: data.owner?.login ?? target.owner,
      name: data.name ?? target.repo,
      id: data.id ?? 0,
      ownerType: data.owner?.type ?? 'unknown',
    };
  }

  async getIssue(ref: IssueRef): Promise<IssueDetail | null> {
    try {
      const { data } = await this.octokit.rest.issues.get({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
      });
      return {
        number: data.number ?? ref.issueNumber,
        title: data.title ?? '',
        body: data.body ?? '',
        state: data.state === 'closed' ? 'closed' : 'open',
        labels: labelNames(data.labels),
        updatedAt: data.updated_at ?? '',
      };
    } catch (err) {
      // A missing issue is a normal Driver situation and maps to null;
      // anything else (auth, network, rate limit) is an infrastructure
      // error that must propagate to the Driver's retry layer.
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  async listComments(ref: IssueRef): Promise<CommentDetail[]> {
    const comments: CommentDetail[] = [];
    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const { data } = await this.octokit.rest.issues.listComments({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: COMMENTS_PER_PAGE,
        page,
      });
      for (const raw of data) {
        comments.push({
          id: raw.id ?? 0,
          user: raw.user?.login ?? 'unknown',
          body: raw.body ?? '',
          createdAt: raw.created_at ?? '',
          updatedAt: raw.updated_at ?? '',
        });
      }
      // A short (or empty) page means we reached the end.
      if (data.length < COMMENTS_PER_PAGE) {
        break;
      }
    }
    comments.sort((a, b) => a.id - b.id);
    return comments;
  }

  async addIssueComment(ref: IssueRef, body: string): Promise<{ id: number }> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      body,
    });
    return { id: data.id ?? 0 };
  }

  async updateIssueComment(ref: IssueRef, commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: commentId,
      body,
    });
  }

  async listIssues(ref: { owner: string; repo: string }): Promise<IssueDetail[]> {
    const issues: IssueDetail[] = [];
    for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
      const { data } = await this.octokit.rest.issues.listForRepo({
        owner: ref.owner,
        repo: ref.repo,
        state: 'open',
        per_page: ISSUES_PER_PAGE,
        page,
      });
      for (const raw of data) {
        issues.push({
          number: raw.number ?? 0,
          title: raw.title ?? '',
          body: raw.body ?? '',
          // Defensive normalization for whatever the API reports.
          state: raw.state === 'closed' ? 'closed' : 'open',
          labels: labelNames(raw.labels),
          updatedAt: raw.updated_at ?? '',
        });
      }
      // A short (or empty) page means we reached the end.
      if (data.length < ISSUES_PER_PAGE) {
        break;
      }
    }
    issues.sort((a, b) => a.number - b.number);
    return issues;
  }
}

/**
 * Builds the real Octokit instance for the Driver. `baseUrl` is optional so
 * tests / GitHub Enterprise installations can point elsewhere.
 */
export function createOctokit(token: string, baseUrl?: string): Octokit {
  return new Octokit({ auth: token, ...(baseUrl ? { baseUrl } : {}) });
}

/**
 * Adapts an (structurally typed) Octokit instance to DriverGitHubClient.
 * `repository` is optional but REQUIRED at runtime for getRepository(); the
 * Driver passes its configured `owner/name` (gateflow.config.yml) here.
 */
export function createDriverGitHubClient(
  octokit: OctokitRest,
  repository?: RepositoryContext,
): DriverGitHubClient {
  return new OctokitDriverClient(octokit, repository);
}
