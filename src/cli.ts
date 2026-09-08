/**
 * `gateflow` CLI (docs/architecture-v1.md §5: src/cli.ts — "gateflow driver
 * CLI (start / once / status / retry)").
 *
 * Usage:
 *   gateflow driver once [--root <dir>] [--config <file>]
 *   gateflow driver start [--root <dir>] [--config <file>]
 *   gateflow driver status [--root <dir>] [--config <file>]
 *   gateflow driver retry <dispatchId> [--root <dir>] [--config <file>]
 *   gateflow driver unlock <dispatchId> [--root <dir>] [--config <file>]
 *
 * - `--root` defaults to the current working directory; `--config` defaults
 *   to `gateflow.config.yml` inside the root.
 * - `once` / `start` need GITHUB_TOKEN in the environment (docs §10: the
 *   token lives only in the Driver process environment, never on disk).
 *   Repository resolution order: config `repository` → GATEFLOW_REPOSITORY
 *   → git remote origin (parsed by driver/config).
 * - `status` / `retry` are OFFLINE operations (no token, no GitHub calls):
 *   they only read / clear local workspace files.
 * - Console logger with timestamps, mirrored (best-effort, never crashing)
 *   into `<workspace>/logs/driver.log`.
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
import { startDriver, runOnce } from './driver/driver';
import type { DriverDeps, DriverLogger } from './driver/driver';
import { retryDispatch } from './driver/retry';
import { executorLockFile, forceReleaseExecutorLock } from './driver/workspace-lock';
import { readCurrent } from './workspace/inbox';
import { listOutboxDispatchIds, listReceipts } from './workspace/outbox';
import { resolveWorkspace } from './workspace/paths';
import type { WorkspacePaths } from './workspace/paths';
import { DISPATCH_DIR_PATTERN } from './workspace/protocol';
import { inspectSubmit } from './workspace/submit';

const USAGE = `gateflow driver — local GateFlow Driver

Usage:
  gateflow driver once   [--root <dir>] [--config <file>]   run one discovery+sync cycle
  gateflow driver start  [--root <dir>] [--config <file>]   poll + watch until interrupted
  gateflow driver status [--root <dir>] [--config <file>]   show local workspace state (offline)
  gateflow driver retry <dispatchId> [--root <dir>]         clear a receipt so the next cycle re-dispatches
  gateflow driver unlock <dispatchId> [--root <dir>]        release a conflicted executor lock (V1.1 Phase 7)

Environment:
  GITHUB_TOKEN          required for once/start; never written to disk
  GATEFLOW_REPOSITORY   optional owner/name fallback for repository resolution`;

interface CliArgs {
  command: 'once' | 'start' | 'status' | 'retry' | 'unlock';
  dispatchId: string | null;
  root: string;
  config: string;
}

function parseArgs(argv: string[]): { ok: true; args: CliArgs } | { ok: false; error: string } {
  const positionals: string[] = [];
  let root = process.cwd();
  let config = 'gateflow.config.yml';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--root' || arg === '--config') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `flag ${arg} requires a value` };
      }
      if (arg === '--root') root = value;
      else config = value;
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
    if (arg.startsWith('--')) {
      return { ok: false, error: `unknown flag "${arg}"` };
    }
    positionals.push(arg);
  }

  // Tolerate `gateflow driver once` and a bare `gateflow once` alike.
  if (positionals[0] === 'driver') positionals.shift();
  const command = positionals[0];
  if (command !== 'once' && command !== 'start' && command !== 'status' && command !== 'retry' && command !== 'unlock') {
    return { ok: false, error: `unknown command "${command ?? ''}"` };
  }
  const dispatchId = positionals[1] ?? null;
  if ((command === 'retry' || command === 'unlock') && dispatchId === null) {
    return { ok: false, error: `${command} requires a <dispatchId> argument` };
  }
  return { ok: true, args: { command, dispatchId, root, config } };
}

/** Timestamped console logger mirrored into <workspace>/logs/driver.log. */
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
 * Best-effort `git remote get-url origin` for repository resolution
 * (docs §10 fallback order). Any failure — missing git, missing remote,
 * non-git directory — yields null, which resolveRepository handles.
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

async function runOnline(args: CliArgs, mode: 'once' | 'start'): Promise<number> {
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token.length === 0) {
    console.error(
      `GITHUB_TOKEN is required for \`gateflow driver ${mode}\`. ` +
        'Export a token with repo access, e.g. `export GITHUB_TOKEN=ghp_...`.',
    );
    return 1;
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
  const deps: DriverDeps = { client, config, projectRoot: args.root, log };
  log.info(`gateflow driver ${mode}: repository=${repository} root=${args.root}`);

  if (mode === 'once') {
    const result = await runOnce(deps);
    const dispatched = result.dispatched.filter((o) => o.dispatched);
    console.log(`dispatched: ${dispatched.length} of ${result.dispatched.length} intent(s)`);
    for (const outcome of result.dispatched) {
      console.log(`  ${outcome.dispatched ? '+' : '-'} ${outcome.dispatchId ?? '?'}: ${outcome.reason}`);
    }
    console.log(`synced: ${result.synced.length} outbox dispatch dir(s)`);
    for (const outcome of result.synced) {
      console.log(`  ${outcome.dispatchId}: ${outcome.action} — ${outcome.detail}`);
    }
    return 0;
  }

  await startDriver(deps);
  return 0;
}

async function runStatus(args: CliArgs): Promise<number> {
  const config = await loadConfig(args.root, args.config);
  const paths = resolveWorkspace(args.root, config.driver.workspaceDir);

  const current = await readCurrent(paths);
  if (current === null) {
    console.log('current.json: (none)');
  } else {
    console.log(
      `current.json: ${current.dispatch_id} (role=${current.role}, issue=#${current.issue_number}, updated=${current.updated_at})`,
    );
  }

  const receipts = await listReceipts(paths);
  console.log(`receipts: ${receipts.length}`);
  for (const receipt of receipts) {
    console.log(
      `  ${receipt.dispatch_id}  status=${receipt.status} attempts=${receipt.attempts} ` +
        `epoch=${receipt.workflow_epoch ?? '-'} ` +
        `published=${receipt.published_comment_id ?? '-'} ` +
        `activation=${receipt.activation ? receipt.activation.state : '-'} ` +
        `last_sync=${receipt.last_sync_at ?? '-'}` +
        `${receipt.error !== undefined && receipt.error !== null ? ` error=${receipt.error}` : ''}`,
    );
  }

  const outboxIds = await listOutboxDispatchIds(paths);
  console.log(`outbox dispatch dirs: ${outboxIds.length}`);
  for (const id of outboxIds) {
    console.log(`  ${id}`);
  }

  const submit = await inspectSubmit(paths);
  if (submit.status === 'empty') {
    console.log('submit: (empty)');
  } else if (submit.status === 'invalid') {
    console.log(`submit: INVALID — ${submit.error}`);
  } else {
    console.log(`submit: ready — "${submit.request.title}" (${submit.request.kind}/${submit.request.maturity_hint})`);
  }
  return 0;
}

async function runRetry(args: CliArgs): Promise<number> {
  const dispatchId = args.dispatchId ?? '';
  if (!DISPATCH_DIR_PATTERN.test(dispatchId)) {
    console.error(
      `invalid dispatch id: ${JSON.stringify(dispatchId)} ` +
        '(expected gf_r<id>_i<issue>_w<epoch-code>_<role>_<revision>)',
    );
    return 1;
  }
  const config = await loadConfig(args.root, args.config);
  const paths = resolveWorkspace(args.root, config.driver.workspaceDir);
  const cleared = await retryDispatch(paths, dispatchId);
  if (cleared) {
    console.log(
      `receipt cleared for ${dispatchId}. The dispatch will be re-dispatched on the next cycle ` +
        'if the issue state still warrants it.',
    );
  } else {
    console.log(`no receipt found for ${dispatchId} — nothing to clear.`);
  }
  return 0;
}

/**
 * Explicit human release of a conflicted executor lock (V1.1 Phase 7):
 * `gateflow driver unlock <dispatch_id>`. INVOKING this command IS the human
 * confirmation that the old desktop client has stopped — the lock is never
 * released automatically by time or by a dead Driver pid.
 */
async function runUnlock(args: CliArgs): Promise<number> {
  const dispatchId = args.dispatchId ?? '';
  if (!DISPATCH_DIR_PATTERN.test(dispatchId)) {
    console.error(
      `invalid dispatch id: ${JSON.stringify(dispatchId)} ` +
        '(expected gf_r<id>_i<issue>_w<epoch-code>_<role>_<revision>)',
    );
    return 1;
  }
  const config = await loadConfig(args.root, args.config);
  const paths = resolveWorkspace(args.root, config.driver.workspaceDir);
  const result = await forceReleaseExecutorLock(executorLockFile(paths), dispatchId);
  if (result.ok) {
    console.log(
      `executor lock released for ${dispatchId} ` +
        `(was held by ${result.holder.holder} pid ${result.holder.pid}, ` +
        `acquired ${result.holder.acquired_at}).`,
    );
    console.log('Make sure the old agent client is really stopped before re-dispatching.');
  } else {
    console.error(`unlock failed: ${result.reason}`);
    return 1;
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
      case 'once':
      case 'start':
        return await runOnline(parsed.args, parsed.args.command);
      case 'status':
        return await runStatus(parsed.args);
      case 'retry':
        return await runRetry(parsed.args);
      case 'unlock':
        return await runUnlock(parsed.args);
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`config error: ${err.message}`);
    } else {
      console.error(`gateflow driver failed: ${err instanceof Error ? err.message : String(err)}`);
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
