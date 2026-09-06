import { describe, expect, it, vi } from 'vitest';
import { createGitHubClient, type OctokitLike } from '../../src/gate/github';
import type { IssueRef } from '../../src/gate/github';

/* Build a structurally-typed fake octokit; no real GitHub API is touched. */
function fakeOctokit() {
  const calls: string[] = [];
  const octokit: OctokitLike = {
    rest: {
      issues: {
        get: vi.fn(async () => {
          calls.push('issues.get');
          return {
            data: {
              state: 'open',
              labels: [{ name: 'bug' }, 'ai:review', { name: null }, { name: '' }],
            },
          };
        }),
        listLabelsOnIssue: vi.fn(async () => {
          calls.push('issues.listLabelsOnIssue');
          return { data: [{ name: 'ai:review' }, { name: null }, {}] };
        }),
        addLabels: vi.fn(async () => {
          calls.push('issues.addLabels');
        }),
        removeLabel: vi.fn(async () => {
          calls.push('issues.removeLabel');
        }),
        updateComment: vi.fn(async () => {
          calls.push('issues.updateComment');
        }),
        getComment: vi.fn(async () => {
          calls.push('issues.getComment');
          return {
            data: { id: 9001, user: { login: 'alice' }, body: 'the comment body' },
          };
        }),
        listComments: vi.fn(async () => {
          calls.push('issues.listComments');
          return { data: [] };
        }),
      },
      reactions: {
        createForIssueComment: vi.fn(async () => {
          calls.push('reactions.createForIssueComment');
        }),
      },
    },
  };
  return { octokit, calls };
}

const ref: IssueRef = { owner: 'owner-user', repo: 'demo', issueNumber: 7 };

describe('OctokitGitHubClient adapter (no real API)', () => {
  it('normalizes issue labels (string or object form) and returns state', async () => {
    const { octokit } = fakeOctokit();
    const client = createGitHubClient(octokit);

    const info = await client.getIssue(ref);

    expect(info.state).toBe('open');
    expect(info.labels).toEqual(['bug', 'ai:review']);
  });

  it('returns plain label names from the labels endpoint (dedicated re-read)', async () => {
    const { octokit } = fakeOctokit();
    const client = createGitHubClient(octokit);

    await expect(client.getLabels(ref)).resolves.toEqual(['ai:review']);
  });

  it('addLabels forwards the label list', async () => {
    const { octokit, calls } = fakeOctokit();
    const client = createGitHubClient(octokit);

    await client.addLabels(ref, ['ai:ready']);

    expect(calls).toEqual(['issues.addLabels']);
  });

  it('addLabels with an empty list performs no API call', async () => {
    const { octokit, calls } = fakeOctokit();
    const client = createGitHubClient(octokit);

    await client.addLabels(ref, []);

    expect(calls).toEqual([]);
  });

  it('removeLabel treats a 404 as success (label already gone)', async () => {
    const { octokit } = fakeOctokit();
    octokit.rest.issues.removeLabel = vi.fn(async () => {
      const err = Object.assign(new Error('Not Found'), { status: 404 });
      throw err;
    });
    const client = createGitHubClient(octokit);

    await expect(client.removeLabel(ref, 'ai:review')).resolves.toBeUndefined();
  });

  it('removeLabel rethrows non-404 failures (infrastructure errors surface)', async () => {
    const { octokit } = fakeOctokit();
    octokit.rest.issues.removeLabel = vi.fn(async () => {
      throw Object.assign(new Error('Bad credentials'), { status: 401 });
    });
    const client = createGitHubClient(octokit);

    await expect(client.removeLabel(ref, 'ai:review')).rejects.toThrow('Bad credentials');
  });

  it('addReaction and editComment target the right comment', async () => {
    const { octokit, calls } = fakeOctokit();
    const client = createGitHubClient(octokit);

    await client.addReaction(ref, 9001, '+1');
    await client.editComment(ref, 9001, 'updated body');

    expect(calls).toEqual(['reactions.createForIssueComment', 'issues.updateComment']);
  });
});

describe('OctokitGitHubClient.getComment (V1 approval validation)', () => {
  it('maps id, user.login and body onto GateComment', async () => {
    const { octokit, calls } = fakeOctokit();
    const client = createGitHubClient(octokit);

    const comment = await client.getComment(ref, 3472198451);

    expect(comment).toEqual({ id: 9001, user: 'alice', body: 'the comment body' });
    expect(calls).toEqual(['issues.getComment']);
    expect(octokit.rest.issues.getComment).toHaveBeenCalledWith({
      owner: 'owner-user',
      repo: 'demo',
      comment_id: 3472198451,
    });
  });

  it('maps a missing user to "unknown" and a missing body to the empty string', async () => {
    const { octokit } = fakeOctokit();
    octokit.rest.issues.getComment = vi.fn(async () => ({
      data: { id: 5, user: null, body: null },
    }));
    const client = createGitHubClient(octokit);

    await expect(client.getComment(ref, 5)).resolves.toEqual({
      id: 5,
      user: 'unknown',
      body: '',
    });
  });

  it('returns null on 404 (deleted comment: a validation failure, not an error)', async () => {
    const { octokit } = fakeOctokit();
    octokit.rest.issues.getComment = vi.fn(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    const client = createGitHubClient(octokit);

    await expect(client.getComment(ref, 99999)).resolves.toBeNull();
  });

  it('rethrows non-404 failures (infrastructure errors surface)', async () => {
    const { octokit } = fakeOctokit();
    octokit.rest.issues.getComment = vi.fn(async () => {
      throw Object.assign(new Error('Bad credentials'), { status: 401 });
    });
    const client = createGitHubClient(octokit);

    await expect(client.getComment(ref, 5)).rejects.toThrow('Bad credentials');
  });
});

describe('OctokitGitHubClient.listComments (V1 approval validation)', () => {
  it('returns the issue comments mapped onto GateComment', async () => {
    const { octokit } = fakeOctokit();
    octokit.rest.issues.listComments = vi.fn(async () => ({
      data: [
        { id: 20, user: { login: 'bob' }, body: 'second' },
        { id: 10, user: { login: 'alice' }, body: 'first' },
      ],
    }));
    const client = createGitHubClient(octokit);

    await expect(client.listComments(ref)).resolves.toEqual([
      { id: 10, user: 'alice', body: 'first' },
      { id: 20, user: 'bob', body: 'second' },
    ]);
  });

  it('sorts id-ascending regardless of the delivery order (plan-revision order)', async () => {
    const { octokit } = fakeOctokit();
    octokit.rest.issues.listComments = vi.fn(async () => ({
      data: [{ id: 30, user: { login: 'c' }, body: 'c' }, { id: 10, user: { login: 'a' }, body: 'a' }, { id: 20, user: { login: 'b' }, body: 'b' }],
    }));
    const client = createGitHubClient(octokit);

    const comments = await client.listComments(ref);
    expect(comments.map((c) => c.id)).toEqual([10, 20, 30]);
  });

  it('paginates at 100 per page until a partial page arrives', async () => {
    const { octokit } = fakeOctokit();
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      user: { login: 'u' },
      body: `c${i + 1}`,
    }));
    const listComments = vi.fn(async (params: { page?: number }) => {
      if ((params.page ?? 1) === 1) {
        return { data: fullPage };
      }
      return { data: [{ id: 101, user: { login: 'u' }, body: 'c101' }] };
    });
    octokit.rest.issues.listComments =
      listComments as unknown as OctokitLike['rest']['issues']['listComments'];
    const client = createGitHubClient(octokit);

    const comments = await client.listComments(ref);

    expect(listComments).toHaveBeenCalledTimes(2);
    expect(comments).toHaveLength(101);
    expect(comments[comments.length - 1]).toEqual({ id: 101, user: 'u', body: 'c101' });
  });

  it('stops after at most 10 pages even when every page is full', async () => {
    const { octokit } = fakeOctokit();
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      user: { login: 'u' },
      body: `c${i + 1}`,
    }));
    const listComments = vi.fn(async () => ({ data: [...fullPage] }));
    octokit.rest.issues.listComments =
      listComments as unknown as OctokitLike['rest']['issues']['listComments'];
    const client = createGitHubClient(octokit);

    const comments = await client.listComments(ref);

    expect(listComments).toHaveBeenCalledTimes(10); // pagination cap: 10 x 100 comments
    expect(comments).toHaveLength(1000);
  });

  it('requests the issue-scoped endpoint with per_page 100 starting at page 1', async () => {
    const { octokit } = fakeOctokit();
    const client = createGitHubClient(octokit);

    await client.listComments(ref);

    expect(octokit.rest.issues.listComments).toHaveBeenCalledWith({
      owner: 'owner-user',
      repo: 'demo',
      issue_number: 7,
      per_page: 100,
      page: 1,
    });
  });
});
