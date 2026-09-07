/**
 * End-to-end driver cycle tests (src/driver/driver.ts runOnce): discovery →
 * dispatch → sync over the in-memory fake client, covering the planning /
 * plan-sync / accepted-feedback / approval-record / retry flows from docs/
 * architecture-v1.md §3 (scenarios 1-4 and 9) under Workspace schema 2.
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
import { canonicalPlanContent, planSha256 } from '../../src/protocol/plan';
import { epochCode } from '../../src/protocol/epoch';
import {
  FakeDriverClient,
  makeDeps,
  makeWorkspace,
  testConfig,
  testEpoch,
  writeOutboxFile,
} from './helpers';

const E7 = testEpoch(7);
const C7 = (round: number): string =>
  `gf_r123_i7_w${epochCode(E7)!}_consumer_0${round}`;
const E9 = testEpoch(9);
const X9 = (planCommentId: number): string =>
  `gf_r123_i9_w${epochCode(E9)!}_executor_p${planCommentId}`;

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

/**
 * Count CONTENT comments (plans, commands, notices): Gate record comments
 * (epoch/approval/feedback) are protocol plumbing, not content. Protocol
 * comments like plan reports embed a `gateflow:dispatch-id` comment but ARE
 * content, so only the three record markers are filtered.
 */
const RECORD_MARKER_PATTERN = /<!-- gateflow:(workflow|approval|feedback):v2/;

function contentCommentCount(client: FakeDriverClient, issueNumber: number): number {
  return (client.issues.get(issueNumber)?.comments ?? []).filter(
    (comment) => !RECORD_MARKER_PATTERN.test(comment.body),
  ).length;
}

/** The Gate-issued approval record fixture for an approved plan comment. */
function addApprovalRecord(
  client: FakeDriverClient,
  issueNumber: number,
  epoch: string,
  planCommentId: number,
  planBody: string,
  commandCommentId: number,
): void {
  client.addGateRecord(issueNumber, {
    schema: 2,
    kind: 'approval',
    repository_id: 123,
    issue_number: issueNumber,
    workflow_epoch: epoch,
    plan_comment_id: planCommentId,
    plan_sha256: planSha256(planBody),
    approval_command_comment_id: commandCommentId,
    approved_by_id: 42,
    approved_by_login: 'octo',
    gate_login: 'github-actions[bot]',
    gate_user_id: 41898282,
    created_at: '2026-09-06T11:10:00Z',
    operation_id: `approval:123:${issueNumber}:${epoch}:p${planCommentId}`,
  });
}

describe('runOnce — planning → plan sync → accepted feedback (scenarios 1-3)', () => {
  it('dispatches round 01, publishes the plan, then round 02 with FEEDBACK.md', async () => {
    const { client, deps, paths, cleanup } = await setup();
    const activation = muteActivation();
    try {
      client.addIssue(7, { title: 'Build export', labels: ['ai:planning'] });
      client.ensureEpoch(7, E7);

      // Cycle 1: consumer_01 dispatched; nothing to sync yet.
      const first = await runOnce(deps);
      expect(first.dispatched).toEqual([
        { dispatched: true, dispatchId: C7(1), reason: 'new' },
      ]);
      expect(first.synced).toEqual([]);
      expect((await readCurrent(paths))?.dispatch_id).toBe(C7(1));

      // The agent works: PLAN.md + result=plan_ready.
      await writeOutboxFile(paths, C7(1), 'PLAN.md', '# Plan v1\n\n- step A');
      await writeOutboxFile(paths, C7(1), 'result.json', JSON.stringify({
        schema: 2,
        dispatch_id: C7(1),
        role: 'consumer',
        result: 'plan_ready',
        plan_file: 'PLAN.md',
      }));

      // Cycle 2 (issue now ai:review, no NEW accepted feedback): plan
      // published only — `published`, not `accepted` (the gate has not been
      // observed moving the label yet at publication time).
      client.issues.get(7)!.labels = ['ai:review'];
      const second = await runOnce(deps);
      expect(second.dispatched).toEqual([]);
      expect(second.synced.map((o) => o.action)).toEqual(['plan-published']);
      expect(contentCommentCount(client, 7)).toBe(1);
      const firstContent = client
        .issues.get(7)!
        .comments.find((comment) => !RECORD_MARKER_PATTERN.test(comment.body));
      expect(firstContent?.body).toContain('# Plan v1');

      // Human feedback lands AFTER the plan comment; the Gate ACCEPTS it
      // (feedback_accepted record). A rejected command would not count.
      const change = client.addComment(7, 'octo', '/change 不要用 SQLite');
      client.addGateRecord(7, {
        schema: 2,
        kind: 'feedback_accepted',
        repository_id: 123,
        issue_number: 7,
        workflow_epoch: E7,
        event_id: `fe${change.id}`,
        feedback_comment_id: change.id,
        feedback_kind: 'change',
        gate_login: 'github-actions[bot]',
        gate_user_id: 41898282,
        created_at: '2026-09-06T11:40:00Z',
        operation_id: `feedback:123:7:${E7}:${change.id}`,
      });

      // Cycle 3: consumer_02 dispatched with FEEDBACK.md projected.
      const third = await runOnce(deps);
      expect(third.dispatched).toEqual([
        { dispatched: true, dispatchId: C7(2), reason: 'new' },
      ]);
      const feedback = await readFile(
        nodePath.join(paths.inbox, C7(2), 'FEEDBACK.md'),
        'utf8',
      );
      expect(feedback).toContain('不要用 SQLite');
      expect(feedback).toContain('(/change)');
      const dispatch02 = await readInboxDispatch(paths, C7(2));
      expect(dispatch02?.reason).toBe('feedback_applied');

      // Round 02 work + sync; round 01 is `published` → replay-guarded.
      await writeOutboxFile(paths, C7(2), 'PLAN.md', '# Plan v2\n\n- step B');
      await writeOutboxFile(paths, C7(2), 'result.json', JSON.stringify({
        schema: 2,
        dispatch_id: C7(2),
        role: 'consumer',
        result: 'plan_ready',
        plan_file: 'PLAN.md',
      }));
      const fourth = await runOnce(deps);
      expect(fourth.synced.map((o) => [o.dispatchId, o.action])).toEqual([
        // No approval record exists for plan v1 (the human requested changes
        // instead), so round 01 stays truthfully `published` — the replay
        // guard now skips it.
        [C7(1), 'skipped'],
        [C7(2), 'plan-published'],
      ]);
      // Comments so far: plan v1, the human /change, plan v2.
      expect(contentCommentCount(client, 7)).toBe(3);

      const fifth = await runOnce(deps);
      expect(fifth.synced.every((o) => o.action === 'skipped' || o.action === 'unchanged')).toBe(true);
      expect(contentCommentCount(client, 7)).toBe(3);
    } finally {
      activation.restore();
      await cleanup();
    }
  });
});

describe('runOnce — approval-record gating (scenario 4)', () => {
  it('fake ai:ready dispatches nothing; a Gate approval RECORD unlocks the executor', async () => {
    const { client, deps, paths, cleanup } = await setup();
    const activation = muteActivation();
    try {
      client.addIssue(9, { labels: ['ai:ready'] });
      client.ensureEpoch(9, E9);
      const planBody = buildPlanCommentBody('# Approved Plan\n\n- do X', 'gf_r123_i9_consumer_01');
      const planComment = client.addComment(9, 'gateflow-driver[bot]', planBody);

      // No approval record → NO executor dispatch (the fake label dies in
      // intent derivation).
      const blocked = await runOnce(deps);
      expect(blocked.dispatched).toEqual([]);
      expect(await readdir(paths.inbox)).toEqual([]);

      // Even the human's /approve COMMAND alone is not enough…
      const approvalCommand = client.addComment(9, 'octo', `/approve ${planComment.id}`);
      const stillBlocked = await runOnce(deps);
      expect(stillBlocked.dispatched).toEqual([]);

      // …the Gate-issued approval RECORD is the durable authorization fact,
      // anchored to the real human command comment.
      addApprovalRecord(client, 9, E9, planComment.id, planBody, approvalCommand.id);
      const allowed = await runOnce(deps);
      const dispatchId = X9(planComment.id);
      expect(allowed.dispatched).toEqual([
        { dispatched: true, dispatchId, reason: 'new' },
      ]);

      // Inbox PLAN.md = approved plan minus marker; context anchors it.
      const inboxDir = nodePath.join(paths.inbox, dispatchId);
      const plan = await readFile(nodePath.join(inboxDir, 'PLAN.md'), 'utf8');
      expect(plan).toBe(canonicalPlanContent(planBody));
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

  it('a plan edited AFTER the approval never dispatches an executor (hash binding)', async () => {
    const { client, deps, paths, cleanup } = await setup();
    try {
      client.addIssue(9, { labels: ['ai:ready'] });
      client.ensureEpoch(9, E9);
      const planBody = buildPlanCommentBody('# Sneaky edit', 'gf_r123_i9_consumer_01');
      const planComment = client.addComment(
        9,
        'gateflow-driver[bot]',
        planBody,
        { createdAt: '2026-09-06T11:00:00Z', updatedAt: '2026-09-06T13:00:00Z' },
      );
      client.addComment(9, 'octo', `/approve ${planComment.id}`, { createdAt: '2026-09-06T12:00:00Z' });
      // The record binds the hash of the plan AS APPROVED (before the edit):
      // the record's hash can never match the edited body again. (The command
      // comment id is irrelevant here — the hash mismatch rejects first.)
      addApprovalRecord(client, 9, E9, planComment.id, buildPlanCommentBody('# Original plan', 'gf_r123_i9_consumer_01'), 0);

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
      client.ensureEpoch(7, E7);
      await writeReceipt(paths, {
        dispatch_id: C7(1),
        status: 'failed',
        attempts: 3,
        error: 'prior infrastructure failure',
      });

      const blocked = await runOnce(deps);
      expect(blocked.dispatched).toEqual([
        { dispatched: false, dispatchId: C7(1), reason: 'retry-limit' },
      ]);

      // Explicit CLI retry = offline receipt clear.
      expect(await retryDispatch(paths, C7(1))).toBe(true);

      const retried = await runOnce(deps);
      expect(retried.dispatched).toEqual([
        // Receipt cleared → fresh dispatch (reason 'new'), attempts restart at 1.
        { dispatched: true, dispatchId: C7(1), reason: 'new' },
      ]);
      const receipt = await readReceipt(paths, C7(1));
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
      client.ensureEpoch(7, E7);
      client.addIssue(13, { labels: ['ai:planning'] });
      // Simulate a per-issue GitHub failure for #13 only.
      const originalList = client.listComments.bind(client);
      client.listComments = async (ref: IssueRef) => {
        if (ref.issueNumber === 13) throw new Error('simulated GitHub error');
        return originalList(ref);
      };

      const result = await runOnce(deps);
      expect(result.dispatched).toEqual([
        { dispatched: true, dispatchId: C7(1), reason: 'new' },
      ]);
      expect(deps.log.lines.some((l) => l.startsWith('error:') && l.includes('#13'))).toBe(true);
      expect(await readdir(paths.inbox)).toEqual([C7(1)]);
    } finally {
      activation.restore();
      await cleanup();
    }
  });
});
