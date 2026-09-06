/**
 * Discovery tests (src/driver/discovery.ts): one-comment-snapshot discovery
 * per issue, trusted-set wiring, and slug parsing guards.
 */
import { describe, expect, it } from 'vitest';

import { discoverIssue, discoverWork, parseRepositorySlug } from '../../src/driver/discovery';
import { buildPlanCommentBody } from '../../src/github/comments';
import { FakeDriverClient, collectingLog, testConfig } from './helpers';

describe('parseRepositorySlug', () => {
  it('accepts owner/name and rejects junk', () => {
    expect(parseRepositorySlug('octo/repo')).toEqual({ owner: 'octo', name: 'repo' });
    expect(parseRepositorySlug('  octo/repo ')).toEqual({ owner: 'octo', name: 'repo' });
    expect(parseRepositorySlug('just-a-name')).toBeNull();
    expect(parseRepositorySlug('')).toBeNull();
    expect(parseRepositorySlug('a/b/c')).toBeNull();
  });
});

describe('discoverIssue', () => {
  it('derives intents AND feedback from a single comment snapshot', async () => {
    const client = new FakeDriverClient();
    const issue = client.addIssue(7, { labels: ['ai:review'] });
    const plan = client.addComment(7, 'gateflow-driver[bot]', buildPlanCommentBody('Plan', 'gf_r123_i7_consumer_01'));
    client.addComment(7, 'octo', '/change use postgres');

    const discovery = await discoverIssue(client, 'octo/repo', issue, testConfig());
    expect(discovery.comments).toHaveLength(2);
    expect(discovery.feedback).toHaveLength(1);
    expect(discovery.intents).toEqual([
      {
        role: 'consumer',
        issueNumber: 7,
        reason: 'feedback_applied',
        revision: '02',
        planCommentId: null,
        approvalCommentId: null,
      },
    ]);
    // Sanity: feedback is newer than the plan (that is what gated the intent).
    expect(discovery.feedback[0]!.comment.id).toBeGreaterThan(plan.id);
  });

  it('trusts the repo owner plus config.trustedHumans (case-insensitive)', async () => {
    const client = new FakeDriverClient();
    const issue = client.addIssue(7, { labels: ['ai:planning'] });
    client.addComment(7, 'OCTO', '/change from owner upper'); // owner, weird case
    client.addComment(7, 'Alice', '/change from trusted');
    client.addComment(7, 'stranger', '/change from nobody');

    const config = testConfig({ trustedHumans: ['alice'] });
    const discovery = await discoverIssue(client, 'octo/repo', issue, config);
    expect(discovery.feedback.map((f) => f.comment.user)).toEqual(['OCTO', 'Alice']);
    expect(discovery.intents[0]?.revision).toBe('03');
  });
});

describe('discoverWork', () => {
  it('only visits open issues with exactly one ai:* label, sequentially', async () => {
    const client = new FakeDriverClient();
    client.addIssue(3, { labels: ['ai:planning'] });
    client.addIssue(1, { labels: ['ai:ready'] });
    client.addIssue(2, { labels: ['bug'] });
    client.addIssue(4, { labels: ['ai:planning', 'ai:review'] });
    client.addIssue(5, { state: 'closed', labels: ['ai:planning'] });

    const discoveries = await discoverWork(client, 'octo/repo', testConfig());
    // Ascending issue-number order from listOpenIssues.
    expect(discoveries.map((d) => d.issue.number)).toEqual([1, 3]);
    // Issue 1 is ai:ready but has no plan/approval comments → no intent yet
    // (approval gating). Issue 3 gets a plain planning intent.
    expect(discoveries[0]!.intents).toEqual([]);
    expect(discoveries[1]!.intents[0]?.role).toBe('consumer');
  });

  it('a failing issue is logged and skipped, not fatal', async () => {
    const client = new FakeDriverClient();
    client.addIssue(7, { labels: ['ai:planning'] });
    client.addIssue(13, { labels: ['ai:planning'] });
    const original = client.listComments.bind(client);
    client.listComments = async (ref) => {
      if (ref.issueNumber === 13) throw new Error('boom');
      return original(ref);
    };
    const log = collectingLog();
    const discoveries = await discoverWork(client, 'octo/repo', testConfig(), log);
    expect(discoveries.map((d) => d.issue.number)).toEqual([7]);
    expect(log.lines.join('\n')).toMatch(/discovery failed for issue #13.*boom/);
  });
});
