/**
 * First real-workflow release scenario.
 *
 * The release entry supplies the infrastructure context.  This module does
 * not create an alternate GitHub client or invoke a fake Gate: `context.gh`
 * performs real gh operations, `context.driver` runs the built Driver, and
 * `context.waitFor` may provide the entry's bounded polling implementation.
 * The small fallbacks below are useful for local/manual invocation and still
 * go through the context's command runner.
 */
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { runFakeAgent } from '../fake-agent.mjs';
import { waitFor as infrastructureWaitFor } from '../wait.mjs';
const DEFAULT_TITLE = 'GateFlow release E2E: update hello.txt';
const DEFAULT_BODY = 'Use the approved plan to update hello.txt in the target workspace and verify the pushed result.';

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
  if (typeof result !== 'string') throw new Error(`${label} did not return JSON`);
  try {
    return JSON.parse(result);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function textOf(value) {
  const result = valueOf(value);
  if (typeof result === 'string') return result;
  return JSON.stringify(result ?? '');
}

async function command(context, executable, args, options = {}) {
  const commandOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? context.options?.timeoutMs ?? 10 * 60 * 1000,
    env: { ...process.env, ...(context.env ?? {}), ...(context.githubToken ? { GITHUB_TOKEN: context.githubToken } : {}), ...(options.env ?? {}) },
  };
  if (typeof context.runCommand === 'function') return context.runCommand(executable, args, commandOptions);
  if (typeof context.exec === 'function') return context.exec(executable, args, commandOptions);
  if (typeof context.runProcess === 'function') return context.runProcess(executable, args, commandOptions);
  if (typeof context.run === 'function') return context.run(executable, args, commandOptions);
  throw new Error(`E2E context must provide runCommand/exec/run for ${executable}`);
}

async function gh(context, args, options = {}) {
  const ghOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? context.options?.timeoutMs ?? 10 * 60 * 1000,
    env: { ...process.env, ...(context.env ?? {}), ...(context.githubToken ? { GITHUB_TOKEN: context.githubToken } : {}), ...(options.env ?? {}) },
  };
  if (typeof context.gh?.json === 'function') return context.gh.json(args, ghOptions);
  if (typeof context.gh?.run === 'function') return context.gh.run(args, ghOptions);
  if (typeof context.gh === 'function') return context.gh(args, ghOptions);
  if (typeof context.runGh === 'function') return context.runGh(args, ghOptions);
  return command(context, 'gh', args, ghOptions);
}

async function driver(context, args, cwd) {
  const options = {
    cwd,
    timeoutMs: context.options?.timeoutMs ?? 10 * 60 * 1000,
    env: { ...process.env, ...(context.env ?? {}), ...(context.githubToken ? { GITHUB_TOKEN: context.githubToken } : {}) },
  };
  if (typeof context.driver === 'function') return context.driver(args, options);
  if (typeof context.runDriver === 'function') return context.runDriver(args, options);
  const cli = context.driverCli ?? path.resolve(context.root ?? context.repositoryRoot ?? cwd, 'dist', 'cli.js');
  return command(context, process.execPath, [cli, ...args], options);
}

function repoArgs(repository) {
  return ['--repo', repository];
}

async function issueView(context, repository, issueNumber) {
  const raw = await gh(context, ['issue', 'view', String(issueNumber), ...repoArgs(repository), '--json', 'number,title,body,state,labels,comments']);
  const issue = jsonOf(raw, 'gh issue view');
  return {
    ...issue,
    labels: Array.isArray(issue.labels) ? issue.labels.map((label) => typeof label === 'string' ? label : label.name).filter(Boolean) : [],
    comments: Array.isArray(issue.comments) ? issue.comments.map((comment) => ({
      ...comment,
      user: comment.user ?? comment.author?.login ?? comment.author?.name ?? '',
      id: Number(comment.id),
    })) : [],
  };
}

async function createIssue(context, repository, title, body) {
  const raw = await gh(context, [
    'api', `repos/${repository}/issues`, '--method', 'POST',
    '-f', `title=${title}`, '-f', `body=${body}`,
  ]);
  const issue = jsonOf(raw, 'gh issue create');
  if (!Number.isSafeInteger(Number(issue.number)) || Number(issue.number) < 1) {
    throw new Error(`gh issue create returned no issue number: ${textOf(raw)}`);
  }
  return { ...issue, number: Number(issue.number) };
}

async function addIssueComment(context, repository, issueNumber, body) {
  // API output includes the database id needed by the frozen /approve syntax.
  const raw = await gh(context, [
    'api',
    `repos/${repository}/issues/${issueNumber}/comments`,
    '--method', 'POST',
    '-f', `body=${body}`,
  ]);
  const comment = jsonOf(raw, 'GitHub issue comment');
  const id = Number(comment.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`GitHub comment response has no id: ${textOf(raw)}`);
  return { ...comment, id };
}

async function loadProtocol(context) {
  const supplied = context.protocol ?? {};
  const suppliedMarkers = supplied.MARKERS ?? supplied.markers;
  const suppliedRecordMarkers = supplied.recordMarkers;
  const suppliedPlanSha256 = supplied.planSha256;
  const suppliedParseRecord = supplied.parseRecord;
  const suppliedFindDispatchId = supplied.findDispatchId;
  const suppliedValidateExpectedDispatchId = supplied.validateExpectedDispatchId;
  if (suppliedMarkers && suppliedRecordMarkers && typeof suppliedPlanSha256 === 'function' &&
      typeof suppliedParseRecord === 'function' && typeof suppliedFindDispatchId === 'function' &&
      typeof suppliedValidateExpectedDispatchId === 'function' && supplied.recordSchema !== undefined) {
    return {
      markers: suppliedMarkers,
      recordMarkers: suppliedRecordMarkers,
      planSha256: suppliedPlanSha256,
      parseRecord: suppliedParseRecord,
      findDispatchId: suppliedFindDispatchId,
      validateExpectedDispatchId: suppliedValidateExpectedDispatchId,
      recordSchema: supplied.recordSchema,
    };
  }
  const root = context.root ?? context.repositoryRoot;
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('workflow scenario needs context.root to load the production protocol');
  }
  let bundle;
  try {
    bundle = await build({
      stdin: {
        sourcefile: 'gateflow-e2e-protocol-entry.ts',
        resolveDir: root,
        contents: [
          "export { MARKERS } from './src/gate/protocol.ts';",
          "export { APPROVAL_RECORD_MARKER, EPOCH_RECORD_MARKER, RECORD_SCHEMA_VERSION } from './src/protocol/records.ts';",
          "export { parseRecord } from './src/protocol/records.ts';",
          "export { findDispatchId, validateExpectedDispatchId } from './src/gate/execution-chain.ts';",
          "export { planSha256 } from './src/protocol/plan.ts';",
        ].join('\n'),
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      write: false,
      logLevel: 'silent',
    });
  } catch (error) {
    throw new Error(`could not bundle the production protocol for E2E: ${error instanceof Error ? error.message : String(error)}`);
  }
  const output = bundle.outputFiles?.[0]?.text;
  if (typeof output !== 'string' || output.length === 0) {
    throw new Error('production protocol bundle produced no in-memory output');
  }
  let runtime;
  try {
    runtime = await import(`data:text/javascript;base64,${Buffer.from(output, 'utf8').toString('base64')}`);
  } catch (error) {
    throw new Error(`could not load the in-memory production protocol bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
  const markers = runtime.MARKERS;
  const recordMarkers = {
    approval: runtime.APPROVAL_RECORD_MARKER,
    workflowEpoch: runtime.EPOCH_RECORD_MARKER,
  };
  if (!markers?.plan || !markers?.executionTracker || !markers?.completionReport ||
      !recordMarkers.approval || !recordMarkers.workflowEpoch ||
      typeof runtime.planSha256 !== 'function' || typeof runtime.parseRecord !== 'function' ||
      typeof runtime.findDispatchId !== 'function' || typeof runtime.validateExpectedDispatchId !== 'function' ||
      runtime.RECORD_SCHEMA_VERSION === undefined) {
    throw new Error('production protocol exports are incomplete');
  }
  return {
    markers,
    recordMarkers,
    planSha256: runtime.planSha256,
    parseRecord: runtime.parseRecord,
    findDispatchId: runtime.findDispatchId,
    validateExpectedDispatchId: runtime.validateExpectedDispatchId,
    recordSchema: runtime.RECORD_SCHEMA_VERSION,
  };
}

function recordFromComment(comment, protocol) {
  if (!comment || typeof comment.body !== 'string') return null;
  const parsed = protocol.parseRecord(Number(comment.id), comment.body);
  return parsed?.ok ? parsed.record : null;
}

function findRecord(comments, kind, protocol) {
  return comments.map((comment) => ({ comment, record: recordFromComment(comment, protocol) }))
    .find(({ record }) => record?.kind === kind) ?? null;
}

function findBoundComment(comments, marker, taskId, protocol) {
  const markerLine = marker.trim().startsWith('<!--') ? marker.trim() : `<!-- ${marker} -->`;
  return comments.find((comment) => typeof comment.body === 'string' &&
    comment.body.split(/\r?\n/).some((line) => line.trim() === markerLine) &&
    protocol.validateExpectedDispatchId(protocol.findDispatchId(comment.body), taskId).ok) ?? null;
}

async function waitUntil(context, description, check, options = {}) {
  const timeoutMs = options.timeoutMs ?? context.options?.timeoutMs ?? context.timeoutMs ?? 15 * 60 * 1000;
  const intervalMs = options.intervalMs ?? context.options?.intervalMs ?? context.options?.pollIntervalMs ?? context.intervalMs ?? 5 * 1000;
  if (typeof context.waitFor === 'function') {
    return context.waitFor({
      description,
      timeoutMs,
      intervalMs,
      check,
    });
  }
  if (typeof context.waitForGh === 'function') {
    return context.waitForGh(description, check, {
      timeoutMs,
      intervalMs,
    });
  }
  if (context.options?.timeoutMs !== undefined) {
    return infrastructureWaitFor(description, check, {
      timeoutMs,
      intervalMs,
    });
  }
  const started = Date.now();
  let attempts = 0;
  let lastValue;
  let lastError = null;
  for (;;) {
    attempts += 1;
    try {
      lastValue = await check({ attempts, elapsedMs: Date.now() - started });
      if (lastValue) return lastValue;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`timed out waiting for ${description} after ${timeoutMs}ms (${attempts} attempt(s)); ` +
        `last value: ${JSON.stringify(lastValue ?? null)}; ` +
        `last error: ${lastError instanceof Error ? lastError.message : lastError ?? 'none'}`);
    }
    if (typeof context.sleep === 'function') await context.sleep(intervalMs);
    else await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForState(context, repository, issueNumber, label, description, extraCheck = () => true) {
  return waitUntil(context, description, async () => {
    const issue = await issueView(context, repository, issueNumber);
    return issue.labels.includes(label) && extraCheck(issue) ? issue : false;
  });
}

function taskIdFromDriverResult(raw) {
  const result = valueOf(raw);
  if (result && typeof result === 'object') {
    const direct = result.taskId ?? result.task_id;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    if (typeof result.stdout === 'string') return taskIdFromDriverResult(result.stdout);
  }
  const match = /(?:^|\n)task:\s*(\S+)/.exec(String(result ?? ''));
  if (!match?.[1]) throw new Error(`Driver did not report a task id: ${textOf(raw)}`);
  return match[1];
}

async function runDriver(context, cwd, args) {
  const raw = await driver(context, args, cwd);
  return { raw, taskId: args[0] === 'run' ? taskIdFromDriverResult(raw) : null };
}

async function verifyRemoteFile(context, repository, relativeFile, expected) {
  const raw = await gh(context, ['api', `repos/${repository}/contents/${relativeFile}`]);
  const file = jsonOf(raw, 'remote hello.txt read');
  if (typeof file.content !== 'string') throw new Error('remote hello.txt response has no content');
  const actual = Buffer.from(file.content.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (actual !== expected) throw new Error(`remote hello.txt differs: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return actual;
}

function driverHasAction(raw, action) {
  const result = valueOf(raw);
  if (result && typeof result === 'object' && Array.isArray(result.outcomes)) {
    return result.outcomes.some((outcome) => outcome?.action === action);
  }
  return typeof result === 'string' && result.includes(`: ${action} `);
}

async function repositoryDetails(context, repository) {
  if (context.repository?.id !== undefined && context.repository?.fullName?.toLowerCase() === repository.toLowerCase()) {
    return context.repository;
  }
  return jsonOf(await gh(context, ['api', `repos/${repository}`]), 'GitHub repository read');
}

async function currentUser(context) {
  if (context.githubUser?.login && context.githubUser?.id !== undefined) {
    return { ...context.githubUser, id: Number(context.githubUser.id) };
  }
  const user = jsonOf(await gh(context, ['api', 'user']), 'GitHub user read');
  if (typeof user.login !== 'string' || !Number.isSafeInteger(Number(user.id))) {
    throw new Error(`GitHub user response is missing login/id: ${textOf(user)}`);
  }
  return { ...user, id: Number(user.id) };
}

function assertDriverAction(raw, action, label) {
  if (!driverHasAction(raw, action)) {
    throw new Error(`${label} did not report Driver action ${action}: ${textOf(raw)}`);
  }
}

function assertTaskId(protocol, taskId, label) {
  const binding = protocol.validateExpectedDispatchId(taskId, taskId);
  if (!binding.ok) throw new Error(`${label} Driver task id is not a canonical production dispatch id: ${binding.reason}`);
  return binding.binding;
}

function assertApprovalBindings(approval, planComment, approvalCommand, epochRecord, repository, issueNumber, user, protocol) {
  const expectedHash = protocol.planSha256(planComment.body);
  const checks = {
    schema: approval?.schema === protocol.recordSchema,
    kind: approval?.kind === 'approval',
    repository_id: approval?.repository_id === Number(repository.id),
    issue_number: approval?.issue_number === issueNumber,
    workflow_epoch: approval?.workflow_epoch === epochRecord.workflow_epoch,
    plan_comment_id: approval?.plan_comment_id === planComment.id,
    plan_sha256: approval?.plan_sha256 === expectedHash,
    approval_command_comment_id: approval?.approval_command_comment_id === approvalCommand.id,
    approved_by_id: approval?.approved_by_id === user.id,
    approved_by_login: typeof approval?.approved_by_login === 'string' && approval.approved_by_login.toLowerCase() === user.login.toLowerCase(),
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([field]) => field);
  if (failed.length > 0) {
    throw new Error(`approval record binding mismatch in ${failed.join(', ')}: ${JSON.stringify({ approval, expectedHash, user: { id: user.id, login: user.login } })}`);
  }
  return { ...approval, expected_plan_sha256: expectedHash };
}

function assertEpochBindings(epoch, repository, issueNumber) {
  if (epoch?.kind !== 'workflow_epoch' || epoch.repository_id !== Number(repository.id) || epoch.issue_number !== issueNumber) {
    throw new Error(`workflow_epoch record binding mismatch: ${JSON.stringify({ epoch, repositoryId: repository.id, issueNumber })}`);
  }
}

async function mutationBaseContent(targetWorkspace, mutation) {
  if (mutation?.type !== 'append-line') return undefined;
  const relativeFile = mutation.path ?? 'hello.txt';
  if (typeof relativeFile !== 'string' || path.isAbsolute(relativeFile)) {
    throw new Error(`append-line mutation.path must be relative, got ${JSON.stringify(relativeFile)}`);
  }
  const targetFile = path.resolve(targetWorkspace, relativeFile);
  const targetRoot = path.resolve(targetWorkspace) + path.sep;
  if (!targetFile.startsWith(targetRoot)) throw new Error('append-line mutation.path escapes target workspace');
  try {
    return await readFile(targetFile, 'utf8');
  } catch (error) {
    throw new Error(`cannot read append base ${targetFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Run the first real GitHub/Gate/Driver workflow round.
 *
 * Required context fields are `controlRepository`, `controlWorkspace`,
 * `targetRepository`, and `targetWorkspace`; the target may equal the
 * control repository/workspace for a single-repository smoke.  Command
 * execution and waiting are delegated to context functions as documented at
 * the top of this file.
 */
export async function runWorkflowScenario(context, options = {}) {
  const protocol = await loadProtocol(context);
  const contextRepository = context.repository?.fullName ?? context.repository?.nameWithOwner;
  const controlRepository = options.controlRepository ?? context.controlRepository ?? contextRepository;
  const contextClone = context.paths?.clone;
  const controlWorkspace = path.resolve(options.controlWorkspace ?? context.controlWorkspace ?? contextClone ?? context.repositoryRoot ?? '');
  const targetRepository = options.targetRepository ?? context.targetRepository ?? contextRepository ?? controlRepository;
  const targetWorkspace = path.resolve(options.targetWorkspace ?? context.targetWorkspace ?? contextClone ?? controlWorkspace);
  if (typeof controlRepository !== 'string' || controlRepository.length === 0) throw new Error('missing controlRepository');
  if (typeof targetRepository !== 'string' || targetRepository.length === 0) throw new Error('missing targetRepository');
  if (!path.isAbsolute(controlWorkspace) || !path.isAbsolute(targetWorkspace)) throw new Error('controlWorkspace/targetWorkspace must be absolute');
  const repository = await repositoryDetails(context, controlRepository);
  const user = await currentUser(context);

  const title = options.title ?? DEFAULT_TITLE;
  const body = options.body ?? DEFAULT_BODY;
  const issue = await createIssue(context, controlRepository, title, body);
  const issueNumber = issue.number;

  await addIssueComment(context, controlRepository, issueNumber, '/ai-plan');
  const planningIssue = await waitForState(context, controlRepository, issueNumber, 'ai:planning', 'ai:planning and workflow epoch', (current) => findRecord(current.comments, 'workflow_epoch', protocol)?.record !== null);
  const epochEntry = findRecord(planningIssue.comments, 'workflow_epoch', protocol);
  const epochRecord = epochEntry?.record;
  if (!epochRecord?.workflow_epoch) throw new Error('Gate reached ai:planning without a workflow_epoch record');
  assertEpochBindings(epochRecord, repository, issueNumber);

  const planRun = await runDriver(context, controlWorkspace, [
    'run', '--issue', String(issueNumber), '--root', controlWorkspace,
    '--target-repository', targetRepository, '--target-workspace', targetWorkspace,
  ]);
  assertTaskId(protocol, planRun.taskId, 'planning');
  const planContent = options.planContent ?? await readFile(options.planFixture ?? new URL('../fixtures/plan.md', import.meta.url), 'utf8');
  const planAgent = await runFakeAgent(context, {
    taskId: planRun.taskId,
    workspaceRoot: controlWorkspace,
    planContent,
  });
  const planSync = await runDriver(context, controlWorkspace, ['sync', '--root', controlWorkspace]);
  assertDriverAction(planSync.raw, 'plan-published', 'plan sync');
  const reviewIssue = await waitForState(context, controlRepository, issueNumber, 'ai:review', 'ai:review after plan publication');
  const planComment = findBoundComment(reviewIssue.comments, protocol.markers.plan, planRun.taskId, protocol);
  if (!planComment) throw new Error(`no current Plan comment was found for ${planRun.taskId}`);

  const approvalCommand = await addIssueComment(context, controlRepository, issueNumber, `/approve ${planComment.id}`);
  const readyIssue = await waitForState(context, controlRepository, issueNumber, 'ai:ready', 'ai:ready and approval record', (current) => {
    const approval = findRecord(current.comments, 'approval', protocol)?.record;
    return approval?.workflow_epoch === epochRecord.workflow_epoch &&
      approval.plan_comment_id === planComment.id &&
      approval.approval_command_comment_id === approvalCommand.id;
  });
  const approvalEntry = findRecord(readyIssue.comments, 'approval', protocol);
  if (!approvalEntry) throw new Error('Gate reached ai:ready without a verifiable approval record');
  const approvalRecord = assertApprovalBindings(approvalEntry.record, planComment, approvalCommand, epochRecord, repository, issueNumber, user, protocol);

  const executeRun = await runDriver(context, controlWorkspace, [
    'run', '--issue', String(issueNumber), '--root', controlWorkspace,
    '--target-repository', targetRepository, '--target-workspace', targetWorkspace,
  ]);
  assertTaskId(protocol, executeRun.taskId, 'execution');
  const appendBaseContent = await mutationBaseContent(targetWorkspace, options.mutation);
  const workingAgent = await runFakeAgent(context, {
    taskId: executeRun.taskId,
    workspaceRoot: controlWorkspace,
    phase: 'working',
    helloContent: options.helloContent,
    mutation: options.mutation,
    baseContent: appendBaseContent,
  });
  const trackerSync = await runDriver(context, controlWorkspace, ['sync', '--root', controlWorkspace]);
  assertDriverAction(trackerSync.raw, 'tracker-created', 'no-result execution sync');
  if (workingAgent.result !== null) throw new Error('working Fake Agent unexpectedly wrote result.json');
  const workingIssue = await waitForState(context, controlRepository, issueNumber, 'ai:working', 'ai:working after execution Tracker');
  const trackerComment = findBoundComment(workingIssue.comments, protocol.markers.executionTracker, executeRun.taskId, protocol);
  if (!trackerComment) throw new Error(`no execution Tracker was found for ${executeRun.taskId}`);

  const reportContent = options.reportContent ?? await readFile(options.reportFixture ?? new URL('../fixtures/report.md', import.meta.url), 'utf8');
  const completedAgent = await runFakeAgent(context, {
    taskId: executeRun.taskId,
    workspaceRoot: controlWorkspace,
    phase: 'completed',
    skipTargetChange: true,
    reportContent,
  });
  const reportSync = await runDriver(context, controlWorkspace, ['sync', '--root', controlWorkspace]);
  assertDriverAction(reportSync.raw, 'completed', 'completion report sync');
  const doneIssue = await waitForState(context, controlRepository, issueNumber, 'ai:done', 'ai:done after completion Report');
  const reportComment = findBoundComment(doneIssue.comments, protocol.markers.completionReport, executeRun.taskId, protocol);
  if (!reportComment) throw new Error(`no completion Report was found for ${executeRun.taskId}`);
  const acceptedSync = await runDriver(context, controlWorkspace, ['sync', '--root', controlWorkspace]);
  const acceptedText = textOf(acceptedSync.raw);
  const acceptedOutcomes = acceptedSync.raw?.outcomes;
  const hasAcceptedOutcome = Array.isArray(acceptedOutcomes) && acceptedOutcomes.some((outcome) => outcome?.action === 'accepted');
  if (!acceptedText.includes('accepted') && !hasAcceptedOutcome) {
    throw new Error(`final Driver sync did not observe acceptance: ${acceptedText}`);
  }
  const expectedFile = options.expectedFile ?? { path: workingAgent.target.relativeFile, content: workingAgent.target.helloContent };
  const helloContent = await verifyRemoteFile(context, targetRepository, expectedFile.path, expectedFile.content);

  return {
    issue: { ...issue, number: issueNumber, state: doneIssue.state, labels: doneIssue.labels },
    epoch: epochRecord,
    plan: { taskId: planRun.taskId, task: planAgent.task, comment: planComment, sync: planSync.raw },
    approval: { command: approvalCommand, record: approvalRecord },
    execute: { taskId: executeRun.taskId, task: workingAgent.task, tracker: trackerComment, sync: trackerSync.raw, report: reportComment, reportSync: reportSync.raw, acceptedSync: acceptedSync.raw },
    task: { planning: planAgent.task, execute: completedAgent.task },
    tasks: { plan: planAgent.task, execute: completedAgent.task },
    target: { repository: targetRepository, workspace: targetWorkspace, helloContent },
  };
}

export const workflow = runWorkflowScenario;
export const runWorkflow = runWorkflowScenario;
export const run = runWorkflowScenario;
export default runWorkflowScenario;
