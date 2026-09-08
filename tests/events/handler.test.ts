/**
 * V1.1 Phase 10 — Event Fixture Integration tests.
 *
 * A plain CI workflow that creates an issue/comment and then `uses: ./`
 * does NOT produce a real `issue_comment` event — so the two layers are
 * tested separately:
 *  1. THESE tests: recorded GitHub webhook payloads (tests/events/fixtures)
 *     are injected through the SAME pure extraction + gate entry the action
 *     uses in production (gateInputFromPayload → runGate), against an
 *     in-memory GitHub. This is the closest thing to a real event delivery
 *     that can run hermetically in CI.
 *  2. The Action runtime smoke (CI `uses: ./`) only proves Node24 runtime,
 *     bundle, inputs and action metadata — never a Gate E2E (see
 *     scripts/check-dist.mjs + docs).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import { runGate, type GateInput, type GateLogger } from '../../src/gate/gate';
import { gateInputFromPayload, type GatePayloadShape } from '../../src/gate/input';
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

const FIXTURES = nodePath.resolve(__dirname, 'fixtures');

function loadFixture(name: string): GatePayloadShape & { action?: string } {
  return JSON.parse(readFileSync(nodePath.join(FIXTURES, name), 'utf8')) as GatePayloadShape;
}

const GATE_IDENTITY: AuthenticatedUser = { id: 41898282, login: 'gate-bot' };
const REPO_IDENTITY: RepoIdentity = { owner: 'owner-user', ownerType: 'User', id: 123 };
const EPOCH = 'wf_qrdeh6k30m1z';
const CONSUMER_DISPATCH = 'gf_r123_i7_wqrdeh6k30m1z_consumer_01';
const PLAN_BODY =
  '<!-- ai-workflow:plan:v1 -->\n\n' +
  `<!-- gateflow:dispatch-id: ${CONSUMER_DISPATCH} -->\n\n## Plan\n\nDo it.\n`;

function gateHarness(comments: GateComment[]): { client: GitHubClient; labels: string[]; commentBodies: string[] } {
  const commentStore = [...comments];
  const state = {
    labels: ['ai:review'] as string[],
    commentBodies: [] as string[],
  };
  const client: GitHubClient = {
    async getIssue() {
      return { state: 'open', labels: [...state.labels] };
    },
    async getLabels() {
      return [...state.labels];
    },
    async addLabels(_ref, labels) {
      // Mutate in place: the test harness holds a spread copy of `state`.
      state.labels.splice(0, state.labels.length, ...new Set([...state.labels, ...labels]));
    },
    async removeLabel(_ref, label) {
      state.labels.splice(0, state.labels.length, ...state.labels.filter((l) => l !== label));
    },
    async addReaction() {},
    async editComment() {},
    async getComment(_ref, commentId) {
      const found = commentStore.find((c) => c.id === commentId);
      return found === undefined ? null : { ...found };
    },
    async listComments() {
      return [...commentStore].sort((a, b) => a.id - b.id);
    },
    async addComment(_ref, body) {
      state.commentBodies.push(body);
      const created: GateComment = { id: 10000 + state.commentBodies.length, user: GATE_IDENTITY.login, body };
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
  return { client, ...state };
}

function gateInputFrom(
  eventName: string,
  payload: GatePayloadShape,
  overrides: Partial<GateInput> = {},
): GateInput | null {
  const extracted = gateInputFromPayload(eventName, payload, {
    repoOwner: 'owner-user',
    repo: 'demo',
    trustedHumansInput: '',
    trustedAgentsInput: 'gateflow-driver[bot]',
  });
  if (extracted === null) return null;
  return { ...extracted, ...overrides };
}

const warnings: string[] = [];
const logger: GateLogger = {
  info() {},
  warning(message) {
    warnings.push(message);
  },
};

describe('V1.1 Phase 10: event fixture integration (recorded payloads → real gate)', () => {
  it('issue_comment.created (/approve) from the recorded payload drives T2 end to end', async () => {
    const payload = loadFixture('issue_comment_created.json');
    const input = gateInputFrom('issue_comment', payload);
    expect(input).not.toBeNull();

    // Canonical state: epoch record + current plan (the approval target).
    const epochComment: GateComment = {
      id: 45,
      user: GATE_IDENTITY.login,
      body: buildRecordBody({
        schema: RECORD_SCHEMA_VERSION,
        kind: 'workflow_epoch',
        repository_id: 123,
        issue_number: 7,
        workflow_epoch: EPOCH,
        created_by: 'gate',
        created_at: '2026-09-06T10:00:00Z',
        issued_by: GATE_IDENTITY.login,
        operation_id: gateEpochOperationId(123, 7, 42),
      }),
    };
    const planComment: GateComment = { id: 123, user: 'gateflow-driver[bot]', body: PLAN_BODY };

    const h = gateHarness([epochComment, planComment]);
    await runGate(input as GateInput, h.client, logger);

    // T2 completed: REVIEW → READY via the approval + transition records.
    expect(h.labels).toEqual([LABELS.ready]);
    expect(h.commentBodies.some((b) => b.includes('gateflow:approval:v2'))).toBe(true);
    expect(h.commentBodies.some((b) => b.includes('gateflow:transition:v2'))).toBe(true);
    const approval = h.commentBodies.find((b) => b.includes('gateflow:approval:v2')) ?? '';
    expect(approval).toContain(`"plan_sha256": "${planSha256(PLAN_BODY)}"`);
    expect(approval).toContain(
      `"operation_id": "${approvalOperationId(123, 7, EPOCH, 123)}"`,
    );
  });

  it('issue_comment.edited (tracker → Blocked) from the recorded payload triggers T4 when the chain holds', async () => {
    const payload = loadFixture('issue_comment_edited.json');
    const input = gateInputFrom('issue_comment', payload, { actorId: 5001 });
    expect(input).not.toBeNull();
    expect(input?.eventAction).toBe('edited');

    const epochComment: GateComment = {
      id: 45,
      user: GATE_IDENTITY.login,
      body: buildRecordBody({
        schema: RECORD_SCHEMA_VERSION,
        kind: 'workflow_epoch',
        repository_id: 123,
        issue_number: 7,
        workflow_epoch: EPOCH,
        created_by: 'gate',
        created_at: '2026-09-06T10:00:00Z',
        issued_by: GATE_IDENTITY.login,
        operation_id: gateEpochOperationId(123, 7, 42),
      }),
    };
    const planComment: GateComment = { id: 123, user: 'gateflow-driver[bot]', body: PLAN_BODY };
    const approveCommand: GateComment = { id: 601, user: 'owner-user', body: '/approve 123' };
    const approvalComment: GateComment = {
      id: 46,
      user: GATE_IDENTITY.login,
      body: buildRecordBody({
        schema: RECORD_SCHEMA_VERSION,
        kind: 'approval',
        repository_id: 123,
        issue_number: 7,
        workflow_epoch: EPOCH,
        plan_comment_id: 123,
        plan_sha256: planSha256(PLAN_BODY),
        approval_command_comment_id: 601,
        approved_by_id: 1001,
        approved_by_login: 'owner-user',
        gate_login: GATE_IDENTITY.login,
        gate_user_id: GATE_IDENTITY.id,
        created_at: '2026-09-06T10:05:00Z',
        operation_id: approvalOperationId(123, 7, EPOCH, 123),
      }),
    };
    const trackerComment: GateComment = {
      id: 700,
      user: 'gateflow-driver[bot]',
      body: payload.comment?.body ?? '',
    };

    // WORKING + the CURRENT executor chain → the Blocked edit is T4.
    const h = gateHarness([epochComment, planComment, approveCommand, approvalComment, trackerComment]);
    h.labels.splice(0, h.labels.length, LABELS.working);
    await runGate(input as GateInput, h.client, logger);
    expect(h.labels).toEqual([LABELS.blocked]);
    expect(h.commentBodies.some((b) => b.includes('"transition": "T4"'))).toBe(true);
  });

  it('issues.opened (Producer schema block) stays observability-only: no auto-labeling', async () => {
    const payload = loadFixture('issues_opened.json');
    const input = gateInputFrom('issues', payload);
    expect(input).not.toBeNull();
    const h = gateHarness([]);
    h.labels.splice(0, h.labels.length); // start outside the workflow
    await runGate(input as GateInput, h.client, logger);
    expect(h.labels).toEqual([]); // no auto-labeling (T0 belongs to /ai-plan)
    expect(h.commentBodies).toEqual([]);
  });

  it('issues.closed is a validated silent stop: no transition', async () => {
    const payload = loadFixture('issues_closed.json');
    const input = gateInputFrom('issues', payload);
    expect(input).not.toBeNull();
    const h = gateHarness([]);
    await runGate(input as GateInput, h.client, logger);
    expect(h.commentBodies).toEqual([]);
  });

  it('the extraction rejects payloads without an issue (misconfigured trigger)', () => {
    expect(gateInputFrom('workflow_dispatch', { action: 'requested' })).toBeNull();
  });

  it('the tracker fixture body carries the marker + dispatch-id exactly as the Driver publishes them', () => {
    const payload = loadFixture('issue_comment_edited.json');
    const body = payload.comment?.body ?? '';
    expect(detectMarker(body)).toBe(MARKERS.executionTracker);
    expect(body).toContain('gateflow:dispatch-id: gf_r123_i7_wqrdeh6k30m1z_executor_p123');
    expect(body).toContain('**Status:** Blocked');
  });
});

/** Local marker check mirroring the gate's line-ownership rule. */
function detectMarker(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === MARKERS.executionTracker) return trimmed;
  }
  return null;
}
