/**
 * Integration focus tests (plan Phase 13):
 *
 * 1. Activation failure tolerance (architecture §3.4 note): a broken
 *    activation channel must never fail the dispatch, never touch the
 *    canonical label (no tracker, no T3), and retry paths still work.
 * 2. Role ≠ Provider unit proof: resolveAdapterForAgent resolves each routing
 *    permutation to exactly the configured adapter kind, and
 *    toActivationDispatch maps the workspace protocol's snake_case dispatch
 *    onto the activation module's camelCase type.
 * 3. Multi-issue isolation: issues in different states are processed in one
 *    runOnce; a malformed outbox file on issue A does not block issue B.
 */
import { describe, expect, it } from 'vitest';

import * as nodePath from 'node:path';

import { resolveAdapterForAgent, toActivationDispatch } from '../../src/activation';
import { retryDispatch } from '../../src/driver/retry';
import { runOnce } from '../../src/driver/driver';
import { buildPlanCommentBody } from '../../src/github/comments';
import { detectCommentMarker } from '../../src/gate/markers';
import { MARKERS } from '../../src/gate/protocol';
import { planSha256 } from '../../src/protocol/plan';
import { epochCode } from '../../src/protocol/epoch';
import { atomicWriteText, readInboxDispatch } from '../../src/workspace/inbox';
import { readReceipt, writeReceipt } from '../../src/workspace/outbox';
import { resolveWorkspace } from '../../src/workspace/paths';
import type { WorkspacePaths } from '../../src/workspace/paths';
import { FakeDriverClient, makeDeps, makeWorkspace, testEpoch } from '../driver/helpers';
import {
  GateSimulator,
  captureStdout,
  freshDispatches,
  manualClock,
  statusFileFor,
  throwingStdout,
  writeConfigYaml,
  writeOutboxStatus,
  zcodeSuggestion,
} from './helpers';
import type { ActivationAgentConfig } from '../../src/activation/types';

/** Nonexistent on every platform (win32 `where` / POSIX `which`). */
const MISSING_COMMAND = 'definitely-missing-cmd-xyz';

// ---------------------------------------------------------------------------
// 1. Activation failure tolerance (architecture §3.4: "Activation 失败时
//    Issue 保持 READY")
// ---------------------------------------------------------------------------

describe('activation failure tolerance', () => {
  it('a failing activation channel keeps the issue ai:ready and retry still dispatches', async () => {
    const client = new FakeDriverClient();
    const fixture = await makeWorkspace();
    const clock = manualClock();
    // Executor routed to a chatgpt adapter whose launch capability is broken:
    // autoStart: true + a missing binary → probe fails → the adapter chain
    // ends in the manual notice, which we make THROW (dead stdout channel).
    const config = await writeConfigYaml(fixture.projectRoot, {
      routing: { executor: 'breakable-agent' },
      agents: {
        'breakable-agent': { activation: 'chatgpt', command: MISSING_COMMAND, autoStart: true },
      },
    });
    const deps = makeDeps(client, config, fixture, clock.now);
    const gate = new GateSimulator(client);
    const paths: WorkspacePaths = resolveWorkspace(fixture.projectRoot);
    const ISSUE = 202;
    const EPOCH = testEpoch(ISSUE);

    try {
      // Canonical state: ai:ready with the full schema-2 authorization chain —
      // epoch record + plan + human /approve + Gate-issued approval record.
      client.addIssue(ISSUE, { title: 'Executor-ready issue', labels: ['ai:ready'] });
      client.ensureEpoch(ISSUE, EPOCH);
      const planBody = buildPlanCommentBody('# Approved Plan\n\n- implement it', 'gf_r123_i202_consumer_01');
      const plan = client.addComment(ISSUE, 'gateflow-driver[bot]', planBody);
      const command = client.addComment(ISSUE, 'octo', `/approve ${plan.id}`);
      client.addGateRecord(ISSUE, {
        schema: 2,
        kind: 'approval',
        repository_id: 123,
        issue_number: ISSUE,
        workflow_epoch: EPOCH,
        plan_comment_id: plan.id,
        plan_sha256: planSha256(planBody),
        approval_command_comment_id: command.id,
        approved_by_id: 9001,
        approved_by_login: 'octo',
        gate_login: 'github-actions[bot]',
        gate_user_id: 41898282,
        created_at: '2026-09-06T12:00:00Z',
        operation_id: `approval:123:${ISSUE}:${EPOCH}:p${plan.id}`,
      });
      gate.syncAll(); // records are protocol plumbing: replaying them is a no-op
      expect(gate.labels(ISSUE)).toEqual(['ai:ready']);

      const stdout = throwingStdout();
      try {
        const executorId = `gf_r123_i${ISSUE}_w${epochCode(EPOCH)!}_executor_p${plan.id}`;

        // Cycle 1: the dispatch survives the failing activation.
        const first = await runOnce(deps);
        expect(freshDispatches(first)).toEqual([{ dispatchId: executorId, reason: 'new' }]);
        expect(
          deps.log.lines.some((l) => l.startsWith('warn:') && l.includes('activation adapter threw')),
        ).toBe(true);
        expect((await readInboxDispatch(paths, executorId))?.role).toBe('executor');
        expect((await readReceipt(paths, executorId))?.status).toBe('dispatched');
        gate.syncAll();
        expect(gate.labels(ISSUE)).toEqual(['ai:ready']); // stays READY: no tracker, no T3
        expect(client.commentCount(ISSUE)).toBe(4); // epoch + approval records, plan + /approve

        // Cycle 2: no duplicate dispatch, still no tracker, still ai:ready.
        const second = await runOnce(deps);
        expect(freshDispatches(second)).toEqual([]);
        gate.syncAll();
        expect(gate.labels(ISSUE)).toEqual(['ai:ready']);
        expect(client.commentCount(ISSUE)).toBe(4);

        // Automatic retry below max_attempts: failed receipt re-dispatches.
        await writeReceipt(paths, {
          dispatch_id: executorId,
          status: 'failed',
          attempts: 1,
          error: 'simulated infrastructure failure',
        });
        const third = await runOnce(deps);
        expect(freshDispatches(third)).toEqual([{ dispatchId: executorId, reason: 'retry' }]);
        expect((await readReceipt(paths, executorId))?.status).toBe('dispatched');
        gate.syncAll();
        expect(gate.labels(ISSUE)).toEqual(['ai:ready']);

        // Explicit retry (gateflow driver retry): cleared receipt → next cycle
        // re-dispatches the same id with attempts restarted.
        expect(await retryDispatch(paths, executorId)).toBe(true);
        const fourth = await runOnce(deps);
        expect(freshDispatches(fourth)).toEqual([{ dispatchId: executorId, reason: 'new' }]);
        expect((await readReceipt(paths, executorId))?.attempts).toBe(1);
        gate.syncAll();
        expect(gate.labels(ISSUE)).toEqual(['ai:ready']);
        expect(client.commentCount(ISSUE)).toBe(4);
      } finally {
        stdout.restore();
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Role ≠ Provider — unit proof (no filesystem, no driver cycle)
// ---------------------------------------------------------------------------

describe('Role ≠ Provider — adapter resolution and dispatch mapping', () => {
  const AGENTS: Record<string, ActivationAgentConfig> = {
    'chatgpt-agent': { activation: 'chatgpt' },
    'zcode-agent': { activation: 'zcode' },
  };

  it.each([
    ['chatgpt-agent', 'chatgpt-agent'],
    ['zcode-agent', 'zcode-agent'],
    ['chatgpt-agent', 'zcode-agent'],
    ['zcode-agent', 'chatgpt-agent'],
  ])('routing consumer=%s / executor=%s resolves exactly the configured provider kinds', (consumerAgent, executorAgent) => {
    // dispatch.ts resolves the adapter per ROLE from routing → agent config:
    const consumerAdapter = resolveAdapterForAgent(consumerAgent, AGENTS, 'manual');
    const executorAdapter = resolveAdapterForAgent(executorAgent, AGENTS, 'manual');
    expect(consumerAdapter.name).toBe(AGENTS[consumerAgent]?.activation);
    expect(executorAdapter.name).toBe(AGENTS[executorAgent]?.activation);
  });

  it('the same role maps to different providers purely via the agent config', () => {
    // A role is not a provider: only routing → agent → activation decides.
    const chatgptRouting = resolveAdapterForAgent('chatgpt-agent', AGENTS, 'manual');
    const zcodeRouting = resolveAdapterForAgent('zcode-agent', AGENTS, 'manual');
    expect(chatgptRouting.name).toBe('chatgpt');
    expect(zcodeRouting.name).toBe('zcode');
  });

  it('each resolution returns a fresh adapter instance (roles share no provider state)', () => {
    const a = resolveAdapterForAgent('chatgpt-agent', AGENTS, 'manual');
    const b = resolveAdapterForAgent('chatgpt-agent', AGENTS, 'manual');
    expect(a).not.toBe(b);
  });

  it('an unrouted role (dispatch.ts uses "__none__") falls through to the fallback', () => {
    expect(resolveAdapterForAgent('__none__', AGENTS, 'manual').name).toBe('manual');
    expect(resolveAdapterForAgent('__none__', AGENTS, 'zcode').name).toBe('zcode');
  });

  it('toActivationDispatch maps snake_case protocol fields to camelCase', () => {
    expect(
      toActivationDispatch({
        dispatch_id: 'gf_r7_i42_consumer_01',
        role: 'consumer',
        issue_number: 42,
        repository: 'octo/repo',
      }),
    ).toEqual({
      dispatchId: 'gf_r7_i42_consumer_01',
      role: 'consumer',
      issueNumber: 42,
      repository: 'octo/repo',
    });
    expect(
      toActivationDispatch({
        dispatch_id: 'gf_r7_i42_executor_p99',
        role: 'executor',
        issue_number: 42,
        repository: 'octo/repo',
      }),
    ).toEqual({
      dispatchId: 'gf_r7_i42_executor_p99',
      role: 'executor',
      issueNumber: 42,
      repository: 'octo/repo',
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-issue isolation
// ---------------------------------------------------------------------------

describe('multi-issue isolation in one cycle', () => {
  it('a malformed outbox file on issue A does not block issue B in the same runOnce', async () => {
    const client = new FakeDriverClient();
    const fixture = await makeWorkspace();
    const clock = manualClock();
    const config = await writeConfigYaml(fixture.projectRoot, {
      routing: { consumer: 'chatgpt-agent', executor: 'zcode-agent' },
      agents: {
        'chatgpt-agent': { activation: 'chatgpt' },
        'zcode-agent': { activation: 'zcode' },
      },
    });
    const deps = makeDeps(client, config, fixture, clock.now);
    const gate = new GateSimulator(client);
    const paths: WorkspacePaths = resolveWorkspace(fixture.projectRoot);
    const A = 60;
    const B = 61;
    const epochA = testEpoch(A);
    const epochB = testEpoch(B);
    const stdout = captureStdout(); // mute activation notices

    try {
      // Issue A reaches ai:ready through the real flow, then is dispatched.
      client.addIssue(A, { title: 'Issue A', labels: ['ai:ready'] });
      client.ensureEpoch(A, epochA);
      const planBodyA = buildPlanCommentBody('# Plan A\n\n- do A', 'gf_r123_i60_consumer_01');
      const planA = client.addComment(A, 'gateflow-driver[bot]', planBodyA);
      const commandA = client.addComment(A, 'octo', `/approve ${planA.id}`);
      client.addGateRecord(A, {
        schema: 2,
        kind: 'approval',
        repository_id: 123,
        issue_number: A,
        workflow_epoch: epochA,
        plan_comment_id: planA.id,
        plan_sha256: planSha256(planBodyA),
        approval_command_comment_id: commandA.id,
        approved_by_id: 9001,
        approved_by_login: 'octo',
        gate_login: 'github-actions[bot]',
        gate_user_id: 41898282,
        created_at: '2026-09-06T12:00:00Z',
        operation_id: `approval:123:${A}:${epochA}:p${planA.id}`,
      });
      const first = await runOnce(deps);
      const executorA = `gf_r123_i${A}_w${epochCode(epochA)!}_executor_p${planA.id}`;
      expect(freshDispatches(first)).toEqual([{ dispatchId: executorA, reason: 'new' }]);
      // T3 already happened between cycles (canonical state moves on).
      client.issues.get(A)!.labels = ['ai:working'];

      // Issue A's agent writes a MALFORMED status; issue B enters planning.
      await atomicWriteText(nodePath.join(paths.outbox, executorA, 'status.json'), '{not json');
      client.addIssue(B, { title: 'Issue B', labels: ['ai:planning'] });
      client.ensureEpoch(B, epochB);

      // One cycle serves both: B dispatches while A is rejected — no cross-talk.
      const second = await runOnce(deps);
      expect(freshDispatches(second)).toEqual([
        { dispatchId: `gf_r123_i${B}_w${epochCode(epochB)!}_consumer_01`, reason: 'new' },
      ]);
      expect(second.synced.map((o) => [o.dispatchId, o.action])).toEqual([[executorA, 'rejected']]);
      expect(second.synced[0]?.detail).toContain('unparseable status.json');
      expect(
        deps.log.lines.some(
          (l) => l.startsWith('warn:') && l.includes('rejected') && l.includes(executorA),
        ),
      ).toBe(true);
      gate.syncAll();
      expect(gate.labels(A)).toEqual(['ai:working']); // untouched by the rejection
      expect(gate.labels(B)).toEqual(['ai:planning']); // dispatch only, no transition
      expect(
        await readInboxDispatch(paths, `gf_r123_i${B}_w${epochCode(epochB)!}_consumer_01`),
      ).not.toBeNull();
      // The zcode executor adapter handled A's dispatch (provider fingerprint).
      expect(stdout.text()).toContain(zcodeSuggestion(executorA));

      // Recovery: A's agent rewrites a valid status → tracker created; B keeps
      // flowing (dedup) without A's earlier failure leaving any damage.
      await writeOutboxStatus(paths, statusFileFor(executorA, 'executor', 'working', clock.iso()));
      const third = await runOnce(deps);
      expect(freshDispatches(third)).toEqual([]);
      expect(third.synced.map((o) => [o.dispatchId, o.action])).toEqual([[executorA, 'tracker-created']]);
      gate.syncAll();
      expect(gate.labels(A)).toEqual(['ai:working']); // T3 precondition already passed
      expect(gate.labels(B)).toEqual(['ai:planning']);
      const trackerA = client.issues.get(A)!.comments.find((c) => detectCommentMarker(c.body) === MARKERS.executionTracker);
      expect(trackerA?.body).toContain('**Status:** In Progress');
      expect((await readReceipt(paths, executorA))?.tracker_comment_id).toBe(trackerA?.id);
      expect(client.commentCount(B)).toBe(1); // only B's epoch record, no content
    } finally {
      stdout.restore();
      await fixture.cleanup();
    }
  });
});
