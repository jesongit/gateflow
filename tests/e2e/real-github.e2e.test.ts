/**
 * V1.1 Phase 11 — Real GitHub E2E (hardening plan §14).
 *
 * Drives the FULL production chain against the REAL GitHub API — the real
 * Gate (runGate over OctokitGitHubClient), the real Driver (discovery →
 * dispatch → sync over the Driver client) and real Agent outbox writes:
 *
 *   Issue → /ai-plan → Epoch (T0) → Consumer Dispatch → Plan (T1)
 *         → /approve → Approval + READY (T2) → Executor Dispatch
 *         → Tracker (T3) → Report (T6, DONE) → receipt `accepted`
 *
 * OPT-IN: this suite is SKIPPED unless both environment variables are set
 * (CI never runs it against production repos; use a dedicated scratch repo):
 *
 *   GATEFLOW_E2E_REPOSITORY=owner/name
 *   GATEFLOW_E2E_TOKEN=ghp_...   (a token of the repository OWNER — the
 *                                 token identity plays the Trusted Human,
 *                                 the Driver and — for this harness — the
 *                                 Gate; a production deployment separates
 *                                 them, the protocol does not care.)
 *
 * Optional: GATEFLOW_E2E_KEEP=1 keeps the issue open for inspection.
 *
 * Run: `GATEFLOW_E2E_REPOSITORY=... GATEFLOW_E2E_TOKEN=... npx vitest run tests/e2e`
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Octokit } from 'octokit';

import { runGate, type GateInput, type GateLogger } from '../../src/gate/gate';
import { createGitHubClient } from '../../src/gate/github';
import { runOnce } from '../../src/driver/driver';
import type { DriverDeps, DriverLogger } from '../../src/driver/driver';
import { createDriverGitHubClient } from '../../src/github/client';
import { readReceipt } from '../../src/workspace/outbox';
import { resolveWorkspace } from '../../src/workspace/paths';
import { loadConfig } from '../../src/driver/config';
import { atomicWriteJson, atomicWriteText } from '../../src/workspace/inbox';
import * as nodePath from 'node:path';

const repository = process.env.GATEFLOW_E2E_REPOSITORY ?? '';
const token = process.env.GATEFLOW_E2E_TOKEN ?? '';
const keep = process.env.GATEFLOW_E2E_KEEP === '1';
const enabled = repository.includes('/') && token.length > 0;

const [ownerName, repoName] = repository.split('/');
const owner = ownerName ?? '';
const repo = repoName ?? '';
const suite = enabled ? describe : describe.skip;

const log: GateLogger & DriverLogger = {
  info: (m) => console.log(`[info] ${m}`),
  warning: (m) => console.log(`[warn] ${m}`),
  error: (m) => console.log(`[error] ${m}`),
};

suite('Real GitHub E2E (V1.1 Phase 11)', () => {
  const octokit = new Octokit({ auth: token });
  const gateClient = createGitHubClient(octokit as unknown as Parameters<typeof createGitHubClient>[0]);
  const driverClient = createDriverGitHubClient(octokit, { owner, repo });

  const projectRoot = process.cwd();
  const paths = resolveWorkspace(projectRoot, '.gateflow-e2e');
  let issueNumber = 0;
  let gateLogin = '';

  afterAll(async () => {
    if (issueNumber > 0 && !keep) {
      await octokit.rest.issues
        .update({ owner, repo, issue_number: issueNumber, state: 'closed' })
        .catch(() => {});
    }
  });

  it('runs the full authorized chain: T0 → T1 → T2 → T3 → T6 → accepted', { timeout: 600_000 }, async () => {
    // -- 0. resolve identities + config -----------------------------------
    const me = await octokit.rest.users.getAuthenticated();
    gateLogin = me.data.login ?? 'unknown';
    expect(gateLogin).not.toBe('unknown');

    const config = await loadConfig(projectRoot, 'gateflow.e2e.config.yml');
    const deps: DriverDeps = { client: driverClient, config, projectRoot, log };

    // -- 1. the issue + the human /ai-plan command -------------------------
    const issue = await octokit.rest.issues.create({
      owner,
      repo,
      title: `[gateflow-e2e] ${new Date().toISOString()}`,
      body: 'Real GitHub E2E (V1.1 Phase 11). Safe to close.',
    });
    issueNumber = issue.data.number;
    const command = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: '/ai-plan',
    });

    const gateEvent = (commentId: number, commentBody: string): GateInput => ({
      eventName: 'issue_comment',
      eventAction: 'created',
      actor: gateLogin,
      actorId: me.data.id ?? 0,
      repositoryId: issue.data.repository?.id ?? 0,
      repoOwner: owner,
      repo,
      issueNumber,
      commentId,
      commentBody,
      trustedHumansInput: gateLogin,
      trustedAgentsInput: gateLogin,
    });

    // -- 2. GATE: T0 (record-first: epoch record BEFORE ai:planning) -------
    await runGate(gateEvent(command.data.id ?? 0, '/ai-plan'), gateClient, log);
    let labels = await gateClient.getLabels({ owner, repo, issueNumber });
    expect(labels).toEqual(['ai:planning']);
    const commentsAfterT0 = await gateClient.listComments({ owner, repo, issueNumber });
    const epochRecord = commentsAfterT0.find((c) => c.body.includes('gateflow:workflow:v2'));
    expect(epochRecord).toBeDefined();
    expect(epochRecord?.body).toContain('"created_by": "gate"');

    // -- 3. DRIVER: discovery → consumer dispatch --------------------------
    const first = await runOnce(deps);
    const consumerId = first.dispatched.find((o) => o.dispatched)?.dispatchId;
    expect(consumerId).toBeDefined();

    // -- 4. AGENT: plan → outbox; DRIVER: sync publishes the plan ----------
    const plan = '# E2E Plan\n\n1. Prove the epoch\n2. Prove the chain';
    await atomicWriteText(nodePath.join(paths.outbox, consumerId!, 'PLAN.md'), plan);
    await atomicWriteJson(nodePath.join(paths.outbox, consumerId!, 'result.json'), {
      schema: 2,
      dispatch_id: consumerId,
      role: 'consumer',
      result: 'plan_ready',
      plan_file: 'PLAN.md',
    });
    const second = await runOnce(deps);
    expect(second.synced.find((o) => o.dispatchId === consumerId)?.action).toBe('plan-published');
    const receiptAfterPlan = await readReceipt(paths, consumerId!);
    expect(receiptAfterPlan?.status).toBe('published');

    // -- 5. GATE: T1 on the plan comment ----------------------------------
    const commentsAfterPlan = await gateClient.listComments({ owner, repo, issueNumber });
    const planComment = commentsAfterPlan
      .filter((c) => c.body.includes('ai-workflow:plan:v1'))
      .at(-1);
    expect(planComment).toBeDefined();
    await runGate(gateEvent(planComment!.id, planComment!.body), gateClient, log);
    labels = await gateClient.getLabels({ owner, repo, issueNumber });
    expect(labels).toEqual(['ai:review']);

    // -- 6. HUMAN: /approve <plan-comment-id>; GATE: T2 --------------------
    const approve = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `/approve ${planComment!.id}`,
    });
    await runGate(
      gateEvent(approve.data.id ?? 0, `/approve ${planComment!.id}`),
      gateClient,
      log,
    );
    labels = await gateClient.getLabels({ owner, repo, issueNumber });
    expect(labels).toEqual(['ai:ready']);

    // -- 7. DRIVER: executor dispatch (approval-record gated) --------------
    const third = await runOnce(deps);
    const executorId = third.dispatched.find((o) => o.dispatched)?.dispatchId;
    expect(executorId).toBeDefined();
    expect(executorId).toContain('_executor_p');

    // -- 8. AGENT + DRIVER: tracker (T3) → report (T6) → accepted ----------
    await atomicWriteText(nodePath.join(paths.outbox, executorId!, 'PROGRESS.md'), 'working…');
    await atomicWriteJson(nodePath.join(paths.outbox, executorId!, 'status.json'), {
      schema: 2,
      dispatch_id: executorId,
      role: 'executor',
      state: 'working',
      updated_at: new Date().toISOString(),
    });
    const fourth = await runOnce(deps);
    expect(fourth.synced.find((o) => o.dispatchId === executorId)?.action).toBe('tracker-created');

    // GATE: T3 on the tracker comment.
    const commentsAfterTracker = await gateClient.listComments({ owner, repo, issueNumber });
    const trackerComment = commentsAfterTracker
      .filter((c) => c.body.includes('ai-workflow:execution-tracker:v1'))
      .at(-1);
    expect(trackerComment).toBeDefined();
    await runGate(gateEvent(trackerComment!.id, trackerComment!.body), gateClient, log);
    labels = await gateClient.getLabels({ owner, repo, issueNumber });
    expect(labels).toEqual(['ai:working']);

    // AGENT: report; DRIVER: publishes it.
    await atomicWriteText(nodePath.join(paths.outbox, executorId!, 'REPORT.md'), 'Done: chain proven.');
    await atomicWriteJson(nodePath.join(paths.outbox, executorId!, 'result.json'), {
      schema: 2,
      dispatch_id: executorId,
      role: 'executor',
      result: 'completed',
      report_file: 'REPORT.md',
      validation: 'passed',
    });
    const fifth = await runOnce(deps);
    expect(fifth.synced.find((o) => o.dispatchId === executorId)?.action).toBe('completed');

    // GATE: T6 on the report comment (WORKING → DONE).
    const commentsAfterReport = await gateClient.listComments({ owner, repo, issueNumber });
    const reportComment = commentsAfterReport
      .filter((c) => c.body.includes('ai-workflow:completion-report:v1'))
      .at(-1);
    expect(reportComment).toBeDefined();
    await runGate(gateEvent(reportComment!.id, reportComment!.body), gateClient, log);
    labels = await gateClient.getLabels({ owner, repo, issueNumber });
    expect(labels).toEqual(['ai:done']);

    // DRIVER: the receipt advances to `accepted` ONLY through the V1.1
    // gate_transition record (epoch + dispatch + T6 + THIS report comment).
    const sixth = await runOnce(deps);
    expect(sixth.synced.find((o) => o.dispatchId === executorId)?.action).toBe('accepted');
    const receipt = await readReceipt(paths, executorId!);
    expect(receipt?.status).toBe('accepted');
  });
});
