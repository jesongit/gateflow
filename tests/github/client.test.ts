import { describe, expect, it, vi } from 'vitest';
import {
  createDriverGitHubClient,
  type IssueRef,
  type OctokitRest,
} from '../../src/github/client';

/*
 * Offline tests for the Driver GitHub client adapter. The octokit instance
 * is faked with plain vi.fn()s shaped exactly like the structural
 * OctokitRest interface — no real GitHub API is ever touched.
 */

/* Raw payloads mirroring the OctokitRest declaration. */
type RawIssue = {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  labels?: ReadonlyArray<string | { name?: string | null }>;
  updated_at?: string;
};

type RawComment = {
  id?: number;
  user?: { login?: string } | null;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
};

interface ReposGetParams {
  owner: string;
  repo: string;
}

interface IssueGetParams {
  owner: string;
  repo: string;
  issue_number: number;
}

interface ListCommentsParams {
  owner: string;
  repo: string;
  issue_number: number;
  per_page: number;
  page: number;
}

interface CreateCommentParams {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
}

interface UpdateCommentParams {
  owner: string;
  repo: string;
  comment_id: number;
  body: string;
}

interface ReactionParams {
  owner: string;
  repo: string;
  comment_id: number;
  content: string;
}

function notFound(): Error {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

function rawComment(id: number, body = 'hello'): RawComment {
  return {
    id,
    user: { login: `user-${id}` },
    body,
    created_at: '2026-09-06T10:00:00Z',
    updated_at: '2026-09-06T11:00:00Z',
  };
}

interface FakeOptions {
  issue?: RawIssue | Error;
  commentPages?: RawComment[][];
}

/* Fake octokit covering ONLY the endpoints OctokitRest declares. */
function fakeOctokit(opts: FakeOptions = {}) {
  let page = 0;
  const fns = {
    reposGet: vi.fn(async (_params: ReposGetParams) => ({
      data: { owner: { login: 'owner-user' }, name: 'demo-repo', id: 424242 },
    })),
    issuesGet: vi.fn(async (_params: IssueGetParams) => {
      if (opts.issue instanceof Error) {
        throw opts.issue;
      }
      const raw: RawIssue = opts.issue ?? {};
      return { data: raw };
    }),
    listComments: vi.fn(async (_params: ListCommentsParams) => {
      const current = opts.commentPages?.[page] ?? [];
      page += 1;
      return { data: current };
    }),
    createComment: vi.fn(async (_params: CreateCommentParams) => ({ data: { id: 9001 } })),
    updateComment: vi.fn(async (_params: UpdateCommentParams) => undefined),
    createReaction: vi.fn(async (_params: ReactionParams) => undefined),
  };
  const octokit: OctokitRest = {
    rest: {
      repos: { get: fns.reposGet },
    issues: {
      get: fns.issuesGet,
      listComments: fns.listComments,
      createComment: fns.createComment,
      updateComment: fns.updateComment,
      // Added when the Driver interface grew listOpenIssues; no existing
      // test asserts on it (see the dedicated listOpenIssues describe below).
      list: vi.fn(async (_params: { owner: string; repo: string; state: string; per_page: number; page: number }) => ({
        data: [],
      })),
    },
      reactions: { createForIssueComment: fns.createReaction },
    },
  };
  return { octokit, fns };
}

const ref: IssueRef = { owner: 'owner-user', repo: 'demo', issueNumber: 7 };

describe('DriverGitHubClient adapter (no real API)', () => {
  it('getRepository maps owner/name/id when repository context is provided', async () => {
    const { octokit } = fakeOctokit();
    const client = createDriverGitHubClient(octokit, { owner: 'owner-user', repo: 'demo' });

    await expect(client.getRepository()).resolves.toEqual({
      owner: 'owner-user',
      name: 'demo-repo',
      id: 424242,
    });
  });

  it('getRepository rejects with a clear error when created without repository context', async () => {
    const { octokit } = fakeOctokit();
    const client = createDriverGitHubClient(octokit);

    await expect(client.getRepository()).rejects.toThrow(/repository context/i);
  });

  it('getIssue maps title/body/updatedAt/labels and normalizes state', async () => {
    const { octokit } = fakeOctokit({
      issue: {
        number: 7,
        title: 'Add retry',
        body: 'please',
        state: 'open',
        labels: [{ name: 'bug' }, 'ai:review', { name: null }, { name: '' }],
        updated_at: '2026-09-06T12:00:00Z',
      },
    });
    const client = createDriverGitHubClient(octokit);

    await expect(client.getIssue(ref)).resolves.toEqual({
      number: 7,
      title: 'Add retry',
      body: 'please',
      state: 'open',
      labels: ['bug', 'ai:review'],
      updatedAt: '2026-09-06T12:00:00Z',
    });
  });

  it('getIssue maps a closed issue state', async () => {
    const { octokit } = fakeOctokit({ issue: { state: 'closed' } });
    const client = createDriverGitHubClient(octokit);

    const issue = await client.getIssue(ref);
    expect(issue?.state).toBe('closed');
  });

  it('getIssue returns null on 404', async () => {
    const { octokit } = fakeOctokit({ issue: notFound() });
    const client = createDriverGitHubClient(octokit);

    await expect(client.getIssue(ref)).resolves.toBeNull();
  });

  it('getIssue rethrows non-404 errors (infrastructure errors surface)', async () => {
    const { octokit } = fakeOctokit({
      issue: Object.assign(new Error('Bad credentials'), { status: 401 }),
    });
    const client = createDriverGitHubClient(octokit);

    await expect(client.getIssue(ref)).rejects.toThrow('Bad credentials');
  });

  it('listComments keeps paginating while a page returns exactly 100 items and sorts ascending by id', async () => {
    const firstPage: RawComment[] = Array.from({ length: 100 }, (_, i) => rawComment(100 - i)); // ids 100..1
    const { octokit, fns } = fakeOctokit({
      commentPages: [firstPage, [rawComment(999), rawComment(101)]],
    });
    const client = createDriverGitHubClient(octokit);

    const comments = await client.listComments(ref);

    expect(fns.listComments).toHaveBeenCalledTimes(2);
    expect(fns.listComments.mock.calls[0]?.[0]).toEqual({
      owner: 'owner-user',
      repo: 'demo',
      issue_number: 7,
      per_page: 100,
      page: 1,
    });
    expect(fns.listComments.mock.calls[1]?.[0]).toEqual({
      owner: 'owner-user',
      repo: 'demo',
      issue_number: 7,
      per_page: 100,
      page: 2,
    });
    expect(comments).toHaveLength(102);
    const ids = comments.map((c) => c.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(ids[0]).toBe(1);
    expect(ids.at(-1)).toBe(999);
  });

  it('listComments stops after a page with fewer than 100 items', async () => {
    const { octokit, fns } = fakeOctokit({ commentPages: [[rawComment(1), rawComment(2)]] });
    const client = createDriverGitHubClient(octokit);

    await expect(client.listComments(ref)).resolves.toHaveLength(2);
    expect(fns.listComments).toHaveBeenCalledTimes(1);
  });

  it('listComments never issues more than 10 pages', async () => {
    const fullPage: RawComment[] = Array.from({ length: 100 }, (_, i) => rawComment(i));
    const { octokit, fns } = fakeOctokit({
      commentPages: Array.from({ length: 12 }, () => [...fullPage]),
    });
    const client = createDriverGitHubClient(octokit);

    const comments = await client.listComments(ref);

    expect(fns.listComments).toHaveBeenCalledTimes(10);
    expect(comments).toHaveLength(1000);
  });

  it('listComments maps a missing user login to "unknown"', async () => {
    const { octokit } = fakeOctokit({
      commentPages: [[{ id: 1, user: null, body: 'ghost' }]],
    });
    const client = createDriverGitHubClient(octokit);

    const comments = await client.listComments(ref);
    expect(comments[0]?.user).toBe('unknown');
  });

  it('addIssueComment forwards the body and returns the created comment id', async () => {
    const { octokit, fns } = fakeOctokit();
    const client = createDriverGitHubClient(octokit);

    await expect(client.addIssueComment(ref, 'body text')).resolves.toEqual({ id: 9001 });

    expect(fns.createComment).toHaveBeenCalledTimes(1);
    expect(fns.createComment.mock.calls[0]?.[0]).toEqual({
      owner: 'owner-user',
      repo: 'demo',
      issue_number: 7,
      body: 'body text',
    });
  });

  it('updateIssueComment targets the right comment with the new body', async () => {
    const { octokit, fns } = fakeOctokit();
    const client = createDriverGitHubClient(octokit);

    await client.updateIssueComment(ref, 555, 'new body');

    expect(fns.updateComment).toHaveBeenCalledTimes(1);
    expect(fns.updateComment.mock.calls[0]?.[0]).toEqual({
      owner: 'owner-user',
      repo: 'demo',
      comment_id: 555,
      body: 'new body',
    });
  });

  it('addReaction targets the right comment with the given content', async () => {
    const { octokit, fns } = fakeOctokit();
    const client = createDriverGitHubClient(octokit);

    await client.addReaction(ref, 9001, 'eyes');

    expect(fns.createReaction).toHaveBeenCalledTimes(1);
    expect(fns.createReaction.mock.calls[0]?.[0]).toEqual({
      owner: 'owner-user',
      repo: 'demo',
      comment_id: 9001,
      content: 'eyes',
    });
  });
});

/*
 * listOpenIssues (appended for the V1 Driver Discovery seam): fake covers
 * ONLY the newly declared rest.issues.list endpoint; existing tests above
 * stay untouched.
 */
describe('DriverGitHubClient.listOpenIssues (no real API)', () => {
  type RawIssueListParams = { owner: string; repo: string; state: string; per_page: number; page: number };

  interface ListFakeOptions {
    pages?: RawIssue[][];
  }

  function fakeListOctokit(opts: ListFakeOptions = {}) {
    const listIssues = vi.fn(async (params: RawIssueListParams) => {
      const current = opts.pages?.[params.page - 1] ?? [];
      return { data: current };
    });
    const octokit: OctokitRest = {
      rest: {
        repos: { get: vi.fn() },
        issues: {
          get: vi.fn(),
          listComments: vi.fn(),
          createComment: vi.fn(),
          updateComment: vi.fn(),
          list: listIssues,
        },
        reactions: { createForIssueComment: vi.fn() },
      },
    };
    return { octokit, listIssues };
  }

  it('requests state=open with per_page=100 and maps raw issues ascending by number', async () => {
    const { octokit, listIssues } = fakeListOctokit({
      pages: [
        [
          { number: 12, title: 'Second', body: 'b2', state: 'open', labels: ['ai:planning'], updated_at: '2026-09-06T12:00:00Z' },
          { number: 3, title: 'First', body: 'b1', state: 'open', labels: [{ name: 'ai:ready' }, 'bug'], updated_at: '2026-09-06T11:00:00Z' },
        ],
      ],
    });
    const client = createDriverGitHubClient(octokit);

    const issues = await client.listOpenIssues({ owner: 'owner-user', repo: 'demo' });

    expect(listIssues.mock.calls[0]?.[0]).toEqual({
      owner: 'owner-user',
      repo: 'demo',
      state: 'open',
      per_page: 100,
      page: 1,
    });
    expect(issues.map((i) => i.number)).toEqual([3, 12]);
    expect(issues[1]?.labels).toEqual(['ai:planning']);
    expect(issues[0]?.labels).toEqual(['ai:ready', 'bug']);
    expect(issues.every((i) => i.state === 'open')).toBe(true);
  });

  it('keeps paginating while pages are full and stops after a short page', async () => {
    const fullPage: RawIssue[] = Array.from({ length: 100 }, (_, i) => ({ number: i, state: 'open' }));
    const { octokit, listIssues } = fakeListOctokit({ pages: [[...fullPage], [{ number: 500, state: 'open' }]] });
    const client = createDriverGitHubClient(octokit);

    const issues = await client.listOpenIssues({ owner: 'o', repo: 'r' });

    expect(listIssues).toHaveBeenCalledTimes(2);
    expect(listIssues.mock.calls[1]?.[0]).toMatchObject({ page: 2, per_page: 100, state: 'open' });
    expect(issues).toHaveLength(101);
  });

  it('never issues more than 10 pages', async () => {
    const fullPage: RawIssue[] = Array.from({ length: 100 }, (_, i) => ({ number: i, state: 'open' }));
    const { octokit, listIssues } = fakeListOctokit({ pages: Array.from({ length: 12 }, () => [...fullPage]) });
    const client = createDriverGitHubClient(octokit);

    const issues = await client.listOpenIssues({ owner: 'o', repo: 'r' });

    expect(listIssues).toHaveBeenCalledTimes(10);
    expect(issues).toHaveLength(1000);
  });
});
