#!/usr/bin/env node
/**
 * Existing-project reconnect scenario.
 *
 * This module deliberately owns only repository/file lifecycle work. The
 * normal Issue flow remains in the workflow scenario and is injected through
 * the shared E2E context, so this file cannot accidentally become a second
 * implementation of the Gate or Workspace protocol.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor as boundedWaitFor } from '../wait.mjs';

const execFile = promisify(nodeExecFile);
const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const GATEFLOW_LABEL = /^ai:/i;

/** Preserve the actual project baseline when checking an append-line result. */
export function expectedAppendedContent(baseContent, line) {
  return `${baseContent}${baseContent.length > 0 && !baseContent.endsWith('\n') ? '\n' : ''}${line}\n`;
}

function fail(message) {
  throw new Error(`[reconnect] ${message}`);
}

function value(context, ...keys) {
  for (const key of keys) {
    if (context?.[key] !== undefined && context[key] !== null) return context[key];
  }
  return undefined;
}

function repositoryOf(context) {
  const candidate = value(context, 'targetRepository', 'controlRepository', 'repository', 'repo');
  const repository = typeof candidate === 'object' && candidate !== null
    ? candidate.fullName ?? candidate.nameWithOwner
    : candidate ?? context?.repository?.fullName ?? context?.repository?.nameWithOwner;
  if (typeof repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    fail('shared context must provide repository as owner/name');
  }
  return repository;
}

function targetDirOf(context, data = {}) {
  const targetDir = value(data, 'targetDir', 'workdir', 'cloneDir')
    ?? value(context, 'targetDir', 'workdir', 'cloneDir', 'targetWorkspace')
    ?? context?.paths?.clone;
  if (typeof targetDir !== 'string' || resolve(targetDir) === resolve(targetDir, '..')) {
    fail('shared context must provide a non-root targetDir/workdir');
  }
  return resolve(targetDir);
}

async function command(context, file, args, options = {}) {
  const runner = value(context, 'execFile', 'runCommand', 'runProcess', 'command', 'exec');
  if (typeof runner === 'function') {
    const result = await runner(file, args, options);
    if (typeof result === 'string') return { stdout: result, stderr: '' };
    return result ?? { stdout: '', stderr: '' };
  }
  try {
    return await execFile(file, args, {
      cwd: options.cwd ?? context.cwd,
      env: { ...process.env, ...(context.env ?? {}), ...(options.env ?? {}) },
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const detail = `${error?.message ?? error}${error?.stdout ? `\n${error.stdout}` : ''}`;
    fail(`command failed: ${file} ${args.join(' ')}\n${detail}`);
  }
}

async function git(context, args, cwd) {
  return command(context, 'git', args, {
    cwd,
    timeoutMs: context.options?.timeoutMs ?? context.timeoutMs ?? 10 * 60 * 1000,
  });
}

function stdoutOf(result) {
  return String(result?.stdout ?? result?.output ?? result ?? '').trim();
}

async function githubCall(context, method, path, body) {
  const github = value(context, 'github', 'githubApi', 'gh');
  if (github && typeof github.request === 'function') {
    return github.request(method, path, body);
  }
  if (github && typeof github.api === 'function') {
    return github.api(path, { method, body });
  }
  if (github && method === 'GET' && typeof github.json === 'function') {
    return github.json(['api', path], { cwd: context.root, timeoutMs: context.options?.timeoutMs });
  }
  if (github && typeof github.run === 'function') {
    const args = ['api', path];
    if (method !== 'GET') args.push('--method', method);
    return github.run(args, {
      cwd: context.root,
      timeoutMs: context.options?.timeoutMs,
      ...(body === undefined ? {} : { input: JSON.stringify(body) }),
    });
  }
  const args = ['api', path];
  if (method !== 'GET') args.push('--method', method);
  if (body !== undefined) args.push('--input', '-');
  const result = await command(context, 'gh', args, {
    input: body === undefined ? undefined : JSON.stringify(body),
  });
  const output = stdoutOf(result);
  return output.length === 0 ? null : JSON.parse(output);
}

async function listLabels(context, repository) {
  const github = value(context, 'github', 'gh');
  if (github && typeof github.listLabels === 'function') {
    return github.listLabels(repository);
  }
  const labels = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = await githubCall(context, 'GET', `repos/${repository}/labels?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) fail('GitHub labels response was not an array');
    labels.push(...batch);
    if (batch.length < 100) return labels;
  }
  fail(`GitHub labels pagination exceeded the safety limit for ${repository}`);
}

async function deleteLabel(context, repository, name) {
  const github = value(context, 'github', 'gh');
  if (github && typeof github.deleteLabel === 'function') {
    return github.deleteLabel(repository, name);
  }
  return githubCall(context, 'DELETE', `repos/${repository}/labels/${encodeURIComponent(name)}`);
}

function workflowRelativePath(context, firstRound = {}) {
  const bootstrap = value(firstRound, 'bootstrap', 'bootstrapResult') ?? value(context, 'bootstrapResult');
  if (!bootstrap || typeof bootstrap !== 'object') {
    fail('context.bootstrapResult is required to identify the installed workflow');
  }
  const target = value(bootstrap ?? {}, 'target', 'workflowPath');
  const workflowFile = value(bootstrap, 'workflowFile');
  if (typeof target !== 'string' || typeof workflowFile !== 'string') {
    fail('context.bootstrapResult must return target and workflowFile');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:yml|yaml)$/.test(workflowFile)) {
    fail(`invalid Bootstrap workflow filename: ${workflowFile}`);
  }
  const targetDir = targetDirOf(context, firstRound);
  const rel = relative(targetDir, resolve(target));
  if (rel.startsWith('..') || !rel.startsWith(`.github${sep}workflows${sep}`)) {
    fail(`Bootstrap workflow target is outside .github/workflows: ${target}`);
  }
  if (rel !== join('.github', 'workflows', workflowFile)) {
    fail(`Bootstrap workflow target does not match workflowFile: ${target} / ${workflowFile}`);
  }
  return { relativePath: rel, bootstrap };
}

function actionRefFromBootstrap(bootstrap, workflow) {
  const returned = value(bootstrap, 'actionRef', 'gateflowActionRef');
  const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)]
    .map((match) => match[1])
    .filter((ref) => /gateflow/i.test(ref));
  if (uses.length !== 1) {
    fail('Bootstrap result/workflow does not identify exactly one GateFlow Action ref');
  }
  if (typeof returned === 'string' && returned.length > 0) {
    if (returned !== uses[0]) fail(`Bootstrap Action ref differs from generated workflow: ${returned} / ${uses[0]}`);
    return returned;
  }
  return uses[0];
}

function gateflowConfigLooksGenerated(content, repository) {
  return /^\s*version\s*:\s*1\s*$/m.test(content)
    && new RegExp(`^\\s*repository\\s*:\\s*${repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(content);
}

function stripRuntimeIgnore(content) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line, index) => {
    if (/^\s*\.gateflow\/?\s*$/.test(line)) return false;
    if (/^\s*# GateFlow V1 local runtime\s*$/.test(line)) {
      const next = lines[index + 1] ?? '';
      return !/^\s*\.gateflow\/?\s*$/.test(next);
    }
    return true;
  });
  return kept.join(newline).replace(new RegExp(`(?:${newline}){3,}`, 'g'), `${newline}${newline}`);
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function gitSnapshot(context, cwd) {
  const [head, count, log] = await Promise.all([
    git(context, ['rev-parse', 'HEAD'], cwd),
    git(context, ['rev-list', '--count', 'HEAD'], cwd),
    git(context, ['log', '--format=%H'], cwd),
  ]);
  return {
    head: stdoutOf(head),
    count: Number(stdoutOf(count)),
    log: stdoutOf(log).split(/\r?\n/).filter(Boolean),
  };
}

async function commitAndPush(context, cwd, paths, message) {
  // `.gateflow/` is intentionally ignored by Bootstrap and is normally
  // untracked, so passing a now-absent directory as a Git pathspec makes
  // `git add` fail. The tracked file deletions remain covered by the other
  // explicit pathspecs.
  const stagePaths = paths.filter((path) => path !== '.gateflow');
  await git(context, ['add', '-A', '--', ...stagePaths], cwd);
  const status = stdoutOf(await git(context, ['status', '--porcelain', '--', ...paths], cwd));
  if (status.length === 0) fail(`expected reconnect changes before commit ${JSON.stringify(message)}`);
  await git(context, ['commit', '-m', message], cwd);
  await git(context, ['push'], cwd);
  return gitSnapshot(context, cwd);
}

/** Remove only the files and labels generated by the real Bootstrap run. */
export async function removeGateFlowIntegration(context, firstRound = {}) {
  const repository = repositoryOf(context);
  const targetDir = targetDirOf(context, firstRound);
  const businessFiles = {};
  for (const name of ['README.md', 'hello.txt']) {
    businessFiles[name] = await readOptional(join(targetDir, name));
    if (businessFiles[name] === null) fail(`first-round project is missing required business file ${name}`);
  }
  const before = await gitSnapshot(context, targetDir);
  const workflowInfo = workflowRelativePath(context, firstRound);
  const workflowRel = workflowInfo.relativePath;
  const workflowPath = join(targetDir, workflowRel);
  const configPath = join(targetDir, 'gateflow.config.yml');
  const runtimePath = join(targetDir, '.gateflow');
  const workflow = await readOptional(workflowPath);
  const config = await readOptional(configPath);
  if (workflow === null) fail(`first-round Bootstrap workflow is missing: ${workflowPath}`);
  if (config === null) fail(`first-round Bootstrap config is missing: ${configPath}`);
  if (!/gateflow|ai-workflow/i.test(workflow)) {
    fail(`refusing to remove a non-GateFlow workflow: ${workflowPath}`);
  }
  if (!gateflowConfigLooksGenerated(config, repository)) {
    fail(`refusing to remove a non-generated gateflow.config.yml: ${configPath}`);
  }
  const actionRef = actionRefFromBootstrap(workflowInfo.bootstrap, workflow);

  if (workflow !== null) await rm(workflowPath, { force: true });
  if (config !== null) await rm(configPath, { force: true });
  await rm(runtimePath, { recursive: true, force: true });
  const gitignorePath = join(targetDir, '.gitignore');
  const gitignore = await readOptional(gitignorePath);
  if (gitignore !== null) {
    await writeFile(gitignorePath, stripRuntimeIgnore(gitignore), 'utf8');
  }

  const labels = await listLabels(context, repository);
  const removedLabels = [];
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label?.name;
    if (typeof name === 'string' && GATEFLOW_LABEL.test(name)) {
      await deleteLabel(context, repository, name);
      removedLabels.push(name);
    }
  }
  const afterRemoval = await commitAndPush(
    context,
    targetDir,
    [workflowRel, 'gateflow.config.yml', '.gitignore', '.gateflow'],
    'test: remove gateflow integration',
  );
  for (const name of ['README.md', 'hello.txt']) {
    const current = await readOptional(join(targetDir, name));
    if (current !== businessFiles[name]) fail(`${name} changed while removing GateFlow integration`);
  }
  if (afterRemoval.count !== before.count + 1 || afterRemoval.log[1] !== before.head) {
    fail('removal commit did not preserve the pre-removal business history');
  }
  return {
    repository,
    targetDir,
    workflowRel,
    actionRef,
    businessFiles,
    before,
    afterRemoval,
    removedLabels,
  };
}

async function runBootstrap(context, targetDir, repository, actionRef) {
  if (typeof actionRef !== 'string' || actionRef.length === 0) {
    fail('cannot reconnect without the Action ref from context.bootstrapResult');
  }
  const bootstrap = value(context, 'runBootstrap', 'bootstrap');
  const args = [
    join(ROOT, 'scripts', 'bootstrap.mjs'),
    '--repo', repository,
    '--workdir', targetDir,
    '--install-mode', 'existing',
    '--yes',
    '--non-interactive',
    '--github-config',
  ];
  args.push('--action-ref', actionRef);
  if (typeof bootstrap === 'function') {
    // A harness-provided bootstrap helper may either accept the full option
    // object or the exact argv array. Prefer the documented object form.
    return bootstrap({ context, args, targetDir, repository, actionRef, commit: false });
  }
  let token = context.env?.GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token && context.gh && typeof context.gh.text === 'function') {
    // Bootstrap uses fetch rather than gh, so bridge the already-authenticated
    // local gh credential into the child process without putting it in argv.
    token = await context.gh.text(['auth', 'token'], {
      cwd: context.root,
      timeoutMs: context.options?.timeoutMs,
    });
  }
  return command(context, process.execPath, args, {
    cwd: ROOT,
    timeoutMs: context.options?.timeoutMs,
    env: { ...process.env, ...(context.env ?? {}), ...(token ? { GITHUB_TOKEN: token } : {}) },
  });
}

/** Re-run the actual Bootstrap and verify business/history preservation. */
export async function reconnectExistingProject(context, removed) {
  const repository = removed.repository ?? repositoryOf(context);
  const targetDir = removed.targetDir ?? targetDirOf(context, removed);
  const actionRef = value(removed, 'actionRef')
    ?? value(context, 'actionRef', 'gateflowActionRef')
    ?? value(context.firstRound ?? {}, 'actionRef')
    ?? (context.preflight?.head ? `jesongit/gateflow@${context.preflight.head}` : undefined);
  const bootstrapResult = await runBootstrap(context, targetDir, repository, actionRef);
  const workflowPath = join(targetDir, removed.workflowRel);
  const workflow = await readOptional(workflowPath);
  const config = await readOptional(join(targetDir, 'gateflow.config.yml'));
  if (workflow === null || (actionRef && !workflow.includes(actionRef))) {
    fail('reconnect Bootstrap did not restore the expected workflow/action ref');
  }
  if (config === null || !/^\s*version\s*:\s*1\s*$/m.test(config)) {
    fail('reconnect Bootstrap did not restore gateflow.config.yml');
  }
  const labels = await listLabels(context, repository);
  const names = new Set(labels.map((label) => typeof label === 'string' ? label : label?.name));
  const expectedLabels = ['ai:planning', 'ai:review', 'ai:ready', 'ai:working', 'ai:blocked', 'ai:done'];
  const missing = expectedLabels.filter((name) => !names.has(name));
  if (missing.length > 0) fail(`reconnect Bootstrap did not restore labels: ${missing.join(', ')}`);
  for (const [name, content] of Object.entries(removed.businessFiles ?? {})) {
    if (await readOptional(join(targetDir, name)) !== content) fail(`${name} was overwritten during reconnect`);
  }
  const afterBootstrap = await gitSnapshot(context, targetDir);
  if (afterBootstrap.head !== removed.afterRemoval.head) {
    fail('Bootstrap unexpectedly committed business history; reconnect commit must be explicit');
  }
  const afterReconnect = await commitAndPush(
    context,
    targetDir,
    [removed.workflowRel, 'gateflow.config.yml', '.gitignore'],
    'test: reconnect gateflow',
  );
  if (afterReconnect.log[1] !== removed.afterRemoval.head) fail('reconnect commit changed history ordering');
  const configure = value(context, 'configureGateToken');
  if (typeof configure !== 'function') {
    fail('shared context must provide configureGateToken before the second Issue');
  }
  const gateToken = await configure();
  return { ...removed, bootstrapResult, afterBootstrap, afterReconnect, gateToken, actionRef };
}

function workflowRunner(context) {
  return value(context, 'runWorkflow', 'runIssueFlow', 'runScenario')
    ?? value(context.workflow ?? {}, 'run')
    ?? value(context.scenarios?.workflow ?? {}, 'run');
}

/** Run the second, normal Issue flow through the shared workflow scenario. */
export async function runSecondIssue(context, reconnect) {
  let runner = workflowRunner(context);
  if (typeof runner !== 'function') {
    const workflowUrl = new URL('./workflow.mjs', import.meta.url);
    try {
      const imported = await import(workflowUrl.href);
      runner = imported.runWorkflowScenario ?? imported.runWorkflow ?? imported.run;
    } catch {
      runner = null;
    }
  }
  if (typeof runner !== 'function') {
    fail('shared context must provide the workflow scenario runner for the second Issue');
  }
  const repository = reconnect.repository;
  const targetDir = reconnect.targetDir;
  const baseHello = await readFile(join(targetDir, 'hello.txt'), 'utf8');
  const expectedHello = expectedAppendedContent(baseHello, 'world');
  let driverToken = context.env?.GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!driverToken && context.gh && typeof context.gh.text === 'function') {
    driverToken = await context.gh.text(['auth', 'token'], {
      cwd: context.root,
      timeoutMs: context.options?.timeoutMs,
    });
  }
  const workflowEnv = {
    ...process.env,
    ...(context.env ?? {}),
    ...(driverToken ? { GITHUB_TOKEN: driverToken } : {}),
  };
  const workflowContext = {
    ...context,
    controlRepository: context.controlRepository ?? repository,
    controlWorkspace: context.controlWorkspace ?? targetDir,
    targetRepository: context.targetRepository ?? repository,
    targetWorkspace: context.targetWorkspace ?? targetDir,
    mutation: { type: 'append-line', path: 'hello.txt', line: 'world' },
    repositoryRoot: context.repositoryRoot ?? ROOT,
    runCommand: context.runCommand ?? ((program, args, options = {}) => {
      if (typeof context.runProcess === 'function') {
        return context.runProcess(program, args, { ...options, env: workflowEnv });
      }
      if (typeof context.exec === 'function') return context.exec(program, args, options);
      throw new Error(`E2E context cannot execute ${program}`);
    }),
    gh: typeof context.gh === 'function'
      ? context.gh
      : context.gh?.run
        ? (args, options) => context.gh.run(args, options)
        : context.gh,
    waitFor: context.waitFor ?? ((options) => boundedWaitFor(
      options.description,
      options.check,
      { timeoutMs: options.timeoutMs, intervalMs: options.intervalMs },
    )),
  };
  const result = await runner(workflowContext, {
    title: 'E2E: append world',
    body: 'Append a second line to hello.txt: world',
    mutation: workflowContext.mutation,
    helloContent: expectedHello,
    expectedFile: { path: 'hello.txt', content: expectedHello },
    reconnect,
  });
  // Keep the original context object visible to a harness, but pass the
  // normalized Control/Target bindings to the workflow scenario.
  if (result === undefined) fail('workflow scenario returned no result');
  const local = await readOptional(join(targetDir, 'hello.txt'));
  if (local !== expectedHello) fail(`second Issue did not leave hello.txt with the expected append result: ${JSON.stringify(local)}`);
  return { ...result, title: 'E2E: append world', expectedHello };
}

/** Entry point used by scripts/e2e-release.mjs. */
export async function run(context) {
  const firstRound = value(context, 'firstRound', 'workflowResult', 'newProjectResult') ?? {};
  const removed = await removeGateFlowIntegration(context, firstRound);
  const reconnected = await reconnectExistingProject(context, removed);
  const secondIssue = await runSecondIssue({ ...context, firstRound, reconnected }, reconnected);
  return { removed, reconnected, secondIssue };
}

export const runReconnectScenario = run;
