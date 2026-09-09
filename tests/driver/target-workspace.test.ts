import { access, readFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCommand, syncCommand } from '../../src/driver/driver';
import { executorLockFile } from '../../src/driver/workspace-lock';
import { planSha256 } from '../../src/protocol/plan';
import { buildRecordBody } from '../../src/protocol/records';
import { MARKERS } from '../../src/gate/protocol';
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
} from './helpers';

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

describe('Control/Target workspace binding', () => {
  let client: RefRecordingClient;
  let fixture: Awaited<ReturnType<typeof makeWorkspace>>;
  let deps: ReturnType<typeof makeDeps>;
  let epoch: ReturnType<typeof testEpoch>;

  beforeEach(async () => {
    client = new RefRecordingClient();
    fixture = await makeWorkspace();
    deps = makeDeps(client, testConfig(), fixture);
    client.addIssue(ISSUE, { labels: ['ai:planning'] });
    epoch = addEpochRecord(client, ISSUE, testEpoch(ISSUE));
  });

  afterEach(async () => fixture.cleanup());

  it('keeps an unknown target explicit during planning, without parsing Issue Markdown', async () => {
    client.issues.get(ISSUE)!.body = 'Please build owner/not-a-real-target from the prose.';
    const prepared = await runCommand(deps);
    expect(prepared.prepared).toBe(true);
    const task = await readTaskFile(fixture.paths, prepared.taskId!);
    expect(task).toMatchObject({
      control_repository: 'octo/repo',
      repository_id: 123,
      issue_number: ISSUE,
      target_repository: null,
      target_workspace: null,
    });
    const current = await readCurrent(fixture.paths);
    expect(current).toMatchObject({
      task_id: prepared.taskId,
      control_repository: 'octo/repo',
      target_repository: null,
      target_workspace: null,
    });
  });

  it('persists an explicit non-existing target and reuses it for execute', async () => {
    const targetWorkspace = nodePath.join(nodePath.dirname(fixture.projectRoot), 'gateflow-target-does-not-exist');
    const planRun = await runCommand(deps, {
      targetRepository: 'octo/new-project',
      targetWorkspace,
    });
    expect(planRun.prepared).toBe(true);
    const planTask = await readTaskFile(fixture.paths, planRun.taskId!);
    expect(planTask?.target_repository).toBe('octo/new-project');
    expect(planTask?.target_workspace).toBe(nodePath.normalize(targetWorkspace));

    await writeTaskFile(fixture.paths, planRun.taskId!, 'plan.md', '# Plan\n');
    await writeTaskFile(
      fixture.paths,
      planRun.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: planRun.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );
    expect((await syncCommand(deps)).outcomes[0]?.action).toBe('plan-published');

    const planComment = client.issues.get(ISSUE)!.comments.find((comment) => comment.body.includes(MARKERS.plan));
    expect(planComment).toBeDefined();
    client.issues.get(ISSUE)!.labels = ['ai:ready'];
    const approvalCommand = client.addComment(ISSUE, OWNER, `/approve ${planComment!.id}`);
    client.addGateRecord(
      ISSUE,
      approvalRecord({
        repositoryId: 123,
        issueNumber: ISSUE,
        epoch,
        planCommentId: planComment!.id,
        planSha256: planSha256(planComment!.body),
        approvalCommandCommentId: approvalCommand.id,
      }),
    );
    expect((await syncCommand(deps)).outcomes[0]?.action).toBe('accepted');

    const executeRun = await runCommand(deps);
    expect(executeRun.mode).toBe('execute');
    const executeTask = await readTaskFile(fixture.paths, executeRun.taskId!);
    expect(executeTask).toMatchObject({
      control_repository: 'octo/repo',
      target_repository: 'octo/new-project',
      target_workspace: nodePath.normalize(targetWorkspace),
    });
    const state = await readDriverState(fixture.paths);
    expect(state.tasks[executeRun.taskId!]?.target_workspace).toBe(nodePath.normalize(targetWorkspace));
    const lock = JSON.parse(await readFile(executorLockFile(fixture.paths), 'utf8')) as { task_id?: string };
    expect(lock.task_id).toBe(executeRun.taskId);
  });

  it('uses only the Control Issue ref for Plan, Tracker and Report writes', async () => {
    const targetWorkspace = nodePath.join(nodePath.dirname(fixture.projectRoot), 'gateflow-target-ref-test');
    const prepared = await runCommand(deps, {
      targetRepository: 'octo/another-project',
      targetWorkspace,
    });
    await writeTaskFile(fixture.paths, prepared.taskId!, 'plan.md', '# Plan\n');
    await writeTaskFile(
      fixture.paths,
      prepared.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: prepared.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );
    await syncCommand(deps);
    expect(client.refs.every((ref) => ref.owner === 'octo' && ref.repo === 'repo' && ref.issueNumber === ISSUE)).toBe(true);
    expect(client.issues.has(999)).toBe(false);
  });

  it('rejects traversal targets and never writes a task for them', async () => {
    const prepared = await runCommand(deps, {
      targetRepository: 'octo/new-project',
      targetWorkspace: `${fixture.projectRoot}\\..\\escape`,
    });
    expect(prepared.prepared).toBe(false);
    expect(prepared.reason).toContain('preparation failed');
    expect(prepared.taskId).toBeNull();
  });

  it('keeps the Executor lock through a non-terminal sync and releases it after report publication', async () => {
    const targetWorkspace = nodePath.join(nodePath.dirname(fixture.projectRoot), 'gateflow-target-lock-test');
    const planRun = await runCommand(deps, { targetRepository: 'octo/lock-project', targetWorkspace });
    await writeTaskFile(fixture.paths, planRun.taskId!, 'plan.md', '# Plan\n');
    await writeTaskFile(
      fixture.paths,
      planRun.taskId!,
      'result.json',
      JSON.stringify({ schema: 3, task_id: planRun.taskId, mode: 'plan', status: 'completed', report: 'plan.md' }),
    );
    await syncCommand(deps);
    const planComment = client.issues.get(ISSUE)!.comments.find((comment) => comment.body.includes(MARKERS.plan))!;
    client.issues.get(ISSUE)!.labels = ['ai:ready'];
    const approvalCommand = client.addComment(ISSUE, OWNER, `/approve ${planComment.id}`);
    client.addGateRecord(
      ISSUE,
      approvalRecord({
        repositoryId: 123,
        issueNumber: ISSUE,
        epoch,
        planCommentId: planComment.id,
        planSha256: planSha256(planComment.body),
        approvalCommandCommentId: approvalCommand.id,
      }),
    );
    await syncCommand(deps);
    const executeRun = await runCommand(deps);
    await writeTaskFile(fixture.paths, executeRun.taskId!, 'report.md', '# Report\n');
    await writeTaskFile(
      fixture.paths,
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
    expect((await syncCommand(deps)).outcomes.some((outcome) => outcome.action === 'tracker-created')).toBe(true);
    await access(executorLockFile(fixture.paths));
    client.issues.get(ISSUE)!.labels = ['ai:working'];
    expect((await syncCommand(deps)).outcomes.some((outcome) => outcome.action === 'completed')).toBe(true);
    await expect(access(executorLockFile(fixture.paths))).rejects.toThrow();
    expect((await readDriverState(fixture.paths)).tasks[executeRun.taskId!]?.executor_lock_task_id).toBeUndefined();
  });
});
