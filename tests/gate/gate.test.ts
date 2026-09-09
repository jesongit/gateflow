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
    client.pushComment(ISSUE, 'gateflow-driver[bot]', planBody('gf_r123_i7_waaaaaaaaaaaa_plan_01'));
    await run(gateInput({ commentBody: planBody('x'), commentId: undefined, eventAction: 'created' }), client);
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
    client.addIssue(ISSUE, [LABELS.ready]);
    const trackerBody = `${MARKERS.executionTracker}\n\n<!-- gateflow:dispatch-id: gf_r123_i7_waaaaaaaaaaaa_execute_p1 -->\n\n**Status:** In Progress\n`;
    client.pushComment(ISSUE, 'gateflow-driver[bot]', trackerBody);
    await run(gateInput({ commentBody: trackerBody, commentId: undefined }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.working]);
  });

  it('T6: completion report moves WORKING → DONE', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.working]);
    const reportBody = `${MARKERS.completionReport}\n\n<!-- gateflow:dispatch-id: gf_r123_i7_waaaaaaaaaaaa_execute_p1 -->\n\nDone.\n`;
    client.pushComment(ISSUE, 'gateflow-driver[bot]', reportBody);
    await run(gateInput({ commentBody: reportBody, commentId: undefined }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.done]);
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
    client.addIssue(ISSUE, [LABELS.working]);
    const tracker = client.pushComment(
      ISSUE,
      'gateflow-driver[bot]',
      `${MARKERS.executionTracker}\n\n<!-- gateflow:dispatch-id: gf_r123_i7_waaaaaaaaaaaa_execute_p1 -->\n\n**Status:** In Progress\n`,
    );
    // T4: the tracker Status edit to Blocked arrives while WORKING.
    tracker.body = tracker.body.replace('**Status:** In Progress', '**Status:** Blocked');
    await run(gateInput({ eventAction: 'edited', commentId: tracker.id, commentBody: tracker.body }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.blocked]);

    // T5: back to In Progress while BLOCKED.
    tracker.body = tracker.body.replace('**Status:** Blocked', '**Status:** In Progress');
    await run(gateInput({ eventAction: 'edited', commentId: tracker.id, commentBody: tracker.body }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.working]);
  });

  it('"Completed" tracker edits never transition (completion is T6 only)', async () => {
    const client = new FakeGateClient();
    client.addIssue(ISSUE, [LABELS.working]);
    const tracker = client.pushComment(
      ISSUE,
      'gateflow-driver[bot]',
      `${MARKERS.executionTracker}\n\n<!-- gateflow:dispatch-id: gf_r123_i7_waaaaaaaaaaaa_execute_p1 -->\n\n**Status:** In Progress\n`,
    );
    tracker.body = tracker.body.replace('**Status:** In Progress', '**Status:** Completed');
    await run(gateInput({ eventAction: 'edited', commentId: tracker.id, commentBody: tracker.body }), client);
    expect(client.labelsOf(ISSUE)).toEqual([LABELS.working]);
  });
});

describe('T2 /approve with a Gate-issued approval record', () => {
  function reviewIssue(client: FakeGateClient): { planId: number; epoch: ReturnType<typeof testGateEpoch> } {
    client.addIssue(ISSUE, [LABELS.review]);
    const epoch = testGateEpoch(ISSUE);
    client.addGateRecord(ISSUE, gateEpochRecord(123, ISSUE, epoch));
    const plan = client.pushComment(ISSUE, 'gateflow-driver[bot]', planBody('gf_r123_i7_waaaaaaaaaaaa_plan_01'));
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
      expect(parsed.record.plan_sha256).toBe(planSha256(planBody('gf_r123_i7_waaaaaaaaaaaa_plan_01')));
      expect(parsed.record.approved_by_login).toBe(OWNER);
    } else {
      throw new Error('expected an approval record');
    }
  });

  it('approving a non-current plan is rejected without a record', async () => {
    const client = new FakeGateClient();
    const { planId } = reviewIssue(client);
    client.pushComment(ISSUE, 'gateflow-driver[bot]', planBody('gf_r123_i7_waaaaaaaaaaaa_plan_02')); // newer plan
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
