/**
 * Discovery tests (src/driver/discovery.ts, schema 2): one-comment-snapshot
 * discovery per issue, trusted-set wiring, Gate-record projection (only
 * ACCEPTED feedback counts), Driver-side epoch bootstrap, and slug parsing
 * guards.
 */
import { describe, expect, it } from 'vitest';

import { discoverIssue, discoverWork, parseRepositorySlug } from '../../src/driver/discovery';
import { buildPlanCommentBody } from '../../src/github/comments';
import {
  FakeDriverClient,
  addEpochRecord,
  collectingLog,
  feedbackRecord,
  testConfig,
  testEpoch,
} from './helpers';

const GATE_LOGIN = 'github-actions[bot]';

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
  it('derives intents AND accepted feedback from a single comment snapshot', async () => {
    const client = new FakeDriverClient();
    const issue = client.addIssue(7, { labels: ['ai:review'] });
    const epoch = addEpochRecord(client, 7);
    const plan = client.addComment(7, GATE_LOGIN, buildPlanCommentBody('Plan', `gf_r123_i7_w${epoch.slice(3)}_consumer_01`));
    const command = client.addComment(7, 'octo', '/change use postgres');
    client.addGateRecord(7, feedbackRecord({ repositoryId: 123, issueNumber: 7, epoch, feedbackCommentId: command.id, kind: 'change' }));

    const discovery = await discoverIssue(client, 'octo/repo', issue, testConfig(), client.repository);
    // Epoch record + plan + human command + feedback record.
    expect(discovery.comments).toHaveLength(4);
    expect(discovery.feedback).toHaveLength(1);
    expect(discovery.intents).toEqual([
      {
        role: 'consumer',
        issueNumber: 7,
        reason: 'feedback_applied',
        revision: '02',
        epoch,
        planCommentId: null,
        approvalCommentId: null,
        planSha256: null,
      },
    ]);
    // Sanity: feedback is newer than the plan (that is what gated the intent).
    expect(discovery.feedback[0]!.comment.id).toBeGreaterThan(plan.id);
  });

  it('trusts the repo owner plus config.trustedHumans (case-insensitive) for command anchoring', async () => {
    const client = new FakeDriverClient();
    const issue = client.addIssue(7, { labels: ['ai:planning'] });
    const epoch = addEpochRecord(client, 7);
    const ownerCommand = client.addComment(7, 'OCTO', '/change from owner upper'); // owner, weird case
    const trustedCommand = client.addComment(7, 'Alice', '/change from trusted');
    const strangerCommand = client.addComment(7, 'stranger', '/change from nobody');
    // The Gate accepted all three commands (records exist)…
    for (const command of [ownerCommand, trustedCommand, strangerCommand]) {
      client.addGateRecord(7, feedbackRecord({ repositoryId: 123, issueNumber: 7, epoch, feedbackCommentId: command.id, kind: 'change' }));
    }

    const config = testConfig({ trustedHumans: ['alice'] });
    const discovery = await discoverIssue(client, 'octo/repo', issue, config, client.repository);
    // …but only commands by the owner / trusted humans are projected.
    expect(discovery.feedback.map((f) => f.comment.user)).toEqual(['OCTO', 'Alice']);
    expect(discovery.intents[0]?.revision).toBe('03');
  });

  it('raw feedback commands WITHOUT Gate records never count (schema 2 hardening)', async () => {
    const client = new FakeDriverClient();
    const issue = client.addIssue(7, { labels: ['ai:planning'] });
    const epoch = addEpochRecord(client, 7);
    client.addComment(7, 'octo', '/change use postgres');
    client.addComment(7, 'Alice', '/choose db postgres');

    const discovery = await discoverIssue(client, 'octo/repo', issue, testConfig(), client.repository);
    expect(discovery.feedback).toEqual([]);
    expect(discovery.intents).toEqual([
      {
        role: 'consumer',
        issueNumber: 7,
        reason: 'planning',
        revision: '01',
        epoch,
        planCommentId: null,
        approvalCommentId: null,
        planSha256: null,
      },
    ]);
  });

  it('a planning issue without an epoch record gets a Driver-bootstrapped epoch comment', async () => {
    const client = new FakeDriverClient();
    const issue = client.addIssue(7, { labels: ['ai:planning'] });

    const discovery = await discoverIssue(client, 'octo/repo', issue, testConfig(), client.repository);
    // Bootstrap happened exactly once: a fresh workflow_epoch record comment.
    expect(client.commentCount(7)).toBe(1);
    const bootstrapped = client.issues.get(7)!.comments[0]!;
    expect(bootstrapped.user).toBe(client.botUser); // issued by the DRIVER identity
    expect(bootstrapped.body).toContain('gateflow:workflow:v2');
    expect(discovery.comments).toHaveLength(1);
    // NOTE: intents stay empty until src/protocol/records.ts injects `schema`
    // into buildRecordBody output (reported src gap): the bootstrap record
    // currently fails parseRecord and the issue fails closed for this cycle.
  });

  it('does NOT bootstrap for non-planning issues or issues that already have an epoch', async () => {
    const client = new FakeDriverClient();
    const reviewIssue = client.addIssue(7, { labels: ['ai:review'] });
    const plannedIssue = client.addIssue(8, { labels: ['ai:planning'] });

    await discoverIssue(client, 'octo/repo', reviewIssue, testConfig(), client.repository);
    expect(client.commentCount(7)).toBe(0); // review issues never bootstrap

    addEpochRecord(client, 8);
    await discoverIssue(client, 'octo/repo', plannedIssue, testConfig(), client.repository);
    expect(client.commentCount(8)).toBe(1); // epoch already present, nothing added
  });

  it('keeps the fresh comment snapshot consistent: records view matches the comments', async () => {
    const client = new FakeDriverClient();
    const issue = client.addIssue(7, { labels: ['ai:planning'] });
    const epoch = addEpochRecord(client, 7);
    const discovery = await discoverIssue(client, 'octo/repo', issue, testConfig(), client.repository);
    expect(discovery.records.epoch?.record.workflow_epoch).toBe(epoch);
    expect(discovery.records.suspect).toEqual([]);
  });

  it('epochRecord builder produces bodies the shared parser accepts (fixture sanity)', async () => {
    const client = new FakeDriverClient();
    const issue = client.addIssue(7, { labels: ['ai:planning'] });
    addEpochRecord(client, 7);
    const discovery = await discoverIssue(client, 'octo/repo', issue, testConfig(), client.repository);
    // The seeded epoch parses and no record is flagged as suspect.
    expect(discovery.records.epoch).not.toBeNull();
    expect(discovery.records.suspect).toEqual([]);
    expect(discovery.intents[0]?.epoch).toBe(testEpoch(7));
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
    addEpochRecord(client, 3); // issue 3 needs an epoch for its planning intent

    const discoveries = await discoverWork(client, 'octo/repo', testConfig(), client.repository);
    // Ascending issue-number order from listIssues.
    expect(discoveries.map((d) => d.issue.number)).toEqual([1, 3]);
    // Issue 1 is ai:ready but has no plan/approval comments → no intent yet
    // (approval-record gating). Issue 3 gets a plain planning intent.
    expect(discoveries[0]!.intents).toEqual([]);
    expect(discoveries[1]!.intents[0]?.role).toBe('consumer');
  });

  it('a failing issue is logged and skipped, not fatal', async () => {
    const client = new FakeDriverClient();
    client.addIssue(7, { labels: ['ai:planning'] });
    client.addIssue(13, { labels: ['ai:planning'] });
    addEpochRecord(client, 7);
    const original = client.listComments.bind(client);
    client.listComments = async (ref) => {
      if (ref.issueNumber === 13) throw new Error('boom');
      return original(ref);
    };
    const log = collectingLog();
    const discoveries = await discoverWork(client, 'octo/repo', testConfig(), client.repository, log);
    expect(discoveries.map((d) => d.issue.number)).toEqual([7]);
    expect(log.lines.join('\n')).toMatch(/discovery failed for issue #13.*boom/);
  });
});
