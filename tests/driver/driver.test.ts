/**
 * End-to-end driver cycle tests (src/driver/driver.ts runOnce): discovery →
 * dispatch → sync over the in-memory fake client, covering the planning /
 * plan-sync / feedback / approval / retry flows from docs/
 * architecture-v1.md §3 (scenarios 1-4 and 9).
 */
import { describe, expect, it, vi } from 'vitest';

import { readFile, readdir } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { buildPlanCommentBody } from '../../src/github/comments';
import type { IssueRef } from '../../src/github/client';
import { runOnce } from '../../src/driver/driver';
import { retryDispatch } from '../../src/driver/retry';
import { resolveWorkspace } from '../../src/workspace/paths';
import type { WorkspacePaths } from '../../src/workspace/paths';
import { readCurrent, readInboxDispatch, sha256Hex, writeInbox } from '../../src/workspace/inbox';
import { readReceipt, writeReceipt } from '../../src/workspace/outbox';
import { extractPlanContent } from '../../src/driver/intent';
import {
  FakeDriverClient,
  makeDeps,
  makeWorkspace,
  testConfig,
  writeOutboxFile,
} from './helpers';

async function setup(): Promise<{
  client: FakeDriverClient;
  deps: ReturnType<typeof makeDeps>;
  paths: WorkspacePaths;
  cleanup: () => Promise<void>;
}> {
  const client = new FakeDriverClient();
  const fixture = await makeWorkspace();
  const deps = makeDeps(client, testConfig(), fixture);
  return { client, deps, paths: resolveWorkspace(fixture.projectRoot), cleanup: fixture.cleanup };
}

/** Mute the manual activation banner (it writes to process.stdout). */
function muteActivation(): { restore: () => void } {
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((() => true) as typeof process.stdout.write);
  return { restore: () => spy.mockRestore() };
}

describe('runOnce — planning → plan sync → feedback (scenarios 1-3)', () => {
  it('dispatches round 01, publishes the plan, then round 02 with FEEDBACK.md', async () => {
    const { client, deps, paths, cleanup } = await setup();
    const activation = muteActivation();
    try {
      client.addIssue(7, { title: 'Build export', labels: ['ai:planning'] });

      // Cycle 1: consumer_01 dispatched; nothing to sync yet.
      const first = await runOnce(deps);
      expect(first.dispatched).toEqual([
        { dispatched: true, dispatchId: 'gf_r123_i7_consumer_01', reason: 'new' },
      ]);
      expect(first.synced).toEqual([]);
      expect((await readCurrent(paths))?.dispatch_id).toBe('gf_r123_i7_consumer_01');

      // The agent works: PLAN.md + result=plan_ready.
      await writeOutboxFile(paths, 'gf_r123_i7_consumer_01', 'PLAN.md', '# Plan v1\n\n- step A');
      await writeOutboxFile(paths, 'gf_r123_i7_consumer_01', 'result.json', JSON.stringify({
        schema: 1,
        dispatch_id: 'gf_r123_i7_consumer_01',
        role: 'consumer',
        result: 'plan_ready',
        plan_file: 'PLAN.md',
      }));

      // Cycle 2 (issue now ai:review, no NEW feedback): plan published only.
      client.issues.get(7)!.labels = ['ai:review'];
      const second = await runOnce(deps);
      expect(second.dispatched).toEqual([]);
      expect(second.synced.map((o) => o.action)).toEqual(['plan-published']);
      expect(client.commentCount(7)).toBe(1);
      expect(client.issues.get(7)!.comments[0]!.body).toContain('# Plan v1');

      // Human feedback lands AFTER the plan comment (newer comment id).
      client.addComment(7, 'octo', '/change 不要用 SQLite');

      // Cycle 3: consumer_02 dispatched with FEEDBACK.md projected.
      const third = await runOnce(deps);
      expect(third.dispatched).toEqual([
        { dispatched: true, dispatchId: 'gf_r123_i7_consumer_02', reason: 'new' },
      ]);
      const feedback = await readFile(
        nodePath.join(paths.inbox, 'gf_r123_i7_consumer_02', 'FEEDBACK.md'),
        'utf8',
      );
      expect(feedback).toContain('不要用 SQLite');
      expect(feedback).toContain('(/change)');
      const dispatch02 = await readInboxDispatch(paths, 'gf_r123_i7_consumer_02');
      expect(dispatch02?.reason).toBe('feedback_applied');

      // Round 02 work + sync; re-run must not repost anything (replay).
      await writeOutboxFile(paths, 'gf_r123_i7_consumer_02', 'PLAN.md', '# Plan v2\n\n- step B');
      await writeOutboxFile(paths, 'gf_r123_i7_consumer_02', 'result.json', JSON.stringify({
        schema: 1,
        dispatch_id: 'gf_r123_i7_consumer_02',
        role: 'consumer',
        result: 'plan_ready',
        plan_file: 'PLAN.md',
      }));
      const fourth = await runOnce(deps);
      expect(fourth.synced.map((o) => [o.dispatchId, o.action])).toEqual([
        ['gf_r123_i7_consumer_01', 'skipped'],
        ['gf_r123_i7_consumer_02', 'plan-published'],
      ]);
      // Comments so far: plan v1, the human /change, plan v2.
      expect(client.commentCount(7)).toBe(3);

      const fifth = await runOnce(deps);
      expect(fifth.synced.every((o) => o.action === 'skipped' || o.action === 'unchanged')).toBe(true);
      expect(client.commentCount(7)).toBe(3);
    } finally {
      activation.restore();
      await cleanup();
    }
  });
});

describe('runOnce — approval gating (scenario 4)', () => {
  it('fake ai:ready dispatches nothing; a trusted /approve unlocks the executor', async () => {
    const { client, deps, paths, cleanup } = await setup();
    const activation = muteActivation();
    try {
      client.addIssue(9, { labels: ['ai:ready'] });
      const planComment = client.addComment(
        9,
        'gateflow-driver[bot]',
        buildPlanCommentBody('# Approved Plan\n\n- do X', 'gf_r123_i9_consumer_01'),
      );

      // No approval → NO executor dispatch (the fake label dies in intent).
      const blocked = await runOnce(deps);
      expect(blocked.dispatched).toEqual([]);
      expect(await readdir(paths.inbox)).toEqual([]);

      // Trusted human approves the CURRENT plan comment.
      client.addComment(9, 'octo', `/approve ${planComment.id}`);
      const allowed = await runOnce(deps);
      const dispatchId = `gf_r123_i9_executor_p${planComment.id}`;
      expect(allowed.dispatched).toEqual([
        { dispatched: true, dispatchId, reason: 'new' },
      ]);

      // Inbox PLAN.md = approved plan minus marker; context anchors it.
      const inboxDir = nodePath.join(paths.inbox, dispatchId);
      const plan = await readFile(nodePath.join(inboxDir, 'PLAN.md'), 'utf8');
      expect(plan).toBe(
        extractPlanContent(buildPlanCommentBody('# Approved Plan\n\n- do X', 'gf_r123_i9_consumer_01')),
      );
      const context = JSON.parse(await readFile(nodePath.join(inboxDir, 'context.json'), 'utf8')) as {
        plan_comment_id: number;
        plan_sha256: string;
      };
      expect(context.plan_comment_id).toBe(planComment.id);
      expect(context.plan_sha256).toBe(sha256Hex(plan));
      const current = await readCurrent(paths);
      expect(current?.dispatch_id).toBe(dispatchId);
      expect(current?.role).toBe('executor');
    } finally {
      activation.restore();
      await cleanup();
    }
  });

  it('a plan edited AFTER the approval never dispatches an executor', async () => {
    const { client, deps, paths, cleanup } = await setup();
    try {
      client.addIssue(9, { labels: ['ai:ready'] });
      const planComment = client.addComment(
        9,
        'gateflow-driver[bot]',
        buildPlanCommentBody('# Sneaky edit', 'gf_r123_i9_consumer_01'),
        { createdAt: '2026-09-06T11:00:00Z', updatedAt: '2026-09-06T13:00:00Z' },
      );
      client.addComment(9, 'octo', `/approve ${planComment.id}`, { createdAt: '2026-09-06T12:00:00Z' });

      const result = await runOnce(deps);
      expect(result.dispatched).toEqual([]);
      expect(await readdir(paths.inbox)).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('runOnce — retry ceiling and explicit retry (scenario 9)', () => {
  it('a maxed-out failed receipt blocks dispatch until retryDispatch clears it', async () => {
    const { client, deps, paths, cleanup } = await setup();
    const activation = muteActivation();
    try {
      client.addIssue(7, { labels: ['ai:planning'] });
      await writeInbox(paths, {
        dispatch: {
          schema: 1,
          dispatch_id: 'gf_r123_i7_consumer_01',
          repository: 'octo/repo',
          repository_id: 123,
          issue_number: 7,
          role: 'consumer',
          reason: 'planning',
          created_at: '2026-09-06T17:00:00Z',
          plan_comment_id: null,
          approval_comment_id: null,
          input: { task: 'TASK.md', plan: null, feedback: null },
        },
        context: { schema: 1, dispatch_id: 'gf_r123_i7_consumer_01', feedback_count: 0 },
        task: '# t\n',
        plan: null,
        feedback: null,
      });
      await writeReceipt(paths, {
        dispatch_id: 'gf_r123_i7_consumer_01',
        status: 'failed',
        attempts: 3,
        error: 'prior infrastructure failure',
      });

      const blocked = await runOnce(deps);
      expect(blocked.dispatched).toEqual([
        { dispatched: false, dispatchId: 'gf_r123_i7_consumer_01', reason: 'retry-limit' },
      ]);

      // Explicit CLI retry = offline receipt clear.
      expect(await retryDispatch(paths, 'gf_r123_i7_consumer_01')).toBe(true);

      const retried = await runOnce(deps);
      expect(retried.dispatched).toEqual([
        // Receipt cleared → fresh dispatch (reason 'new'), attempts restart at 1.
        { dispatched: true, dispatchId: 'gf_r123_i7_consumer_01', reason: 'new' },
      ]);
      const receipt = await readReceipt(paths, 'gf_r123_i7_consumer_01');
      expect(receipt?.status).toBe('dispatched');
      expect(receipt?.attempts).toBe(1);
    } finally {
      activation.restore();
      await cleanup();
    }
  });
});

describe('runOnce — per-issue containment', () => {
  it('one broken issue is logged and skipped; the others still dispatch', async () => {
    const { client, deps, paths, cleanup } = await setup();
    const activation = muteActivation();
    try {
      client.addIssue(7, { labels: ['ai:planning'] });
      client.addIssue(13, { labels: ['ai:planning'] });
      // Simulate a per-issue GitHub failure for #13 only.
      const originalList = client.listComments.bind(client);
      client.listComments = async (ref: IssueRef) => {
        if (ref.issueNumber === 13) throw new Error('simulated GitHub error');
        return originalList(ref);
      };

      const result = await runOnce(deps);
      expect(result.dispatched).toEqual([
        { dispatched: true, dispatchId: 'gf_r123_i7_consumer_01', reason: 'new' },
      ]);
      expect(deps.log.lines.some((l) => l.startsWith('error:') && l.includes('#13'))).toBe(true);
      expect(await readdir(paths.inbox)).toEqual(['gf_r123_i7_consumer_01']);
    } finally {
      activation.restore();
      await cleanup();
    }
  });
});
