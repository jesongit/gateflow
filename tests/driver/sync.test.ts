/**
 * Sync engine tests (src/driver/sync.ts): validation-before-sync, PREFLIGHT
 * authorization, replay protection, human-only rejection, plan/completion
 * publication (published ≠ accepted), operation reconciliation (adopt /
 * conflict), tracker lifecycle (create → blocked → resumed → completed),
 * progress debounce and crash recovery. All GitHub access goes through the
 * in-memory fake.
 */
import { describe, expect, it } from 'vitest';

import { rm } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { CommentDetail } from '../../src/github/client';
import type { Dispatch, WorkspaceContext } from '../../src/workspace/protocol';
import { transitionRecord } from './helpers';
import { atomicWriteJson, sha256Hex } from '../../src/workspace/inbox';
import { syncAll, syncDispatch } from '../../src/driver/sync';
import { readReceipt } from '../../src/workspace/outbox';
import { buildPlanCommentBody } from '../../src/github/comments';
import { planSha256 } from '../../src/protocol/plan';
import { epochCode } from '../../src/protocol/epoch';
import {
  FakeDriverClient,
  ISSUE,
  collectingLog,
  makeDeps,
  makeWorkspace,
  testConfig,
  testEpoch,
  writeOutboxFile,
} from './helpers';
import type { WorkspaceFixture } from './helpers';

const EPOCH = testEpoch(ISSUE);
const CODE = epochCode(EPOCH)!;
const CONSUMER_ID = `gf_r123_i${ISSUE}_w${CODE}_consumer_01`;
const EXECUTOR_ID = `gf_r123_i${ISSUE}_w${CODE}_executor_p501`;
const PLAN = '# Execution Plan\n\n1. step one\n2. step two';
const REPORT = '# Report\n\nEverything verified.';

const RECORD_MARKER = /<!-- gateflow:(workflow|approval|feedback):v2/;

/**
 * CONTENT comments on the issue (plans, trackers, notices, commands): Gate
 * record comments are protocol plumbing, not content, and setup's epoch
 * record must not distort write-count assertions.
 */
function contentComments(client: FakeDriverClient, issueNumber: number): CommentDetail[] {
  return (client.issues.get(issueNumber)?.comments ?? []).filter(
    (comment) => !RECORD_MARKER.test(comment.body),
  );
}

/**
 * Executor preflight requires the REAL authorization chain on GitHub: the
 * current plan comment #501, the human /approve command, and a Gate-issued
 * approval record binding (epoch, plan id, exact plan hash, command).
 */
function seedExecutorAuthorization(client: FakeDriverClient, planBody = buildPlanCommentBody(PLAN, EXECUTOR_ID)): void {
  client.addComment(ISSUE, 'gateflow-driver[bot]', planBody, { id: 501 });
  client.addComment(ISSUE, 'octo', '/approve 501', { id: 601 });
  client.addGateRecord(ISSUE, {
    schema: 2,
    kind: 'approval',
    repository_id: 123,
    issue_number: ISSUE,
    workflow_epoch: EPOCH,
    plan_comment_id: 501,
    plan_sha256: planSha256(planBody),
    approval_command_comment_id: 601,
    approved_by_id: 42,
    approved_by_login: 'octo',
    gate_login: 'github-actions[bot]',
    gate_user_id: 41898282,
    created_at: '2026-09-06T17:05:00Z',
    operation_id: `approval:123:${ISSUE}:${EPOCH}:p501`,
  });
}

async function seedInbox(
  fixture: WorkspaceFixture,
  dispatchId: string,
  role: 'consumer' | 'executor',
): Promise<void> {
  const dispatch: Dispatch = {
    schema: 2,
    dispatch_id: dispatchId,
    repository: 'octo/repo',
    repository_id: 123,
    issue_number: ISSUE,
    workflow_epoch: EPOCH,
    role,
    reason: role === 'executor' ? 'approved_plan' : 'planning',
    created_at: '2026-09-06T17:00:00Z',
    plan_comment_id: role === 'executor' ? 501 : null,
    approval_comment_id: role === 'executor' ? 900 : null,
    input:
      role === 'executor'
        ? { task: 'TASK.md', plan: 'PLAN.md', feedback: null }
        : { task: 'TASK.md', plan: null, feedback: null },
  };
  const context: WorkspaceContext = {
    schema: 2,
    dispatch_id: dispatchId,
    workflow_epoch: EPOCH,
    ...(role === 'executor' ? { plan_comment_id: 501, plan_sha256: 'a'.repeat(64) } : {}),
    feedback_count: 0,
    input_snapshot_sha256: 'b'.repeat(64),
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
  client.ensureEpoch(ISSUE, EPOCH);
  return { client, fixture, deps, log, cleanup: fixture.cleanup };
}

describe('rejection gates (docs §5, §8)', () => {
  it('unknown dispatch id (no inbox) → rejected, nothing synced', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await writeOutboxFile(fixture.paths, `gf_r123_i99_w${'0'.repeat(12)}_consumer_99`, 'status.json', '{}');
      const outcome = await syncDispatch(deps, client.repository, `gf_r123_i99_w${'0'.repeat(12)}_consumer_99`);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/unknown dispatch/i);
      expect(contentComments(client, ISSUE)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('human-only result value "approved" → rejected, no GitHub write, no crash', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'approved',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
      expect(contentComments(client, ISSUE)).toHaveLength(0);
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
        schema: 2,
        dispatch_id: `gf_r123_i7_w${CODE}_consumer_99`, // wrong dispatch
        role: 'consumer',
        result: 'plan_ready',
        plan_file: 'PLAN.md',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/dispatch_id/);
      expect(contentComments(client, ISSUE)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('role mismatch (executor file in consumer dispatch) → rejected', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'executor', result: 'completed',
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
      client.issues.get(ISSUE)!.labels = ['ai:planning'];
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'PLAN.md', 'x'.repeat(513 * 1024));
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/exceeds 524288/);
      expect(contentComments(client, ISSUE)).toHaveLength(0);
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

describe('preflight authorization gates (hardening)', () => {
  it('a dispatch whose epoch is superseded → obsolete (old dispatch invalid)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      // A NEW round starts: a newer epoch record supersedes the old one.
      const newEpoch = testEpoch(9001);
      client.addGateRecord(ISSUE, {
        schema: 2,
        kind: 'workflow_epoch',
        repository_id: 123,
        issue_number: ISSUE,
        workflow_epoch: newEpoch,
        created_by: 'gate',
        created_at: '2026-09-06T18:00:00Z',
        issued_by: 'github-actions[bot]',
        operation_id: `epoch:123:${ISSUE}:c9002`,
      });
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('obsolete');
      expect(outcome.detail).toMatch(/superseded/);
      expect((await readReceipt(fixture.paths, CONSUMER_ID))?.status).toBe('obsolete');
    } finally {
      await cleanup();
    }
  });

  it('a dispatch whose label vanished (cancel) → obsolete', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      client.issues.get(ISSUE)!.labels = [];
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('obsolete');
      expect((await readReceipt(fixture.paths, CONSUMER_ID))?.status).toBe('obsolete');
    } finally {
      await cleanup();
    }
  });

  it('an executor without a valid approval binding (hash mismatch) → obsolete, nothing published', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      // The approval record binds a DIFFERENT plan content than comment #501
      // currently carries (the plan was edited after approval): the comment
      // keeps the ORIGINAL plan, the record pins the pre-edit hash — which
      // can never match the edited body again.
      const editedBody = buildPlanCommentBody('# Sneakily edited plan', EXECUTOR_ID);
      client.addComment(ISSUE, 'gateflow-driver[bot]', editedBody, { id: 501 });
      client.addGateRecord(ISSUE, {
        schema: 2,
        kind: 'approval',
        repository_id: 123,
        issue_number: ISSUE,
        workflow_epoch: EPOCH,
        plan_comment_id: 501,
        plan_sha256: planSha256(buildPlanCommentBody('# Original approved plan', EXECUTOR_ID)),
        approval_command_comment_id: 601,
        approved_by_id: 42,
        approved_by_login: 'octo',
        gate_login: 'github-actions[bot]',
        gate_user_id: 41898282,
        created_at: '2026-09-06T17:05:00Z',
        operation_id: `approval:123:${ISSUE}:${EPOCH}:p501`,
      });
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'REPORT.md', REPORT);
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'completed',
        report_file: 'REPORT.md', validation: 'passed',
      }));
      const outcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(outcome.action).toBe('obsolete');
      expect(outcome.detail).toMatch(/approval record/);
      // Only the plan comment is content: no report was published.
      expect(contentComments(client, ISSUE)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

describe('consumer sync (scenario 2)', () => {
  it('result=plan_ready publishes the plan comment once (published); replay skipped', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.issues.get(ISSUE)!.labels = ['ai:planning'];
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'PLAN.md', PLAN);
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md',
      }));

      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('plan-published');
      expect(outcome.detail).toMatch(/awaiting Gate acceptance/);
      expect(contentComments(client, ISSUE)).toHaveLength(1);
      const body = contentComments(client, ISSUE)[0]!.body;
      expect(body).toContain('ai-workflow:plan:v1');
      expect(body).toContain(`gateflow:dispatch-id: ${CONSUMER_ID}`);
      expect(body).toContain('1. step one');

      const receipt = await readReceipt(fixture.paths, CONSUMER_ID);
      expect(receipt?.status).toBe('published');
      expect(receipt?.published_comment_id).toBe(contentComments(client, ISSUE)[0]!.id);

      // Replay protection (docs §8.4): a second sync must not repost.
      const second = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(second.action).toBe('skipped');
      expect(contentComments(client, ISSUE)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('published plan becomes accepted when the Gate approves it (approval record)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.issues.get(ISSUE)!.labels = ['ai:planning'];
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'PLAN.md', PLAN);
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md',
      }));
      await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect((await readReceipt(fixture.paths, CONSUMER_ID))?.status).toBe('published');

      // The label alone (review) is not acceptance: without an approval
      // record bound to the published plan, the receipt stays `published`.
      client.issues.get(ISSUE)!.labels = ['ai:review'];
      const stillPublished = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(stillPublished.action).toBe('skipped');
      expect((await readReceipt(fixture.paths, CONSUMER_ID))?.status).toBe('published');

      // The Gate approves the PUBLISHED plan comment (record for that id).
      const publishedPlanId = (await readReceipt(fixture.paths, CONSUMER_ID))?.published_comment_id!;
      client.addComment(ISSUE, 'octo', `/approve ${publishedPlanId}`, { id: 600 });
      client.addGateRecord(ISSUE, {
        schema: 2,
        kind: 'approval',
        repository_id: 123,
        issue_number: ISSUE,
        workflow_epoch: EPOCH,
        plan_comment_id: publishedPlanId,
        plan_sha256: planSha256(buildPlanCommentBody(PLAN, CONSUMER_ID)),
        approval_command_comment_id: 600,
        approved_by_id: 42,
        approved_by_login: 'octo',
        gate_login: 'github-actions[bot]',
        gate_user_id: 41898282,
        created_at: '2026-09-06T17:20:00Z',
        operation_id: `approval:123:${ISSUE}:${EPOCH}:p${publishedPlanId}`,
      });
      const accepted = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(accepted.action).toBe('accepted');
      expect((await readReceipt(fixture.paths, CONSUMER_ID))?.status).toBe('accepted');
    } finally {
      await cleanup();
    }
  });

  it('plan_ready without PLAN.md → rejected', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.issues.get(ISSUE)!.labels = ['ai:planning'];
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/PLAN\.md/);
    } finally {
      await cleanup();
    }
  });

  it('result=question posts a plain notice once; the receipt stays dispatched (notices are non-state-bearing)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'question',
        reason: '需要确认数据库选型',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('notice');
      expect(contentComments(client, ISSUE)[0]!.body).toBe(
        `[gateflow] consumer question (dispatch ${CONSUMER_ID}): 需要确认数据库选型`,
      );
      const receipt = await readReceipt(fixture.paths, CONSUMER_ID);
      expect(receipt?.status).toBe('dispatched');
      expect(receipt?.last_notice_key).toMatch(/^[0-9a-f]{16}$/);

      const repeat = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(repeat.action).toBe('unchanged');
      expect(contentComments(client, ISSUE)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('status=working without a result → unchanged (no GitHub write)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'status.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'consumer', state: 'working',
        updated_at: '2026-09-06T17:30:00Z',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('unchanged');
      expect(contentComments(client, ISSUE)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('status=blocked without a result → plain notice once, receipt stays dispatched (replay token reserved for results)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'status.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'consumer', state: 'blocked',
        summary: '等待 API key',
        updated_at: '2026-09-06T17:30:00Z',
      }));
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('notice');
      expect(contentComments(client, ISSUE)[0]!.body).toBe(
        `[gateflow] consumer blocked (dispatch ${CONSUMER_ID}): 等待 API key`,
      );
      // Status notices are non-terminal (docs §2.6 / §8.4): the receipt must
      // NOT become `published`, otherwise the dispatch's later legitimate
      // result.json would be swallowed by the replay guard. The notice key
      // remembers it so it is posted once, not every cycle.
      const receipt = await readReceipt(fixture.paths, CONSUMER_ID);
      expect(receipt?.status).toBe('dispatched');
      expect(receipt?.last_notice_key).toMatch(/^[0-9a-f]{16}$/);

      const repeat = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(repeat.action).toBe('unchanged');
      expect(contentComments(client, ISSUE)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

describe('executor sync — completion (scenario 5 tail)', () => {
  it('completed + passed + REPORT.md → lawful tracker repaired + report published; replays skipped', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      seedExecutorAuthorization(client);
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'REPORT.md', REPORT);
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'completed',
        report_file: 'REPORT.md', validation: 'passed',
      }));

      const outcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(outcome.action).toBe('completed');
      // The agent completed without a tracker: the Driver repairs the lawful
      // chain (tracker first, then report — the issue can legally reach DONE).
      const comments = contentComments(client, ISSUE);
      expect(comments).toHaveLength(4); // plan + /approve + tracker + report
      expect(comments[0]!.body).toContain('ai-workflow:plan:v1');
      expect(comments[2]!.body).toContain('ai-workflow:execution-tracker:v1');
      const report = comments[3]!;
      expect(report.body).toContain('ai-workflow:completion-report:v1');
      expect(report.body).toContain(`gateflow:dispatch-id: ${EXECUTOR_ID}`);
      expect(report.body).toContain('Everything verified.');
      const receipt = await readReceipt(fixture.paths, EXECUTOR_ID);
      expect(receipt?.status).toBe('published');
      expect(receipt?.published_comment_id).toBe(report.id);
      expect(receipt?.tracker_comment_id).toBe(comments[2]!.id);

      const second = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(second.action).toBe('skipped');
      expect(contentComments(client, ISSUE)).toHaveLength(4);
    } finally {
      await cleanup();
    }
  });

  it('report published then label done observed → accepted (published ≠ accepted)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      seedExecutorAuthorization(client);
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'REPORT.md', REPORT);
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'completed',
        report_file: 'REPORT.md', validation: 'passed',
      }));
      await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect((await readReceipt(fixture.paths, EXECUTOR_ID))?.status).toBe('published');
      const reportCommentId = (await readReceipt(fixture.paths, EXECUTOR_ID))?.published_comment_id;

      // V1.1 Phase 5 NEGATIVE: the bare `ai:done` label is NEVER acceptance.
      client.issues.get(ISSUE)!.labels = ['ai:done'];
      const notAccepted = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(notAccepted.action).toBe('skipped'); // replay guard keeps it published
      expect((await readReceipt(fixture.paths, EXECUTOR_ID))?.status).toBe('published');

      // The Gate accepted the report (T6): the gate_transition record binds
      // (epoch, dispatch, T6, THIS report comment) — then the label moved.
      client.addGateRecord(ISSUE, transitionRecord({
        repositoryId: 123,
        issueNumber: ISSUE,
        epoch: EPOCH,
        transition: 'T6',
        fromLabel: 'ai:working',
        toLabel: 'ai:done',
        sourceCommentId: reportCommentId ?? -1,
        dispatchId: EXECUTOR_ID,
      }) as never);
      const accepted = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(accepted.action).toBe('accepted');
      expect((await readReceipt(fixture.paths, EXECUTOR_ID))?.status).toBe('accepted');
    } finally {
      await cleanup();
    }
  });

  it('completed with validation="failed" → rejected (unverified claims never publish)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      seedExecutorAuthorization(client);
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'REPORT.md', REPORT);
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'completed',
        report_file: 'REPORT.md', validation: 'failed',
      }));
      const outcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(outcome.action).toBe('rejected');
      expect(contentComments(client, ISSUE)).toHaveLength(2); // plan + /approve
    } finally {
      await cleanup();
    }
  });

  it('completed without REPORT.md → rejected', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      seedExecutorAuthorization(client);
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'completed',
        report_file: 'REPORT.md', validation: 'passed',
      }));
      const outcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/REPORT\.md/);
    } finally {
      await cleanup();
    }
  });

  it('result=blocked → tracker Blocked + plain notice, receipt stays dispatched', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      seedExecutorAuthorization(client);
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'blocked',
        reason: '缺少第三方 API 凭证',
      }));
      const outcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(outcome.action).toBe('notice');
      const comments = contentComments(client, ISSUE);
      expect(comments).toHaveLength(4); // plan + /approve + tracker + notice
      expect(comments[2]!.body).toContain('**Status:** Blocked');
      expect(comments[2]!.body).toContain('ai-workflow:execution-tracker:v1');
      expect(comments[3]!.body).toBe(
        `[gateflow] executor blocked (dispatch ${EXECUTOR_ID}): 缺少第三方 API 凭证`,
      );
      const receipt = await readReceipt(fixture.paths, EXECUTOR_ID);
      expect(receipt?.status).toBe('dispatched');
      expect(receipt?.tracker_comment_id).toBe(comments[2]!.id);
    } finally {
      await cleanup();
    }
  });
});

describe('executor tracker lifecycle (scenario 5)', () => {
  async function writeStatus(fixture: WorkspaceFixture, state: 'working' | 'blocked'): Promise<void> {
    await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'status.json', JSON.stringify({
      schema: 2, dispatch_id: EXECUTOR_ID, role: 'executor', state,
      updated_at: '2026-09-06T17:30:00Z',
    }));
  }

  it('working → tracker created In Progress; blocked → same comment edited; working → resumed', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      seedExecutorAuthorization(client);
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeStatus(fixture, 'working');

      const created = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(created.action).toBe('tracker-created');
      let comments = contentComments(client, ISSUE);
      expect(comments).toHaveLength(3); // plan + /approve + tracker
      const trackerId = comments[2]!.id;
      expect(comments[2]!.body).toContain('**Status:** In Progress');
      expect(comments[2]!.body).toContain(`gateflow:dispatch-id: ${EXECUTOR_ID}`);
      expect((await readReceipt(fixture.paths, EXECUTOR_ID))?.tracker_comment_id).toBe(trackerId);

      // Nothing changed → unchanged (no edit spam).
      expect((await syncDispatch(deps, client.repository, EXECUTOR_ID)).action).toBe('unchanged');

      await writeStatus(fixture, 'blocked');
      const blocked = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(blocked.action).toBe('blocked');
      comments = contentComments(client, ISSUE);
      expect(comments).toHaveLength(3); // edited, not duplicated
      expect(comments[2]!.id).toBe(trackerId);
      expect(comments[2]!.body).toContain('**Status:** Blocked');

      await writeStatus(fixture, 'working');
      const resumed = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(resumed.action).toBe('resumed');
      comments = contentComments(client, ISSUE);
      expect(comments).toHaveLength(3);
      expect(comments[2]!.body).toContain('**Status:** In Progress');
      expect(comments[2]!.body).not.toContain('**Status:** Blocked');

      // Terminal: report + completed → completion report; receipt published.
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'REPORT.md', REPORT);
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: EXECUTOR_ID, role: 'executor', result: 'completed',
        report_file: 'REPORT.md', validation: 'passed',
      }));
      const completed = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(completed.action).toBe('completed');
      expect(contentComments(client, ISSUE)).toHaveLength(4);
      expect((await readReceipt(fixture.paths, EXECUTOR_ID))?.status).toBe('published');

      const again = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(again.action).toBe('skipped');
      expect(contentComments(client, ISSUE)).toHaveLength(4);
    } finally {
      await cleanup();
    }
  });

  it('blocked with no prior tracker creates one and immediately sets Blocked', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      seedExecutorAuthorization(client);
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'status.json', JSON.stringify({
        schema: 2, dispatch_id: EXECUTOR_ID, role: 'executor', state: 'blocked',
        updated_at: '2026-09-06T17:30:00Z',
      }));
      const outcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(outcome.action).toBe('blocked');
      const comments = contentComments(client, ISSUE);
      expect(comments).toHaveLength(3); // plan + /approve + tracker
      expect(comments[2]!.body).toContain('**Status:** Blocked');
    } finally {
      await cleanup();
    }
  });

  it('progress edits are debounced (scenario 6, injected clock)', async () => {
    const { client, fixture, cleanup } = await setup();
    try {
      seedExecutorAuthorization(client);
      let clock = new Date('2026-09-06T17:00:00Z');
      const timedDeps = makeDeps(client, testConfig({ progressSyncSeconds: 60 }), fixture, () => clock);
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'status.json', JSON.stringify({
        schema: 2, dispatch_id: EXECUTOR_ID, role: 'executor', state: 'working',
        updated_at: '2026-09-06T17:00:00Z',
      }));
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'PROGRESS.md', 'P1: started');

      expect((await syncDispatch(timedDeps, client.repository, EXECUTOR_ID)).action).toBe('tracker-created');
      const trackerId = contentComments(client, ISSUE)[2]!.id;
      expect(contentComments(client, ISSUE)[2]!.body).toContain('P1: started');

      // Progress changes within the window → no edit.
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'PROGRESS.md', 'P2: half done');
      clock = new Date('2026-09-06T17:00:30Z');
      expect((await syncDispatch(timedDeps, client.repository, EXECUTOR_ID)).action).toBe('unchanged');
      expect(contentComments(client, ISSUE)[2]!.body).toContain('P1: started');
      expect(contentComments(client, ISSUE)[2]!.body).not.toContain('P2');

      // After the window elapses → single tracker edit with the new content.
      clock = new Date('2026-09-06T17:01:01Z');
      const updated = await syncDispatch(timedDeps, client.repository, EXECUTOR_ID);
      expect(updated.action).toBe('tracker-updated');
      expect(contentComments(client, ISSUE)[2]!.id).toBe(trackerId);
      expect(contentComments(client, ISSUE)[2]!.body).toContain('P2: half done');
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
      seedExecutorAuthorization(client);
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'status.json', JSON.stringify({
        schema: 2, dispatch_id: EXECUTOR_ID, role: 'executor', state: 'working',
        updated_at: '2026-09-06T17:30:00Z',
      }));
      expect((await syncDispatch(deps, client.repository, EXECUTOR_ID)).action).toBe('tracker-created');
      const trackerId = contentComments(client, ISSUE)[2]!.id;

      // Crash: receipts vanish (docs §2.6 — cache, rebuildable).
      await rm(nodePath.join(fixture.paths.receipts, `${EXECUTOR_ID}.json`));

      const recovered = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(recovered.action).toBe('tracker-created');
      expect(recovered.detail).toMatch(/recovered/);
      expect(contentComments(client, ISSUE)).toHaveLength(3);
      expect(contentComments(client, ISSUE)[2]!.id).toBe(trackerId);
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
      const otherId = `gf_r123_i8_w${epochCode(testEpoch(8))!}_consumer_01`;
      client.addIssue(8, { labels: ['ai:working'] });
      client.ensureEpoch(8, testEpoch(8));
      client.issues.get(ISSUE)!.labels = ['ai:planning'];
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'PLAN.md', PLAN);
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md',
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

describe('operation reconciliation (hardening Phase 5)', () => {
  it('plan published, receipt lost → remote plan comment ADOPTED, not duplicated', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.issues.get(ISSUE)!.labels = ['ai:planning'];
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'PLAN.md', PLAN);
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md',
      }));
      await syncDispatch(deps, client.repository, CONSUMER_ID);
      const planCommentId = contentComments(client, ISSUE)[0]!.id;

      // Crash: the receipt is lost before it could be persisted.
      await rm(nodePath.join(fixture.paths.receipts, `${CONSUMER_ID}.json`));

      const recovered = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(recovered.action).toBe('plan-published');
      expect(recovered.detail).toMatch(/awaiting Gate acceptance/);
      expect(contentComments(client, ISSUE)).toHaveLength(1); // adopted, not duplicated
      const receipt = await readReceipt(fixture.paths, CONSUMER_ID);
      expect(receipt?.status).toBe('published');
      expect(receipt?.published_comment_id).toBe(planCommentId);
    } finally {
      await cleanup();
    }
  });

  it('same dispatch id, remote plan with DIFFERENT content → CONFLICT, fail closed', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      client.issues.get(ISSUE)!.labels = ['ai:planning'];
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      // A remote plan comment already exists for this dispatch, with content
      // that diverges from the local PLAN.md (e.g. edited out-of-band).
      const { publishPlanComment } = await import('../../src/github/issue-sync');
      await publishPlanComment(
        deps.client,
        { owner: 'octo', repo: 'repo', issueNumber: ISSUE },
        '# A different plan entirely',
        CONSUMER_ID,
      );
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'PLAN.md', PLAN);
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'result.json', JSON.stringify({
        schema: 2, dispatch_id: CONSUMER_ID, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md',
      }));

      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/DIFFERENT content/);
      const receipt = await readReceipt(fixture.paths, CONSUMER_ID);
      expect(receipt?.status).toBe('failed');
      expect(receipt?.error).toMatch(/DIFFERENT content/);
      expect(contentComments(client, ISSUE)).toHaveLength(1); // no duplicate posted
    } finally {
      await cleanup();
    }
  });
});
