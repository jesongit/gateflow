/**
 * `gateflow` CLI — the V1 Manual-Activation driver (docs/plans/
 * v1-simplification-plan.md §7).
 *
 * Usage:
 *   gateflow run    [--issue <n>] [--root <dir>] [--config <file>]
 *   gateflow sync   [--root <dir>] [--config <file>]
 *   gateflow status [--root <dir>] [--config <file>]
 *   gateflow retry  <task-id> [--root <dir>] [--config <file>]
 *
 * - `run` prepares the active task directory and prints the prompt to paste
 *   into ChatGPT / ZCode. `--issue` explicitly switches the active task.
 * - `sync` publishes validated task results to GitHub (Plan / Tracker /
 *   Report comments; the Gate alone transitions state).
 * - `status` is OFFLINE: it only reads local workspace files.
 * - `retry <task-id>` clears the driver-state record so the next `run`
 *   re-prepares the task. Offline.
 * - `run` / `sync` need GITHUB_TOKEN in the environment; the token lives
 *   only in the Driver process environment, never on disk. Repository
 *   resolution order: config `repository` → GATEFLOW_REPOSITORY → git
 *   remote origin.
 * - Console logger with timestamps, mirrored (best-effort, never crashing)
 *   into `<workspace>/driver/logs/driver.log`.
 * - Exit codes: 0 success, 1 usage/config/infrastructure error.
 *
 * No new dependencies: argv parsing is manual.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { createDriverGitHubClient, createOctokit } from './github/client';
import { ConfigError, loadConfig, resolveRepository } from './driver/config';
import { runCommand, syncCommand } from './driver/driver';
import type { DriverDeps, DriverLogger } from './driver/driver';
import { readCurrent } from './workspace/tasks';
import { readDriverState } from './workspace/driver-state';
import { resolveWorkspace } from './workspace/paths';
import type { WorkspacePaths } from './workspace/paths';
import { TASK_ID_PATTERN } from './workspace/protocol';
import { clearTask } from './driver/sync';

const USAGE = `gateflow — local GateFlow driver (Manual Activation)

Usage:
  gateflow run    [--issue <n>] [--root <dir>] [--config <file>]
                  discover GitHub state, prepare the active task, print the AI prompt
  gateflow sync   [--root <dir>] [--config <file>]
                  validate task results and publish them to GitHub
  gateflow status [--root <dir>] [--config <file>]
                  show local workspace state (offline)
  gateflow retry  <task-id> [--root <dir>]
                  clear a task's driver state so the next run re-prepares it (offline)

Environment:
  GITHUB_TOKEN          required for run/sync; never written to disk
  GATEFLOW_REPOSITORY   optional owner/name fallback for repository resolution`;

interface CliArgs {
  command: 'run' | 'sync' | 'status' | 'retry';
  taskId: string | null;
  issue: number | null;
  root: string;
  config: string;
}

function parseArgs(argv: string[]): { ok: true; args: CliArgs } | { ok: false; error: string } {
  const positionals: string[] = [];
  let root = process.cwd();
  let config = 'gateflow.config.yml';
  let issue: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--root' || arg === '--config' || arg === '--issue') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `flag ${arg} requires a value` };
      }
      if (arg === '--root') root = value;
      else if (arg === '--config') config = value;
      else {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          return { ok: false, error: `--issue must be a positive integer, got ${JSON.stringify(value)}` };
        }
        issue = parsed;
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
      continue;
    }
    if (arg.startsWith('--config=')) {
      config = arg.slice('--config='.length);
      continue;
    }
    if (arg.startsWith('--issue=')) {
      const parsed = Number(arg.slice('--issue='.length));
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        return { ok: false, error: `--issue must be a positive integer, got ${JSON.stringify(arg.slice('--issue='.length))}` };
      }
      issue = parsed;
      continue;
    }
    if (arg.startsWith('--')) {
      return { ok: false, error: `unknown flag "${arg}"` };
    }
    positionals.push(arg);
  }

  const command = positionals[0];
  if (command !== 'run' && command !== 'sync' && command !== 'status' && command !== 'retry') {
    return { ok: false, error: `unknown command "${command ?? ''}"` };
  }
  const taskId = positionals[1] ?? null;
  if (command === 'retry' && taskId === null) {
    return { ok: false, error: 'retry requires a <task-id> argument' };
  }
  return { ok: true, args: { command, taskId, issue, root, config } };
}

/** Timestamped console logger mirrored into <workspace>/driver/logs/driver.log. */
function createLogger(paths: WorkspacePaths): DriverLogger {
  const emit = (level: 'info' | 'warn' | 'error', msg: string): void => {
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    try {
      if (level === 'info') console.log(line);
      else console.error(line);
    } catch {
      // Console can be closed (piped stdout); never crash on logging.
    }
    try {
      mkdirSync(paths.logs, { recursive: true });
      appendFileSync(`${paths.logs}/driver.log`, `${line}\n`, 'utf8');
    } catch {
      // File logging is best-effort by design; it must never crash the CLI.
    }
  };
  return {
    info: (msg) => emit('info', msg),
    warning: (msg) => emit('warn', msg),
    error: (msg) => emit('error', msg),
  };
}

/**
 * Best-effort `git remote get-url origin` for repository resolution.
 * Any failure — missing git, missing remote, non-git directory — yields
 * null, which resolveRepository handles.
 */
function readGitRemoteUrl(projectRoot: string): string | null {
  try {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    if (result.status !== 0 || result.error !== undefined) return null;
    const url = (result.stdout ?? '').trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

async function onlineDeps(args: CliArgs): Promise<DriverDeps> {
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new ConfigError(
      'GITHUB_TOKEN is required for `gateflow run` / `gateflow sync`. ' +
        'Export a token with repo access, e.g. `export GITHUB_TOKEN=ghp_...`.',
    );
  }
  const config = await loadConfig(args.root, args.config);
  const repository = resolveRepository(config, process.env, readGitRemoteUrl(args.root));
  const parts = repository.split('/');
  const owner = parts[0];
  const repo = parts[1];
  if (owner === undefined || repo === undefined) {
    throw new ConfigError(`repository must be "owner/name", got ${JSON.stringify(repository)}`);
  }
  const paths = resolveWorkspace(args.root, config.driver.workspaceDir);
  const log = createLogger(paths);
  const octokit = createOctokit(token);
  const client = createDriverGitHubClient(octokit, { owner, repo });
  return { client, config, projectRoot: args.root, log };
}

async function runOnline(args: CliArgs, command: 'run' | 'sync'): Promise<number> {
  const deps = await onlineDeps(args);
  deps.log.info(`gateflow ${command}: root=${args.root}`);

  if (command === 'run') {
    const result = await runCommand(deps, { issue: args.issue ?? undefined });
    if (result.taskId !== null) {
      console.log(`task: ${result.taskId} (${result.mode ?? '?'}, issue #${result.issueNumber ?? '?'})`);
    }
    console.log(`result: ${result.reason}`);
    if (result.prompt !== undefined) {
      console.log('');
      console.log('--- copy the prompt below into ChatGPT / ZCode ---');
      console.log(result.prompt);
      console.log('--- end of prompt ---');
    }
    return 0;
  }

  const result = await syncCommand(deps);
  console.log(`synced: ${result.outcomes.length} task dir(s)`);
  for (const outcome of result.outcomes) {
    console.log(`  ${outcome.taskId}: ${outcome.action} — ${outcome.detail}`);
  }
  return 0;
}

async function runStatus(args: CliArgs): Promise<number> {
  const config = await loadConfig(args.root, args.config);
  const paths = resolveWorkspace(args.root, config.driver.workspaceDir);

  const current = await readCurrent(paths);
  if (current === null) {
    console.log('current task: (none — run `gateflow run`)');
  } else {
    console.log(
      `current task: ${current.task_id} (mode=${current.mode}, issue=#${current.issue_number}, updated=${current.updated_at})`,
    );
  }

  const state = await readDriverState(paths);
  const records = Object.values(state.tasks).sort((a, b) => a.task_id.localeCompare(b.task_id));
  console.log(`driver state: ${records.length} task record(s)`);
  for (const record of records) {
    console.log(
      `  ${record.task_id}  status=${record.status} attempts=${record.attempts} ` +
        `issue=#${record.issue_number} epoch=${record.workflow_epoch}` +
        `${record.published_comment_id !== undefined ? ` published=#${record.published_comment_id}` : ''}` +
        `${record.last_sync_at !== undefined ? ` last_sync=${record.last_sync_at}` : ''}` +
        `${record.error !== undefined && record.error !== null ? ` error=${record.error}` : ''}`,
    );
  }

  const pendingSync = records.filter((record) => record.status === 'prepared' || record.status === 'publishing');
  if (pendingSync.length > 0) {
    console.log('next step: work with your AI client, then run `gateflow sync`.');
  } else if (current !== null) {
    const record = state.tasks[current.task_id];
    if (record !== undefined && (record.status === 'published')) {
      console.log('next step: results published — wait for the Gate (or re-run sync to confirm acceptance).');
    } else if (record !== undefined && record.status === 'accepted') {
      console.log('next step: output accepted by the Gate — continue on GitHub (/approve or check ai:done).');
    }
  } else {
    console.log('next step: run `gateflow run` (or /ai-plan on GitHub to start a task).');
  }
  return 0;
}

async function runRetry(args: CliArgs): Promise<number> {
  const taskId = args.taskId ?? '';
  if (!TASK_ID_PATTERN.test(taskId)) {
    console.error(`invalid task id: ${JSON.stringify(taskId)} (expected gf_r<id>_i<issue>_w<epoch>_<mode>_<rev>)`);
    return 1;
  }
  const config = await loadConfig(args.root, args.config);
  const paths = resolveWorkspace(args.root, config.driver.workspaceDir);
  const cleared = await clearTask(paths, taskId);
  if (cleared) {
    console.log(
      `driver state cleared for ${taskId}. The task will be re-prepared by ` +
        '`gateflow run` if the issue state still warrants it.',
    );
  } else {
    console.log(`no driver-state record found for ${taskId} — nothing to clear.`);
  }
  return 0;
}

/** CLI entry point; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`error: ${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  try {
    switch (parsed.args.command) {
      case 'run':
      case 'sync':
        return await runOnline(parsed.args, parsed.args.command);
      case 'status':
        return await runStatus(parsed.args);
      case 'retry':
        return await runRetry(parsed.args);
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`config error: ${err.message}`);
    } else {
      console.error(`gateflow failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}

/* Run only when executed directly (bin gateflow → dist/cli.js); importing
 * this module (tests, tooling) never triggers the CLI. NOTE: the esbuild CJS
 * bundle replaces `import.meta.url` with an empty shim, so the primary check
 * compares resolved argv[1] against __filename; the URL comparison is the
 * ESM fallback. */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    if (typeof __filename === 'string') {
      return nodePath.resolve(entry) === nodePath.resolve(__filename);
    }
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
