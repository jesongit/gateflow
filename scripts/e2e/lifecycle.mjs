/**
 * Release E2E lifecycle: preflight → local gates → scenario loading → remote
 * repository lifecycle → cleanup.  Remote creation is intentionally below all
 * preconditions so a failing local check cannot leave a GitHub repository.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  E2EError,
  RELEASE_SCENARIOS,
  REQUIRED_LOCAL_SCRIPTS,
  fileExists,
  readPackageScripts,
} from './context.mjs';
import { assert, assertEqual, assertPrivateRepository } from './assertions.mjs';

function output(result) {
  return result.stdout.trim();
}

function validatePart(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new E2EError(`${label} must contain only GitHub-safe letters, numbers, '.', '_' or '-', got ${JSON.stringify(value)}`);
  }
  return value;
}

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const EXPECTED_BOOTSTRAP_LABELS = Object.freeze([
  'ai:planning', 'ai:review', 'ai:ready', 'ai:working', 'ai:blocked', 'ai:done',
]);
const GATE_TOKEN_SECRET = 'GATEFLOW_GATE_TOKEN';
const GITHUB_TOKEN_EXPRESSION = '${{ github.token }}';
const GATE_TOKEN_EXPRESSION = '${{ secrets.GATEFLOW_GATE_TOKEN }}';

function addGateLogin(config, login) {
  let parsed;
  try {
    parsed = parseYaml(config);
  } catch (error) {
    throw new E2EError(`gateflow.config.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'gateflow.config.yml must contain a top-level mapping');
  const existing = parsed.gate_logins;
  if (existing !== undefined && (!Array.isArray(existing) || existing.some((value) => typeof value !== 'string' || value.length === 0))) {
    throw new E2EError('gateflow.config.yml gate_logins must be a list of non-empty strings');
  }
  if (Array.isArray(existing) && existing.some((value) => value.toLowerCase() === login.toLowerCase())) {
    return { content: config, changed: false };
  }

  const newline = config.includes('\r\n') ? '\r\n' : '\n';
  const lines = config.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => /^gate_logins\s*:/.test(line));
  if (keyIndex < 0) {
    const separator = config.length === 0 || config.endsWith('\n') ? '' : newline;
    return {
      content: `${config}${separator}gate_logins:${newline}  - ${JSON.stringify(login)}${newline}`,
      changed: true,
    };
  }

  const keyLine = lines[keyIndex];
  const keyIndent = /^\s*/.exec(keyLine)[0].length;
  const keyMatch = /^(\s*gate_logins\s*:\s*)(.*?)(\s*(?:#.*)?)$/.exec(keyLine);
  const valueText = keyMatch?.[2]?.trim() ?? '';
  if (valueText.startsWith('[') && valueText.endsWith(']')) {
    const close = keyLine.lastIndexOf(']');
    const prefix = keyLine.slice(0, close).replace(/\s+$/, '');
    const inner = keyLine.slice(keyLine.indexOf('[') + 1, close).trim();
    lines[keyIndex] = `${prefix}${inner.length > 0 ? `, ${JSON.stringify(login)}` : JSON.stringify(login)}]${keyMatch?.[3] ?? ''}`;
    return { content: lines.join(newline), changed: true };
  }

  let insertAt = keyIndex + 1;
  while (insertAt < lines.length) {
    const line = lines[insertAt];
    const trimmed = line.trim();
    const indent = /^\s*/.exec(line)[0].length;
    if (trimmed === '' || trimmed.startsWith('#') || indent > keyIndent) insertAt += 1;
    else break;
  }
  lines.splice(insertAt, 0, `${' '.repeat(keyIndent + 2)}- ${JSON.stringify(login)}`);
  return { content: lines.join(newline), changed: true };
}

function verifyGateLogin(config, login) {
  let parsed;
  try {
    parsed = parseYaml(config);
  } catch (error) {
    throw new E2EError(`updated gateflow.config.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const logins = parsed?.gate_logins;
  assert(Array.isArray(logins), 'updated gateflow.config.yml gate_logins is not a list');
  assert(logins.some((value) => typeof value === 'string' && value.toLowerCase() === login.toLowerCase()),
    `Driver configuration does not contain gate login ${login}`);
  return logins;
}

export async function runStage(context, name, action) {
  context.currentStage = name;
  const result = await action();
  context.stages.push({ name, status: 'PASS' });
  return result;
}

export async function runPreflight(context) {
  context.log('[e2e] preflight: gh --version');
  const ghVersion = await context.gh.run(['--version'], { cwd: context.root, timeoutMs: context.options.timeoutMs });
  context.log(`[e2e] ${output(ghVersion)}`);

  context.log('[e2e] preflight: gh auth status');
  const auth = await context.gh.run(['auth', 'status'], { cwd: context.root, timeoutMs: context.options.timeoutMs });

  context.log('[e2e] preflight: gh api user --jq .login');
  const login = await context.gh.text(['api', 'user', '--jq', '.login'], {
    cwd: context.root,
    timeoutMs: context.options.timeoutMs,
  });
  assert(login.length > 0, 'gh api user --jq .login returned an empty login');
  context.log('[e2e] preflight: gh auth token (memory only)');
  const token = await context.gh.text(['auth', 'token'], {
    cwd: context.root,
    timeoutMs: context.options.timeoutMs,
    sensitive: true,
  });
  assert(token.length > 0, 'gh auth token returned an empty token');
  context.githubToken = token;
  Object.assign(context.bootstrapEnv, context.baseEnv, { GITHUB_TOKEN: token });
  Object.assign(context.driverEnv, context.baseEnv, { GITHUB_TOKEN: token });
  Object.assign(context.ghEnv, { GITHUB_TOKEN: token });
  context.log('[e2e] preflight: git rev-parse HEAD');
  const headResult = await context.runProcess('git', ['rev-parse', 'HEAD'], {
    cwd: context.root,
    timeoutMs: context.options.timeoutMs,
    env: context.localEnv,
  });
  const head = output(headResult);
  assert(/^[0-9a-f]{40}$/i.test(head), `git rev-parse HEAD returned an invalid commit SHA: ${JSON.stringify(head)}`);

  context.log('[e2e] preflight: require clean worktree');
  const status = await context.runProcess('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: context.root,
    timeoutMs: context.options.timeoutMs,
    env: context.localEnv,
  });
  assertEqual(output(status), '', 'git worktree');

  context.preflight = { ghVersion: output(ghVersion), auth: output(auth), login, head };
  context.actionRef = `jesongit/gateflow@${head}`;
  return context.preflight;
}

export async function runLocalChecks(context) {
  const scripts = await readPackageScripts(context.root);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const results = [];
  for (const name of REQUIRED_LOCAL_SCRIPTS) {
    if (typeof scripts[name] !== 'string' || scripts[name].trim() === '') {
      throw new E2EError(`package.json is missing required script "${name}"; refusing to create a remote repository`);
    }
    context.currentStage = `local checks (${name})`;
    context.log(`[e2e] local gate: npm run ${name}`);
    const result = await context.runProcess(npm, ['run', name], {
      cwd: context.root,
      timeoutMs: context.options.timeoutMs,
      env: context.localEnv,
    });
    results.push({ name, result });
  }
  context.localChecks = results;
  return results;
}

export async function resolveScenarioModules(context) {
  if (context.scenarioModulesOverride !== null) {
    context.scenarioModules = context.scenarioModulesOverride;
    return context.scenarioModules;
  }
  const found = [];
  for (const scenario of RELEASE_SCENARIOS) {
    if (scenario.name === 'security' && context.options.skipSecurity) continue;
    const path = resolve(context.root, 'scripts', 'e2e', scenario.file);
    if (!(await fileExists(path))) {
      const requirement = scenario.required
        ? 'required'
        : 'optional unless --skip-security is supplied';
      throw new E2EError(
        `TODO: ${requirement} release E2E scenario is not implemented: ${path}. ` +
          'Add the scenario module with an exported run(context) before running the release E2E.',
      );
    }
    found.push({ ...scenario, path });
  }
  context.scenarioModules = found;
  return found;
}

export async function runScenarioModules(context, modules = context.scenarioModules) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new E2EError('TODO: no release E2E scenario modules are available');
  }
  const results = [];
  for (const scenario of modules) {
    context.currentStage = `scenario (${scenario.name})`;
    context.log(`[e2e] scenario: ${scenario.name}`);
    let imported;
    try {
      imported = await import(pathToFileURL(scenario.path).href);
    } catch (error) {
      throw new E2EError(`failed to load scenario ${scenario.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const run = imported.run ?? imported.default;
    if (typeof run !== 'function') {
      throw new E2EError(`scenario ${scenario.path} must export async run(context) or a default function`);
    }
    const result = await run(context);
    results.push(result);
    if (scenario.name === 'workflow') {
      context.workflowResult = { ...(result ?? {}), bootstrap: context.bootstrapResult };
      context.firstRound = context.workflowResult;
    }
    if (scenario.name === 'security' && result?.status !== 'passed') {
      throw new E2EError(
        `[security] scenario did not complete remotely (status ${result?.status ?? 'unknown'}); ` +
          'use --skip-security only when the security layer is intentionally unavailable',
      );
    }
  }
  return results;
}

export function chooseRepository(context) {
  const owner = validatePart(context.options.owner ?? context.preflight?.login, '--owner');
  const requested = context.options.repoName;
  const name = requested === null
    ? `gateflow-release-e2e-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(5).toString('hex')}`
    : validatePart(requested, '--repo-name');
  return { owner, name, fullName: `${owner}/${name}` };
}

export async function createRepository(context) {
  assert(context.preflight !== null, 'preflight must run before repository creation');
  assert(
    typeof context.githubToken === 'string' && context.githubToken.length > 0,
    'gh auth token did not produce a token; refusing to create a remote repository',
  );
  const repository = chooseRepository(context);
  const clone = join(context.tempRoot, repository.name);
  if (await fileExists(clone)) {
    throw new E2EError(`clone destination already exists at ${clone}; choose a different --repo-name`);
  }
  context.repository = repository;
  context.paths.clone = clone;
  // A timeout after GitHub accepted the request leaves existence unknown, so
  // failure must retain the repository for diagnosis.
  context.cleanup.remoteCreated = true;
  context.log(`[e2e] creating private repository ${repository.fullName}`);
  await context.gh.run(['repo', 'create', repository.fullName, '--private', '--add-readme'], {
    cwd: context.root,
    timeoutMs: context.options.timeoutMs,
  });
  context.log(`[e2e] cloning ${repository.fullName} to ${clone}`);
  await context.gh.run(['repo', 'clone', repository.fullName, clone], {
    cwd: context.root,
    timeoutMs: context.options.timeoutMs,
  });
  const details = await context.gh.json([
    'repo', 'view', repository.fullName,
    '--json', 'nameWithOwner,visibility,isArchived,defaultBranchRef',
  ], { cwd: context.root, timeoutMs: context.options.timeoutMs });
  assertEqual(details.nameWithOwner?.toLowerCase(), repository.fullName.toLowerCase(), 'created repository');
  assertPrivateRepository(details);
  assert(details.isArchived !== true, `created repository ${repository.fullName} is archived`);
  return { ...repository, clone, details };
}

/** Bootstrap the disposable checkout and push only the generated integration files. */
export async function bootstrapRepository(
  context,
  targetDir = context.paths.clone,
  repository = context.repository.fullName,
  installMode = 'new',
  actionRef = context.actionRef ?? `jesongit/gateflow@${context.preflight?.head ?? ''}`,
) {
  assert(typeof targetDir === 'string' && targetDir.length > 0, 'Bootstrap target directory is missing');
  const githubToken = context.githubToken;
  assert(typeof githubToken === 'string' && githubToken.length > 0, 'GitHub token is unavailable for Bootstrap');
  const bootstrapScript = resolve(context.root, 'scripts', 'bootstrap.mjs');
  const readmePath = resolve(targetDir, 'README.md');
  const beforeReadme = await readFile(readmePath, 'utf8');
  context.log(`[e2e] bootstrapping ${repository}`);
  const bootstrap = await context.runProcess(process.execPath, [
    bootstrapScript,
    '--repo', repository,
    '--workdir', targetDir,
    '--install-mode', installMode,
    '--github-config',
    '--action-ref', actionRef,
    '--yes',
    '--non-interactive',
  ], {
    cwd: context.root,
    env: context.bootstrapEnv,
    redactOutput: true,
    timeoutMs: context.options.timeoutMs,
  });
  const status = await context.runProcess('git', ['status', '--porcelain=v1'], {
    cwd: targetDir,
    env: context.bootstrapEnv,
    redactOutput: true,
    timeoutMs: context.options.timeoutMs,
  });
  assert(output(status).length > 0, 'Bootstrap produced no checkout changes');
  await context.runProcess('git', ['add', '--', '.github', 'gateflow.config.yml', '.gitignore'], {
    cwd: targetDir,
    env: context.bootstrapEnv,
    redactOutput: true,
    timeoutMs: context.options.timeoutMs,
  });
  await context.runProcess('git', [
    '-c', 'user.name=GateFlow Release E2E',
    '-c', 'user.email=gateflow-release-e2e@example.invalid',
    'commit', '-m', 'test: bootstrap GateFlow release E2E',
  ], { cwd: targetDir, env: context.bootstrapEnv, timeoutMs: context.options.timeoutMs, redactOutput: true });
  await context.runProcess('git', ['push', '--set-upstream', 'origin', 'HEAD'], {
    cwd: targetDir,
    env: context.bootstrapEnv,
    timeoutMs: context.options.timeoutMs,
    redactOutput: true,
  });
  const workflowFile = context.workflowFile ?? context.bootstrapResult?.workflowFile ?? 'ai-workflow.yml';
  const actualWorkflowPath = resolve(targetDir, '.github', 'workflows', workflowFile);
  const actions = {
    bootstrap: { status: 'passed', installMode, actionRef },
  };
  let actualLabels = [];
  try {
    const afterReadme = await readFile(readmePath, 'utf8');
    assertEqual(afterReadme, beforeReadme, 'Bootstrap README');
    actions.readme = { status: 'passed', unchanged: true, path: readmePath };

    const workflow = await readFile(actualWorkflowPath, 'utf8');
    assert(
      new RegExp(`^\\s*uses:\\s*${escapeRegex(actionRef)}\\s*$`, 'm').test(workflow),
      `Bootstrap workflow does not use ${actionRef}: ${actualWorkflowPath}`,
    );
    actions.workflow = { status: 'passed', path: actualWorkflowPath, workflowFile, actionRef };

    const configPath = resolve(targetDir, 'gateflow.config.yml');
    assert(await fileExists(configPath), `Bootstrap did not create ${configPath}`);
    actions.config = { status: 'passed', path: configPath };

    const gitignorePath = resolve(targetDir, '.gitignore');
    const gitignore = await readFile(gitignorePath, 'utf8');
    assert(/(?:^|\r?\n)\s*\.gateflow\/?\s*(?:\r?\n|$)/.test(gitignore), `Bootstrap .gitignore does not contain .gateflow/: ${gitignorePath}`);
    actions.gitignore = { status: 'passed', path: gitignorePath, contains: '.gateflow/' };

    const labels = await context.gh.json([
      'api', `repos/${repository}/labels?per_page=100`,
    ], { cwd: context.root, timeoutMs: context.options.timeoutMs });
    actualLabels = Array.isArray(labels) ? labels.map(labelName).filter(Boolean) : [];
    const missing = EXPECTED_BOOTSTRAP_LABELS.filter((name) => !actualLabels.includes(name));
    assert(missing.length === 0, `GitHub API labels are missing: ${missing.join(', ') || '(all labels response invalid)'}`);
    actions.labels = { status: 'passed', expected: [...EXPECTED_BOOTSTRAP_LABELS], actual: actualLabels };
    const result = {
      status: 'passed',
      actions,
      labels: actions.labels,
      output: bootstrap.stdout,
      target: actualWorkflowPath,
      workflowFile,
      repository,
      actionRef,
    };
    context.bootstrapResult = result;
    context.actionRef = actionRef;
    context.workflowFile = workflowFile;
    return result;
  } catch (error) {
    const result = {
      status: 'failed',
      actions,
      labels: { status: 'failed', expected: [...EXPECTED_BOOTSTRAP_LABELS], actual: actualLabels },
      target: actualWorkflowPath,
      workflowFile,
      repository,
      actionRef,
    };
    context.bootstrapResult = result;
    throw error;
  }
}

/** Configure the disposable repository to pass the Gate token to Bootstrap's workflow. */
export async function configureGateToken(context) {
  assert(context.repository !== null, 'repository must exist before Gate token configuration');
  assert(typeof context.paths.clone === 'string', 'clone workspace must exist before Gate token configuration');
  assert(typeof context.githubToken === 'string' && context.githubToken.length > 0, 'GitHub token is unavailable for Gate token configuration');

  const repository = context.repository.fullName;
  const workflowFile = context.bootstrapResult?.workflowFile ?? context.workflowFile ?? 'ai-workflow.yml';
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:yml|yaml)$/.test(workflowFile),
    `invalid Bootstrap workflow filename: ${workflowFile}`,
  );
  const relativeWorkflowPath = join('.github', 'workflows', workflowFile);
  const workflowPath = resolve(context.paths.clone, relativeWorkflowPath);
  const configPath = resolve(context.paths.clone, 'gateflow.config.yml');
  const relativeConfigPath = 'gateflow.config.yml';
  const login = context.preflight?.login;
  assert(typeof login === 'string' && login.length > 0, 'preflight login is unavailable for Gate identity binding');
  let workflow;
  try {
    workflow = await readFile(workflowPath, 'utf8');
    const config = await readFile(configPath, 'utf8');
    const replacementCount = workflow.split(GITHUB_TOKEN_EXPRESSION).length - 1;
    assert(replacementCount > 0, `workflow ${workflowPath} has no exact ${GITHUB_TOKEN_EXPRESSION} expression`);
    const updatedWorkflow = workflow.replaceAll(GITHUB_TOKEN_EXPRESSION, GATE_TOKEN_EXPRESSION);
    const configUpdate = addGateLogin(config, login);

    await context.gh.run(['secret', 'set', GATE_TOKEN_SECRET, '--repo', repository], {
      cwd: context.root,
      timeoutMs: context.options.timeoutMs,
      input: `${context.githubToken}\n`,
      redactOutput: true,
    });
    await writeFile(workflowPath, updatedWorkflow, 'utf8');
    if (configUpdate.changed) await writeFile(configPath, configUpdate.content, 'utf8');
    await context.runProcess('git', ['add', '--', relativeWorkflowPath, relativeConfigPath], {
      cwd: context.paths.clone,
      env: context.driverEnv,
      timeoutMs: context.options.timeoutMs,
      redactOutput: true,
    });
    await context.runProcess('git', [
      '-c', 'user.name=GateFlow Release E2E',
      '-c', 'user.email=gateflow-release-e2e@example.invalid',
      'commit', '-m', 'test: configure Gate token secret',
    ], {
      cwd: context.paths.clone,
      env: context.driverEnv,
      timeoutMs: context.options.timeoutMs,
      redactOutput: true,
    });
    await context.runProcess('git', ['push', '--set-upstream', 'origin', 'HEAD'], {
      cwd: context.paths.clone,
      env: context.driverEnv,
      timeoutMs: context.options.timeoutMs,
      redactOutput: true,
    });

    const verifiedWorkflow = await readFile(workflowPath, 'utf8');
    const verifiedConfig = await readFile(configPath, 'utf8');
    assert(!verifiedWorkflow.includes(GITHUB_TOKEN_EXPRESSION), `workflow still contains ${GITHUB_TOKEN_EXPRESSION}`);
    const verifiedCount = verifiedWorkflow.split(GATE_TOKEN_EXPRESSION).length - 1;
    assert(verifiedCount === replacementCount, `workflow replacement count changed: expected ${replacementCount}, received ${verifiedCount}`);
    const driverGateLogins = verifyGateLogin(verifiedConfig, login);
    const result = {
      status: 'passed',
      secret: { status: 'passed', name: GATE_TOKEN_SECRET, repository },
      workflow: {
        status: 'passed',
        path: workflowPath,
        workflowFile,
        replaced: replacementCount,
        expression: GATE_TOKEN_EXPRESSION,
      },
      config: {
        status: 'passed',
        path: configPath,
        gateLogin: login,
        gateLogins: driverGateLogins,
        changed: configUpdate.changed,
      },
      commit: { status: 'passed' },
      push: { status: 'passed' },
    };
    context.gateTokenResult = result;
    return result;
  } catch (error) {
    context.gateTokenResult = {
      status: 'failed',
      secret: { status: 'unknown', name: GATE_TOKEN_SECRET, repository },
      workflow: { status: 'failed', path: workflowPath, workflowFile },
      config: { status: 'failed', path: configPath, gateLogin: login },
    };
    throw error;
  }
}

function jsonOutput(result, label) {
  try {
    return typeof result === 'string' ? JSON.parse(result) : JSON.parse(result.stdout);
  } catch (error) {
    throw new E2EError(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Prepare one Driver task and stop, without claiming that the full E2E passed. */
export async function prepareAgentWorkspace(context) {
  assert(context.repository !== null, 'repository must exist before --prepare-agent');
  const repository = context.repository.fullName;
  const title = 'GateFlow release E2E: prepare agent workspace';
  const body = 'Prepare a GateFlow Driver task for the release E2E agent. No business change is requested yet.';
  context.log(`[e2e] prepare-agent: creating Issue in ${repository}`);
  const issueRaw = await context.gh.run([
    'api', `repos/${repository}/issues`, '--method', 'POST',
    '-f', `title=${title}`, '-f', `body=${body}`,
  ], { cwd: context.root, timeoutMs: context.options.timeoutMs });
  const issue = jsonOutput(issueRaw, 'prepare-agent Issue creation');
  const issueNumber = Number(issue.number);
  assert(Number.isSafeInteger(issueNumber) && issueNumber > 0, 'prepare-agent Issue response has no number');
  const issueUrl = issue.html_url ?? issue.url ?? `https://github.com/${repository}/issues/${issueNumber}`;
  context.prepareAgentIssue = { number: issueNumber, url: issueUrl };
  await context.gh.run([
    'api', `repos/${repository}/issues/${issueNumber}/comments`, '--method', 'POST',
    '-f', 'body=/ai-plan',
  ], { cwd: context.root, timeoutMs: context.options.timeoutMs });
  await context.waitFor({
    description: `prepare-agent Issue #${issueNumber} to enter ai:planning`,
    timeoutMs: context.options.timeoutMs,
    intervalMs: context.options.pollIntervalMs,
    check: async () => {
      const current = await context.gh.json([
        'issue', 'view', String(issueNumber), '--repo', repository, '--json', 'labels,comments',
      ], { cwd: context.root, timeoutMs: context.options.timeoutMs });
      const labels = (current.labels ?? []).map((label) => typeof label === 'string' ? label : label?.name);
      const comments = current.comments ?? [];
      const hasEpoch = comments.some((comment) => String(comment.body ?? '').includes('gateflow:workflow:v2'));
      return labels.includes('ai:planning') && hasEpoch ? { labels } : false;
    },
  });
  const driver = await context.runProcess(process.execPath, [
    resolve(context.root, 'dist', 'cli.js'),
    'run', '--issue', String(issueNumber), '--root', context.paths.clone,
    '--target-repository', repository, '--target-workspace', context.paths.clone,
  ], {
    cwd: context.root,
    env: context.driverEnv,
    timeoutMs: context.options.timeoutMs,
    redactOutput: true,
  });
  const taskMatch = /(?:^|\n)task:\s*(\S+)/.exec(driver.stdout);
  assert(taskMatch?.[1], `prepare-agent Driver did not report a task id; output: ${driver.stdout.trim() || '(empty)'}`);
  const result = {
    repository,
    workspace: context.paths.clone,
    issue: { number: issueNumber, url: issueUrl },
    taskId: taskMatch[1],
  };
  context.prepareAgentResult = result;
  context.log(`[e2e] READY FOR AGENT repository=${repository} issue=#${issueNumber} task=${result.taskId} workspace=${result.workspace}`);
  return result;
}

/**
 * Success removes the disposable clone and remote. Failure deliberately keeps
 * both so a GitHub run can be diagnosed. --keep preserves them after success.
 */
export async function cleanup(context, { success = false } = {}) {
  const preserve = context.options.keep || !success || context.prepareAgentResult !== null;
  const errors = [];
  if (!context.cleanup.remoteCreated || context.repository === null) {
    context.cleanup.completed = true;
    return { preserved: preserve, errors };
  }
  if (preserve) {
    context.log(
      `[e2e] retaining ${success ? 'success' : 'failure'} artifacts: repository ${context.repository.fullName}, ` +
        `clone ${context.paths.clone ?? '(not cloned)'}`,
    );
    context.cleanup.completed = true;
    return { preserved: true, errors };
  }
  try {
    await context.gh.run(['repo', 'delete', context.repository.fullName, '--yes'], {
      cwd: context.root,
      timeoutMs: context.options.timeoutMs,
    });
    context.log(`[e2e] deleted repository ${context.repository.fullName}`);
  } catch (error) {
    errors.push(`remote cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (context.paths.clone !== null) {
    try {
      await rm(context.paths.clone, { recursive: true, force: true });
    } catch (error) {
      errors.push(`clone cleanup failed at ${context.paths.clone}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  context.cleanup.completed = true;
  if (errors.length > 0) {
    const failure = new E2EError(errors.join('; '));
    failure.context = context;
    throw failure;
  }
  return { preserved: false, errors };
}
