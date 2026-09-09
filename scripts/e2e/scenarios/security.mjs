#!/usr/bin/env node
/**
 * Small security smoke layer for Release E2E.
 *
 * Normal workflow state is never manufactured here. The four cases are
 * delegated to the real GitHub workflow when the harness supplies a case
 * runner. In environments where a safe isolated remote cannot be used, the
 * same assertions can be run by the integration fixture seam; the returned
 * result records that limitation explicitly instead of calling it a remote
 * pass.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { waitFor } from '../wait.mjs';
import { runFakeAgent } from '../fake-agent.mjs';
import {
  issueComments as workflowIssueComments,
  issueView as workflowIssueView,
  runWorkflowScenario,
} from './workflow.mjs';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OBSERVATION_MS = 30_000;

function valueOf(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.stdout === 'string') return value.stdout;
    if (typeof value.output === 'string') return value.output;
  }
  return value;
}

function jsonOf(value, label) {
  const result = valueOf(value);
  if (result !== null && typeof result === 'object') return result;
  if (typeof result !== 'string') throw new Error(`[security] ${label} did not return JSON`);
  try {
    return JSON.parse(result);
  } catch (error) {
    throw new Error(`[security] ${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function commandOptions(context, options = {}) {
  return {
    ...options,
    timeoutMs: options.timeoutMs ?? context.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: {
      ...process.env,
      ...(context.env ?? {}),
      ...(context.githubToken ? { GITHUB_TOKEN: context.githubToken } : {}),
      ...(options.env ?? {}),
    },
  };
}

async function command(context, executable, args, options = {}) {
  const resolved = commandOptions(context, options);
  if (typeof context.runCommand === 'function') return context.runCommand(executable, args, resolved);
  if (typeof context.exec === 'function') return context.exec(executable, args, resolved);
  if (typeof context.runProcess === 'function') return context.runProcess(executable, args, resolved);
  if (typeof context.run === 'function') return context.run(executable, args, resolved);
  throw new Error(`[security] E2E context cannot execute ${executable}`);
}

async function gh(context, args, options = {}) {
  const resolved = commandOptions(context, options);
  if (typeof context.gh?.json === 'function') return context.gh.json(args, resolved);
  if (typeof context.gh?.run === 'function') return context.gh.run(args, resolved);
  if (typeof context.gh === 'function') return context.gh(args, resolved);
  if (typeof context.runGh === 'function') return context.runGh(args, resolved);
  return command(context, process.platform === 'win32' ? 'gh.cmd' : 'gh', args, resolved);
}

async function driver(context, workspace, args) {
  const options = commandOptions(context, { cwd: workspace });
  if (typeof context.driver === 'function') return context.driver(args, options);
  if (typeof context.runDriver === 'function') return context.runDriver(args, options);
  const cli = context.driverCli ?? path.resolve(context.root ?? workspace, 'dist', 'cli.js');
  return command(context, process.execPath, [cli, ...args], options);
}

async function waitUntil(context, description, check, options = {}) {
  const timeoutMs = options.timeoutMs ?? context.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? context.options?.pollIntervalMs ?? 2_000;
  if (typeof context.waitFor === 'function') {
    return context.waitFor({ description, timeoutMs, intervalMs, check });
  }
  return waitFor(description, check, { timeoutMs, intervalMs });
}

export const SECURITY_CASES = Object.freeze([
  {
    id: 'wrong-approval',
    description: 'a non-existent Plan comment id must not move an Issue to ai:ready',
    expected: { labelsExclude: 'ai:ready' },
  },
  {
    id: 'old-plan-approval',
    description: 'approval of a superseded Plan must be rejected',
    expected: { labelsExclude: 'ai:ready' },
  },
  {
    id: 'old-report',
    description: 'a Report bound to an old execution task must not complete the current task',
    expected: { labelsExclude: 'ai:done' },
  },
  {
    id: 'fake-ready',
    description: 'a READY label without a valid Approval must not prepare an execute task',
    expected: { noExecuteTask: true },
  },
]);

const FIXTURE_DIR = new URL('../fixtures/security/', import.meta.url);

function caseDefinition(id) {
  const definition = SECURITY_CASES.find((item) => item.id === id);
  if (!definition) throw new Error(`[security] unknown smoke case: ${id}`);
  return definition;
}

function providedRunner(context, id) {
  const security = context?.security;
  if (security && typeof security[id] === 'function') return security[id];
  if (security && typeof security.runCase === 'function') return (ctx) => security.runCase(id, ctx);
  if (context?.securityCases && typeof context.securityCases[id] === 'function') return context.securityCases[id];
  if (typeof context?.runSecurityCase === 'function') return (ctx) => context.runSecurityCase(id, ctx);
  if (context?.integration?.security && typeof context.integration.security[id] === 'function') {
    return context.integration.security[id];
  }
  return null;
}

async function readFixture(id) {
  const path = new URL(`${id}.json`, FIXTURE_DIR);
  return JSON.parse(await readFile(path, 'utf8'));
}

// Both scenarios use the workflow reader so every protocol comment has the
// numeric REST database id required by /approve and record parsing.
const issueView = workflowIssueView;

async function readIssueLabels(context, repository, issueNumber) {
  return (await issueView(context, repository, issueNumber)).labels;
}

function repositoryOf(context) {
  const raw = context?.targetRepository ?? context?.controlRepository ?? context?.repository ?? context?.repo;
  const candidate = typeof raw === 'object' && raw !== null
    ? raw.fullName ?? raw.nameWithOwner
    : raw;
  return typeof candidate === 'string' && /^[^/\s]+\/[^/\s]+$/.test(candidate) ? candidate : null;
}

function workspaceOf(context) {
  const candidate = context.targetWorkspace
    ?? context.controlWorkspace
    ?? context.reconnected?.targetDir
    ?? context.reconnected?.targetWorkspace
    ?? context.paths?.clone
    ?? context.repositoryRoot
    ?? context.root;
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  return path.resolve(candidate);
}

async function createIssue(context, repository, title, body) {
  const raw = await gh(context, [
    'api', `repos/${repository}/issues`, '--method', 'POST',
    '-f', `title=${title}`, '-f', `body=${body}`,
  ], { cwd: context.root });
  const issue = jsonOf(raw, 'GitHub Issue creation');
  const number = Number(issue.number);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`[security] GitHub Issue creation returned no number: ${JSON.stringify(issue)}`);
  }
  return { ...issue, number };
}

async function addComment(context, repository, issueNumber, body) {
  const raw = await gh(context, [
    'api', `repos/${repository}/issues/${issueNumber}/comments`, '--method', 'POST',
    '-f', `body=${body}`,
  ], { cwd: context.root });
  const comment = jsonOf(raw, 'GitHub Issue comment');
  const id = Number(comment.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`[security] GitHub comment response returned no id: ${JSON.stringify(comment)}`);
  }
  return { ...comment, id, body };
}

async function closeIssue(context, repository, issueNumber) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return;
  try {
    await gh(context, [
      'api', `repos/${repository}/issues/${issueNumber}`, '--method', 'PATCH', '-f', 'state=closed',
    ], { cwd: context.root });
  } catch {
    // Cleanup is best effort; a cleanup failure must not turn a security
    // assertion into an unexamined pass or hide its original error.
  }
}

function taskIdFromDriverResult(raw) {
  const result = valueOf(raw);
  if (result && typeof result === 'object') {
    const direct = result.taskId ?? result.task_id;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    if (typeof result.stdout === 'string') return taskIdFromDriverResult(result.stdout);
  }
  const match = /(?:^|\n)task:\s*(\S+)/.exec(String(result ?? ''));
  if (!match?.[1]) throw new Error(`[security] Driver did not report a task id: ${JSON.stringify(result)}`);
  return match[1];
}

function driverAction(raw, action) {
  const result = valueOf(raw);
  if (result && typeof result === 'object' && Array.isArray(result.outcomes)) {
    return result.outcomes.some((outcome) => outcome?.action === action);
  }
  return typeof result === 'string' && result.includes(`: ${action} `);
}

async function loadProtocol(context) {
  const supplied = context.protocol ?? {};
  const suppliedMarkers = supplied.MARKERS ?? supplied.markers;
  if (suppliedMarkers?.plan && typeof supplied.parseRecord === 'function') {
    return { markers: suppliedMarkers, parseRecord: supplied.parseRecord };
  }
  const root = context.root ?? context.repositoryRoot;
  if (typeof root !== 'string' || root.length === 0) return null;
  try {
    const { build } = await import('esbuild');
    const bundle = await build({
      stdin: {
        sourcefile: 'gateflow-security-protocol-entry.ts',
        resolveDir: root,
        contents: [
          "export { MARKERS } from './src/gate/protocol.ts';",
          "export { parseRecord } from './src/protocol/records.ts';",
        ].join('\n'),
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      write: false,
      logLevel: 'silent',
    });
    const output = bundle.outputFiles?.[0]?.text;
    if (typeof output !== 'string' || output.length === 0) return null;
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(output, 'utf8').toString('base64')}`);
    if (!runtime.MARKERS?.plan || typeof runtime.parseRecord !== 'function') return null;
    return { markers: runtime.MARKERS, parseRecord: runtime.parseRecord };
  } catch {
    return null;
  }
}

function recordsOf(issue, kind, protocol) {
  if (!protocol) return [];
  const records = [];
  for (const comment of issue.comments) {
    const parsed = protocol.parseRecord(comment.id, comment.body);
    if (parsed?.ok && parsed.record?.kind === kind) records.push({ comment, record: parsed.record });
  }
  return records;
}

function findRecord(issue, kind, protocol) {
  return recordsOf(issue, kind, protocol).at(-1) ?? null;
}

function planMarkerOf(protocol) {
  return protocol?.markers?.plan;
}

function ownsLine(body, marker) {
  return body.split(/\r?\n/).some((line) => line.trim() === marker);
}

function findPlan(issue, taskId, protocol) {
  return findBoundComment(issue, planMarkerOf(protocol), taskId);
}

function findBoundComment(issue, marker, taskId) {
  if (typeof marker !== 'string' || marker.length === 0) return null;
  const dispatch = `gateflow:dispatch-id: ${taskId}`;
  return issue.comments.find((comment) =>
    ownsLine(comment.body, marker) && comment.body.includes(dispatch)) ?? null;
}

async function waitForPlanning(context, repository, issueNumber, protocol) {
  return waitUntil(context, `security Issue #${issueNumber} to enter planning`, async () => {
    const issue = await issueView(context, repository, issueNumber);
    const epoch = findRecord(issue, 'workflow_epoch', protocol);
    return issue.labels.includes('ai:planning') && (protocol === null || epoch !== null)
      ? { issue, epoch }
      : false;
  });
}

async function waitForPlan(context, repository, issueNumber, taskId, protocol, description) {
  return waitUntil(context, description, async () => {
    const issue = await issueView(context, repository, issueNumber);
    const plan = findPlan(issue, taskId, protocol);
    return issue.labels.includes('ai:review') && plan ? { issue, plan } : false;
  });
}

async function observeStablePhase(context, repository, issueNumber, allowedLabels, forbiddenLabel, description) {
  const timeoutMs = Math.min(context.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_OBSERVATION_MS);
  const intervalMs = context.options?.pollIntervalMs ?? 2_000;
  const started = Date.now();
  let lastIssue = null;
  while (Date.now() - started < timeoutMs) {
    const issue = await issueView(context, repository, issueNumber);
    lastIssue = issue;
    if (issue.labels.includes(forbiddenLabel)) {
      throw new Error(`[security] ${description} reached ${forbiddenLabel}`);
    }
    if (!allowedLabels.some((label) => issue.labels.includes(label))) {
      throw new Error(`[security] ${description} left the expected phase: ${issue.labels.join(', ') || '(none)'}`);
    }
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  if (!lastIssue || lastIssue.labels.includes(forbiddenLabel) ||
      !allowedLabels.some((label) => lastIssue.labels.includes(label))) {
    throw new Error(`[security] ${description} did not remain in the expected phase after timeout`);
  }
  return { issue: lastIssue, waitedMs: Date.now() - started, timeoutMs };
}

async function realWrongApproval(context) {
  const repository = repositoryOf(context);
  if (!repository || !context?.gh) return null;

  const created = jsonOf(await gh(context, [
    'api', `repos/${repository}/issues`,
    '--method', 'POST',
    '-f', 'title=GateFlow security smoke: wrong approval',
    '-f', 'body=Release E2E security smoke; no production changes are requested.',
  ], { cwd: context.root }), 'wrong-approval Issue creation');
  const issueNumber = Number(created?.number);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new Error('[security] GitHub did not return the wrong-approval Issue number');
  }
  await gh(context, [
    'api', `repos/${repository}/issues/${issueNumber}/comments`,
    '--method', 'POST', '-f', 'body=/ai-plan',
  ], { cwd: context.root });
  const planning = await waitUntil(context, 'security Issue to enter planning/review', async () => {
    const labels = await readIssueLabels(context, repository, issueNumber);
    return labels.includes('ai:planning') || labels.includes('ai:review') ? labels : false;
  }, {
    timeoutMs: context.options?.timeoutMs ?? 10 * 60 * 1000,
    intervalMs: context.options?.pollIntervalMs ?? 2_000,
  });
  await gh(context, [
    'api', `repos/${repository}/issues/${issueNumber}/comments`,
    '--method', 'POST', '-f', 'body=/approve 999999999',
  ], { cwd: context.root });
  // Do not return success on the first non-READY read: that can race the
  // Actions run. Observe the Issue for the complete bounded interval, then
  // assert that it never reached READY.
  const timeoutMs = Math.min(context.options?.timeoutMs ?? 10 * 60 * 1000, 30_000);
  const intervalMs = context.options?.pollIntervalMs ?? 2_000;
  const started = Date.now();
  let checked = null;
  while (Date.now() - started < timeoutMs) {
    const labels = await readIssueLabels(context, repository, issueNumber);
    checked = { labels };
    if (labels.includes('ai:ready')) {
      throw new Error('[security] wrong approval unexpectedly moved the Issue to ai:ready');
    }
    if (!labels.includes('ai:planning') && !labels.includes('ai:review')) {
      throw new Error(`[security] wrong approval observation left ai:planning/ai:review: ${labels.join(', ') || '(none)'}`);
    }
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  const waitedMs = Date.now() - started;
  if (!checked
    || checked.labels.includes('ai:ready')
    || (!checked.labels.includes('ai:planning') && !checked.labels.includes('ai:review'))) {
    throw new Error('[security] wrong approval reached ai:ready after the observation timeout');
  }
  return { status: 'passed', issueNumber, labels: checked.labels, planningLabels: planning, waitedMs, timeoutMs };
}

function workflowDriverArgs(repository, workspace, issueNumber) {
  return [
    'run', '--issue', String(issueNumber), '--root', workspace,
    '--target-repository', repository, '--target-workspace', workspace,
  ];
}

async function realOldPlanApproval(context) {
  const repository = repositoryOf(context);
  const workspace = workspaceOf(context);
  if (!repository || !workspace || !context?.gh) return null;

  const protocol = await loadProtocol(context);
  if (!protocol) return null;

  let issueNumber = null;
  try {
    const issue = await createIssue(
      context,
      repository,
      'GateFlow security smoke: superseded Plan approval',
      'Security smoke: verify that an approval for Plan A cannot authorize superseded Plan B.',
    );
    issueNumber = issue.number;
    await addComment(context, repository, issueNumber, '/ai-plan');
    const planned = await waitForPlanning(context, repository, issueNumber, protocol);
    const epoch = planned.epoch;
    if (!epoch) throw new Error('[security] old-plan Issue reached planning without a workflow epoch');

    const planRunA = await driver(context, workspace, workflowDriverArgs(repository, workspace, issueNumber));
    const planTaskA = taskIdFromDriverResult(planRunA);
    const planContent = await readFile(new URL('../fixtures/plan.md', import.meta.url), 'utf8');
    const planAgentA = await runFakeAgent(context, {
      taskId: planTaskA,
      workspaceRoot: workspace,
      planContent,
    });
    const planSyncA = await driver(context, workspace, ['sync', '--root', workspace]);
    if (!driverAction(planSyncA, 'plan-published')) {
      throw new Error('[security] old-plan Plan A sync did not publish a plan');
    }
    const reviewedA = await waitForPlan(
      context,
      repository,
      issueNumber,
      planTaskA,
      protocol,
      'old-plan Issue Plan A to enter review',
    );

    const changeCommand = await addComment(context, repository, issueNumber, '/change revise the plan for security smoke');
    const feedback = await waitUntil(context, 'old-plan accepted feedback record', async () => {
      const current = await issueView(context, repository, issueNumber);
      const accepted = recordsOf(current, 'feedback_accepted', protocol)
        .find((entry) => entry.record.feedback_comment_id === changeCommand.id);
      return accepted ? { issue: current, record: accepted } : false;
    });

    const planRunB = await driver(context, workspace, workflowDriverArgs(repository, workspace, issueNumber));
    const planTaskB = taskIdFromDriverResult(planRunB);
    if (planTaskA === planTaskB) throw new Error('[security] /change did not produce a new Plan task');
    const planAgentB = await runFakeAgent(context, {
      taskId: planTaskB,
      workspaceRoot: workspace,
      planContent: `${planContent.trimEnd()}\n\nSecurity smoke revision B.\n`,
    });
    const planSyncB = await driver(context, workspace, ['sync', '--root', workspace]);
    if (!driverAction(planSyncB, 'plan-published')) {
      throw new Error('[security] old-plan Plan B sync did not publish a plan');
    }
    const reviewedB = await waitForPlan(
      context,
      repository,
      issueNumber,
      planTaskB,
      protocol,
      'old-plan Issue Plan B to enter review',
    );

    const oldApprovalCommand = await addComment(
      context,
      repository,
      issueNumber,
      `/approve ${reviewedA.plan.id}`,
    );
    const afterOldApproval = await observeStablePhase(
      context,
      repository,
      issueNumber,
      ['ai:review'],
      'ai:ready',
      'old Plan approval',
    );
    const oldApprovalRecords = recordsOf(afterOldApproval.issue, 'approval', protocol)
      .filter((entry) => entry.record.plan_comment_id === reviewedA.plan.id);
    if (oldApprovalRecords.length > 0) {
      throw new Error('[security] superseded Plan A received a Gate approval record');
    }

    const currentPlan = findPlan(afterOldApproval.issue, planTaskB, protocol);
    if (!currentPlan || currentPlan.id !== reviewedB.plan.id) {
      throw new Error('[security] current Plan B binding was not preserved after rejecting Plan A');
    }
    const newApprovalCommand = await addComment(
      context,
      repository,
      issueNumber,
      `/approve ${reviewedB.plan.id}`,
    );
    const ready = await waitUntil(context, 'old-plan Issue to enter ready with Plan B approval', async () => {
      const current = await issueView(context, repository, issueNumber);
      if (!current.labels.includes('ai:ready')) return false;
      const approval = recordsOf(current, 'approval', protocol)
        .find((entry) => entry.record.plan_comment_id === reviewedB.plan.id &&
          entry.record.approval_command_comment_id === newApprovalCommand.id);
      return approval ? { issue: current, approval } : false;
    });
    const approvalRecord = ready.approval.record;
    if (approvalRecord.issue_number !== issueNumber || approvalRecord.workflow_epoch !== epoch.record.workflow_epoch) {
      throw new Error('[security] Plan B approval record is not bound to the security Issue epoch');
    }
    return {
      status: 'passed',
      mode: 'real-github',
      issueNumber,
      epoch: epoch.record,
      feedback: { command: changeCommand, record: feedback.record },
      plans: {
        a: { taskId: planTaskA, task: planAgentA.task, comment: reviewedA.plan, sync: planSyncA },
        b: { taskId: planTaskB, task: planAgentB.task, comment: reviewedB.plan, sync: planSyncB },
      },
      approvals: {
        old: { command: oldApprovalCommand, rejected: true },
        current: { command: newApprovalCommand, record: approvalRecord },
      },
      observedAfterOldApproval: {
        labels: afterOldApproval.issue.labels,
        waitedMs: afterOldApproval.waitedMs,
        timeoutMs: afterOldApproval.timeoutMs,
      },
      finalLabels: ready.issue.labels,
    };
  } finally {
    await closeIssue(context, repository, issueNumber);
  }
}

async function taskFilesForIssue(workspace, issueNumber) {
  const tasksRoot = path.join(workspace, '.gateflow', 'tasks');
  let entries;
  try {
    entries = await readdir(tasksRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const task = JSON.parse(await readFile(path.join(tasksRoot, entry.name, 'task.json'), 'utf8'));
      if (Number(task.issue_number) === issueNumber) tasks.push(task);
    } catch {
      // Ignore unrelated/incomplete task directories; the Driver itself owns
      // their validation. A valid execute task for this Issue is never ignored.
    }
  }
  return tasks;
}

async function realFakeReady(context) {
  const repository = repositoryOf(context);
  const workspace = workspaceOf(context);
  if (!repository || !workspace || !context?.gh) return null;

  let issueNumber = null;
  try {
    const issue = await createIssue(
      context,
      repository,
      'GateFlow security smoke: fake READY',
      'Security smoke: READY is not a substitute for a Gate-issued Approval.',
    );
    issueNumber = issue.number;
    await gh(context, [
      'api', `repos/${repository}/issues/${issueNumber}/labels`, '--method', 'POST',
      '-f', 'labels[]=ai:ready',
    ], { cwd: context.root });
    const ready = await waitUntil(context, 'fake-ready Issue to receive the manual ai:ready label', async () => {
      const current = await issueView(context, repository, issueNumber);
      return current.labels.includes('ai:ready') ? current : false;
    });
    const driverRun = await driver(context, workspace, workflowDriverArgs(repository, workspace, issueNumber));
    const tasks = await taskFilesForIssue(workspace, issueNumber);
    const executeTasks = tasks.filter((task) => task.mode === 'execute');
    if (executeTasks.length > 0) {
      throw new Error(`[security] fake READY produced execute task(s): ${executeTasks.map((task) => task.task_id).join(', ')}`);
    }
    return {
      status: 'passed',
      mode: 'real-github',
      issueNumber,
      labels: ready.labels,
      driver: driverRun,
      tasks,
      executeTasks,
    };
  } finally {
    await closeIssue(context, repository, issueNumber);
  }
}

async function readTaskMetadata(workspace, taskId) {
  const taskPath = path.join(workspace, '.gateflow', 'tasks', taskId, 'task.json');
  try {
    return JSON.parse(await readFile(taskPath, 'utf8'));
  } catch (error) {
    throw new Error(`[security] cannot read Driver task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertExecuteBinding(task, expected) {
  const checks = {
    task_id: task?.task_id === expected.taskId,
    mode: task?.mode === 'execute',
    issue_number: Number(task?.issue_number) === expected.issueNumber,
    workflow_epoch: task?.workflow_epoch === expected.workflowEpoch,
    plan_comment_id: Number(task?.plan_comment_id) === expected.planCommentId,
    approval_comment_id: Number(task?.approval_comment_id) === expected.approvalCommentId,
    target_repository: task?.target_repository === expected.repository,
    target_workspace: path.resolve(task?.target_workspace ?? '') === path.resolve(expected.workspace),
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([field]) => field);
  if (failed.length > 0) {
    throw new Error(`[security] execute task binding mismatch in ${failed.join(', ')}: ${JSON.stringify({ task, expected })}`);
  }
}

async function prepareCurrentExecute(context, repository, workspace, protocol) {
  const issue = await createIssue(
    context,
    repository,
    'GateFlow security smoke: current Report binding',
    'Security smoke: only the current execute task may complete this Issue.',
  );
  const issueNumber = issue.number;
  await addComment(context, repository, issueNumber, '/ai-plan');
  const planned = await waitForPlanning(context, repository, issueNumber, protocol);
  if (!planned.epoch) throw new Error('[security] current-report Issue has no workflow epoch');

  const planRun = await driver(context, workspace, workflowDriverArgs(repository, workspace, issueNumber));
  const planTaskId = taskIdFromDriverResult(planRun);
  const planContent = await readFile(new URL('../fixtures/plan.md', import.meta.url), 'utf8');
  await runFakeAgent(context, { taskId: planTaskId, workspaceRoot: workspace, planContent });
  const planSync = await driver(context, workspace, ['sync', '--root', workspace]);
  if (!driverAction(planSync, 'plan-published')) throw new Error('[security] current-report Plan sync did not publish');
  const reviewed = await waitForPlan(
    context, repository, issueNumber, planTaskId, protocol, 'current-report Issue to enter review',
  );

  const approvalCommand = await addComment(context, repository, issueNumber, `/approve ${reviewed.plan.id}`);
  const ready = await waitUntil(context, 'current-report Issue to enter ready', async () => {
    const current = await issueView(context, repository, issueNumber);
    const approval = recordsOf(current, 'approval', protocol).find((entry) =>
      entry.record.workflow_epoch === planned.epoch.record.workflow_epoch &&
      entry.record.plan_comment_id === reviewed.plan.id &&
      entry.record.approval_command_comment_id === approvalCommand.id);
    return current.labels.includes('ai:ready') && approval ? { issue: current, approval } : false;
  });

  const executeRun = await driver(context, workspace, workflowDriverArgs(repository, workspace, issueNumber));
  const executeTaskId = taskIdFromDriverResult(executeRun);
  const executeTask = await readTaskMetadata(workspace, executeTaskId);
  assertExecuteBinding(executeTask, {
    taskId: executeTaskId,
    issueNumber,
    workflowEpoch: planned.epoch.record.workflow_epoch,
    planCommentId: reviewed.plan.id,
    approvalCommentId: approvalCommand.id,
    repository,
    workspace,
  });

  const relativeFile = `.gateflow-security-current-${issueNumber}.txt`;
  await writeFile(path.join(workspace, relativeFile), '', 'utf8');
  const mutation = { type: 'append-line', path: relativeFile, line: 'current' };
  const workingAgent = await runFakeAgent(context, {
    taskId: executeTaskId,
    workspaceRoot: workspace,
    phase: 'working',
    mutation,
    baseContent: '',
  });
  const trackerSync = await driver(context, workspace, ['sync', '--root', workspace]);
  if (!driverAction(trackerSync, 'tracker-created')) throw new Error('[security] current execute Tracker sync did not publish');
  const working = await waitUntil(context, 'current-report Issue to enter working', async () => {
    const current = await issueView(context, repository, issueNumber);
    const tracker = findBoundComment(current, protocol.markers.executionTracker, executeTaskId);
    return current.labels.includes('ai:working') && tracker ? { issue: current, tracker } : false;
  });
  return {
    issue: { ...issue, number: issueNumber },
    epoch: planned.epoch.record,
    plan: { taskId: planTaskId, comment: reviewed.plan, sync: planSync },
    approval: { command: approvalCommand, record: ready.approval.record },
    execute: { taskId: executeTaskId, task: executeTask, tracker: working.tracker, sync: trackerSync },
    mutation,
    workingIssue: working.issue,
    workingAgent,
  };
}

async function realOldReport(context) {
  const repository = repositoryOf(context);
  const workspace = workspaceOf(context);
  if (!repository || !workspace || !context?.gh) return null;
  const protocol = await loadProtocol(context);
  if (!protocol) return null;

  let currentIssueNumber = null;
  let oldIssueNumber = null;
  try {
    const oldRelativeFile = `.gateflow-security-old-${Date.now()}.txt`;
    await writeFile(path.join(workspace, oldRelativeFile), '', 'utf8');
    const oldResult = await runWorkflowScenario({
      ...context,
      controlRepository: repository,
      controlWorkspace: workspace,
      targetRepository: repository,
      targetWorkspace: workspace,
    }, {
      title: 'GateFlow security smoke: completed old task',
      body: 'Security smoke source Issue; its completed Report must not complete another Issue.',
      mutation: { type: 'append-line', path: oldRelativeFile, line: 'old' },
      helloContent: 'old\n',
      expectedFile: { path: oldRelativeFile, content: 'old\n' },
    });
    oldIssueNumber = Number(oldResult.issue?.number);
    const oldTaskId = oldResult.execute?.taskId;
    const oldReport = oldResult.execute?.report;
    const oldEpoch = oldResult.epoch?.workflow_epoch;
    if (!Number.isSafeInteger(oldIssueNumber) || oldIssueNumber < 1 ||
        typeof oldTaskId !== 'string' || typeof oldReport?.body !== 'string' ||
        typeof oldEpoch !== 'string') {
      throw new Error('[security] completed old workflow returned incomplete Issue/task/report/epoch binding');
    }
    if (!oldReport.body.includes(`gateflow:dispatch-id: ${oldTaskId}`)) {
      throw new Error('[security] old Report is not bound to the completed old task');
    }

    const current = await prepareCurrentExecute(context, repository, workspace, protocol);
    currentIssueNumber = current.issue.number;
    if (currentIssueNumber === oldIssueNumber) throw new Error('[security] old and current Issue bindings unexpectedly match');
    const currentTaskId = current.execute.taskId;
    if (oldTaskId === currentTaskId || oldResult.issue?.number === current.issue.number) {
      throw new Error('[security] old and current execute task bindings unexpectedly match');
    }

    const staleReport = await addComment(context, repository, currentIssueNumber, oldReport.body);
    const staleObserved = await waitUntil(context, 'stale Report comment to be visible on current Issue', async () => {
      const issue = await issueView(context, repository, currentIssueNumber);
      const comment = issue.comments.find((entry) => entry.id === staleReport.id && entry.body === oldReport.body);
      return comment && issue.labels.includes('ai:working') ? { issue, comment } : false;
    });
    const staleStability = await observeStablePhase(
      context,
      repository,
      currentIssueNumber,
      ['ai:working'],
      'ai:done',
      'stale old-task Report',
    );
    const reportContent = await readFile(new URL('../fixtures/report.md', import.meta.url), 'utf8');
    await runFakeAgent(context, {
      taskId: currentTaskId,
      workspaceRoot: workspace,
      phase: 'completed',
      skipTargetChange: true,
      reportContent,
    });
    const currentReportSync = await driver(context, workspace, ['sync', '--root', workspace]);
    if (!driverAction(currentReportSync, 'completed')) {
      throw new Error('[security] current task Report sync did not complete');
    }
    const done = await waitUntil(context, 'current Issue to enter done from current Report', async () => {
      const issue = await issueView(context, repository, currentIssueNumber);
      const report = findBoundComment(issue, protocol.markers.completionReport, currentTaskId);
      return issue.labels.includes('ai:done') && report ? { issue, report } : false;
    });
    if (!done.issue.comments.some((comment) => comment.id === staleReport.id && comment.body === oldReport.body)) {
      throw new Error('[security] stale Report disappeared from the current Issue history');
    }
    return {
      status: 'passed',
      mode: 'real-github',
      old: {
        issueNumber: oldIssueNumber,
        epoch: oldEpoch,
        taskId: oldTaskId,
        reportComment: { id: oldReport.id, body: oldReport.body },
      },
      current: {
        issueNumber: currentIssueNumber,
        epoch: current.epoch,
        taskId: currentTaskId,
        planCommentId: current.plan.comment.id,
        approvalCommentId: current.approval.command.id,
        trackerCommentId: current.execute.tracker.id,
        staleReportCommentId: staleReport.id,
        staleObservedIssue: staleObserved.issue,
        staleStability: { labels: staleStability.issue.labels, waitedMs: staleStability.waitedMs, timeoutMs: staleStability.timeoutMs },
        currentReportCommentId: done.report.id,
        finalLabels: done.issue.labels,
      },
      currentReportSync,
    };
  } finally {
    await closeIssue(context, repository, currentIssueNumber);
    await closeIssue(context, repository, oldIssueNumber);
  }
}

function normalizeResult(id, result, mode) {
  if (result === false) {
    throw new Error(`[security] ${id} failed: assertion returned false`);
  }
  const normalized = result === true ? {} : (result ?? {});
  if (normalized.passed === false || normalized.status === 'failed') {
    throw new Error(`[security] ${id} failed: ${normalized.reason ?? 'assertion failed'}`);
  }
  return {
    id,
    mode,
    status: normalized.status ?? 'passed',
    ...normalized,
  };
}

/** Run one case through the injected real/fixture integration seam. */
export async function runSecurityCase(context, id) {
  const definition = caseDefinition(id);
  const runner = providedRunner(context, id);
  if (runner) {
    const result = await runner({ ...context, securityCase: definition });
    return normalizeResult(id, result, 'integration');
  }
  if (id === 'wrong-approval') {
    const result = await realWrongApproval(context);
    if (result) return normalizeResult(id, result, 'real-github');
  }
  if (id === 'old-plan-approval') {
    const result = await realOldPlanApproval(context);
    if (result) return normalizeResult(id, result, 'real-github');
  }
  if (id === 'fake-ready') {
    const result = await realFakeReady(context);
    if (result) return normalizeResult(id, result, 'real-github');
  }
  if (id === 'old-report') {
    const result = await realOldReport(context);
    if (result) return normalizeResult(id, result, 'real-github');
  }
  const fixture = await readFixture(id);
  return {
    id,
    mode: 'fixture-only',
    status: 'limited',
    passed: false,
    reason: fixture.limitReason,
    expected: fixture.expected,
    record: fixture.record,
  };
}

export async function runWrongApproval(context) {
  return runSecurityCase(context, 'wrong-approval');
}

export async function runOldPlanApproval(context) {
  return runSecurityCase(context, 'old-plan-approval');
}

export async function runOldReport(context) {
  return runSecurityCase(context, 'old-report');
}

export async function runFakeReady(context) {
  return runSecurityCase(context, 'fake-ready');
}

/**
 * Execute all security smoke cases. Fixture-only cases are returned as
 * `limited` and do not pretend to be successful remote E2E assertions.
 */
export async function run(context) {
  const results = [];
  for (const definition of SECURITY_CASES) {
    results.push(await runSecurityCase(context, definition.id));
  }
  return {
    status: results.every((result) => result.status === 'passed') ? 'passed' : 'limited',
    results,
    limitations: results.filter((result) => result.status === 'limited').map((result) => ({
      id: result.id,
      reason: result.reason,
    })),
  };
}

export const runSecuritySmoke = run;

export { workflowIssueComments as issueComments, workflowIssueView as readIssueView };
