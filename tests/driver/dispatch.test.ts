/**
 * Dispatch tests (src/driver/dispatch.ts): intent → atomic inbox build →
 * current.json → receipt → activation notice, plus dedup/retry-limit and
 * executor plan anchoring (plan_sha256, p<planCommentId> revision).
 */
import { describe, expect, it, vi } from 'vitest';

import { readFile, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { buildPlanCommentBody } from '../../src/github/comments';
import { dispatchIntent, processIntents } from '../../src/driver/dispatch';
import { readInboxDispatch, readCurrent, sha256Hex } from '../../src/workspace/inbox';
import { readReceipt, writeReceipt } from '../../src/workspace/outbox';
import { deriveIntents } from '../../src/driver/intent';
import { discoverIssue } from '../../src/driver/discovery';
import {
  FakeDriverClient,
  collectingLog,
  makeDeps,
  makeWorkspace,
  testConfig,
} from './helpers';
import { extractPlanContent } from '../../src/driver/intent';

const PLAN = '# Plan\n\n1. Do it\n2. Verify it';

describe('dispatchIntent — consumer planning (scenario 1)', () => {
  it('builds inbox + current + receipt and notifies the manual adapter', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:planning'] });
      const discovery = await discoverIssue(client, 'octo/repo', client.issues.get(7)!, deps.config);
      const [intent] = deriveIntents(client.issues.get(7)!, discovery.comments, new Set(), 'octo');
      expect(intent).toBeDefined();

      // Capture the manual adapter notice (stdout injection via spy — the
      // adapter is constructed inside resolveAdapterForAgent).
      const writes: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

      const outcome = await dispatchIntent(deps, client.repository, discovery, intent!);

      expect(outcome).toEqual({
        dispatched: true,
        dispatchId: 'gf_r123_i7_consumer_01',
        reason: 'new',
      });
      spy.mockRestore();

      // Manual activation notice reached stdout (first-class manual path).
      const printed = writes.join('');
      expect(printed).toContain('GateFlow: dispatch ready');
      expect(printed).toContain('gf_r123_i7_consumer_01');

      // Inbox content.
      const inboxDir = nodePath.join(fixture.paths.inbox, 'gf_r123_i7_consumer_01');
      const task = await readFile(nodePath.join(inboxDir, 'TASK.md'), 'utf8');
      expect(task).toContain('# Issue 7');
      expect(task).toContain('## Goal');
      await expect(stat(nodePath.join(inboxDir, 'FEEDBACK.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(nodePath.join(inboxDir, 'PLAN.md'))).rejects.toMatchObject({ code: 'ENOENT' });

      // dispatch.json is a valid ready marker; context carries no plan fields.
      const dispatch = await readInboxDispatch(fixture.paths, 'gf_r123_i7_consumer_01');
      expect(dispatch).not.toBeNull();
      expect(dispatch?.role).toBe('consumer');
      expect(dispatch?.reason).toBe('planning');
      expect(dispatch?.input).toEqual({ task: 'TASK.md', plan: null, feedback: null });

      // current.json points at the fresh dispatch.
      const current = await readCurrent(fixture.paths);
      expect(current?.dispatch_id).toBe('gf_r123_i7_consumer_01');
      expect(current?.issue_number).toBe(7);

      // Receipt: first attempt, dispatched.
      const receipt = await readReceipt(fixture.paths, 'gf_r123_i7_consumer_01');
      expect(receipt?.status).toBe('dispatched');
      expect(receipt?.attempts).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('projects FEEDBACK.md and bumps the round for every all-time feedback command', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:planning'] });
      client.addComment(7, 'octo', '/change 不要使用 SQLite。', { id: 5, createdAt: '2026-09-06T11:00:00Z' });
      client.addComment(7, 'octo', '/choose db postgres', { id: 6, createdAt: '2026-09-06T11:30:00Z' });
      const issue = client.issues.get(7)!;
      const discovery = await discoverIssue(client, 'octo/repo', issue, deps.config);

      expect(discovery.feedback).toHaveLength(2);
      const outcome = await dispatchIntent(deps, client.repository, discovery, discovery.intents[0]!);

      expect(outcome.dispatchId).toBe('gf_r123_i7_consumer_03');
      expect(outcome.dispatched).toBe(true);
      const feedback = await readFile(
        nodePath.join(fixture.paths.inbox, 'gf_r123_i7_consumer_03', 'FEEDBACK.md'),
        'utf8',
      );
      expect(feedback).toContain('不要使用 SQLite。');
      expect(feedback).toContain('Q: db → A: postgres');

      const dispatch = await readInboxDispatch(fixture.paths, 'gf_r123_i7_consumer_03');
      expect(dispatch?.reason).toBe('feedback_applied');
      expect(dispatch?.input.feedback).toBe('FEEDBACK.md');
    } finally {
      await cleanup();
    }
  });
});

describe('dispatchIntent — dedup and retry ceiling (scenario 9)', () => {
  it('dispatched/synced receipts are never re-dispatched', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:planning'] });
      const discovery = await discoverIssue(client, 'octo/repo', client.issues.get(7)!, deps.config);
      const intent = discovery.intents[0]!;

      await writeReceipt(fixture.paths, {
        dispatch_id: 'gf_r123_i7_consumer_01',
        status: 'synced',
        attempts: 1,
      });
      const outcome = await dispatchIntent(deps, client.repository, discovery, intent);
      expect(outcome).toEqual({ dispatched: false, dispatchId: 'gf_r123_i7_consumer_01', reason: 'synced' });
    } finally {
      await cleanup();
    }
  });

  it('failed receipts re-dispatch below max_attempts and increment attempts', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:planning'] });
      const discovery = await discoverIssue(client, 'octo/repo', client.issues.get(7)!, deps.config);
      const intent = discovery.intents[0]!;
      await writeReceipt(fixture.paths, {
        dispatch_id: 'gf_r123_i7_consumer_01',
        status: 'failed',
        attempts: 2,
        error: 'activation died',
      });

      const outcome = await dispatchIntent(deps, client.repository, discovery, intent);
      expect(outcome.dispatched).toBe(true);
      expect(outcome.reason).toBe('retry');
      const receipt = await readReceipt(fixture.paths, 'gf_r123_i7_consumer_01');
      expect(receipt?.attempts).toBe(3);
      expect(receipt?.status).toBe('dispatched');
      expect(receipt?.error).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('failed receipts at max_attempts hit the retry limit (no inbox write)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:planning'] });
      const discovery = await discoverIssue(client, 'octo/repo', client.issues.get(7)!, deps.config);
      await writeReceipt(fixture.paths, {
        dispatch_id: 'gf_r123_i7_consumer_01',
        status: 'failed',
        attempts: 3, // == maxAttempts (default 3)
      });

      const outcome = await dispatchIntent(deps, client.repository, discovery, discovery.intents[0]!);
      expect(outcome).toEqual({
        dispatched: false,
        dispatchId: 'gf_r123_i7_consumer_01',
        reason: 'retry-limit',
      });
      // No inbox was built for the blocked dispatch.
      await expect(
        stat(nodePath.join(fixture.paths.inbox, 'gf_r123_i7_consumer_01')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cleanup();
    }
  });
});

describe('dispatchIntent — executor plan anchoring', () => {
  it('binds PLAN.md to the approved plan comment and pins plan_sha256', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:ready'] });
      const planComment = client.addComment(7, 'gateflow-driver[bot]', buildPlanCommentBody(PLAN, 'gf_r123_i7_consumer_01'));
      const approval = client.addComment(7, 'octo', `/approve ${planComment.id}`);
      const discovery = await discoverIssue(client, 'octo/repo', client.issues.get(7)!, deps.config);
      expect(discovery.intents).toHaveLength(1);

      const outcome = await dispatchIntent(deps, client.repository, discovery, discovery.intents[0]!);
      expect(outcome.dispatchId).toBe(`gf_r123_i7_executor_p${planComment.id}`);
      expect(outcome.dispatched).toBe(true);

      const inboxDir = nodePath.join(fixture.paths.inbox, outcome.dispatchId!);
      const plan = await readFile(nodePath.join(inboxDir, 'PLAN.md'), 'utf8');
      expect(plan).toBe(extractPlanContent(buildPlanCommentBody(PLAN, 'gf_r123_i7_consumer_01')));
      expect(plan).not.toContain('gateflow:dispatch-id');

      const dispatch = await readInboxDispatch(fixture.paths, outcome.dispatchId!);
      expect(dispatch?.plan_comment_id).toBe(planComment.id);
      expect(dispatch?.approval_comment_id).toBe(approval.id);
      expect(dispatch?.input.plan).toBe('PLAN.md');
      expect(dispatch?.reason).toBe('approved_plan');

      const context = JSON.parse(
        await readFile(nodePath.join(inboxDir, 'context.json'), 'utf8'),
      ) as { plan_comment_id: number; plan_sha256: string; feedback_count: number };
      expect(context.plan_comment_id).toBe(planComment.id);
      expect(context.plan_sha256).toBe(sha256Hex(plan));
      expect(context.feedback_count).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

describe('processIntents', () => {
  it('walks every open issue with exactly one ai:* label and skips others', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(1, { labels: ['ai:planning'] });
      client.addIssue(2, { labels: ['bug'] }); // no ai label → skipped
      client.addIssue(3, { labels: ['ai:working'] }); // sync-only → no intents
      client.addIssue(4, { state: 'closed', labels: ['ai:planning'] }); // closed → skipped

      const outcomes = await processIntents(deps, client.repository);
      expect(outcomes).toEqual([
        { dispatched: true, dispatchId: 'gf_r123_i1_consumer_01', reason: 'new' },
      ]);
      const { readdir } = await import('node:fs/promises');
      const inboxes = await readdir(fixture.paths.inbox);
      expect(inboxes).toEqual(['gf_r123_i1_consumer_01']);
    } finally {
      await cleanup();
    }
  });
});

/* Shared fixture for this file. */
async function setup() {
  const client = new FakeDriverClient();
  const fixture = await makeWorkspace();
  const deps = makeDeps(client, testConfig(), fixture);
  return { client, fixture, deps, cleanup: fixture.cleanup };
}
