/**
 * Driver orchestration — the two ONLINE commands (`run` / `sync`).
 *
 * V1 has NO daemon: the user drives the flow with explicit commands
 * (docs/plans/v1-simplification-plan.md §7).
 *   gateflow run    — discover, prepare THE active task, print the prompt.
 *   gateflow sync   — pull canonical GitHub state, publish validated task
 *                     results, reconcile interrupted syncs.
 *
 * FROZEN CONSTRAINTS (stated once per driver module; repeated where they
 * bite):
 * - The Driver NEVER calls an LLM and NEVER transitions labels or issue
 *   state; it derives intents from canonical GitHub state, builds local task
 *   directories, and publishes validated protocol comments. The Gate owns
 *   every transition.
 * - One bad issue or one bad task must not abort a pass: per-item errors
 *   are logged and skipped. Cycle-level infrastructure failures
 *   (getRepository / listIssues) bubble to the caller.
 * - Single-instance guard: a `driver.lock` in the Driver-private locks
 *   directory is acquired for the whole run/sync command; a second Driver
 *   on the SAME machine workspace fails fast instead of double-writing.
 *   The lock constrains same-machine processes only — cross-machine
 *   exclusivity needs an external coordinator (documented, never assumed).
 */
import type { DriverGitHubClient, RepositoryInfo } from '../github/client';
import type { DriverConfig } from './config';
import { ensureWorkspace, resolveWorkspace } from '../workspace/paths';
import { acquireLock, releaseLock, driverLockFile, DRIVER_LOCK_HOLDER } from './workspace-lock';
import { discoverWork } from './discovery';
import { prepareCurrentTask } from './prepare';
import type { PrepareOutcome } from './prepare';
import { syncAll } from './sync';
import type { SyncOutcome } from './sync';

/** Minimal logging seam the CLI and tests inject. */
export interface DriverLogger {
  info(msg: string): void;
  warning(msg: string): void;
  error(msg: string): void;
}

/** Everything a driver command needs; `now` is injectable for tests. */
export interface DriverDeps {
  client: DriverGitHubClient;
  config: DriverConfig;
  /** Control Repository checkout root (contains `.gateflow/`); Target Workspace is task metadata. */
  projectRoot: string;
  log: DriverLogger;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

/** Options for `run`. */
export interface RunOptions {
  /** Explicit issue selection (single-active-task switch). */
  issue?: number;
  /** Explicit target metadata; omitted values are inherited or remain null. */
  targetRepository?: string | null;
  targetWorkspace?: string | null;
}

/** Result of one `run` command. */
export type RunResult = PrepareOutcome;

/** Result of one `sync` command. */
export interface SyncResult {
  outcomes: SyncOutcome[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fail-closed identity rule (GF-H10, kept): on a non-personal repository
 * (owner type != "User", verified via the API) the Driver refuses to run
 * without an explicit trusted-humans allowlist. A repo-owner login that is
 * really an Organization must never silently count as a Human.
 */
export function assertUsableRepository(config: DriverConfig, repositoryInfo: RepositoryInfo): void {
  if (
    config.requireExplicitHumans &&
    repositoryInfo.ownerType !== 'User' &&
    config.trustedHumans.length === 0
  ) {
    throw new Error(
      `repository owner "${repositoryInfo.owner}" has GitHub type "${repositoryInfo.ownerType}"; ` +
        'Driver refuses to run on an Organization-owned repository without an explicit ' +
        '`trusted_humans` allowlist in gateflow.config.yml (fail closed, GF-H10).',
    );
  }
}

async function withDriverLock<T>(
  deps: DriverDeps,
  body: (repositoryInfo: RepositoryInfo) => Promise<T>,
): Promise<T> {
  const paths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);
  await ensureWorkspace(paths);
  const now = deps.now ?? (() => new Date());
  const lock = await acquireLock(driverLockFile(paths), DRIVER_LOCK_HOLDER, now);
  if (!lock.ok) {
    throw new Error(
      'another GateFlow driver instance appears to be running for this workspace ' +
        `(driver.lock held by ${lock.holder ? `${lock.holder.holder} pid ${lock.holder.pid}` : 'an unknown process'}); ` +
        'refusing to run a second instance (single-writer rule)',
    );
  }
  try {
    const repositoryInfo = await deps.client.getRepository();
    assertUsableRepository(deps.config, repositoryInfo);
    return await body(repositoryInfo);
  } finally {
    await releaseLock(driverLockFile(paths), DRIVER_LOCK_HOLDER);
  }
}

/**
 * `gateflow run`: discover, prepare the active task, return the outcome
 * (including the copy-paste prompt when a task is ready or already
 * prepared).
 */
export async function runCommand(deps: DriverDeps, opts: RunOptions = {}): Promise<RunResult> {
  return withDriverLock(deps, async (repositoryInfo) => {
    const repository = `${repositoryInfo.owner}/${repositoryInfo.name}`;
    const discoveries = await discoverWork(deps.client, repository, deps.config, repositoryInfo, deps.log);
    return prepareCurrentTask(deps, repositoryInfo, discoveries, {
      issue: opts.issue,
      ...(Object.prototype.hasOwnProperty.call(opts, 'targetRepository')
        ? { targetRepository: opts.targetRepository }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(opts, 'targetWorkspace')
        ? { targetWorkspace: opts.targetWorkspace }
        : {}),
    });
  });
}

/**
 * `gateflow sync`: publish every validated task result and reconcile
 * interrupted syncs. Per-task failures are logged and returned as outcomes;
 * infrastructure failures of the whole pass bubble to the caller.
 */
export async function syncCommand(deps: DriverDeps): Promise<SyncResult> {
  return withDriverLock(deps, async (repositoryInfo) => {
    const { outcomes } = await syncAll(deps, repositoryInfo);
    return { outcomes };
  });
}

export { errorMessage };
