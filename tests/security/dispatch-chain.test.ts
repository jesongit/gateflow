/**
 * V1.1 SECURITY (adversarial) — hardening plan acceptance suites:
 *
 * Phase 1 (Gate Dispatch Authorization):
 *   旧 Plan Tracker / 旧 Epoch Tracker 无法触发状态迁移; Fake Tracker 无法
 *   触发 WORKING; 无 Approval 的 READY 无法进入 WORKING; 旧 Report 无法触发
 *   DONE; Report dispatch_id 不匹配无法触发 DONE; 旧 Tracker 编辑不影响新
 *   轮次; 合法链完整迁移成功。
 *
 * Phase 2 (Epoch Record Trust):
 *   普通用户伪造 Epoch 无效; Trusted Agent 伪造 Epoch 无效; wrong
 *   repository_id / issue_number 无效; duplicate same operation 可 adopt;
 *   conflicting epoch fail closed。
 *
 * Phase 3 (T0 recovery):
 *   重复 /ai-plan event 不创建第二个 Epoch; epoch record 已存在时可 adopt;
 *   epoch record 写入失败不会进入 PLANNING。
 *
 * Every attack asserts BOTH "rejection" AND "no side effect" (gate writes).
 */
import { describe, expect, it } from 'vitest';

import { runGate, type GateInput } from '../../src/gate/gate';
import type { GateComment } from '../../src/gate/approvals';
import type { AuthenticatedUser, GitHubClient, RepoIdentity } from '../../src/gate/github';
import { LABELS, MARKERS } from '../../src/gate/protocol';
import {
  approvalOperationId,
  buildRecordBody,
  gateEpochOperationId,
  RECORD_SCHEMA_VERSION,
} from '../../src/protocol/records';
import { planSha256 } from '../../src/protocol/plan';

/* ------------------------------------------------------------- fixtures */

const GATE_IDENTITY: AuthenticatedUser = { id: 41898282, login: 'gate-bot' };
const REPO_IDENTITY: RepoIdentity = { owner: 'owner-user', ownerType: 'User', id: 123 };
const EPOCH = 'wf_qrdeh6k30m1z';
const OLD_EPOCH = 'wf_aaaabbbbbbcc';
const CONSUMER_DISPATCH = `gf_r123_i7_w${EPOCH.slice(3)}_consumer_01`;
const EXECUTOR_DISPATCH = `gf_r123_i7_w${EPOCH.slice(3)}_executor_p123`;
const OLD_EXECUTOR_DISPATCH = `gf_r123_i7_w${OLD_EPOCH.slice(3)}_executor_p123`;

const PLAN_BODY =
  `<!-- ${'ai-workflow'}:plan:v1 -->\n\n` +
  `<!-- gateflow:dispatch-id: ${CONSUMER_DISPATCH} -->\n\n## Plan\n\nDo it.\n`;

function markerBody(marker: string, dispatchId: string, extra = ''): string {
  return `${marker}\n\n<!-- gateflow:dispatch-id: ${dispatchId} -->\n\n${extra}`;
}

const TRACKER_BODY = markerBody(MARKERS.executionTracker, EXECUTOR_DISPATCH, '**Status:** In Progress\n');
const OLD_ROUND_TRACKER_BODY = markerBody(MARKERS.executionTracker, OLD_EXECUTOR_DISPATCH, '**Status:** In Progress\n');
const REPORT_BODY = markerBody(MARKERS.completionReport, EXECUTOR_DISPATCH, 'All done.\n');

function seed(kind: string, fields: Record<string, unknown>, id = 45, user = GATE_IDENTITY.login): GateComment {
  return {
    id,
    user,
    body: buildRecordBody({ schema: RECORD_SCHEMA_VERSION, kind, ...fields } as never),
  };
}

const epochRecord = (id = 45, epoch = EPOCH): GateComment =>
  seed('workflow_epoch', {
    repository_id: 123,
    issue_number: 7,
    workflow_epoch: epoch,
    created_by: 'gate',
    created_at: '2026-09-06T10:00:00Z',
    issued_by: GATE_IDENTITY.login,
    operation_id: gateEpochOperationId(123, 7, 42),
  }, id);

const approveCommand: GateComment = { id: 601, user: 'owner-user', body: '/approve 123' };

const approvalRecord = (id = 46): GateComment =>
  seed('approval', {
    repository_id: 123,
    issue_number: 7,
    workflow_epoch: EPOCH,
    plan_comment_id: 123,
    plan_sha256: planSha256(PLAN_BODY),
    approval_command_comment_id: approveCommand.id,
    approved_by_id: 1001,
    approved_by_login: 'owner-user',
    gate_login: GATE_IDENTITY.login,
    gate_user_id: GATE_IDENTITY.id,
    created_at: '2026-09-06T10:05:00Z',
    operation_id: approvalOperationId(123, 7, EPOCH, 123),
  }, id);

/** The complete, LEGAL executor chain for plan comment 123. */
function legalExecutorChain(): GateComment[] {
  return [
    { id: 123, user: 'consumer-bot', body: PLAN_BODY },
    epochRecord(),
    approveCommand,
    approvalRecord(),
  ];
}

/* --------------------------------------------------------------- harness */

interface Stats {
  labels: string[];
  removed: string[];
  comments: Array<{ body: string }>;
  reactions: Array<{ content: string }>;
}

function harness(options: { labels?: string[]; comments?: GateComment[] } = {}): {
  client: GitHubClient;
  stats: Stats;
  commentStore: GateComment[];
} {
  const commentStore = [...(options.comments ?? [])];
  const stats: Stats = { labels: [], removed: [], comments: [], reactions: [] };
  const client: GitHubClient = {
    async getIssue() {
      return { state: 'open', labels: [...(options.labels ?? [])] };
    },
    async getLabels() {
      return [...(options.labels ?? [])];
    },
    async addLabels(_ref, labels) {
      stats.labels.push(...labels);
    },
    async removeLabel(_ref, label) {
      stats.removed.push(label);
    },
    async addReaction(_ref, _id, content) {
      stats.reactions.push({ content });
    },
    async editComment() {},
    async getComment(_ref, commentId) {
      const found = commentStore.find((c) => c.id === commentId);
      return found === undefined ? null : { ...found };
    },
    async listComments() {
      return [...commentStore].sort((a, b) => a.id - b.id);
    },
    async addComment(_ref, body) {
      stats.comments.push({ body });
      const created: GateComment = { id: 10000 + stats.comments.length, user: GATE_IDENTITY.login, body };
      commentStore.push(created);
      return { id: created.id };
    },
    async getAuthenticatedUser() {
      return { ...GATE_IDENTITY };
    },
    async getRepoIdentity(query) {
      return { ...REPO_IDENTITY, owner: query.owner };
    },
  };
  return { client, stats, commentStore };
}

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    eventName: 'issue_comment',
    eventAction: 'created',
    actor: 'owner-user',
    actorId: 1001,
    repositoryId: 123,
    repoOwner: 'owner-user',
    repo: 'demo',
    issueNumber: 7,
    commentId: 9001,
    commentBody: '/approve 123',
    trustedHumansInput: '',
    trustedAgentsInput: 'executor-bot, consumer-bot',
    ...overrides,
  };
}

function gateWrites(stats: Stats): number {
  return stats.labels.length + stats.removed.length + stats.reactions.length;
}

/* -------------------------------------------------- Phase 1: dispatch chain */

describe('V1.1 Phase 1: gate dispatch-chain authorization (adversarial)', () => {
  it('a FAKE tracker (no dispatch binding) cannot trigger WORKING', async () => {
    const fakeTracker = `<!-- ${'ai-workflow'}:execution-tracker:v1 -->\n\n**Status:** In Progress\n`;
    const h = harness({ labels: [LABELS.ready], comments: legalExecutorChain() });
    await runGate(input({ commentBody: fakeTracker, commentId: 700, actor: 'executor-bot' }), h.client, { info() {}, warning() {} });
    expect(gateWrites(h.stats)).toBe(0);
  });

  it('an OLD-round tracker (superseded epoch in the dispatch id) cannot trigger WORKING', async () => {
    const h = harness({ labels: [LABELS.ready], comments: legalExecutorChain() });
    await runGate(
      input({ commentBody: OLD_ROUND_TRACKER_BODY, commentId: 700, actor: 'executor-bot' }),
      h.client,
      { info() {}, warning() {} },
    );
    expect(gateWrites(h.stats)).toBe(0);
  });

  it('READY without a valid approval record cannot enter WORKING (fake ready dies)', async () => {
    const comments = legalExecutorChain().filter((c) => c.id !== 46); // strip the approval record
    const h = harness({ labels: [LABELS.ready], comments });
    await runGate(
      input({ commentBody: TRACKER_BODY, commentId: 700, actor: 'executor-bot' }),
      h.client,
      { info() {}, warning() {} },
    );
    expect(gateWrites(h.stats)).toBe(0);
  });

  it('an OLD report cannot trigger DONE (old-epoch dispatch id)', async () => {
    const oldReport = markerBody(MARKERS.completionReport, OLD_EXECUTOR_DISPATCH, 'Done.\n');
    const oldTracker = OLD_ROUND_TRACKER_BODY;
    const h = harness({
      labels: [LABELS.working],
      comments: [...legalExecutorChain(), { id: 700, user: 'executor-bot', body: oldTracker }, { id: 701, user: 'executor-bot', body: oldReport }],
    });
    await runGate(input({ commentBody: oldReport, commentId: 701, actor: 'executor-bot' }), h.client, {
      info() {},
      warning() {},
    });
    expect(gateWrites(h.stats)).toBe(0);
  });

  it('a report whose dispatch_id does not match the authorized executor chain cannot trigger DONE', async () => {
    const otherDispatchReport = markerBody(
      MARKERS.completionReport,
      `gf_r123_i7_w${EPOCH.slice(3)}_executor_p999`,
      'Done.\n',
    );
    const h = harness({
      labels: [LABELS.working],
      comments: [
        ...legalExecutorChain(),
        { id: 700, user: 'executor-bot', body: TRACKER_BODY },
        { id: 701, user: 'executor-bot', body: otherDispatchReport },
      ],
    });
    await runGate(input({ commentBody: otherDispatchReport, commentId: 701, actor: 'executor-bot' }), h.client, {
      info() {},
      warning() {},
    });
    // p999 does not bind the current plan comment (p123) → no DONE.
    expect(gateWrites(h.stats)).toBe(0);
  });

  it('an OLD tracker EDIT cannot drive T4/T5 of the new round (old Agent cannot touch the new round)', async () => {
    const oldTracker = { id: 800, user: 'executor-bot', body: OLD_ROUND_TRACKER_BODY };
    const h = harness({
      labels: [LABELS.working],
      comments: [...legalExecutorChain(), { id: 801, user: 'executor-bot', body: TRACKER_BODY }, oldTracker],
    });
    await runGate(
      input({
        eventAction: 'edited',
        commentBody: OLD_ROUND_TRACKER_BODY.replace('In Progress', 'Blocked'),
        commentId: 800,
        actor: 'executor-bot',
      }),
      h.client,
      { info() {}, warning() {} },
    );
    expect(gateWrites(h.stats)).toBe(0);
  });

  it('the LEGAL chain still migrates end to end: T3 (READY→WORKING) and T6 (WORKING→DONE)', async () => {
    // T3
    const tracker = { id: 700, user: 'executor-bot', body: TRACKER_BODY };
    const h3 = harness({ labels: [LABELS.ready], comments: [...legalExecutorChain(), tracker] });
    await runGate(input({ commentBody: TRACKER_BODY, commentId: 700, actor: 'executor-bot' }), h3.client, {
      info() {},
      warning() {},
    });
    expect(h3.stats.labels).toEqual([LABELS.working]);
    expect(h3.stats.removed).toEqual([LABELS.ready]);
    // A transition record was persisted first (audit + receipt evidence).
    expect(h3.stats.comments[0]?.body).toContain('gateflow:transition:v2');

    // T6
    const report = { id: 701, user: 'executor-bot', body: REPORT_BODY };
    const h6 = harness({
      labels: [LABELS.working],
      comments: [...legalExecutorChain(), tracker, report],
    });
    await runGate(input({ commentBody: REPORT_BODY, commentId: 701, actor: 'executor-bot' }), h6.client, {
      info() {},
      warning() {},
    });
    expect(h6.stats.labels).toEqual([LABELS.done]);
    expect(h6.stats.removed).toEqual([LABELS.working]);
  });
});

/* ------------------------------------------------- Phase 2: epoch trust */

describe('V1.1 Phase 2: epoch record trust (adversarial)', () => {
  it('a FORGED epoch record by a plain user is invalid: /approve fails closed', async () => {
    const forged = seed('workflow_epoch', {
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: 'wf_forged00001',
      created_by: 'gate', // claims gate class…
      created_at: '2026-09-06T10:00:00Z',
      issued_by: 'attacker',
      operation_id: gateEpochOperationId(123, 7, 77),
    }, 90, 'attacker'); // …but is authored by a nobody
    const h = harness({ labels: [LABELS.review], comments: [{ id: 123, user: 'consumer-bot', body: PLAN_BODY }, forged] });
    await runGate(input(), h.client, { info() {}, warning() {} });
    expect(gateWrites(h.stats)).toBe(0);
    expect(h.stats.comments).toEqual([]); // no approval record either
  });

  it('a forged epoch by a TRUSTED AGENT is invalid too (agents never issue epochs)', async () => {
    const forged = seed('workflow_epoch', {
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: 'wf_forged00002',
      created_by: 'gate',
      created_at: '2026-09-06T10:00:00Z',
      issued_by: 'executor-bot',
      operation_id: gateEpochOperationId(123, 7, 78),
    }, 91, 'executor-bot');
    const h = harness({ labels: [LABELS.review], comments: [{ id: 123, user: 'consumer-bot', body: PLAN_BODY }, forged] });
    await runGate(input(), h.client, { info() {}, warning() {} });
    expect(gateWrites(h.stats)).toBe(0);
  });

  it('an epoch record with a wrong repository_id fails closed', async () => {
    const transplanted = seed('workflow_epoch', {
      repository_id: 999,
      issue_number: 7,
      workflow_epoch: EPOCH,
      created_by: 'gate',
      created_at: '2026-09-06T10:00:00Z',
      issued_by: GATE_IDENTITY.login,
      operation_id: gateEpochOperationId(999, 7, 42),
    });
    const h = harness({ labels: [LABELS.review], comments: [{ id: 123, user: 'consumer-bot', body: PLAN_BODY }, transplanted] });
    await runGate(input(), h.client, { info() {}, warning() {} });
    expect(gateWrites(h.stats)).toBe(0);
  });

  it('an epoch record with a wrong issue_number fails closed', async () => {
    const transplanted = seed('workflow_epoch', {
      repository_id: 123,
      issue_number: 8,
      workflow_epoch: EPOCH,
      created_by: 'gate',
      created_at: '2026-09-06T10:00:00Z',
      issued_by: GATE_IDENTITY.login,
      operation_id: gateEpochOperationId(123, 8, 42),
    });
    const h = harness({ labels: [LABELS.review], comments: [{ id: 123, user: 'consumer-bot', body: PLAN_BODY }, transplanted] });
    await runGate(input(), h.client, { info() {}, warning() {} });
    expect(gateWrites(h.stats)).toBe(0);
  });

  it('a CONFLICTING epoch under the same operation id fails closed (never latest-wins)', async () => {
    const conflicting = seed('workflow_epoch', {
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: 'wf_conflict0001',
      created_by: 'gate',
      created_at: '2026-09-06T10:30:00Z',
      issued_by: GATE_IDENTITY.login,
      operation_id: gateEpochOperationId(123, 7, 42), // same op id as epochRecord(), different epoch
    }, 95);
    const h = harness({ labels: [LABELS.review], comments: [{ id: 123, user: 'consumer-bot', body: PLAN_BODY }, epochRecord(), conflicting] });
    await runGate(input(), h.client, { info() {}, warning() {} });
    expect(gateWrites(h.stats)).toBe(0);
    expect(h.stats.comments).toEqual([]);
  });
});

/* ------------------------------------------------- Phase 3: T0 recovery */

describe('V1.1 Phase 3: T0 epoch recovery', () => {
  it('a REDELIVERED /ai-plan (same command comment) adopts the existing epoch: no second epoch record', async () => {
    const existingEpoch = epochRecord(45);
    const h = harness({ labels: [], comments: [{ id: 123, user: 'consumer-bot', body: PLAN_BODY }, existingEpoch] });
    // The issue label write of round 1 never happened (crash) — issue is
    // still outside the workflow; the redelivered event re-derives the same
    // operation id (epoch:123:7:c9001)…
    const redelivered = seed('workflow_epoch', {
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: EPOCH,
      created_by: 'gate',
      created_at: '2026-09-06T10:00:00Z',
      issued_by: GATE_IDENTITY.login,
      operation_id: gateEpochOperationId(123, 7, 9001),
    }, 46);
    h.commentStore.push(redelivered);
    await runGate(input({ commentBody: '/ai-plan' }), h.client, { info() {}, warning() {} });
    // …adopts it (no new record) and completes the label migration.
    expect(h.stats.comments).toEqual([]);
    expect(h.stats.labels).toEqual([LABELS.planning]);
  });

  it('an epoch record WRITE FAILURE means NO PLANNING (record-first, fail closed)', async () => {
    const h = harness({ labels: [] });
    h.client.addComment = async () => {
      throw new Error('500 write failed');
    };
    await runGate(input({ commentBody: '/ai-plan' }), h.client, { info() {}, warning() {} });
    expect(h.stats.labels).toEqual([]); // no label migration
    expect(h.stats.reactions).toEqual([]); // and no ✅
  });

  it('a second /ai-plan after a completed round starts a NEW round with a NEW epoch (never inherits)', async () => {
    // Round 1 done: issue carried ai:planning, then /cancel removed it.
    const h = harness({ labels: [], comments: [epochRecord(45, EPOCH)] });
    await runGate(input({ commentBody: '/ai-plan', commentId: 9500 }), h.client, { info() {}, warning() {} });
    // New operation id (c9500) → a NEW epoch record is minted.
    expect(h.stats.comments).toHaveLength(1);
    const body = h.stats.comments[0]?.body ?? '';
    expect(body).toContain(`"operation_id": "${gateEpochOperationId(123, 7, 9500)}"`);
    expect(body).not.toContain(`"${EPOCH}"`);
    expect(h.stats.labels).toEqual([LABELS.planning]);
  });
});
