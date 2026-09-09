/**
 * Deterministic agent used by the release E2E.
 *
 * This is intentionally a very small Workspace Protocol client.  It learns
 * the task identity and mode from task.json, reads only the declared task
 * inputs, and writes the protocol output files in that task directory.  The
 * status/progress files are human-readable test breadcrumbs; Driver sync
 * ignores them.  The root plan.md/report.md files are the schema-3 outputs.
 * PLAN/ and REPORT/ are mirrors kept for the release fixture's easy visual
 * inspection and are never used as protocol inputs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const DEFAULT_HELLO = 'hello from GateFlow release E2E\n';

function outputOf(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if ('stdout' in value && typeof value.stdout === 'string') return value.stdout;
    if ('output' in value && typeof value.output === 'string') return value.output;
  }
  return value;
}

async function runCommand(context, command, args, options = {}) {
  const commandOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? context.options?.timeoutMs ?? 10 * 60 * 1000,
    env: options.env ?? { ...process.env, ...(context.env ?? {}), ...(context.githubToken ? { GITHUB_TOKEN: context.githubToken } : {}) },
  };
  if (typeof context.runCommand === 'function') {
    return context.runCommand(command, args, commandOptions);
  }
  if (typeof context.exec === 'function') {
    return context.exec(command, args, commandOptions);
  }
  if (typeof context.runProcess === 'function') {
    return context.runProcess(command, args, commandOptions);
  }
  if (typeof context.run === 'function') {
    return context.run(command, args, commandOptions);
  }
  throw new Error(`E2E context must provide runCommand/exec/run to execute ${command}`);
}

function agentLocalEnv(context) {
  const env = { ...process.env, ...(context.localEnv ?? context.env ?? {}) };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'GITHUB_TOKEN' || key.toUpperCase() === 'GH_TOKEN') delete env[key];
  }
  return env;
}

async function runGit(context, args, cwd) {
  const options = {
    cwd,
    timeoutMs: context.options?.timeoutMs ?? 10 * 60 * 1000,
    env: agentLocalEnv(context),
  };
  if (typeof context.git === 'function') return context.git(args, options);
  return runCommand(context, 'git', args, options);
}

async function writeText(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function writeJson(file, value) {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function absoluteTaskDirectory(options, taskId) {
  const directory = options.taskDirectory ?? options.taskDir;
  if (typeof directory === 'string') {
    if (taskId && path.basename(directory) !== taskId) {
      throw new Error('fake agent taskDirectory basename does not match taskId');
    }
    return path.resolve(directory);
  }
  if (typeof options.workspaceRoot !== 'string') {
    throw new Error('fake agent needs taskDirectory or workspaceRoot');
  }
  if (taskId.includes('/') || taskId.includes('\\') || taskId === '.' || taskId === '..') {
    throw new Error('fake agent taskId must be a single workspace directory name');
  }
  return path.resolve(options.workspaceRoot, '.gateflow', 'tasks', taskId);
}

function phaseOf(options, mode) {
  const phase = options.phase ?? options.stage;
  if (mode === 'plan') return 'completed';
  if (phase === undefined) return 'completed';
  if (phase !== 'working' && phase !== 'completed') {
    throw new Error(`fake executor phase must be "working" or "completed", got ${JSON.stringify(phase)}`);
  }
  return phase;
}

async function readTask(taskDirectory) {
  const raw = JSON.parse(await readFile(path.join(taskDirectory, 'task.json'), 'utf8'));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('fake agent found a non-object task.json');
  }
  if (typeof raw.task_id !== 'string' || (raw.mode !== 'plan' && raw.mode !== 'execute')) {
    throw new Error('fake agent found task.json without a valid task_id/mode');
  }
  return raw;
}

async function readDeclaredInputs(taskDirectory, task) {
  const inputs = {
    task: await readFile(path.join(taskDirectory, task.input?.task ?? 'task.md'), 'utf8'),
  };
  if (task.mode === 'execute') {
    inputs.plan = await readFile(path.join(taskDirectory, task.input?.plan ?? 'plan.md'), 'utf8');
  }
  if (task.input?.feedback !== null && task.input?.feedback !== undefined) {
    inputs.feedback = await readFile(path.join(taskDirectory, task.input.feedback), 'utf8');
  }
  return inputs;
}

async function writeBreadcrumbs(taskDirectory, task, status, progress) {
  await writeJson(path.join(taskDirectory, 'status.json'), {
    task_id: task.task_id,
    mode: task.mode,
    status,
  });
  await writeText(path.join(taskDirectory, 'PROGRESS.md'), `${progress.trim()}\n`);
}

async function writeMirroredOutput(taskDirectory, directoryName, fileName, content) {
  // The root file is the schema-3 file consumed by Driver sync.  The mirror
  // is deliberately just Markdown and is not referenced by result.json.
  await writeText(path.join(taskDirectory, fileName), content);
  await writeText(path.join(taskDirectory, directoryName, fileName), content);
}

async function executeTargetChange(context, task, options) {
  const targetWorkspace = task.target_workspace;
  if (typeof targetWorkspace !== 'string' || !path.isAbsolute(targetWorkspace)) {
    throw new Error('execute task has no absolute target_workspace');
  }
  const mutation = options.mutation ?? null;
  const relativeFile = mutation?.path ?? 'hello.txt';
  if (typeof relativeFile !== 'string' || path.isAbsolute(relativeFile) || relativeFile === '' || relativeFile === '.' || relativeFile === '..') {
    throw new Error(`fake executor mutation.path must be a relative file, got ${JSON.stringify(relativeFile)}`);
  }
  const targetFile = path.resolve(targetWorkspace, relativeFile);
  const targetRoot = path.resolve(targetWorkspace) + path.sep;
  if (!targetFile.startsWith(targetRoot)) throw new Error('fake executor mutation.path escapes target workspace');

  let hello;
  if (mutation?.type === 'append-line') {
    if (typeof mutation.line !== 'string' || mutation.line.length === 0) {
      throw new Error('fake executor append-line mutation requires a non-empty line');
    }
    const current = options.baseContent;
    if (typeof current !== 'string') {
      throw new Error('fake executor append-line requires baseContent supplied by the scenario');
    }
    hello = `${current}${current.length > 0 && !current.endsWith('\n') ? '\n' : ''}${mutation.line}\n`;
    if (options.helloContent !== undefined && options.helloContent !== hello) {
      throw new Error(`append-line result differs from options.helloContent: expected ${JSON.stringify(options.helloContent)}, got ${JSON.stringify(hello)}`);
    }
  } else if (mutation !== null && mutation.type !== undefined) {
    throw new Error(`unsupported fake executor mutation type ${JSON.stringify(mutation.type)}`);
  } else {
    hello = options.helloContent ?? DEFAULT_HELLO;
  }

  await writeText(targetFile, hello);
  await runGit(context, ['add', '--', relativeFile], targetWorkspace);
  await runGit(
    context,
    ['-c', 'user.name=GateFlow E2E', '-c', 'user.email=gateflow-e2e@example.invalid', 'commit', '-m', `e2e: update ${relativeFile}`],
    targetWorkspace,
  );
  await runGit(context, ['push', '--set-upstream', 'origin', 'HEAD'], targetWorkspace);
  return { targetWorkspace, relativeFile, helloContent: hello, mutation };
}

/**
 * Run one fake plan/executor activation.
 *
 * `options.phase="working"` is only meaningful for execute tasks.  It makes
 * the target change and push, then leaves result.json absent so the first
 * Driver sync must create the execution Tracker.  A later call with
 * `phase="completed"` writes report.md and the minimal schema-3 result.
 */
export async function runFakeAgent(context, options = {}) {
  const initialTaskId = options.taskId;
  const taskDirectory = absoluteTaskDirectory(options, initialTaskId ?? '');
  const task = await readTask(taskDirectory);
  const inputs = await readDeclaredInputs(taskDirectory, task);
  const phase = phaseOf(options, task.mode);

  if (task.mode === 'execute' && phase === 'working') {
    const target = await executeTargetChange(context, task, options);
    await writeBreadcrumbs(taskDirectory, task, 'working', 'Target workspace updated and pushed; waiting for Driver Tracker sync.');
    return { task, taskDirectory, inputs, phase, target, result: null };
  }

  if (task.mode === 'plan') {
    if (typeof options.planContent !== 'string') throw new Error('fake planner needs planContent supplied by the scenario');
    const plan = options.planContent;
    await writeMirroredOutput(taskDirectory, 'PLAN', 'plan.md', plan);
    await writeBreadcrumbs(taskDirectory, task, 'completed', 'Deterministic plan written; ready for Driver sync.');
    const result = { schema: task.schema, task_id: task.task_id, mode: task.mode, status: 'completed', report: 'plan.md' };
    await writeJson(path.join(taskDirectory, 'result.json'), result);
    return { task, taskDirectory, inputs, phase, result };
  }

  if (typeof options.reportContent !== 'string') throw new Error('fake executor needs reportContent supplied by the scenario');
  const report = options.reportContent;
  const target = options.skipTargetChange === true ? undefined : await executeTargetChange(context, task, options);
  await writeMirroredOutput(taskDirectory, 'REPORT', 'report.md', report);
  await writeBreadcrumbs(taskDirectory, task, 'completed', 'Target change pushed; completion report written; ready for Driver sync.');
  const result = {
    schema: task.schema,
    task_id: task.task_id,
    mode: task.mode,
    status: 'completed',
    report: 'report.md',
    validation: 'passed',
  };
  await writeJson(path.join(taskDirectory, 'result.json'), result);
  return { task, taskDirectory, inputs, phase, target, result };
}

export const fakeAgent = runFakeAgent;

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error('fake-agent.mjs is a library; invoke runFakeAgent from the release E2E scenario.');
  process.exitCode = 2;
}
