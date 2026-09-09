#!/usr/bin/env node
/** One-command release E2E entry point. */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { createReleaseContext, E2EError } from './e2e/context.mjs';
import {
  cleanup,
  bootstrapRepository,
  configureGateToken,
  createRepository,
  prepareAgentWorkspace,
  resolveScenarioModules,
  runStage,
  runLocalChecks,
  runPreflight,
  runScenarioModules,
} from './e2e/lifecycle.mjs';

const USAGE = `GateFlow release E2E

Usage:
  npm run e2e:release [-- [options]]

Options:
  --keep                 Keep the temporary repository and clone after success
  --repo-name <name>    Use this repository name instead of a generated unique name
  --owner <login>       Create under this GitHub owner (default: gh api user login)
  --skip-security       Do not require/run scripts/e2e/scenarios/security.mjs
  --prepare-agent       Bootstrap, create an Issue, prepare one Driver task, then stop
  --help                Show this help
`;

function parseArgs(argv) {
  const options = { keep: false, repoName: null, owner: null, skipSecurity: false, prepareAgent: false };
  const value = (flag, index) => {
    const next = argv[index];
    if (next === undefined || next.startsWith('--')) throw new E2EError(`${flag} requires a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--skip-security') options.skipSecurity = true;
    else if (arg === '--prepare-agent') options.prepareAgent = true;
    else if (arg === '--repo-name') options.repoName = value(arg, index += 1);
    else if (arg === '--owner') options.owner = value(arg, index += 1);
    else if (arg.startsWith('--repo-name=')) options.repoName = arg.slice('--repo-name='.length);
    else if (arg.startsWith('--owner=')) options.owner = arg.slice('--owner='.length);
    else throw new E2EError(`unknown option ${arg}`);
  }
  return options;
}

export { parseArgs };

export async function runReleaseE2E(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    (deps.log ?? console.log)(USAGE);
    return { help: true, options };
  }
  const context = createReleaseContext(options, deps);
  context.runBootstrap = ({ targetDir, repository, args = [], commit = true }) => {
    const modeIndex = args.indexOf('--install-mode');
    const installMode = modeIndex >= 0 ? args[modeIndex + 1] : 'existing';
    const refIndex = args.indexOf('--action-ref');
    const actionRef = refIndex >= 0 ? args[refIndex + 1] : context.actionRef;
    return bootstrapRepository(context, targetDir, repository, installMode, actionRef, { commit });
  };
  context.configureGateToken = () => configureGateToken(context);
  let success = false;
  try {
    await runStage(context, 'preflight', () => runPreflight(context));
    await runStage(context, 'local gates', () => runLocalChecks(context));
    await runStage(context, 'scenario resolution', () => resolveScenarioModules(context));
    await runStage(context, 'repository creation', () => createRepository(context));
    context.controlRepository = context.repository.fullName;
    context.targetRepository = context.repository.fullName;
    context.controlWorkspace = context.paths.clone;
    context.targetWorkspace = context.paths.clone;
    await runStage(context, 'Bootstrap', () => bootstrapRepository(context));
    await runStage(context, 'Gate token configuration', () => configureGateToken(context));
    if (options.prepareAgent) {
      const prepared = await runStage(context, 'prepare-agent', () => prepareAgentWorkspace(context));
      success = true;
      return { context, prepareAgent: prepared };
    }
    const results = await runStage(context, 'release scenarios', () => runScenarioModules(context));
    success = true;
    return { context, results };
  } catch (error) {
    const failure = error instanceof E2EError ? error : new E2EError(error instanceof Error ? error.message : String(error));
    failure.context = context;
    throw failure;
  } finally {
    try {
      await cleanup(context, { success });
    } catch (cleanupError) {
      if (success) {
        const failure = cleanupError instanceof E2EError
          ? cleanupError
          : new E2EError(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        failure.context = context;
        throw failure;
      }
      context.error(`[e2e] ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
  }
}

function repositoryText(context) {
  return context.repository?.fullName ?? '(not created)';
}

function issueText(context) {
  const issue = context.prepareAgentIssue
    ?? context.workflowResult?.issue
    ?? context.firstRound?.issue;
  if (!issue) return '(not available)';
  return `#${issue.number ?? '?'}${issue.url ? ` ${issue.url}` : ''}`;
}

function recentWorkflowText(context) {
  const issue = context.prepareAgentIssue
    ?? context.workflowResult?.issue
    ?? context.firstRound?.issue;
  if (!issue) return '(not available)';
  const labels = Array.isArray(issue.labels) ? issue.labels.join(',') : '(labels unavailable)';
  return `issue #${issue.number ?? '?'} state=${issue.state ?? '(unknown)'} labels=${labels}`;
}

function recentActionsText(context) {
  if (context.repository === null) return '(repository was not created)';
  return `gh run list --repo ${context.repository.fullName}`;
}

function safeErrorMessage(error, context) {
  const message = error instanceof Error ? error.message : String(error);
  return context.githubToken ? message.replaceAll(context.githubToken, '<redacted>') : message;
}

export function printSuccessSummary(context, result, log = context.log) {
  log(result.prepareAgent ? '[e2e] PREPARE-AGENT PASS' : '[e2e] E2E PASS');
  for (const stage of context.stages) log(`[e2e] ${stage.status} ${stage.name}`);
  if (result.prepareAgent) {
    log(`[e2e] READY FOR AGENT repository=${result.prepareAgent.repository} issue=#${result.prepareAgent.issue.number} task=${result.prepareAgent.taskId}`);
    log(`[e2e] Driver workspace: ${result.prepareAgent.workspace}`);
  } else {
    log(`[e2e] repository: ${repositoryText(context)}`);
    log(`[e2e] READY FOR RELEASE repository=${repositoryText(context)} issue=${issueText(context)}`);
  }
}

export function printFailureSummary(context, error, log = context.error) {
  log('[e2e] E2E FAILED');
  log(`[e2e] repository: ${repositoryText(context)}`);
  log(`[e2e] local workspace: ${context.paths.clone ?? '(not created)'}`);
  log(`[e2e] issue: ${issueText(context)}`);
  log(`[e2e] failed stage: ${context.currentStage ?? '(unknown)'}`);
  log(`[e2e] recent workflow: ${recentWorkflowText(context)}`);
  log(`[e2e] Recent GitHub Actions: ${recentActionsText(context)}`);
  log(`[e2e] reason: ${safeErrorMessage(error, context)}`);
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  try {
    const result = await runReleaseE2E(argv, deps);
    if (!result.help) printSuccessSummary(result.context, result);
    return 0;
  } catch (error) {
    const context = error?.context;
    if (context) printFailureSummary(context, error, deps.error ?? console.error);
    else (deps.error ?? console.error)('[e2e] E2E FAILED');
    const message = context ? safeErrorMessage(error, context) : error instanceof Error ? error.message : String(error);
    (deps.error ?? console.error)(`[e2e] release E2E failed: ${message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
