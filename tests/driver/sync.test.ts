import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncCommand } from '../../src/driver/driver';
import { MARKERS } from '../../src/gate/protocol';
import { buildCompletionReportBody } from '../../src/github/comments';
import { planSha256 } from '../../src/protocol/plan';
import { readDriverState, writeDriverState } from '../../src/workspace/driver-state';
import { inputSnapshotSha256 } from '../../src/workspace/tasks';
import { makeExecuteTaskId, makePlanTaskId } from '../../src/workspace/protocol';
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
} from './helpers';

const REPOSITORY_ID = 123;

class OneStalePlanReadClient extends FakeDriverClient {
  private hideNextPlanRead = false;

  override async addIssueComment(ref: { owner: string; repo: string; issueNumber: number }, body: string): Promise<{ id: number }> {
    const created = await super.addIssueComment(ref, body);
    if (body.includes(MARKERS.plan)) this.hideNextPlanRead = true;
    return created;
  }

  override async listComments(ref: { owner: string; repo: string; issueNumber: number }) {
    const comments = await super.listComments(ref);
    if (!this.hideNextPlanRead) return comments;
    this.hideNextPlanRead = false;
    return comments.filter((comment) => !comment.body.includes(MARKERS.plan));
  }
}

describe('Driver execute synchronization', () => {
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

  async function preparePlan(): Promise<{ taskId: string; planId: number }> {
    const issue = client.issues.get(ISSUE)!;
    const planTaskId = makePlanTaskId(REPOSITORY_ID, ISSUE, epoch, 1);
    const plan = client.addComment(ISSUE, client.botUser, `<!-- ai-workflow:plan:v1 -->\n\n<!-- gateflow:dispatch-id: ${planTaskId} -->\n\n# Plan\n`);
    const approvalCommand = client.addComment(ISSUE, OWNER, `/approve ${plan.id}`);
    client.addGateRecord(
      ISSUE,
      approvalRecord({
        repositoryId: REPOSITORY_ID,
        issueNumber: ISSUE,
        epoch,
        planCommentId: plan.id,
        planSha256: planSha256(plan.body),
        approvalCommandCommentId: approvalCommand.id,
      }),
    );
    issue.labels = ['ai:ready'];
    return { taskId: planTaskId, planId: plan.id };
  }

  async function prepareExecute(): Promise<{ taskId: string; planId: number }> {
    const prepared = await preparePlan();
    const taskId = makeExecuteTaskId(REPOSITORY_ID, ISSUE, epoch, prepared.planId);
    const taskBody = '# Task\n';
    const planBody = '# Plan\n';
    const input = { task: 'task.md', plan: 'plan.md', feedback: null } as const;
    await writeTaskFile(fixture.paths, taskId, 'task.md', taskBody);
    await writeTaskFile(fixture.paths, taskId, 'plan.md', planBody);
    await writeTaskFile(
      fixture.paths,
      taskId,
      'task.json',
      JSON.stringify({
        schema: 3,
        task_id: taskId,
        control_repository: `${OWNER}/repo`,
        repository_id: REPOSITORY_ID,
        issue_number: ISSUE,
        workflow_epoch: epoch,
        target_repository: null,
        target_workspace: null,
        mode: 'execute',
        reason: 'approved_plan',
        created_at: '2026-09-09T12:00:00Z',
        plan_comment_id: prepared.planId,
        approval_comment_id: client.issues.get(ISSUE)!.comments.find((comment) => comment.body.includes('gateflow:approval:v2'))!.id,
        input,
      }),
    );
    await writeDriverState(fixture.paths, {
      schema: 3,
      updated_at: '2026-09-09T12:00:00Z',
      tasks: {
        [taskId]: {
          task_id: taskId,
          status: 'prepared',
          attempts: 1,
          mode: 'execute',
          control_repository: `${OWNER}/repo`,
          repository_id: REPOSITORY_ID,
          issue_number: ISSUE,
          workflow_epoch: epoch,
          target_repository: null,
          target_workspace: null,
          executor_lock_task_id: taskId,
          input_snapshot_sha256: inputSnapshotSha256({ task: taskBody, plan: planBody, feedback: null }),
          plan_comment_id: prepared.planId,
          approval_comment_id: client.issues.get(ISSUE)!.comments.find((comment) => comment.body.includes('gateflow:approval:v2'))!.id,
          error: null,
        },
      },
    });
    return { taskId, planId: prepared.planId };
  }

  it('does not publish a Report until the Gate-observed state is WORKING', async () => {
    const prepared = await prepareExecute();
    await writeTaskFile(fixture.paths, prepared.taskId, 'report.md', '# Report\n');
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
        validation: 'passed',
      }),
    );

    const readySync = await syncCommand(deps);
    expect(readySync.outcomes[0]?.action).toBe('tracker-created');
    expect(client.issues.get(ISSUE)!.comments.some((comment) => comment.body.includes(MARKERS.completionReport))).toBe(false);

    client.issues.get(ISSUE)!.labels = ['ai:working'];
    const workingSync = await syncCommand(deps);
    expect(workingSync.outcomes[0]?.action).toBe('completed');
    expect(client.issues.get(ISSUE)!.comments.some((comment) => comment.body.includes(MARKERS.completionReport))).toBe(true);
  });

  it('adopts a Report which arrived before the Tracker instead of duplicating it', async () => {
    const prepared = await prepareExecute();
    await writeTaskFile(fixture.paths, prepared.taskId, 'report.md', '# Report\n');
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
        validation: 'passed',
      }),
    );
    const reportBody = buildCompletionReportBody('# Report\n', prepared.taskId);
    client.addComment(ISSUE, client.botUser, reportBody);

    const first = await syncCommand(deps);
    expect(first.outcomes[0]?.action).toBe('tracker-created');
    expect(client.issues.get(ISSUE)!.comments.filter((comment) => comment.body.includes(MARKERS.completionReport))).toHaveLength(1);

    client.issues.get(ISSUE)!.labels = ['ai:working'];
    const second = await syncCommand(deps);
    expect(second.outcomes[0]?.action).toBe('completed');
    expect(client.issues.get(ISSUE)!.comments.filter((comment) => comment.body.includes(MARKERS.completionReport))).toHaveLength(1);
  });

  it('does not accept a bare DONE label as the Report receipt', async () => {
    const prepared = await prepareExecute();
    const issue = client.issues.get(ISSUE)!;
    issue.labels = ['ai:done'];
    await writeTaskFile(fixture.paths, prepared.taskId, 'report.md', '# Report\n');
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
        validation: 'passed',
      }),
    );

    const sync = await syncCommand(deps);
    expect(sync.outcomes[0]?.action).toBe('unchanged');
    const state = await readDriverState(fixture.paths);
    expect(state.tasks[prepared.taskId]?.status).toBe('prepared');
  });

  it('keeps a publishing receipt when the post succeeds but the confirmation read is stale', async () => {
    const staleClient = new OneStalePlanReadClient();
    const staleFixture = await makeWorkspace();
    const staleDeps = makeDeps(staleClient, testConfig(), staleFixture);
    staleClient.addIssue(ISSUE, { labels: ['ai:planning'] });
    const staleEpoch = testEpoch(ISSUE);
    addEpochRecord(staleClient, ISSUE, staleEpoch);
    try {
      const taskId = makePlanTaskId(REPOSITORY_ID, ISSUE, staleEpoch, 1);
      const taskBody = '# Task\n';
      await writeTaskFile(staleFixture.paths, taskId, 'task.md', taskBody);
      await writeTaskFile(
        staleFixture.paths,
        taskId,
        'task.json',
        JSON.stringify({
          schema: 3,
          task_id: taskId,
          control_repository: `${OWNER}/repo`,
          repository_id: REPOSITORY_ID,
          issue_number: ISSUE,
          workflow_epoch: staleEpoch,
          target_repository: null,
          target_workspace: null,
          mode: 'plan',
          reason: 'planning',
          created_at: '2026-09-09T12:00:00Z',
          plan_comment_id: null,
          approval_comment_id: null,
          input: { task: 'task.md', plan: null, feedback: null },
        }),
      );
      await writeDriverState(staleFixture.paths, {
        schema: 3,
        updated_at: '2026-09-09T12:00:00Z',
        tasks: {
          [taskId]: {
            task_id: taskId,
            status: 'prepared',
            attempts: 1,
            mode: 'plan',
            control_repository: `${OWNER}/repo`,
            repository_id: REPOSITORY_ID,
            issue_number: ISSUE,
            workflow_epoch: staleEpoch,
            target_repository: null,
            target_workspace: null,
            input_snapshot_sha256: inputSnapshotSha256({ task: taskBody, plan: null, feedback: null }),
            error: null,
          },
        },
      });
      await writeTaskFile(staleFixture.paths, taskId, 'plan.md', '# Plan\n');
      await writeTaskFile(
        staleFixture.paths,
        taskId,
        'result.json',
        JSON.stringify({
          schema: 3,
          task_id: taskId,
          mode: 'plan',
          status: 'completed',
          report: 'plan.md',
        }),
      );

      const first = await syncCommand(staleDeps);
      expect(first.outcomes[0]?.action).toBe('unchanged');
      const firstState = await readDriverState(staleFixture.paths);
      expect(firstState.tasks[taskId]?.status).toBe('publishing');
      expect(staleClient.issues.get(ISSUE)!.comments.filter((comment) => comment.body.includes(MARKERS.plan))).toHaveLength(1);

      const second = await syncCommand(staleDeps);
      expect(second.outcomes[0]?.action).toBe('plan-published');
      expect(staleClient.issues.get(ISSUE)!.comments.filter((comment) => comment.body.includes(MARKERS.plan))).toHaveLength(1);
    } finally {
      await staleFixture.cleanup();
    }
  });
});
