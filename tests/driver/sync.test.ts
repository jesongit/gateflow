/**
 * Sync engine tests (src/driver/sync.ts): validation-before-sync, replay
 * protection, human-only rejection, plan/completion publication, tracker
 * lifecycle (create → blocked → resumed → completed), progress debounce and
 * crash recovery. All GitHub access goes through the in-memory fake.
 */
import { describe, expect, it } from 'vitest';

import { rm } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { Dispatch, WorkspaceContext } from '../../src/workspace/protocol';
import { atomicWriteJson, sha256Hex } from '../../src/workspace/inbox';
import { syncAll, syncDispatch } from '../../src/driver/sync';
import { readReceipt } from '../../src/workspace/outbox';
import {
  FakeDriverClient,
  ISSUE,
  collectingLog,
  makeDeps,
  makeWorkspace,
  testConfig,
  writeOutboxFile,
} from './helpers';
import type { WorkspaceFixture } from './helpers';

const CONSUMER_ID = `gf_r123_i${ISSUE}_consumer_01`;
const EXECUTOR_ID = `gf_r123_i${ISSUE}_executor_p501`;
const PLAN = '# Execution Plan\n\n1. step one\n2. step two';
const REPORT = '# Report\n\nEverything verified.';

async function seedInbox(
  fixture: WorkspaceFixture,
  dispatchId: string,
  role: 'consumer' | 'executor',
): Promise<void> {
  const dispatch: Dispatch = {
    schema: 1,
    dispatch_id: dispatchId,
    repository: 'octo/repo',
    repository_id: 123,
    issue_number: ISSUE,
    role,
    reason: role === 'executor' ? 'approved_plan' : 'planning',
    created_at: '2026-09-06T17:00:00Z',
    plan_comment_id: role === 'executor' ? 501 : null,
    approval_comment_id: role === 'executor' ? 601 : null,
    input:
      role === 'executor'
        ? { task: 'TASK.md', plan: 'PLAN.md', feedback: null }
        : { task: 'TASK.md', plan: null, feedback: null },
  };
  const context: WorkspaceContext = {
    schema: 1,
    dispatch_id: dispatchId,
    ...(role === 'executor' ? { plan_comment_id: 501, plan_sha256: 'a'.repeat(64) } : {}),
    feedback_count: 0,
  };
  await atomicWriteJson(nodePath.join(fixture.paths.inbox, dispatchId, 'dispatch.json'), dispatch);
  await atomicWriteJson(nodePath.join(fixture.paths.inbox, dispatchId, 'context.json'), context);
}

async function setup() {
  const client = new FakeDriverClient();
  const fixture = await makeWorkspace();
  const log = collectingLog();
  const deps = makeDeps(client, testConfig(), fixture);
  client.addIssue(ISSUE, { labels: ['ai:working'] });
  return { client, fixture, deps, log, cleanup: fixture.cleanup };
}

describe('rejection gates (docs §5, §8)', () => {
  it('unknown dispatch id (no inbox) → rejected, nothing synced', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await writeOutboxFile(fixture.paths, `gf_r123_i99_consumer_99`, 'status.json', '{}');
      const outcome = await syncDispatch(deps, client.repository, 'gf_r123_i99_consumer_99');
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/unknown dispatch/i);
      expect(client.commentCount(ISSUE)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('human-only result value "approved" → rejected, no GitHub write, no crash', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'approved',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
      expect(client.commentCount(ISSUE)).toBe(0);
      expect((await readReceipt(fixture.paths, CONSUMER_ID))?.status ?? 'absent').toBe('absent');
    } finally {
      await cleanup();
    }
  });

  it('dispatch_id mismatch between outbox file and directory → rejected', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 1,
        dispatch_id: 'gf_r123_i7_consumer_99', // wrong dispatch
        role: 'consumer',
        result: 'plan_ready',
        plan_file: 'PLAN.md',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/dispatch_id/);
      expect(client.commentCount(ISSUE)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('role mismatch (executor file in consumer dispatch) → rejected', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: CONSUMER_ID, role: 'executor', result: 'completed',
        report_file: 'REPORT.md', validation: 'passed',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/role/);
    } finally {
      await cleanup();
    }
  });

  it('oversized PLAN.md (> 512 KB) → rejected (anti-oversized, docs §5.7)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'PLAN.md', 'x'.repeat(513 * 1024));
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/exceeds 524288/);
      expect(client.commentCount(ISSUE)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('invalid JSON result → rejected', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', '{not json');
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
    } finally {
      await cleanup();
    }
  });
});

describe('consumer sync (scenario 2)', () => {
  it('result=plan_ready publishes the plan comment once; replays are skipped', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'PLAN.md', PLAN);
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md',
      }));

      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('plan-published');
      expect(client.commentCount(ISSUE)).toBe(1);
      const body = client.issues.get(ISSUE)!.comments[0]!.body;
      expect(body).toContain('ai-workflow:plan:v1');
      expect(body).toContain(`gateflow:dispatch-id: ${CONSUMER_ID}`);
      expect(body).toContain('1. step one');

      const receipt = await readReceipt(fixture.paths, CONSUMER_ID);
      expect(receipt?.status).toBe('synced');

      // Replay protection (docs §8.4): a second sync must not repost.
      const second = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(second.action).toBe('skipped');
      expect(client.commentCount(ISSUE)).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('plan_ready without PLAN.md → rejected', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/PLAN\.md/);
    } finally {
      await cleanup();
    }
  });

  it('result=question posts a plain notice and syncs the receipt', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'question',
        reason: '需要确认数据库选型',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('notice');
      expect(client.issues.get(ISSUE)!.comments[0]!.body).toBe(
        `[gateflow] consumer question (dispatch ${CONSUMER_ID}): 需要确认数据库选型`,
      );
      expect((await readReceipt(fixture.paths, CONSUMER_ID))?.status).toBe('synced');
    } finally {
      await cleanup();
    }
  });

  it('status=working without a result → unchanged (no GitHub write)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'status.json', JSON.stringify({
        schema: 1, dispatch_id: CONSUMER_ID, role: 'consumer', state: 'working',
        updated_at: '2026-09-06T17:30:00Z',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('unchanged');
      expect(client.commentCount(ISSUE)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('status=blocked without a result → plain notice, receipt synced', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'status.json', JSON.stringify({
        schema: 1, dispatch_id: CONSUMER_ID, role: 'consumer', state: 'blocked',
        summary: '等待 API key',
        updated_at: '2026-09-06T17:30:00Z',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('notice');
      expect(client.issues.get(ISSUE)!.comments[0]!.body).toBe(
        `[gateflow] consumer blocked (dispatch ${CONSUMER_ID}): 等待 API key`,
      );
      expect((await readReceipt(fixture.paths, CONSUMER_ID))?.status).toBe('synced');
    } finally {
      await cleanup();
    }
  });
});

describe('executor sync — completion (scenario 5 tail)', () => {
  it('completed + passed + REPORT.md → completion report; replays skipped', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'REPORT.md', REPORT);
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'completed',
        report_file: 'REPORT.md', validation: 'passed',
      }));

      const outcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(outcome.action).toBe('completed');
      const body = client.issues.get(ISSUE)!.comments[0]!.body;
      expect(body).toContain('ai-workflow:completion-report:v1');
      expect(body).toContain(`gateflow:dispatch-id: ${EXECUTOR_ID}`);
      expect(body).toContain('Everything verified.');
      expect((await readReceipt(fixture.paths, EXECUTOR_ID))?.status).toBe('synced');

      const second = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(second.action).toBe('skipped');
      expect(client.commentCount(ISSUE)).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('completed with validation="failed" → rejected (unverified claims never publish)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'REPORT.md', REPORT);
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'completed',
        report_file: 'REPORT.md', validation: 'failed',
      }));
      const outcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(outcome.action).toBe('rejected');
      expect(client.commentCount(ISSUE)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('completed without REPORT.md → rejected', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'completed',
        report_file: 'REPORT.md', validation: 'passed',
      }));
      const outcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/REPORT\.md/);
    } finally {
      await cleanup();
    }
  });

  it('result=blocked → tracker Blocked + plain notice, receipt synced', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'blocked',
        reason: '缺少第三方 API 凭证',
      }));
      const outcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(outcome.action).toBe('notice');
      const comments = client.issues.get(ISSUE)!.comments;
      expect(comments).toHaveLength(2);
      expect(comments[0]!.body).toContain('**Status:** Blocked');
      expect(comments[0]!.body).toContain('ai-workflow:execution-tracker:v1');
      expect(comments[1]!.body).toBe(
        `[gateflow] executor blocked (dispatch ${EXECUTOR_ID}): 缺少第三方 API 凭证`,
      );
      const receipt = await readReceipt(fixture.paths, EXECUTOR_ID);
      expect(receipt?.status).toBe('synced');
      expect(receipt?.tracker_comment_id).toBe(comments[0]!.id);

      const second = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(second.action).toBe('skipped');
    } finally {
      await cleanup();
    }
  });
});

describe('executor tracker lifecycle (scenario 5)', () => {
  async function writeStatus(fixture: WorkspaceFixture, state: 'working' | 'blocked'): Promise<void> {
    await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'status.json', JSON.stringify({
      schema: 1, dispatch_id: EXECUTOR_ID, role: 'executor', state,
      updated_at: '2026-09-06T17:30:00Z',
    }));
  }

  it('working → tracker created In Progress; blocked → same comment edited; working → resumed', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeStatus(fixture, 'working');

      const created = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(created.action).toBe('tracker-created');
      let comments = client.issues.get(ISSUE)!.comments;
      expect(comments).toHaveLength(1);
      const trackerId = comments[0]!.id;
      expect(comments[0]!.body).toContain('**Status:** In Progress');
      expect(comments[0]!.body).toContain(`gateflow:dispatch-id: ${EXECUTOR_ID}`);
      expect((await readReceipt(fixture.paths, EXECUTOR_ID))?.tracker_comment_id).toBe(trackerId);

      // Nothing changed → unchanged (no edit spam).
      expect((await syncDispatch(deps, client.repository, EXECUTOR_ID)).action).toBe('unchanged');

      await writeStatus(fixture, 'blocked');
      const blocked = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(blocked.action).toBe('blocked');
      comments = client.issues.get(ISSUE)!.comments;
      expect(comments).toHaveLength(1); // edited, not duplicated
      expect(comments[0]!.id).toBe(trackerId);
      expect(comments[0]!.body).toContain('**Status:** Blocked');

      await writeStatus(fixture, 'working');
      const resumed = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(resumed.action).toBe('resumed');
      comments = client.issues.get(ISSUE)!.comments;
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain('**Status:** In Progress');
      expect(comments[0]!.body).not.toContain('**Status:** Blocked');

      // Terminal: report + completed → completion report; receipt synced.
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'REPORT.md', REPORT);
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'completed',
        report_file: 'REPORT.md', validation: 'passed',
      }));
      const completed = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(completed.action).toBe('completed');
      expect(client.commentCount(ISSUE)).toBe(2);
      expect((await readReceipt(fixture.paths, EXECUTOR_ID))?.status).toBe('synced');

      const again = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(again.action).toBe('skipped');
      expect(client.commentCount(ISSUE)).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it('blocked with no prior tracker creates one and immediately sets Blocked', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'status.json', JSON.stringify({
        schema: 1, dispatch_id: EXECUTOR_ID, role: 'executor', state: 'blocked',
        updated_at: '2026-09-06T17:30:00Z',
      }));
      const outcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(outcome.action).toBe('blocked');
      const comments = client.issues.get(ISSUE)!.comments;
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain('**Status:** Blocked');
    } finally {
      await cleanup();
    }
  });

  it('progress edits are debounced (scenario 6, injected clock)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      let clock = new Date('2026-09-06T17:00:00Z');
      const timedDeps = makeDeps(client, testConfig({ progressSyncSeconds: 60 }), fixture, () => clock);
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'status.json', JSON.stringify({
        schema: 1, dispatch_id: EXECUTOR_ID, role: 'executor', state: 'working',
        updated_at: '2026-09-06T17:00:00Z',
      }));
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'PROGRESS.md', 'P1: started');

      expect((await syncDispatch(timedDeps, client.repository, EXECUTOR_ID)).action).toBe('tracker-created');
      const trackerId = client.issues.get(ISSUE)!.comments[0]!.id;
      expect(client.issues.get(ISSUE)!.comments[0]!.body).toContain('P1: started');

      // Progress changes within the window → no edit.
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'PROGRESS.md', 'P2: half done');
      clock = new Date('2026-09-06T17:00:30Z');
      expect((await syncDispatch(timedDeps, client.repository, EXECUTOR_ID)).action).toBe('unchanged');
      expect(client.issues.get(ISSUE)!.comments[0]!.body).toContain('P1: started');
      expect(client.issues.get(ISSUE)!.comments[0]!.body).not.toContain('P2');

      // After the window elapses → single tracker edit with the new content.
      clock = new Date('2026-09-06T17:01:01Z');
      const updated = await syncDispatch(timedDeps, client.repository, EXECUTOR_ID);
      expect(updated.action).toBe('tracker-updated');
      expect(client.issues.get(ISSUE)!.comments[0]!.id).toBe(trackerId);
      expect(client.issues.get(ISSUE)!.comments[0]!.body).toContain('P2: half done');
      expect((await readReceipt(fixture.paths, EXECUTOR_ID))?.last_progress_sha256).toBe(
        sha256Hex('P2: half done'),
      );
    } finally {
      await cleanup();
    }
  });

  it('receipts lost after tracker creation → tracker adopted, not duplicated (scenario 8)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'status.json', JSON.stringify({
        schema: 1, dispatch_id: EXECUTOR_ID, role: 'executor', state: 'working',
        updated_at: '2026-09-06T17:30:00Z',
      }));
      expect((await syncDispatch(deps, client.repository, EXECUTOR_ID)).action).toBe('tracker-created');
      const trackerId = client.issues.get(ISSUE)!.comments[0]!.id;

      // Crash: receipts vanish (docs §2.6 — cache, rebuildable).
      await rm(nodePath.join(fixture.paths.receipts, `${EXECUTOR_ID}.json`));

      const recovered = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(recovered.action).toBe('tracker-created');
      expect(recovered.detail).toMatch(/recovered/);
      expect(client.commentCount(ISSUE)).toBe(1);
      expect(client.issues.get(ISSUE)!.comments[0]!.id).toBe(trackerId);
      expect((await readReceipt(fixture.paths, EXECUTOR_ID))?.tracker_comment_id).toBe(trackerId);
    } finally {
      await cleanup();
    }
  });
});

describe('syncAll', () => {
  it('syncs every outbox dispatch dir sequentially', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      const otherId = 'gf_r123_i8_consumer_01';
      client.addIssue(8, { labels: ['ai:working'] });
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'PLAN.md', PLAN);
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 1, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md',
      }));

      // An outbox dir whose inbox is gone → rejected, does not stop the rest.
      await writeOutboxFile(fixture.paths, otherId, 'status.json', '{}');

      const outcomes = await syncAll(deps, client.repository);
      const byId = new Map(outcomes.map((o) => [o.dispatchId, o.action]));
      expect(byId.get(CONSUMER_ID)).toBe('plan-published');
      expect(byId.get(otherId)).toBe('rejected');
    } finally {
      await cleanup();
    }
  });
});
