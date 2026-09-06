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
