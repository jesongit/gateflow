/**
 * The gate's deterministic core, end-to-end over a fake client: T0 (+ the
 * V1 self-heal), T1/T3/T6 marker transitions, T2 approval records, /change
 * feedback records, /cancel, permissions, and the T4/T5 tracker channel.
 */
import { describe, expect, it } from 'vitest';

import { runGate, type GateInput } from '../../src/gate/gate';
import { LABELS, MARKERS, STATES } from '../../src/gate/protocol';
import { parseRecord, planSha256 } from '../../src/protocol';
import {
  FakeGateClient,
  OWNER,
  REPO,
  ISSUE,
  gateApprovalRecord,
  gateEpochRecord,
  testGateEpoch,
} from './helpers';

function gateInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    eventName: 'issue_comment',
    eventAction: 'created',
    actor: OWNER,
    actorId: 1001,
    repositoryId: 123,
    repoOwner: OWNER,
    repo: REPO,
    issueNumber: ISSUE,
    commentId: 900001,
    commentBody: '/ai-plan',
    trustedHumansInput: '',
    trustedAgentsInput: 'gateflow-driver[bot]',
    requireExplicitHumansInput: 'true',
    ...overrides,
  };
}

function planBody(taskId: string): string {
  return `${MARKERS.plan}\n\n<!-- gateflow:dispatch-id: ${taskId} -->\n\n# Execution Plan\n\nDo it.\n`;
}

function planTaskId(epoch: ReturnType<typeof testGateEpoch>, revision = '01'): string {
  return `gf_r123_i7_w${epoch.slice(3)}_plan_${revision}`;
}

function executeTaskId(epoch: ReturnType<typeof testGateEpoch>, planId: number): string {
  return `gf_r123_i7_w${epoch.slice(3)}_execute_p${planId}`;
}

/** Seed the current approved execution chain used by tracker/report tests. */
function approvedExecutionChain(
  client: FakeGateClient,
  state: 'ready' | 'working' = 'ready',
): { epoch: ReturnType<typeof testGateEpoch>; planId: number; executeId: string; trackerId?: number } {
  client.addIssue(ISSUE, [LABELS[state]]);
  const epoch = testGateEpoch(ISSUE);
  client.addGateRecord(ISSUE, gateEpochRecord(123, ISSUE, epoch));
  const plan = client.pushComment(ISSUE, 'gateflow-driver[bot]', planBody(planTaskId(epoch)));
  const approvalCommand = client.pushComment(ISSUE, OWNER, `/approve ${plan.id}`);
  client.addGateRecord(
    ISSUE,
    gateApprovalRecord({
      repositoryId: 123,
      issueNumber: ISSUE,
      epoch,
      planCommentId: plan.id,
      planSha256: planSha256(plan.body),
      approvalCommandCommentId: approvalCommand.id,
      approvedByLogin: OWNER,
    }),
  );
  const executeId = executeTaskId(epoch, plan.id);
  if (state === 'working') {
    const tracker = client.pushComment(
      ISSUE,
      'gateflow-driver[bot]',
      `${MARKERS.executionTracker}\n\n<!-- gateflow:dispatch-id: ${executeId} -->\n\n**Status:** In Progress\n`,
    );
    return { epoch, planId: plan.id, executeId, trackerId: tracker.id };
  }
  return { epoch, planId: plan.id, executeId };
}

async function run(input: GateInput, client: FakeGateClient): Promise<void> {
  const warnings: string[] = [];
  await runGate(input, client, {
    info: () => {},
    warning: (m) => warnings.push(m),
  });
}

describe('T0 /ai-plan', () => {
  it('labels PLANNING and issues a workflow_epoch record', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE);
    const comment = client.pushComment(ISSUE, OWNER, '/ai-plan');
    await run(gateInput({ commentId: comment.id }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.planning]);
    const records = client.gateComments(ISSUE);
    expect(records).toHaveLength(1);
    const parsed = parseRecord(records[0]!.id, records[0]!.body);
    expect(parsed.ok).toBe(true);
  });

  it('is rejected for a Trusted Agent and non-trusted actors (no label, no record)', async () => {
    for (const actor of ['gateflow-driver[bot]', 'random-user']) {
      const client = new FakeGateClient();
      client.addIssue(ISSUE);
      const comment = client.pushComment(ISSUE, actor, '/ai-plan');
      await run(gateInput({ actor, commentId: comment.id }), client);
      expect(client.labelsOf(ISSUE)).toEqual([]);
      expect(client.gateComments(ISSUE)).toHaveLength(0);
      expect(client.reactions).toContainEqual({ issue: ISSUE, commentId: comment.id, content: '-1' });
    }
  });

  it('does not re-enter an issue already in the workflow', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.review]);
    await run(gateInput(), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.review]);
    expect(client.gateComments(ISSUE)).toHaveLength(0);
  });
});

describe('T0 SELF-HEAL: /ai-plan on a PLANNING issue without an epoch record', () => {
  it('re-issues the missing epoch record without a state migration', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.planning]);
    const comment = client.pushComment(ISSUE, OWNER, '/ai-plan');
    await run(gateInput({ commentId: comment.id }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.planning]); // unchanged
    expect(client.gateComments(ISSUE)).toHaveLength(1); // epoch re-issued
    expect(client.reactions).toContainEqual({ issue: ISSUE, commentId: comment.id, content: '+1' });
  });

  it('stays rejected when a valid epoch record already exists', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.planning]);
    client.addGateRecord(ISSUE, gateEpochRecord(123, ISSUE, testGateEpoch(ISSUE)));
    await run(gateInput(), client);
    expect(client.gateComments(ISSUE)).toHaveLength(1); // no new record
  });

  it('fails closed on an unparsable epoch record', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.planning]);
    client.pushComment(ISSUE, client.gateLogin, '<!-- gateflow:workflow:v2 -->\n\n```json\n{"broken":true}\n```');
    await run(gateInput(), client);
    expect(client.gateComments(ISSUE)).toHaveLength(1); // no new record
  });
});

describe('T1 / T3 / T6 marker transitions', () => {
  it('T1: plan marker by trusted agent moves PLANNING → REVIEW', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.planning]);
    const epoch = testGateEpoch(ISSUE);
    client.addGateRecord(ISSUE, gateEpochRecord(123, ISSUE, epoch));
    const body = planBody(planTaskId(epoch));
    const plan = client.pushComment(ISSUE, 'gateflow-driver[bot]', body);
    await run(gateInput({ actor: 'gateflow-driver[bot]', commentBody: body, commentId: plan.id, eventAction: 'created' }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.review]);
  });

  it('T1: plan marker by an unknown actor is plain text (no transition)', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.planning]);
    client.pushComment(ISSUE, 'spoofer', planBody('gf_r123_i7_waaaaaaaaaaaa_plan_01'));
    await run(gateInput({ commentBody: 'trigger', commentId: undefined }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.planning]);
  });

  it('T1: plan marker in the wrong state is a no-op', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.ready]);
    client.pushComment(ISSUE, 'gateflow-driver[bot]', planBody('gf_r123_i7_waaaaaaaaaaaa_plan_01'));
    await run(gateInput({ commentBody: 'x', commentId: undefined }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.ready]);
  });

  it('T3: tracker creation moves READY → WORKING', async () => {
    const client = new FakeGateClient();
    const { executeId } = approvedExecutionChain(client);
    const trackerBody = `${MARKERS.executionTracker}\n\n<!-- gateflow:dispatch-id: ${executeId} -->\n\n**Status:** In Progress\n`;
    const tracker = client.pushComment(ISSUE, 'gateflow-driver[bot]', trackerBody);
    await run(gateInput({ actor: 'gateflow-driver[bot]', commentBody: trackerBody, commentId: tracker.id }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.working]);
  });

  it('T6: completion report moves WORKING → DONE', async () => {
    const client = new FakeGateClient();
    const { executeId } = approvedExecutionChain(client, 'working');
    const tracker = client.issues.get(ISSUE)!.comments.at(-1)!;
    const reportBody = `${MARKERS.completionReport}\n\n<!-- gateflow:dispatch-id: ${executeId} -->\n\nDone.\n`;
    const report = client.pushComment(ISSUE, 'gateflow-driver[bot]', reportBody);
    await run(gateInput({ actor: 'gateflow-driver[bot]', commentBody: reportBody, commentId: report.id }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.done]);
    expect(tracker.body).toContain('execution-tracker');
  });

  it('T6 requires WORKING: a report from READY never completes the issue', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.ready]);
    const reportBody = `${MARKERS.completionReport}\n\n<!-- gateflow:dispatch-id: gf_r123_i7_waaaaaaaaaaaa_execute_p1 -->\n\nDone.\n`;
    client.pushComment(ISSUE, 'gateflow-driver[bot]', reportBody);
    await run(gateInput({ commentBody: reportBody, commentId: undefined }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.ready]);
  });

  it('T4/T5: tracker status edits move WORKING ↔ BLOCKED', async () => {
    const client = new FakeGateClient();
    const { trackerId } = approvedExecutionChain(client, 'working');
    const tracker = client.issues.get(ISSUE)!.comments.find((comment) => comment.id === trackerId)!;
    // T4: the tracker Status edit to Blocked arrives while WORKING.
    tracker.body = tracker.body.replace('**Status:** In Progress', '**Status:** Blocked');
    await run(gateInput({ actor: 'gateflow-driver[bot]', eventAction: 'edited', commentId: tracker.id, commentBody: tracker.body }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.blocked]);

    // T5: back to In Progress while BLOCKED.
    tracker.body = tracker.body.replace('**Status:** Blocked', '**Status:** In Progress');
    await run(gateInput({ actor: 'gateflow-driver[bot]', eventAction: 'edited', commentId: tracker.id, commentBody: tracker.body }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.working]);
  });

  it('"Completed" tracker edits never transition (completion is T6 only)', async () => {
    const client = new FakeGateClient();
    const { trackerId } = approvedExecutionChain(client, 'working');
    const tracker = client.issues.get(ISSUE)!.comments.find((comment) => comment.id === trackerId)!;
    tracker.body = tracker.body.replace('**Status:** In Progress', '**Status:** Completed');
    await run(gateInput({ actor: 'gateflow-driver[bot]', eventAction: 'edited', commentId: tracker.id, commentBody: tracker.body }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.working]);
  });
});

describe('T2 /approve with a Gate-issued approval record', () => {
  function reviewIssue(client: FakeGateClient): { planId: number; epoch: ReturnType<typeof testGateEpoch> } {
    client.addIssue(ISSUE, [LABELS.review]);
    const epoch = testGateEpoch(ISSUE);
    client.addGateRecord(ISSUE, gateEpochRecord(123, ISSUE, epoch));
    const plan = client.pushComment(ISSUE, 'gateflow-driver[bot]', planBody(planTaskId(epoch)));
    return { planId: plan.id, epoch };
  }

  it('binds repo/issue/epoch/plan-id/plan-hash and then swaps labels REVIEW → READY', async () => {
    const client = new FakeGateClient();
    const { planId, epoch } = reviewIssue(client);
    const command = client.pushComment(ISSUE, OWNER, `/approve ${planId}`);
    await run(gateInput({ commentId: command.id, commentBody: `/approve ${planId}` }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.ready]);
    const records = client.gateComments(ISSUE).slice(1); // skip epoch record
    const parsed = parseRecord(records[0]!.id, records[0]!.body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.record.kind === 'approval') {
      expect(parsed.record.workflow_epoch).toBe(epoch);
      expect(parsed.record.plan_comment_id).toBe(planId);
      expect(parsed.record.plan_sha256).toBe(planSha256(planBody(planTaskId(epoch))));
      expect(parsed.record.approved_by_login).toBe(OWNER);
    } else {
      throw new Error('expected an approval record');
    }
  });

  it('approving a non-current plan is rejected without a record', async () => {
    const client = new FakeGateClient();
    const { planId } = reviewIssue(client);
    client.pushComment(ISSUE, 'gateflow-driver[bot]', planBody(planTaskId(testGateEpoch(ISSUE), '02'))); // newer plan
    const command = client.pushComment(ISSUE, OWNER, `/approve ${planId}`);
    await run(gateInput({ commentId: command.id, commentBody: `/approve ${planId}` }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.review]);
    expect(client.gateComments(ISSUE)).toHaveLength(1); // epoch only, no approval record
  });

  it('/approve from a non-trusted human gets 👎 and no record', async () => {
    const client = new FakeGateClient();
    const { planId } = reviewIssue(client);
    const command = client.pushComment(ISSUE, 'random-user', `/approve ${planId}`);
    await run(gateInput({ actor: 'random-user', commentId: command.id, commentBody: `/approve ${planId}` }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.review]);
    expect(client.gateComments(ISSUE)).toHaveLength(1);
    expect(client.reactions).toContainEqual({ issue: ISSUE, commentId: command.id, content: '-1' });
  });

  it('a repeated /approve reuses the existing record (idempotent crash recovery)', async () => {
    const client = new FakeGateClient();
    const { planId } = reviewIssue(client);
    const command = client.pushComment(ISSUE, OWNER, `/approve ${planId}`);
    await run(gateInput({ commentId: command.id, commentBody: `/approve ${planId}` }), client);
    const afterFirst = client.gateComments(ISSUE).length;
    await run(gateInput({ commentId: command.id, commentBody: `/approve ${planId}` }), client);
    expect(client.gateComments(ISSUE).length).toBe(afterFirst);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.ready]);
  });
});

describe('Task 02 execution-chain fail-closed checks', () => {
  it('rejects a plan from an old epoch or with the wrong repository/issue task id', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.planning]);
    const currentEpoch = testGateEpoch(ISSUE);
    client.addGateRecord(ISSUE, gateEpochRecord(123, ISSUE, currentEpoch));

    const oldBody = planBody('gf_r123_i7_w000000000002_plan_01');
    const oldPlan = client.pushComment(ISSUE, 'gateflow-driver[bot]', oldBody);
    await run(
      gateInput({ actor: 'gateflow-driver[bot]', commentId: oldPlan.id, commentBody: oldBody }),
      client,
    );
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.planning]);

    const wrongBody = planBody(`gf_r999_i7_w${currentEpoch.slice(3)}_plan_01`);
    const wrongPlan = client.pushComment(ISSUE, 'gateflow-driver[bot]', wrongBody);
    await run(
      gateInput({ actor: 'gateflow-driver[bot]', commentId: wrongPlan.id, commentBody: wrongBody }),
      client,
    );
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.planning]);
  });

  it('rejects a Tracker when the current Plan has no valid Approval', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.ready]);
    const epoch = testGateEpoch(ISSUE);
    client.addGateRecord(ISSUE, gateEpochRecord(123, ISSUE, epoch));
    const plan = client.pushComment(ISSUE, 'gateflow-driver[bot]', planBody(planTaskId(epoch)));
    const trackerBody = `${MARKERS.executionTracker}\n\n<!-- gateflow:dispatch-id: ${executeTaskId(epoch, plan.id)} -->\n\n**Status:** In Progress\n`;
    const tracker = client.pushComment(ISSUE, 'gateflow-driver[bot]', trackerBody);

    await run(
      gateInput({ actor: 'gateflow-driver[bot]', commentId: tracker.id, commentBody: trackerBody }),
      client,
    );
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.ready]);
  });

  it('rejects an old Tracker and an old Report after a current execution is active', async () => {
    const client = new FakeGateClient();
    const { epoch, executeId } = approvedExecutionChain(client, 'working');
    const oldId = `gf_r123_i7_w000000000002_execute_p1`;
    const oldTrackerBody = `${MARKERS.executionTracker}\n\n<!-- gateflow:dispatch-id: ${oldId} -->\n\n**Status:** In Progress\n`;
    const oldTracker = client.pushComment(ISSUE, 'gateflow-driver[bot]', oldTrackerBody);
    await run(
      gateInput({ actor: 'gateflow-driver[bot]', commentId: oldTracker.id, commentBody: oldTrackerBody }),
      client,
    );
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.working]);

    const oldReportBody = `${MARKERS.completionReport}\n\n<!-- gateflow:dispatch-id: ${oldId} -->\n\nDone.\n`;
    const oldReport = client.pushComment(ISSUE, 'gateflow-driver[bot]', oldReportBody);
    await run(
      gateInput({ actor: 'gateflow-driver[bot]', commentId: oldReport.id, commentBody: oldReportBody }),
      client,
    );
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.working]);
    expect(executeId).not.toBe(oldId);
    expect(epoch).toBe(testGateEpoch(ISSUE));
  });

  it('requires the current Tracker before accepting a Report', async () => {
    const client = new FakeGateClient();
    const { epoch, executeId } = approvedExecutionChain(client);
    client.issues.get(ISSUE)!.labels = [LABELS.working];
    const reportBody = `${MARKERS.completionReport}\n\n<!-- gateflow:dispatch-id: ${executeId} -->\n\nDone.\n`;
    const report = client.pushComment(ISSUE, 'gateflow-driver[bot]', reportBody);

    await run(
      gateInput({ actor: 'gateflow-driver[bot]', commentId: report.id, commentBody: reportBody }),
      client,
    );
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.working]);
    expect(epoch).toBe(testGateEpoch(ISSUE));
  });
});

describe('normal Plan → Approve → Execute → Report flow', () => {
  it('completes only after every object in the current chain is present', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE);

    const planCommand = client.pushComment(ISSUE, OWNER, '/ai-plan');
    await run(gateInput({ commentId: planCommand.id }), client);
    const epochRecord = client.gateComments(ISSUE)[0]!;
    const parsedEpoch = parseRecord(epochRecord.id, epochRecord.body);
    if (!parsedEpoch.ok || parsedEpoch.record.kind !== 'workflow_epoch') {
      throw new Error('expected the Gate-issued epoch record');
    }
    const planBodyText = planBody(planTaskId(parsedEpoch.record.workflow_epoch));
    const plan = client.pushComment(ISSUE, 'gateflow-driver[bot]', planBodyText);
    await run(
      gateInput({ actor: 'gateflow-driver[bot]', commentId: plan.id, commentBody: planBodyText }),
      client,
    );

    const approveBody = `/approve ${plan.id}`;
    const approve = client.pushComment(ISSUE, OWNER, approveBody);
    await run(gateInput({ commentId: approve.id, commentBody: approveBody }), client);

    const executeId = executeTaskId(parsedEpoch.record.workflow_epoch, plan.id);
    const trackerBody = `${MARKERS.executionTracker}\n\n<!-- gateflow:dispatch-id: ${executeId} -->\n\n**Status:** In Progress\n`;
    const tracker = client.pushComment(ISSUE, 'gateflow-driver[bot]', trackerBody);
    await run(
      gateInput({ actor: 'gateflow-driver[bot]', commentId: tracker.id, commentBody: trackerBody }),
      client,
    );

    const reportBody = `${MARKERS.completionReport}\n\n<!-- gateflow:dispatch-id: ${executeId} -->\n\nDone.\n`;
    const report = client.pushComment(ISSUE, 'gateflow-driver[bot]', reportBody);
    await run(
      gateInput({ actor: 'gateflow-driver[bot]', commentId: report.id, commentBody: reportBody }),
      client,
    );
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.done]);
  });
});

describe('/change feedback records', () => {
  it('accepts a trusted-human /change in REVIEW and persists a feedback record', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.review]);
    client.addGateRecord(ISSUE, gateEpochRecord(123, ISSUE, testGateEpoch(ISSUE)));
    const command = client.pushComment(ISSUE, OWNER, '/change 请把状态收敛为五个');
    await run(gateInput({ commentId: command.id, commentBody: '/change 请把状态收敛为五个' }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.review]); // NO state migration
    const records = client.gateComments(ISSUE);
    const parsed = parseRecord(records[records.length - 1]!.id, records[records.length - 1]!.body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.record.kind === 'feedback_accepted') {
      expect(parsed.record.feedback_kind).toBe('change');
    } else {
      throw new Error('expected a feedback record');
    }
  });

  it('rejects /change outside REVIEW and from non-trusted actors', async () => {
    const planning = new FakeGateClient();
    planning.addIssue(ISSUE, [LABELS.planning]);
    planning.pushComment(ISSUE, OWNER, '/change x');
    await run(gateInput({ commentBody: '/change x' }), planning);
    expect(planning.gateComments(ISSUE)).toHaveLength(0);

    const foreign = new FakeGateClient();
    foreign.addIssue(ISSUE, [LABELS.review]);
    foreign.pushComment(ISSUE, 'random-user', '/change x');
    const commandId = foreign.issues.get(ISSUE)!.comments[0]!.id;
    await run(gateInput({ actor: 'random-user', commentId: commandId, commentBody: '/change x' }), foreign);
    expect(foreign.reactions).toContainEqual({ issue: ISSUE, commentId: commandId, content: '-1' });
    expect(foreign.gateComments(ISSUE)).toHaveLength(0);
  });
});

describe('/cancel', () => {
  it('removes all ai:* labels from any state (including DONE)', async () => {
    for (const label of [LABELS.planning, LABELS.blocked, LABELS.done]) {
      const client = new FakeGateClient();
      client.addIssue(ISSUE, [label]);
      await run(gateInput({ commentBody: '/cancel' }), client);
      expect(client.labelsOf(ISSUE)).toEqual([]);
    }
  });

  it('is a no-op outside the workflow', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE);
    await run(gateInput({ commentBody: '/cancel' }), client);
    expect(client.labelsOf(ISSUE)).toEqual([]);
  });
});

describe('ambiguous label state', () => {
  it('multiple ai:* labels fail every command closed except /cancel', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.planning, LABELS.working]);
    await run(gateInput({ commentBody: '/ai-plan' }), client);
    await run(gateInput({ commentBody: '/approve 1' }), client);
    expect(client.labelsOf(ISSUE).sort()).toEqual([LABELS.planning, LABELS.working].sort());
    await run(gateInput({ commentBody: '/cancel' }), client);
    expect(client.labelsOf(ISSUE)).toEqual([]);
  });
});

describe('issues.* events', () => {
  it('opened never auto-labels (no Producer lifecycle)', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE);
    await run(gateInput({ eventName: 'issues', eventAction: 'opened', commentId: undefined, commentBody: undefined }), client);
    expect(client.labelsOf(ISSUE)).toEqual([]);
  });

  it('closed is observed without transition', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.working], 'closed');
    await run(gateInput({ eventName: 'issues', eventAction: 'closed', commentId: undefined, commentBody: undefined }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.working]);
  });
});

describe('identity fail-closed (Organization rule)', () => {
  it('rejects an Organization-owned repo without trusted_humans', async () => {
    const client = new FakeGateClient({ owner: 'octo-org', ownerType: 'Organization' });
    client.addIssue(ISSUE);
    await expect(run(gateInput({ repoOwner: 'octo-org' }), client)).rejects.toThrow(/identity configuration/);
  });
});
