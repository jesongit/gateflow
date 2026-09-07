/**
 * Dispatch tests (src/driver/dispatch.ts): intent → atomic inbox build →
 * current.json → receipt → activation notice, plus dedup/retry-limit,
 * epoch-bound dispatch ids and executor plan anchoring (plan_sha256 bound by
 * the Gate-issued approval record).
 */
import { describe, expect, it, vi } from 'vitest';

import { readFile, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { buildPlanCommentBody } from '../../src/github/comments';
import { dispatchIntent, processIntents } from '../../src/driver/dispatch';
import { readInboxDispatch, readCurrent, sha256Hex } from '../../src/workspace/inbox';
import { readReceipt, writeReceipt } from '../../src/workspace/outbox';
import { discoverIssue } from '../../src/driver/discovery';
import { canonicalPlanContent, planSha256 } from '../../src/protocol/plan';
import { epochCode } from '../../src/protocol/epoch';
import {
  FakeDriverClient,
  makeDeps,
  makeWorkspace,
  testConfig,
  testEpoch,
} from './helpers';

const PLAN = '# Plan\n\n1. Do it\n2. Verify it';
/** Issue 7's deterministic test epoch and its dispatch-id code. */
const EPOCH = testEpoch(7);
const EPOCH_CODE = epochCode(EPOCH)!;
const CONSUMER_ID = `gf_r123_i7_w${EPOCH_CODE}_consumer_01`;

describe('dispatchIntent — consumer planning (scenario 1)', () => {
  it('builds inbox + current + receipt and notifies the manual adapter', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:planning'] });
      client.ensureEpoch(7, EPOCH);
      const discovery = await discoverIssue(client, 'octo/repo', client.issues.get(7)!, deps.config, client.repository);
      const intent = discovery.intents[0]!;
      expect(intent).toBeDefined();
      expect(intent.epoch).toBe(EPOCH);

      // Capture the manual adapter notice (stdout injection via spy — the
      // adapter is constructed inside resolveAdapterForAgent).
      const writes: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

      const outcome = await dispatchIntent(deps, client.repository, discovery, intent);

      expect(outcome).toEqual({
        dispatched: true,
        dispatchId: CONSUMER_ID,
        reason: 'new',
      });
      spy.mockRestore();

      // Manual activation notice reached stdout (first-class manual path),
      // pointing at the EXACT dispatch path, never current.json.
      const printed = writes.join('');
      expect(printed).toContain('GateFlow: dispatch ready');
      expect(printed).toContain(CONSUMER_ID);
      expect(printed).toContain(`inbox/${CONSUMER_ID}/dispatch.json`);

      // Inbox content.
      const inboxDir = nodePath.join(fixture.paths.inbox, CONSUMER_ID);
      const task = await readFile(nodePath.join(inboxDir, 'TASK.md'), 'utf8');
      expect(task).toContain('# Issue 7');
      expect(task).toContain('## Goal');
      await expect(stat(nodePath.join(inboxDir, 'FEEDBACK.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(nodePath.join(inboxDir, 'PLAN.md'))).rejects.toMatchObject({ code: 'ENOENT' });

      // dispatch.json is a valid ready marker; context carries no plan fields
      // but binds the epoch and the input snapshot.
      const dispatch = await readInboxDispatch(fixture.paths, CONSUMER_ID);
      expect(dispatch).not.toBeNull();
      expect(dispatch?.role).toBe('consumer');
      expect(dispatch?.reason).toBe('planning');
      expect(dispatch?.workflow_epoch).toBe(EPOCH);
      expect(dispatch?.input).toEqual({ task: 'TASK.md', plan: null, feedback: null });

      // current.json points at the fresh dispatch (a manual pointer only).
      const current = await readCurrent(fixture.paths);
      expect(current?.dispatch_id).toBe(CONSUMER_ID);
      expect(current?.issue_number).toBe(7);

      // Receipt: first attempt, dispatched, epoch-bound, activation observed.
      const receipt = await readReceipt(fixture.paths, CONSUMER_ID);
      expect(receipt?.status).toBe('dispatched');
      expect(receipt?.attempts).toBe(1);
      expect(receipt?.workflow_epoch).toBe(EPOCH);
      expect(receipt?.activation?.state).toBe('notified');
      expect(receipt?.activation?.adapter).toBe('manual');
    } finally {
      await cleanup();
    }
  });

  it('projects only Gate-ACCEPTED feedback and bumps the round per accepted event', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:planning'] });
      client.ensureEpoch(7, EPOCH);
      // Two trusted-human feedback commands...
      const change = client.addComment(7, 'octo', '/change 不要使用 SQLite。', { id: 5, createdAt: '2026-09-06T11:00:00Z' });
      const choose = client.addComment(7, 'octo', '/choose db postgres', { id: 6, createdAt: '2026-09-06T11:30:00Z' });
      // ...but only /change has a Gate-issued acceptance record: /choose was
      // rejected by the gate and must NOT count towards the round.
      client.addGateRecord(7, {
        schema: 2,
        kind: 'feedback_accepted',
        repository_id: 123,
        issue_number: 7,
        workflow_epoch: EPOCH,
        event_id: `fe${change.id}`,
        feedback_comment_id: change.id,
        feedback_kind: 'change',
        gate_login: 'github-actions[bot]',
        gate_user_id: 41898282,
        created_at: '2026-09-06T11:05:00Z',
        operation_id: `feedback:123:7:${EPOCH}:${change.id}`,
      });

      const issue = client.issues.get(7)!;
      const discovery = await discoverIssue(client, 'octo/repo', issue, deps.config, client.repository);

      expect(discovery.feedback).toHaveLength(1);
      const outcome = await dispatchIntent(deps, client.repository, discovery, discovery.intents[0]!);

      const roundId = `gf_r123_i7_w${EPOCH_CODE}_consumer_02`;
      expect(outcome.dispatchId).toBe(roundId);
      expect(outcome.dispatched).toBe(true);
      const feedback = await readFile(
        nodePath.join(fixture.paths.inbox, roundId, 'FEEDBACK.md'),
        'utf8',
      );
      expect(feedback).toContain('不要使用 SQLite。');
      expect(feedback).not.toContain('postgres');

      const dispatch = await readInboxDispatch(fixture.paths, roundId);
      expect(dispatch?.reason).toBe('feedback_applied');
      expect(dispatch?.input.feedback).toBe('FEEDBACK.md');
    } finally {
      await cleanup();
    }
  });
});

describe('dispatchIntent — dedup and retry ceiling (scenario 9)', () => {
  it('published receipts are never re-dispatched (replay guard)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:planning'] });
      client.ensureEpoch(7, EPOCH);
      const discovery = await discoverIssue(client, 'octo/repo', client.issues.get(7)!, deps.config, client.repository);
      const intent = discovery.intents[0]!;

      await writeReceipt(fixture.paths, {
        dispatch_id: CONSUMER_ID,
        status: 'published',
        attempts: 1,
      });
      const outcome = await dispatchIntent(deps, client.repository, discovery, intent);
      expect(outcome).toEqual({ dispatched: false, dispatchId: CONSUMER_ID, reason: 'published' });
    } finally {
      await cleanup();
    }
  });

  it('failed receipts re-dispatch below max_attempts and increment attempts', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:planning'] });
      client.ensureEpoch(7, EPOCH);
      const discovery = await discoverIssue(client, 'octo/repo', client.issues.get(7)!, deps.config, client.repository);
      const intent = discovery.intents[0]!;
      await writeReceipt(fixture.paths, {
        dispatch_id: CONSUMER_ID,
        status: 'failed',
        attempts: 2,
        error: 'activation died',
      });

      const outcome = await dispatchIntent(deps, client.repository, discovery, intent);
      expect(outcome.dispatched).toBe(true);
      expect(outcome.reason).toBe('retry');
      const receipt = await readReceipt(fixture.paths, CONSUMER_ID);
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
      client.ensureEpoch(7, EPOCH);
      const discovery = await discoverIssue(client, 'octo/repo', client.issues.get(7)!, deps.config, client.repository);
      await writeReceipt(fixture.paths, {
        dispatch_id: CONSUMER_ID,
        status: 'failed',
        attempts: 3, // == maxAttempts (default 3)
      });

      const outcome = await dispatchIntent(deps, client.repository, discovery, discovery.intents[0]!);
      expect(outcome).toEqual({
        dispatched: false,
        dispatchId: CONSUMER_ID,
        reason: 'retry-limit',
      });
      // No inbox was built for the blocked dispatch.
      await expect(
        stat(nodePath.join(fixture.paths.inbox, CONSUMER_ID)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cleanup();
    }
  });
});

describe('dispatchIntent — executor plan anchoring', () => {
  it('binds PLAN.md to the approval-RECORD plan hash and pins plan_sha256', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:ready'] });
      client.ensureEpoch(7, EPOCH);
      const planComment = client.addComment(7, 'gateflow-driver[bot]', buildPlanCommentBody(PLAN, CONSUMER_ID));
      // The human's /approve command alone authorizes nothing: the durable
      // fact is the Gate-issued approval RECORD binding epoch+plan+hash.
      const humanCommand = client.addComment(7, 'octo', `/approve ${planComment.id}`);
      const approvalRecord = client.addGateRecord(7, {
        schema: 2,
        kind: 'approval',
        repository_id: 123,
        issue_number: 7,
        workflow_epoch: EPOCH,
        plan_comment_id: planComment.id,
        plan_sha256: planSha256(buildPlanCommentBody(PLAN, CONSUMER_ID)),
        approval_command_comment_id: humanCommand.id,
        approved_by_id: 42,
        approved_by_login: 'octo',
        gate_login: 'github-actions[bot]',
        gate_user_id: 41898282,
        created_at: '2026-09-06T11:10:00Z',
        operation_id: `approval:123:7:${EPOCH}:p${planComment.id}`,
      });
      const discovery = await discoverIssue(client, 'octo/repo', client.issues.get(7)!, deps.config, client.repository);
      expect(discovery.intents).toHaveLength(1);

      const outcome = await dispatchIntent(deps, client.repository, discovery, discovery.intents[0]!);
      const executorId = `gf_r123_i7_w${EPOCH_CODE}_executor_p${planComment.id}`;
      expect(outcome.dispatchId).toBe(executorId);
      expect(outcome.dispatched).toBe(true);

      const inboxDir = nodePath.join(fixture.paths.inbox, executorId);
      const plan = await readFile(nodePath.join(inboxDir, 'PLAN.md'), 'utf8');
      expect(plan).toBe(canonicalPlanContent(buildPlanCommentBody(PLAN, CONSUMER_ID)));
      expect(plan).not.toContain('gateflow:dispatch-id');

      const dispatch = await readInboxDispatch(fixture.paths, executorId);
      expect(dispatch?.plan_comment_id).toBe(planComment.id);
      expect(dispatch?.approval_comment_id).toBe(approvalRecord.id);
      expect(dispatch?.workflow_epoch).toBe(EPOCH);
      expect(dispatch?.input.plan).toBe('PLAN.md');
      expect(dispatch?.reason).toBe('approved_plan');

      const context = JSON.parse(
        await readFile(nodePath.join(inboxDir, 'context.json'), 'utf8'),
      ) as { plan_comment_id: number; plan_sha256: string; feedback_count: number; workflow_epoch: string; input_snapshot_sha256: string };
      expect(context.plan_comment_id).toBe(planComment.id);
      expect(context.plan_sha256).toBe(sha256Hex(plan));
      expect(context.workflow_epoch).toBe(EPOCH);
      expect(context.input_snapshot_sha256).toHaveLength(64);
      expect(context.feedback_count).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('does NOT dispatch an executor without a Gate-issued approval record', async () => {
    const { client, deps, cleanup } = await setup();
    try {
      client.addIssue(7, { labels: ['ai:ready'] });
      client.ensureEpoch(7, EPOCH);
      const planComment = client.addComment(7, 'gateflow-driver[bot]', buildPlanCommentBody(PLAN, CONSUMER_ID));
      // Only a human /approve comment, NO gate record: the fake-ready attack.
      client.addComment(7, 'octo', `/approve ${planComment.id}`);
      const discovery = await discoverIssue(client, 'octo/repo', client.issues.get(7)!, deps.config, client.repository);
      expect(discovery.intents).toHaveLength(0);
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
      client.ensureEpoch(1, testEpoch(1));
      client.addIssue(2, { labels: ['bug'] }); // no ai label → skipped
      client.addIssue(3, { labels: ['ai:working'] }); // sync-only → no intents
      client.addIssue(4, { state: 'closed', labels: ['ai:planning'] }); // closed → skipped

      const outcomes = await processIntents(deps, client.repository);
      expect(outcomes).toEqual([
        { dispatched: true, dispatchId: `gf_r123_i1_w${epochCode(testEpoch(1))!}_consumer_01`, reason: 'new' },
      ]);
      const { readdir } = await import('node:fs/promises');
      const inboxes = await readdir(fixture.paths.inbox);
      expect(inboxes).toEqual([`gf_r123_i1_w${epochCode(testEpoch(1))!}_consumer_01`]);
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
