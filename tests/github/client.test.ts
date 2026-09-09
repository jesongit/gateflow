import { describe, expect, it, vi } from 'vitest';

import { createDriverGitHubClient, type OctokitRest } from '../../src/github/client';

describe('Octokit Driver client issue discovery', () => {
  it('lists issues for the configured repository', async () => {
    const listForRepo = vi.fn().mockResolvedValue({
      data: [
        {
          number: 1,
          title: 'release task',
          body: 'update the file',
          state: 'open',
          labels: [{ name: 'ai:planning' }],
          updated_at: '2026-09-09T08:38:37Z',
        },
      ],
    });
    const octokit: OctokitRest = {
      rest: {
        repos: {
          get: vi.fn(),
        },
        issues: {
          get: vi.fn(),
          listComments: vi.fn(),
          listForRepo,
          createComment: vi.fn(),
          updateComment: vi.fn(),
        },
      },
    };

    const client = createDriverGitHubClient(octokit);
    await expect(client.listIssues({ owner: 'jesongit', repo: 'gateflow' })).resolves.toEqual([
      {
        number: 1,
        title: 'release task',
        body: 'update the file',
        state: 'open',
        labels: ['ai:planning'],
        updatedAt: '2026-09-09T08:38:37Z',
      },
    ]);
    expect(listForRepo).toHaveBeenCalledWith({
      owner: 'jesongit',
      repo: 'gateflow',
      state: 'open',
      per_page: 100,
      page: 1,
    });
  });
});
