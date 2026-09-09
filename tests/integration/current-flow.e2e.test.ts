/**
 * Current V1 flow acceptance tests.
 *
 * These tests deliberately keep the Gate effects explicit: the fake GitHub
 * client stores comments, while each label transition represents the Gate
 * consuming the preceding event.  The Driver must never infer acceptance
 * from an agent result or from an unrelated task's protocol comment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCommand, syncCommand } from '../../src/driver/driver';
import { buildCompletionReportBody, buildPlanCommentBody, buildTrackerCommentBody } from '../../src/github/comments';
import { MARKERS } from '../../src/gate/protocol';
import { planSha256 } from '../../src/protocol/plan';
import { makeExecuteTaskId, makePlanTaskId } from '../../src/workspace/protocol';
import { readCurrent, readTaskFile } from '../../src/workspace/tasks';
import { readDriverState } from '../../src/workspace/driver-state';
import type { IssueRef } from '../../src/github/client';
import {
  FakeDriverClient,
  ISSUE,
  OWNER,
  addEpochRecord,
  approvalRecord,
  makeDeps,
  makeWorkspace,
  testConfig,
  testEpoch,
  writeTaskFile,
} from '../driver/helpers';

const REPOSITORY_ID = 123;
const CONTROL_REPOSITORY = 'octo/repo';

class TimeoutAfterRemoteWriteClient extends FakeDriverClient {
  failNextPlanPost = true;

  override async addIssueComment(ref: IssueRef, body: string): Promise<{ id: number }> {
    const created = await super.addIssueComment(ref, body);
    if (this.failNextPlanPost && body.includes(MARKERS.plan)) {
      this.failNextPlanPost = false;
      throw new Error('simulated API timeout after remote write');
    }
    return created;
  }
}

class RefRecordingClient extends FakeDriverClient {
  readonly refs: IssueRef[] = [];

  override async addIssueComment(ref: IssueRef, body: string): Promise<{ id: number }> {
    this.refs.push({ ...ref });
    return super.addIssueComment(ref, body);
  }

  override async updateIssueComment(ref: IssueRef, commentId: number, body: string): Promise<void> {
    this.refs.push({ ...ref });
    return super.updateIssueComment(ref, commentId, body);
  }
}

describe('current V1 fake closed loop', () => {
  let client: FakeDriverClient;
  let fixture: Awaited<ReturnType<typeof makeWorkspace>>;
  let deps: ReturnType<typeof makeDeps>;
  let epoch: ReturnType<typeof testEpoch>;

  beforeEach(async () => {
    client = new FakeDriverClient();
    fixture = await makeWorkspace();
    deps = makeDeps(client, testConfig(), fixture);
    client.addIssue(ISSUE, { labels: ['ai:planning'] });
    epoch = addEpochRecord(client, ISSUE, testEpoch(ISSUE));
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  async function writePlanResult(taskId: string, markdown = '# Plan\n'): Promise<void> {
    await writeTaskFile(fixture.paths, taskId, 'plan.md', markdown);
    await writeTaskFile(
      fixture.paths,
      taskId,
      'result.json',
      JSON.stringify({ schema: 3, task_id: taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );
  }

  async function writeExecuteResult(taskId: string, markdown = '# Report\n'): Promise<void> {
    await writeTaskFile(fixture.paths, taskId, 'report.md', markdown);
    await writeTaskFile(
      fixture.paths,
      taskId,
      'result.json',
      JSON.stringify({
        schema: 3,
        task_id: taskId,
        mode: 'execute',
        status: 'completed',
        report: 'report.md',
        validation: 'passed',
      }),
    );
  }

  /** Prepare an execute task by applying the fake Gate's T1/T2 effects. */
  async function prepareApprovedExecute(options: {
    targetRepository?: string;
    targetWorkspace?: string;
  } = {}): Promise<{ taskId: string; planId: number; planTaskId: string }> {
    const planRun = await runCommand(deps, options);
    expect(planRun.prepared).toBe(true);
    await writePlanResult(planRun.taskId!);
    expect((await syncCommand(deps)).outcomes[0]?.action).toBe('plan-published');

    const issue = client.issues.get(ISSUE)!;
    issue.labels = ['ai:review']; // fake Gate T1
    const plan = issue.comments.find((comment) => comment.body.includes(MARKERS.plan));
    expect(plan).toBeDefined();
    const approvalCommand = client.addComment(ISSUE, OWNER, `/approve ${plan!.id}`);
    client.addGateRecord(
      ISSUE,
      approvalRecord({
        repositoryId: REPOSITORY_ID,
        issueNumber: ISSUE,
        epoch,
        planCommentId: plan!.id,
        planSha256: planSha256(plan!.body),
        approvalCommandCommentId: approvalCommand.id,
      }),
    );
    issue.labels = ['ai:ready']; // fake Gate T2
    expect((await syncCommand(deps)).outcomes[0]?.action).toBe('accepted');

    const executeRun = await runCommand(deps);
    expect(executeRun.mode).toBe('execute');
    expect(executeRun.prepared).toBe(true);
    return { taskId: executeRun.taskId!, planId: plan!.id, planTaskId: planRun.taskId! };
  }

  it('requires the current epoch and exact current plan before executing', async () => {
    const oldPlanRun = await runCommand(deps);
    const oldTaskId = oldPlanRun.taskId!;
    await writePlanResult(oldTaskId, '# Old plan\n');

    // A new /ai-plan round supersedes the task before its delayed result is
    // synchronized. The old task must not publish into the new epoch.
    epoch = addEpochRecord(client, ISSUE, testEpoch(99));
    const oldEpochSync = await syncCommand(deps);
    expect(oldEpochSync.outcomes[0]?.action).toBe('obsolete');
    expect(client.issues.get(ISSUE)!.comments.some((comment) => comment.body.includes(MARKERS.plan))).toBe(false);

    // Establish a valid execute task in the new epoch, then append a newer
    // Plan object. The execute task is bound to the approved Plan id, not to
    // whichever Plan happens to be latest in the Issue.
    client.issues.get(ISSUE)!.labels = ['ai:planning'];
    const freshPlanRun = await runCommand(deps);
    await writePlanResult(freshPlanRun.taskId!, '# Current plan\n');
    await syncCommand(deps);
    const issue = client.issues.get(ISSUE)!;
    const currentPlan = issue.comments.find((comment) => comment.body.includes(MARKERS.plan))!;
    issue.labels = ['ai:review'];
    const command = client.addComment(ISSUE, OWNER, `/approve ${currentPlan.id}`);
    client.addGateRecord(
      ISSUE,
      approvalRecord({
        repositoryId: REPOSITORY_ID,
        issueNumber: ISSUE,
        epoch,
        planCommentId: currentPlan.id,
        planSha256: planSha256(currentPlan.body),
        approvalCommandCommentId: command.id,
      }),
    );
    issue.labels = ['ai:ready'];
    await syncCommand(deps);
    const execute = await runCommand(deps);
    await writeExecuteResult(execute.taskId!);

    const newerPlanId = makePlanTaskId(REPOSITORY_ID, ISSUE, epoch, 2);
    client.addComment(ISSUE, client.botUser, buildPlanCommentBody('# Newer plan\n', newerPlanId));
    const stalePlanSync = await syncCommand(deps);
    expect(stalePlanSync.outcomes.find((outcome) => outcome.taskId === execute.taskId)?.action).toBe('obsolete');
    expect(issue.comments.some((comment) => comment.body.includes(MARKERS.completionReport))).toBe(false);
  });

  it('does not treat a hand-added READY label as Gate approval', async () => {
    client.issues.get(ISSUE)!.labels = ['ai:ready'];
    const run = await runCommand(deps);
    expect(run.prepared).toBe(false);
    expect(run.taskId).toBeNull();
    expect(await readCurrent(fixture.paths)).toBeNull();
  });

  it('ignores old Tracker and Report comments from another task', async () => {
    const prepared = await prepareApprovedExecute();
    const oldEpoch = testEpoch(42);
    const oldTaskId = makeExecuteTaskId(REPOSITORY_ID, ISSUE, oldEpoch, prepared.planId);
    const issue = client.issues.get(ISSUE)!;

    issue.labels = ['ai:ready'];
    client.addComment(
      ISSUE,
      client.botUser,
      buildTrackerCommentBody({ taskId: oldTaskId, issueNumber: ISSUE, status: 'In Progress' }),
    );
    await writeExecuteResult(prepared.taskId);
    const trackerSync = await syncCommand(deps);
    expect(trackerSync.outcomes[0]?.action).toBe('tracker-created');
    expect(issue.comments.filter((comment) => comment.body.includes(MARKERS.executionTracker))).toHaveLength(2);
    expect(issue.comments.some((comment) => comment.body.includes(MARKERS.completionReport))).toBe(false);

    // A stale Report is also not a receipt for the current execute task. Once
    // WORKING is observed, the Driver publishes exactly one current Report.
    issue.labels = ['ai:working'];
    client.addComment(ISSUE, client.botUser, buildCompletionReportBody('# Stale report\n', oldTaskId));
    const reportSync = await syncCommand(deps);
    expect(reportSync.outcomes[0]?.action).toBe('completed');
    const reports = issue.comments.filter((comment) => comment.body.includes(MARKERS.completionReport));
    expect(reports).toHaveLength(2);
    expect(reports.some((comment) => comment.body.includes(prepared.taskId))).toBe(true);
    expect(reports.some((comment) => comment.body.includes(oldTaskId))).toBe(true);
  });

  it('cancels a task before delayed agent output and never publishes that output', async () => {
    const prepared = await prepareApprovedExecute();
    const issue = client.issues.get(ISSUE)!;
    issue.labels = ['ai:working'];
    expect((await syncCommand(deps)).outcomes[0]?.action).toBe('tracker-created');

    // The agent writes after a human cancellation. The old task is obsolete
    // before the Driver considers any output file for publication.
    issue.labels = [];
    await writeExecuteResult(prepared.taskId, '# Delayed report after cancel\n');
    const cancelled = await syncCommand(deps);
    expect(cancelled.outcomes[0]?.action).toBe('obsolete');
    expect(issue.comments.some((comment) => comment.body.includes(MARKERS.completionReport))).toBe(false);
    expect((await readDriverState(fixture.paths)).tasks[prepared.taskId]?.status).toBe('obsolete');
  });

  it('reconciles a post-timeout write after Driver restart and is idempotent', async () => {
    const timeoutClient = new TimeoutAfterRemoteWriteClient();
    timeoutClient.addIssue(ISSUE, { labels: ['ai:planning'] });
    const timeoutEpoch = addEpochRecord(timeoutClient, ISSUE, testEpoch(ISSUE));
    // Keep the alternate client and its workspace together. This prevents
    // the timeout scenario from sharing a task directory with the default
    // beforeEach client, so the publishing record is guaranteed to be
    // discoverable by the following sync.
    const timeoutFixture = await makeWorkspace();
    try {
      const timeoutDeps = makeDeps(timeoutClient, testConfig(), timeoutFixture);
      const run = await runCommand(timeoutDeps);
      expect(run.prepared).toBe(true);
      await writeTaskFile(timeoutFixture.paths, run.taskId!, 'plan.md', '# Timeout-safe plan\n');
      await writeTaskFile(
        timeoutFixture.paths,
        run.taskId!,
        'result.json',
        JSON.stringify({ schema: 3, task_id: run.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
      );
      const timedOutSync = await syncCommand(timeoutDeps);
      // syncAll isolates a per-task infrastructure failure: the command
      // returns no outcome for that task and records the real exception in
      // the Driver log instead of rejecting the whole pass.
      expect(timedOutSync.outcomes).toHaveLength(0);
      expect(timeoutDeps.log.lines.some((line) => line.includes('simulated API timeout after remote write'))).toBe(true);

      const publishing = await readDriverState(timeoutFixture.paths);
      expect(publishing.tasks[run.taskId!]?.status).toBe('publishing');
      expect(timeoutClient.issues.get(ISSUE)!.comments.filter((comment) => comment.body.includes(MARKERS.plan))).toHaveLength(1);

      // A new Driver process adopts the already-created Operation object.
      const restartedDeps = makeDeps(timeoutClient, testConfig(), timeoutFixture);
      const recovered = await syncCommand(restartedDeps);
      expect(recovered.outcomes[0]?.action).toBe('plan-published');
      expect((await readDriverState(timeoutFixture.paths)).tasks[run.taskId!]?.status).toBe('published');

      const repeated = await syncCommand(restartedDeps);
      expect(repeated.outcomes[0]?.action).toBe('skipped');
      expect(timeoutClient.issues.get(ISSUE)!.comments.filter((comment) => comment.body.includes(MARKERS.plan))).toHaveLength(1);
      expect(timeoutEpoch).toBe(testEpoch(ISSUE));
    } finally {
      await timeoutFixture.cleanup();
    }
  });

  it('keeps Control Issue refs separate from Target Repository metadata', async () => {
    const refClient = new RefRecordingClient();
    const refFixture = fixture;
    const refDeps = makeDeps(refClient, testConfig(), refFixture);
    refClient.addIssue(ISSUE, { labels: ['ai:planning'] });
    addEpochRecord(refClient, ISSUE, testEpoch(ISSUE));
    const targetWorkspace = `${fixture.projectRoot}-target-workspace`;

    const planRun = await runCommand(refDeps, {
      targetRepository: 'jesongit/gateflow-target-e2e',
      targetWorkspace,
    });
    await writeTaskFile(refFixture.paths, planRun.taskId!, 'plan.md', '# Target plan\n');
    await writeTaskFile(
      refFixture.paths,
      planRun.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: planRun.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );
    expect((await syncCommand(refDeps)).outcomes[0]?.action).toBe('plan-published');

    const issue = refClient.issues.get(ISSUE)!;
    const plan = issue.comments.find((comment) => comment.body.includes(MARKERS.plan))!;
    issue.labels = ['ai:review'];
    const approvalCommand = refClient.addComment(ISSUE, OWNER, `/approve ${plan.id}`);
    refClient.addGateRecord(
      ISSUE,
      approvalRecord({
        repositoryId: REPOSITORY_ID,
        issueNumber: ISSUE,
        epoch: testEpoch(ISSUE),
        planCommentId: plan.id,
        planSha256: planSha256(plan.body),
        approvalCommandCommentId: approvalCommand.id,
      }),
    );
    issue.labels = ['ai:ready'];
    expect((await syncCommand(refDeps)).outcomes[0]?.action).toBe('accepted');

    const executeRun = await runCommand(refDeps);
    const executeTask = await readTaskFile(refFixture.paths, executeRun.taskId!);
    expect(executeTask).toMatchObject({
      control_repository: CONTROL_REPOSITORY,
      repository_id: REPOSITORY_ID,
      issue_number: ISSUE,
      target_repository: 'jesongit/gateflow-target-e2e',
    });
    expect(executeTask?.target_workspace).toBe(targetWorkspace);
    await writeTaskFile(refFixture.paths, executeRun.taskId!, 'report.md', '# Target report\n');
    await writeTaskFile(
      refFixture.paths,
      executeRun.taskId!,
      'result.json',
      JSON.stringify({
        schema: 3,
        task_id: executeRun.taskId,
        mode: 'execute',
        status: 'completed',
        report: 'report.md',
        validation: 'passed',
      }),
    );
    expect((await syncCommand(refDeps)).outcomes[0]?.action).toBe('tracker-created');
    issue.labels = ['ai:working'];
    expect((await syncCommand(refDeps)).outcomes[0]?.action).toBe('completed');

    expect(refClient.refs.length).toBe(3);
    expect(refClient.refs.every((ref) => ref.owner === 'octo' && ref.repo === 'repo' && ref.issueNumber === ISSUE)).toBe(true);
    expect(refClient.issues.has(999)).toBe(false);
    expect(refClient.issues.get(ISSUE)?.comments.some((comment) => comment.body.includes('gateflow-target-e2e'))).toBe(false);
  });
});
