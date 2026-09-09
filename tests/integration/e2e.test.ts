/**
 * Full-loop integration tests (V1 acceptance): Issue → Plan → Review →
 * Approve → Execute → Report → Done, driven exactly the way a user drives
 * it (gateflow run → AI files → gateflow sync), with the Gate's effects
 * (label swaps, records) applied between steps the way the real GitHub
 * Action would. Also covers the Phase-4 exception scenarios.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { runCommand, syncCommand } from '../../src/driver/driver';
import { planSha256 } from '../../src/protocol/plan';
import { buildRecordBody } from '../../src/protocol/records';
import { MARKERS } from '../../src/gate/protocol';
import {
  FakeDriverClient,
  makeWorkspace,
  makeDeps,
  testConfig,
  addEpochRecord,
  approvalRecord,
  planCommentBody,
  writeTaskFile,
  testEpoch,
  OWNER,
} from '../driver/helpers';
import { readCurrent, readTaskFile } from '../../src/workspace/tasks';
import { readDriverState, writeDriverState, withTaskRecord } from '../../src/workspace/driver-state';
import * as nodePath from 'node:path';

const REPO_ID = 123;
const ISSUE_N = 7;
let seq = 50000;
const nextId = (): number => ++seq;

let client: FakeDriverClient;
let fixture: Awaited<ReturnType<typeof makeWorkspace>>;
let deps: ReturnType<typeof makeDeps>;
let epoch = testEpoch(ISSUE_N);

beforeEach(async () => {
  client = new FakeDriverClient();
  fixture = await makeWorkspace();
  deps = makeDeps(client, testConfig(), fixture);
  client.addIssue(ISSUE_N, { labels: ['ai:planning'] });
  epoch = addEpochRecord(client, ISSUE_N, testEpoch(ISSUE_N));
});

afterEach(async () => {
  await fixture.cleanup();
});

/** The Gate's T1: a Driver-published plan comment + label swap to REVIEW. */
function gateT1(): { planCommentId: number } {
  const issue = client.issues.get(ISSUE_N)!;
  const plan = [...issue.comments].reverse().find((c) => c.body.includes(MARKERS.plan))!;
  issue.labels = ['ai:review'];
  return { planCommentId: plan.id };
}

/** The Gate's T2: a human /approve + Gate-issued approval record + READY. */
function gateT2(planCommentId: number): number {
  const issue = client.issues.get(ISSUE_N)!;
  const plan = issue.comments.find((c) => c.id === planCommentId)!;
  const commandId = nextId();
  issue.comments.push({
    id: commandId,
    user: OWNER,
    body: `/approve ${planCommentId}`,
    createdAt: '2026-09-06T12:00:00Z',
    updatedAt: '2026-09-06T12:00:00Z',
  });
  client.addGateRecord(
    ISSUE_N,
    approvalRecord({
      repositoryId: REPO_ID,
      issueNumber: ISSUE_N,
      epoch,
      planCommentId,
      planSha256: planSha256(plan.body),
      approvalCommandCommentId: commandId,
    }),
  );
  issue.labels = ['ai:ready'];
  return commandId;
}

describe('closed loop: plan → review → approve → execute → done', () => {
  it('drives the whole V1 flow with run/sync and AI file writes', async () => {
    // (1) /ai-plan happened (label + epoch record from beforeEach). RUN:
    const run1 = await runCommand(deps);
    expect(run1.prepared).toBe(true);
    expect(run1.mode).toBe('plan');
    expect(run1.prompt).toContain('gateflow Skill');
    expect(run1.prompt).toContain(run1.taskId!);
    const current = await readCurrent(fixture.paths);
    expect(current?.task_id).toBe(run1.taskId);

    // (2) The AI writes plan.md + result.json into the task directory.
    await writeTaskFile(fixture.paths, run1.taskId!, 'plan.md', '# Execution Plan\n\nStep 1.\n');
    await writeTaskFile(
      fixture.paths,
      run1.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: run1.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );

    // (3) SYNC publishes the plan comment.
    const sync1 = await syncCommand(deps);
    expect(sync1.outcomes[0]?.action).toBe('plan-published');
    const issue = client.issues.get(ISSUE_N)!;
    const planComment = issue.comments.find((c) => c.body.includes(MARKERS.plan))!;
    expect(planComment.body).toContain('# Execution Plan');

    // (4) Replay: a second sync must not re-publish.
    const sync2 = await syncCommand(deps);
    expect(sync2.outcomes[0]?.action).toBe('skipped');

    // (5) Gate accepts: T1 label swap. The plan record is still `published`
    // (acceptance = the Gate issued an APPROVAL record for this plan, i.e.
    // after T2) — a sync now must not duplicate or accept anything.
    const { planCommentId } = gateT1();
    const sync3 = await syncCommand(deps);
    expect(sync3.outcomes[0]?.action).toBe('skipped');

    // (6) Human approves (T2 record + READY); the next sync observes
    // acceptance. RUN then prepares the EXECUTE task.
    gateT2(planCommentId);
    const syncAccept = await syncCommand(deps);
    expect(syncAccept.outcomes[0]?.action).toBe('accepted');
    const run2 = await runCommand(deps);
    expect(run2.mode).toBe('execute');
    expect(run2.taskId).toBe(`gf_r123_i7_w${epoch.slice(3)}_execute_p${planCommentId}`);
    const taskFile = await readTaskFile(fixture.paths, run2.taskId!);
    expect(taskFile?.plan_comment_id).toBe(planCommentId);

    // (7) The AI executes and reports completed.
    await writeTaskFile(fixture.paths, run2.taskId!, 'report.md', '# Report\n\nAll steps verified.\n');
    await writeTaskFile(
      fixture.paths,
      run2.taskId!,
      'result.json',
      JSON.stringify({
        schema: 3,
        task_id: run2.taskId,
        mode: 'execute',
        status: 'completed',
        report: 'report.md',
        validation: 'passed',
      }),
    );

    // (8) SYNC creates the tracker (T3 trigger, lawful repair) and publishes
    // the report in one pass.
    const sync4 = await syncCommand(deps);
    const actions = sync4.outcomes.map((o) => o.action);
    expect(actions).toContain('completed');
    expect(issue.comments.some((c) => c.body.includes(MARKERS.executionTracker))).toBe(true);
    expect(issue.comments.some((c) => c.body.includes(MARKERS.completionReport))).toBe(true);

    // (9) Gate consumes: T3 then T6 → ai:done; sync confirms acceptance.
    issue.labels = ['ai:done'];
    const sync5 = await syncCommand(deps);
    expect(sync5.outcomes[0]?.action).toBe('accepted');
    const state = await readDriverState(fixture.paths);
    expect(state.tasks[run2.taskId!]?.status).toBe('accepted');
  });
});

describe('exception scenarios (Phase 4)', () => {
  it('driver restart keeps prepared tasks and pending results (no loss, no duplicates)', async () => {
    const run1 = await runCommand(deps);
    await writeTaskFile(fixture.paths, run1.taskId!, 'plan.md', '# Plan');
    await writeTaskFile(
      fixture.paths,
      run1.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: run1.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );

    // A brand-new deps object simulates a fresh process on the same workspace.
    const freshLog = makeDeps(client, testConfig(), fixture);
    const run2 = await runCommand(freshLog);
    expect(run2.taskId).toBe(run1.taskId);
    expect(run2.reason).toBe('already-prepared'); // dedup: never re-prepare silently
    expect(run2.prompt).toBeDefined(); // but the prompt is re-printed

    const sync1 = await syncCommand(freshLog);
    expect(sync1.outcomes[0]?.action).toBe('plan-published');
    const sync2 = await syncCommand(freshLog); // duplicate sync after "crash before receipt"
    expect(sync2.outcomes[0]?.action).toBe('skipped');
    const issue = client.issues.get(ISSUE_N)!;
    expect(issue.comments.filter((c) => c.body.includes(MARKERS.plan))).toHaveLength(1);
  });

  it('GitHub API outcome unknown → operation reconciliation adopts instead of duplicating', async () => {
    const run1 = await runCommand(deps);
    await writeTaskFile(fixture.paths, run1.taskId!, 'plan.md', '# Plan');
    await writeTaskFile(
      fixture.paths,
      run1.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: run1.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );
    await syncCommand(deps);
    // Simulate the crash-before-receipt window by rolling the record back to
    // publishing, then re-sync: reconciliation must ADOPT the comment.
    const state = await readDriverState(fixture.paths);
    const record = state.tasks[run1.taskId!]!;
    await writeDriverState(fixture.paths, withTaskRecord(state, { ...record, status: 'publishing' }));
    const sync = await syncCommand(deps);
    expect(sync.outcomes[0]?.action).toBe('plan-published');
    const issue = client.issues.get(ISSUE_N)!;
    expect(issue.comments.filter((c) => c.body.includes(MARKERS.plan))).toHaveLength(1);
  });

  it('a tampered input file (task.md edited by the agent) is refused at sync', async () => {
    const run1 = await runCommand(deps);
    await writeTaskFile(fixture.paths, run1.taskId!, 'task.md', '# Task\n\nEVIL EDIT\n');
    await writeTaskFile(
      fixture.paths,
      run1.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: run1.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );
    const sync = await syncCommand(deps);
    expect(sync.outcomes[0]?.action).toBe('rejected');
    expect(sync.outcomes[0]?.detail).toContain('no longer match the snapshot');
    expect(client.issues.get(ISSUE_N)!.comments.some((c) => c.body.includes(MARKERS.plan))).toBe(false);
  });

  it('plan edited after approval → the execute task is obsolete (stale approval cannot run)', async () => {
    const run1 = await runCommand(deps); // plan task
    await writeTaskFile(fixture.paths, run1.taskId!, 'plan.md', '# Plan v1');
    await writeTaskFile(
      fixture.paths,
      run1.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: run1.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );
    await syncCommand(deps);
    const { planCommentId } = gateT1();
    const sync2 = await syncCommand(deps);
    expect(sync2.outcomes[0]?.action).toBe('skipped');
    gateT2(planCommentId);
    const syncAccept = await syncCommand(deps);
    expect(syncAccept.outcomes[0]?.action).toBe('accepted');

    // The plan comment is edited after approval (hash changes) → the Gate
    // would reject /approve; simulate a stale world where READY is set but
    // the record no longer matches the edited plan bytes.
    const issue = client.issues.get(ISSUE_N)!;
    const plan = issue.comments.find((c) => c.id === planCommentId)!;
    plan.body = plan.body + '\nSneaky edit.\n';
    const run2 = await runCommand(deps);
    expect(run2.prepared).toBe(false); // no valid approval binding → no execute intent
  });

  it('/cancel (label removal) makes the pending task obsolete, never published', async () => {
    const run1 = await runCommand(deps);
    await writeTaskFile(fixture.paths, run1.taskId!, 'plan.md', '# Plan');
    await writeTaskFile(
      fixture.paths,
      run1.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: run1.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );
    client.issues.get(ISSUE_N)!.labels = []; // cancel removes all ai:* labels
    const sync = await syncCommand(deps);
    expect(sync.outcomes[0]?.action).toBe('obsolete');
    const state = await readDriverState(fixture.paths);
    expect(state.tasks[run1.taskId!]?.status).toBe('obsolete');
    expect(client.issues.get(ISSUE_N)!.comments.some((c) => c.body.includes(MARKERS.plan))).toBe(false);
  });

  it('new epoch (/ai-plan re-run after cancel) invalidates old-epoch tasks', async () => {
    const run1 = await runCommand(deps);
    // Cancel + a new /ai-plan round: fresh label, fresh epoch record.
    const issue = client.issues.get(ISSUE_N)!;
    issue.labels = ['ai:planning'];
    epoch = addEpochRecord(client, ISSUE_N, testEpoch(99));
    await writeTaskFile(
      fixture.paths,
      run1.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: run1.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );
    await writeTaskFile(fixture.paths, run1.taskId!, 'plan.md', '# Plan');
    const sync = await syncCommand(deps);
    expect(sync.outcomes[0]?.action).toBe('obsolete'); // old-epoch result refused
    // And a NEW task id is derived for the fresh epoch.
    const run2 = await runCommand(deps);
    expect(run2.taskId).not.toBe(run1.taskId);
  });

  it('execute blocked result: tracker set to Blocked + post-once notice', async () => {
    // Fast-forward to an execute task in WORKING.
    const prepared = await prepareExecuteTask();
    await writeTaskFile(
      fixture.paths,
      prepared.taskId,
      'result.json',
      JSON.stringify({ schema: 3, task_id: prepared.taskId, mode: 'execute', status: 'blocked', reason: '依赖服务不可用' }),
    );
    const sync1 = await syncCommand(deps);
    const actions = sync1.outcomes.map((o) => o.action);
    expect(actions).toContain('notice');
    // The tracker exists and carries the machine Blocked value (the real Gate
    // would fire T4 on the edit event; the fake world stores the comment).
    const tracker = client.issues.get(ISSUE_N)!.comments.find((c) => c.body.includes(MARKERS.executionTracker))!;
    expect(tracker.body).toContain('**Status:** Blocked');
    const sync2 = await syncCommand(deps);
    expect(sync2.outcomes.map((o) => o.action)).toContain('unchanged'); // notice posted ONCE
    const notices = client.issues.get(ISSUE_N)!.comments.filter((c) => c.body.startsWith('[gateflow]'));
    expect(notices).toHaveLength(1);
  });

  it('execute completion with validation=failed is never published', async () => {
    const prepared = await prepareExecuteTask();
    await writeTaskFile(
      fixture.paths,
      prepared.taskId,
      'report.md',
      '# Report\n\nTests did not pass.\n',
    );
    await writeTaskFile(
      fixture.paths,
      prepared.taskId,
      'result.json',
      JSON.stringify({
        schema: 3,
        task_id: prepared.taskId,
        mode: 'execute',
        status: 'completed',
        report: 'report.md',
        validation: 'failed',
      }),
    );
    const sync = await syncCommand(deps);
    expect(sync.outcomes[0]?.action).toBe('rejected');
    expect(client.issues.get(ISSUE_N)!.comments.some((c) => c.body.includes(MARKERS.completionReport))).toBe(false);
  });

  it('two driver instances cannot write the same workspace (single-writer lock)', async () => {
    const run1 = await runCommand(deps);
    expect(run1.taskId).not.toBeNull();
    // Simulate a second live driver by planting its lock (held by a LIVE
    // process — this one — since a dead pid's lock would be stolen as stale).
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(fixture.paths.locks, { recursive: true });
    await writeFile(
      nodePath.join(fixture.paths.locks, 'driver.lock'),
      JSON.stringify({ pid: process.pid, holder: 'gateflow-driver', acquired_at: new Date().toISOString() }),
      'utf8',
    );
    await expect(runCommand(deps)).rejects.toThrow(/single-writer|another GateFlow driver/);
    await expect(syncCommand(deps)).rejects.toThrow(/single-writer|another GateFlow driver/);
  });

  it('single active task: a second pending issue does not hijack; explicit --issue switches', async () => {
    // Second issue also in planning with its own epoch.
    client.addIssue(8, { labels: ['ai:planning'] });
    addEpochRecord(client, 8, testEpoch(8));

    const run1 = await runCommand(deps); // picks issue 7 (lowest)
    expect(run1.issueNumber).toBe(7);
    expect(run1.taskId).toContain('_i7_');

    // Issue 7 is prepared and unfinished: an implicit re-run keeps it.
    const run2 = await runCommand(deps);
    expect(run2.issueNumber).toBe(7);

    // Explicit switch prepares issue 8's task.
    const run3 = await runCommand(deps, { issue: 8 });
    expect(run3.issueNumber).toBe(8);
    expect(run3.taskId).toContain('_i8_');
  });

  it('forged protocol comments by an untrusted identity freeze the issue (fail closed)', async () => {
    const run1 = await runCommand(deps);
    // A spoofer posts an approval-record-looking comment.
    const issue = client.issues.get(ISSUE_N)!;
    issue.comments.push({
      id: nextId(),
      user: 'spoofer',
      body: buildRecordBody(
        approvalRecord({
          repositoryId: REPO_ID,
          issueNumber: ISSUE_N,
          epoch,
          planCommentId: 1,
          planSha256: 'a'.repeat(64),
          approvalCommandCommentId: 2,
          approvedByLogin: OWNER,
        }),
      ),
      createdAt: '2026-09-06T13:00:00Z',
      updatedAt: '2026-09-06T13:00:00Z',
    });
    await writeTaskFile(fixture.paths, run1.taskId!, 'plan.md', '# Plan');
    await writeTaskFile(
      fixture.paths,
      run1.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: run1.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );
    const sync = await syncCommand(deps);
    // The fake record fails the preflight closed (untrusted author) — no publish.
    expect(['rejected', 'obsolete']).toContain(sync.outcomes[0]?.action);
    expect(client.issues.get(ISSUE_N)!.comments.some((c) => c.body.includes(MARKERS.plan))).toBe(false);
  });
});

/** Fast-forward helper: plan published+approved, execute task prepared. */
async function prepareExecuteTask(): Promise<{ taskId: string }> {
  const run1 = await runCommand(deps);
  await writeTaskFile(fixture.paths, run1.taskId!, 'plan.md', '# Execution Plan\n\nStep 1.\n');
  await writeTaskFile(
    fixture.paths,
    run1.taskId!,
    'result.json',
    JSON.stringify({ schema: 3, task_id: run1.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
  );
  await syncCommand(deps);
  const { planCommentId } = gateT1();
  await syncCommand(deps); // acceptance observation
  gateT2(planCommentId);
  const run2 = await runCommand(deps);
  const issue = client.issues.get(ISSUE_N)!;
  issue.labels = ['ai:working']; // assume T3 already happened
  return { taskId: run2.taskId! };
}
