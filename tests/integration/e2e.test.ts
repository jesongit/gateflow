/**
 * End-to-end integration suite (plan Phase 13): full Driver cycles
 * (runOnce = discovery → dispatch → sync) against the in-memory fake GitHub,
 * with a deterministic Gate simulator replaying the real V1 transition rules
 * (T1-T6) over the comment stream. One complete lifecycle per routing combo
 * proves docs/architecture-v1.md §3 flows 3.1-3.4 AND that Role ≠ Provider:
 * the identical lifecycle passes for every consumer/executor →
 * {chatgpt, zcode} provider permutation, and each dispatch wakes exactly the
 * provider its ROUTING config names (never a role-determined one).
 *
 * Activation capture seam: src/driver/dispatch.ts builds adapters internally
 * via resolveAdapterForAgent — there is no injection point — so activation is
 * observed through process.stdout (the manual banner every adapter delegates
 * to, plus the zcode adapter's provider-specific suggestion line). The strict
 * adapter-kind mapping proof lives at unit level in lifecycle-variants.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { readFile, readdir } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { runOnce } from '../../src/driver/driver';
import { canonicalPlanContent } from '../../src/protocol/plan';
import { epochCode } from '../../src/protocol/epoch';
import { detectCommentMarker } from '../../src/gate/markers';
import { MARKERS } from '../../src/gate/protocol';
import { readCurrent, readInboxDispatch, sha256Hex } from '../../src/workspace/inbox';
import { readReceipt } from '../../src/workspace/outbox';
import { resolveWorkspace } from '../../src/workspace/paths';
import type { WorkspacePaths } from '../../src/workspace/paths';
import { FakeDriverClient, makeDeps, makeWorkspace, testEpoch } from '../driver/helpers';
import {
  GateSimulator,
  auditKind,
  captureStdout,
  completedResult,
  freshDispatches,
  manualBannerLine,
  manualClock,
  planReadyResult,
  statusFileFor,
  writeConfigYaml,
  writeOutboxMarkdown,
  writeOutboxResult,
  writeOutboxStatus,
  zcodeSuggestion,
} from './helpers';
import type { ManualClock, StdoutCapture } from './helpers';

const ISSUE = 101;
/** The deterministic fixture epoch; its code rides inside every dispatch id. */
const EPOCH = testEpoch(ISSUE);
/** Gate record comments (schema 2) are audit entries, not content. */
const RECORD_MARKER = /<!-- gateflow:(workflow|approval|feedback):v2/;
const contentComments = (client: FakeDriverClient, issueNumber: number) =>
  (client.issues.get(issueNumber)?.comments ?? []).filter((c) => !RECORD_MARKER.test(c.body));

type Provider = 'chatgpt' | 'zcode';

interface Combo {
  label: string;
  consumer: Provider;
  executor: Provider;
}

const COMBOS: Combo[] = [
  { label: 'chatgpt consumer + chatgpt executor', consumer: 'chatgpt', executor: 'chatgpt' },
  { label: 'zcode consumer + zcode executor', consumer: 'zcode', executor: 'zcode' },
  { label: 'chatgpt consumer + zcode executor', consumer: 'chatgpt', executor: 'zcode' },
  { label: 'zcode consumer + chatgpt executor', consumer: 'zcode', executor: 'chatgpt' },
];

interface Lifecycle {
  client: FakeDriverClient;
  deps: ReturnType<typeof makeDeps>;
  gate: GateSimulator;
  paths: WorkspacePaths;
  clock: ManualClock;
  stdout: StdoutCapture;
  consumerId(round: number): string;
  cleanup(): Promise<void>;
}

async function startLifecycle(combo: Combo): Promise<Lifecycle> {
  const client = new FakeDriverClient();
  const fixture = await makeWorkspace();
  const clock = manualClock();
  // gateflow.config.yml per combo, parsed through the production loadConfig.
  const config = await writeConfigYaml(fixture.projectRoot, {
    routing: { consumer: `${combo.consumer}-agent`, executor: `${combo.executor}-agent` },
    agents: {
      [`${combo.consumer}-agent`]: { activation: combo.consumer },
      [`${combo.executor}-agent`]: { activation: combo.executor },
    },
  });
  const deps = makeDeps(client, config, fixture, clock.now);
  const stdout = captureStdout();
  client.addIssue(ISSUE, {
    title: 'Build CSV export',
    body: 'Users need CSV export of their data.',
    labels: ['ai:planning'],
  });
  // Schema 2: the issue's workflow epoch (as a Gate/Driver bootstrap record).
  client.ensureEpoch(ISSUE, EPOCH);
  return {
    client,
    deps,
    gate: new GateSimulator(client),
    paths: resolveWorkspace(fixture.projectRoot),
    clock,
    stdout,
    consumerId: (round: number) => `gf_r123_i${ISSUE}_w${epochCode(EPOCH)!}_consumer_0${round}`,
    cleanup: async () => {
      stdout.restore();
      await fixture.cleanup();
    },
  };
}

/** Byte snapshot of a flat inbox directory (old rounds must stay untouched). */
async function snapshotDir(dir: string): Promise<Array<{ name: string; content: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  return Promise.all(
    names.map(async (name) => ({ name, content: await readFile(nodePath.join(dir, name), 'utf8') })),
  );
}

/** The full V1 lifecycle (docs/architecture-v1.md §3.1 → §3.4) for one combo. */
async function exerciseLifecycle(combo: Combo): Promise<void> {
  const ctx = await startLifecycle(combo);
  const { client, deps, gate, paths, clock, stdout } = ctx;
  try {
    const consumer01 = ctx.consumerId(1);

    // -- Step 1+2: seeded ai:planning issue → round-01 consumer dispatch ----
    const first = await runOnce(deps);
    expect(freshDispatches(first)).toEqual([{ dispatchId: consumer01, reason: 'new' }]);
    expect(first.synced).toEqual([]);
    const task01 = await readFile(nodePath.join(paths.inbox, consumer01, 'TASK.md'), 'utf8');
    expect(task01).toContain('# Build CSV export');
    expect(task01).toContain('Users need CSV export of their data.');
    expect(task01).toContain('## Goal');
    expect(task01).toContain('outbox/PLAN.md');
    expect(task01).toContain('result=plan_ready');
    const current01 = await readCurrent(paths);
    expect(current01?.dispatch_id).toBe(consumer01);
    expect(current01?.role).toBe('consumer');
    const receipt01 = await readReceipt(paths, consumer01);
    expect(receipt01?.status).toBe('dispatched');
    expect(receipt01?.attempts).toBe(1);
    const dispatch01 = await readInboxDispatch(paths, consumer01);
    expect(dispatch01?.role).toBe('consumer');
    expect(dispatch01?.reason).toBe('planning');
    expect(dispatch01?.input).toEqual({ task: 'TASK.md', plan: null, feedback: null });
    expect(stdout.text()).toContain(manualBannerLine(consumer01)); // activation fired
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:planning']); // Driver never transitions

    // -- Step 3: agent plans → plan comment → Gate T1 (PLANNING → REVIEW) ---
    const PLAN_V1 = '# Execution Plan v1\n\n1. Model the CSV schema\n2. Implement the exporter';
    await writeOutboxStatus(paths, statusFileFor(consumer01, 'consumer', 'working', clock.iso()));
    await writeOutboxMarkdown(paths, consumer01, 'PLAN.md', PLAN_V1);
    await writeOutboxResult(paths, planReadyResult(consumer01));
    const second = await runOnce(deps);
    expect(freshDispatches(second)).toEqual([]); // consumer_01 deduped, nothing new
    expect(second.synced.map((o) => [o.dispatchId, o.action])).toEqual([
      [consumer01, 'plan-published'],
    ]);
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:review']); // T1 fired
    const afterPlan1 = contentComments(client, ISSUE);
    expect(afterPlan1).toHaveLength(1);
    const plan1 = afterPlan1[0]!;
    expect(plan1.body.startsWith(MARKERS.plan)).toBe(true); // published by the Driver bot
    expect(plan1.body).toContain(`<!-- gateflow:dispatch-id: ${consumer01} -->`);
    expect(plan1.body).toContain('Model the CSV schema');
    expect((await readReceipt(paths, consumer01))?.status).toBe('published');

    // -- Step 4: human /change → round-02 consumer dispatch with FEEDBACK ---
    const round01Before = await snapshotDir(nodePath.join(paths.inbox, consumer01));
    client.addComment(ISSUE, 'octo', '/change 不要使用 SQLite');
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:review']); // /change never migrates
    const third = await runOnce(deps);
    const consumer02 = ctx.consumerId(2);
    expect(freshDispatches(third)).toEqual([{ dispatchId: consumer02, reason: 'new' }]);
    const feedback = await readFile(nodePath.join(paths.inbox, consumer02, 'FEEDBACK.md'), 'utf8');
    expect(feedback).toContain('不要使用 SQLite');
    expect(feedback).toContain('(/change)');
    const dispatch02 = await readInboxDispatch(paths, consumer02);
    expect(dispatch02?.reason).toBe('feedback_applied');
    expect(dispatch02?.input.feedback).toBe('FEEDBACK.md');
    expect((await readCurrent(paths))?.dispatch_id).toBe(consumer02);
    // The round-01 inbox is never rewritten by a later projection.
    expect(await snapshotDir(nodePath.join(paths.inbox, consumer01))).toEqual(round01Before);

    // -- Step 5: re-plan → second plan comment, still REVIEW ----------------
    const PLAN_V2 =
      '# Execution Plan v2\n\n1. Model the CSV schema\n2. Implement the exporter without SQLite';
    await writeOutboxMarkdown(paths, consumer02, 'PLAN.md', PLAN_V2);
    await writeOutboxResult(paths, planReadyResult(consumer02));
    const fourth = await runOnce(deps);
    expect(freshDispatches(fourth)).toEqual([]);
    // consumer01 was already observed `accepted` during the previous cycle
    // (its label was review by then) — the replay guard now skips it.
    expect(fourth.synced.map((o) => [o.dispatchId, o.action])).toEqual([
      [consumer01, 'skipped'],
      [consumer02, 'plan-published'],
    ]);
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:review']); // T1 needs PLANNING: no-op
    const afterPlan2 = contentComments(client, ISSUE);
    expect(afterPlan2).toHaveLength(3); // plan1 + /change + plan2
    const plan2 = afterPlan2[2]!;
    expect(plan2.body.startsWith(MARKERS.plan)).toBe(true);
    expect(plan2.body).toContain(`<!-- gateflow:dispatch-id: ${consumer02} -->`);
    expect(plan2.body).toContain('without SQLite');

    // -- Step 6: /approve → Gate T2 (REVIEW → READY) -------------------------
    // A stale approval (the superseded first plan) must NOT unlock anything:
    // the simulator mirrors the gate — no record, no transition.
    client.addComment(ISSUE, 'octo', `/approve ${plan1.id}`);
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:review']); // not the current plan
    const approval = client.addComment(ISSUE, 'octo', `/approve ${plan2.id}`);
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:ready']); // T2 fired
    // The durable authorization fact is the Gate-issued approval RECORD.
    const approvalRecordId = client
      .issues.get(ISSUE)!
      .comments.filter((c) => RECORD_MARKER.test(c.body) && c.body.includes('gateflow:approval:v2'))
      .at(-1)!.id;
    expect(approvalRecordId).toBeGreaterThan(approval.id);

    // -- Step 7: executor dispatch bound to the approved plan comment -------
    const executorId = `gf_r123_i${ISSUE}_w${epochCode(EPOCH)!}_executor_p${plan2.id}`;
    expect(executorId.endsWith(`_executor_p${plan2.id}`)).toBe(true);
    const fifth = await runOnce(deps);
    expect(freshDispatches(fifth)).toEqual([{ dispatchId: executorId, reason: 'new' }]);
    const inboxPlan = await readFile(nodePath.join(paths.inbox, executorId, 'PLAN.md'), 'utf8');
    expect(inboxPlan).toBe(canonicalPlanContent(plan2.body)); // marker/dispatch-id stripped
    const context = JSON.parse(
      await readFile(nodePath.join(paths.inbox, executorId, 'context.json'), 'utf8'),
    ) as { plan_comment_id?: number; plan_sha256?: string; feedback_count: number };
    expect(context.plan_comment_id).toBe(plan2.id);
    expect(context.plan_sha256).toBe(sha256Hex(inboxPlan)); // tamper-evident anchor
    expect(context.feedback_count).toBe(1);
    const executorDispatch = await readInboxDispatch(paths, executorId);
    expect(executorDispatch?.role).toBe('executor');
    expect(executorDispatch?.reason).toBe('approved_plan');
    expect(executorDispatch?.plan_comment_id).toBe(plan2.id);
    // The dispatch binds the approval RECORD, not the human's command comment.
    expect(executorDispatch?.approval_comment_id).toBe(approvalRecordId);
    expect(executorDispatch?.input.plan).toBe('PLAN.md');
    const taskExec = await readFile(nodePath.join(paths.inbox, executorId, 'TASK.md'), 'utf8');
    expect(taskExec).toContain('## Goal');
    expect(taskExec).toContain('PLAN.md 执行');
    expect(taskExec).toContain('result=completed');
    expect((await readCurrent(paths))?.dispatch_id).toBe(executorId);
    expect((await readCurrent(paths))?.role).toBe('executor');

    // -- Step 8: agent starts → tracker comment → Gate T3 (READY → WORKING) -
    await writeOutboxStatus(paths, statusFileFor(executorId, 'executor', 'working', clock.iso()));
    const sixth = await runOnce(deps);
    expect(sixth.synced.map((o) => [o.dispatchId, o.action])).toEqual([
      [consumer01, 'skipped'], // already accepted in step 5
      [consumer02, 'skipped'], // already accepted in step 7 (review observed)
      [executorId, 'tracker-created'],
    ]);
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:working']); // T3 fired
    const contentSoFar = contentComments(client, ISSUE);
    const tracker = contentSoFar.at(-1)!;
    expect(detectCommentMarker(tracker.body)).toBe(MARKERS.executionTracker);
    expect(tracker.body).toContain(`<!-- gateflow:dispatch-id: ${executorId} -->`);
    expect(tracker.body).toContain('**Status:** In Progress');
    expect((await readReceipt(paths, executorId))?.tracker_comment_id).toBe(tracker.id);

    // -- Step 9: debounced progress edits (one tracker, edited in place) ----
    await writeOutboxMarkdown(paths, executorId, 'PROGRESS.md', 'P1: schema designed');
    clock.advanceSeconds(61); // progress_sync_seconds = 60 (config YAML)
    const seventh = await runOnce(deps);
    expect(seventh.synced.map((o) => [o.dispatchId, o.action])).toEqual([
      [consumer01, 'skipped'],
      [consumer02, 'skipped'],
      [executorId, 'tracker-updated'],
    ]);
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:working']); // progress edit is no transition
    expect(tracker.body).toContain('P1: schema designed');

    await writeOutboxMarkdown(paths, executorId, 'PROGRESS.md', 'P2: exporter implemented');
    clock.advanceSeconds(61);
    const eighth = await runOnce(deps);
    expect(eighth.synced.map((o) => [o.dispatchId, o.action])).toEqual([
      [consumer01, 'skipped'],
      [consumer02, 'skipped'],
      [executorId, 'tracker-updated'],
    ]);
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:working']);
    const trackers = client
      .issues.get(ISSUE)!
      .comments.filter((c) => detectCommentMarker(c.body) === MARKERS.executionTracker);
    expect(trackers).toHaveLength(1); // same comment edited, never duplicated
    expect(trackers[0]?.id).toBe(tracker.id);
    expect(tracker.body).toContain('P2: exporter implemented');
    expect(tracker.body).not.toContain('P1:');

    // -- Step 10: blocked → tracker Status: Blocked → Gate T4 ---------------
    await writeOutboxStatus(paths, statusFileFor(executorId, 'executor', 'blocked', clock.iso(), 'waiting for CSV lib license'));
    const ninth = await runOnce(deps);
    expect(ninth.synced.map((o) => [o.dispatchId, o.action])).toEqual([
      [consumer01, 'skipped'],
      [consumer02, 'skipped'],
      [executorId, 'blocked'],
    ]);
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:blocked']); // T4 fired
    expect(tracker.body).toContain('**Status:** Blocked');
    expect(trackers).toHaveLength(1);

    // -- Step 11: resumed → Status: In Progress → Gate T5 -------------------
    await writeOutboxStatus(paths, statusFileFor(executorId, 'executor', 'working', clock.iso()));
    const tenth = await runOnce(deps);
    expect(tenth.synced.map((o) => [o.dispatchId, o.action])).toEqual([
      [consumer01, 'skipped'],
      [consumer02, 'skipped'],
      [executorId, 'resumed'],
    ]);
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:working']); // T5 fired
    expect(tracker.body).toContain('**Status:** In Progress');
    expect(tracker.body).not.toContain('**Status:** Blocked');

    // -- Step 12: completion report → Gate T6 (WORKING → DONE) --------------
    const REPORT = '# Completion Report\n\n- CSV export implemented\n- validation: all tests green';
    await writeOutboxMarkdown(paths, executorId, 'REPORT.md', REPORT);
    await writeOutboxResult(paths, completedResult(executorId));
    const eleventh = await runOnce(deps);
    expect(eleventh.synced.map((o) => [o.dispatchId, o.action])).toEqual([
      [consumer01, 'skipped'],
      [consumer02, 'skipped'],
      [executorId, 'completed'],
    ]);
    expect((await readReceipt(paths, executorId))?.status).toBe('published');
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(['ai:done']); // T6 fired
    const completion = contentComments(client, ISSUE).at(-1)!;
    expect(completion.body.startsWith(MARKERS.completionReport)).toBe(true);
    expect(completion.body).toContain(`<!-- gateflow:dispatch-id: ${executorId} -->`);
    expect(completion.body).toContain('validation: all tests green');

    // -- Step 13: no-op cycle + full audit trail ----------------------------
    const commentsBefore = [...(client.issues.get(ISSUE)!.comments)];
    const labelsBefore = gate.labels(ISSUE);
    const last = await runOnce(deps);
    expect(freshDispatches(last)).toEqual([]);
    // The executor's published report is now observed accepted (done label).
    expect(last.synced.map((o) => [o.dispatchId, o.action])).toEqual([
      [consumer01, 'skipped'],
      [consumer02, 'skipped'],
      [executorId, 'accepted'],
    ]);
    gate.syncAll();
    expect(gate.labels(ISSUE)).toEqual(labelsBefore);
    expect(client.issues.get(ISSUE)!.comments.map((c) => c.id)).toEqual(
      commentsBefore.map((c) => c.id),
    );

    const comments = client.issues.get(ISSUE)!.comments;
    expect(comments.map((c) => auditKind(c.body))).toEqual([
      'other', // workflow_epoch record (schema 2 bootstrap)
      'plan',
      'human-feedback',
      'other', // feedback_accepted record
      'plan',
      'human-approval', // stale /approve (superseded plan) — no record, no transition
      'human-approval', // current /approve → T2
      'other', // approval record (the durable authorization fact)
      'tracker',
      'completion',
    ]);
    for (let i = 1; i < comments.length; i += 1) {
      expect(comments[i]?.id).toBeGreaterThan(comments[i - 1]?.id ?? 0); // id order
    }
    const plans = comments.filter((c) => detectCommentMarker(c.body) === MARKERS.plan);
    expect(plans.map((p) => p.id)).toEqual([plan1.id, plan2.id]);
    expect(comments.filter((c) => detectCommentMarker(c.body) === MARKERS.executionTracker)).toHaveLength(1);
    expect(comments.filter((c) => detectCommentMarker(c.body) === MARKERS.completionReport)).toHaveLength(1);
    // Round 01's plan was SUPERSEDED (never approved — the human approved
    // plan2 instead), so its receipt truthfully stays `published`, never
    // `accepted`. Round 02's plan2 earned the approval record → accepted.
    expect((await readReceipt(paths, consumer01))?.status).toBe('published');
    expect((await readReceipt(paths, consumer02))?.status).toBe('accepted');

    // -- Role ≠ Provider (E2E): each dispatch woke its ROUTED provider ------
    const out = stdout.text();
    for (const id of [consumer01, consumer02, executorId]) {
      // Every actual dispatch produced exactly one activation notice...
      expect(out.split(manualBannerLine(id))).toHaveLength(2);
      // ...through the provider the ROUTING named for that role:
      const roleProvider = id === executorId ? combo.executor : combo.consumer;
      if (roleProvider === 'zcode') {
        expect(out).toContain(zcodeSuggestion(id)); // zcode adapter fingerprint
      } else {
        expect(out).not.toContain(zcodeSuggestion(id)); // chatgpt path differs
      }
    }
  } finally {
    await ctx.cleanup();
  }
}

describe('E2E lifecycle per routing combo (Role ≠ Provider, architecture §3)', () => {
  it.each(COMBOS)('$label: planning → feedback → approve → execute → done', async (combo) => {
    await exerciseLifecycle(combo);
  });
});
