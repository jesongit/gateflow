/**
 * Driver orchestration (docs/architecture-v1.md §5: "编排循环（once / start
 * 共用）").
 *
 * FROZEN CONSTRAINTS (stated once per driver module; repeated where they
 * bite):
 * - The Driver NEVER calls an LLM and NEVER transitions labels or issue
 *   state; it derives intents from canonical GitHub state, builds local
 *   inboxes, and publishes validated protocol comments. The Gate owns every
 *   transition (docs/architecture-v1.md §6).
 * - One bad issue or one bad dispatch must not abort a cycle: per-item
 *   errors are logged and skipped. Cycle-level infrastructure failures
 *   (getRepository / listOpenIssues) bubble to the caller.
 * - Watcher callbacks and timer exceptions must never kill the process.
 */
import type { DriverGitHubClient, RepositoryInfo } from '../github/client';
import type { DriverConfig } from './config';
import { ensureWorkspace, resolveWorkspace } from '../workspace/paths';
import { watchOutbox } from '../workspace/watcher';
import type { OutboxWatcher } from '../workspace/watcher';
import { processIntents } from './dispatch';
import type { DispatchOutcome } from './dispatch';
import { processSubmit } from './submit';
import type { SubmitOutcome } from './submit';
import { syncAll, syncDispatch } from './sync';
import type { SyncOutcome } from './sync';
import { acquireLock, releaseLock, driverLockFile, DRIVER_LOCK_HOLDER } from './workspace-lock';

/** Minimal logging seam the CLI and tests inject. */
export interface DriverLogger {
  info(msg: string): void;
  warning(msg: string): void;
  error(msg: string): void;
}

/** Everything a driver cycle needs; `now` is injectable for tests. */
export interface DriverDeps {
  client: DriverGitHubClient;
  config: DriverConfig;
  /** Target repository root (contains `.gateflow/`); NOT the workspace dir. */
  projectRoot: string;
  log: DriverLogger;
  /** Clock injection for deterministic debounce/timestamp tests. */
  now?: () => Date;
}

/** Result of one runOnce cycle. */
export interface DriverOnceResult {
  dispatched: DispatchOutcome[];
  synced: SyncOutcome[];
  /**
   * Producer submit processing (docs/workspace-protocol.md §9). Absent when
   * there was nothing to submit (`action: 'empty'`) — the common case.
   */
  submit?: SubmitOutcome;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fail-closed identity rule (hardening §8, GF-H10): on a non-personal
 * repository (owner type != "User", verified via the API) the Driver refuses
 * to run without an explicit trusted-humans allowlist. A repo-owner login
 * that is really an Organization must never silently count as a Human.
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
        '`trusted_humans` allowlist in gateflow.config.yml (fail closed, hardening GF-H10).',
    );
  }
}

/**
 * One full driver cycle: ensure the workspace, resolve repository identity
 * (the client is already bound to owner/repo at construction; getRepository
 * supplies the database id that dispatch_ids embed and the OWNER TYPE the
 * identity rule needs), process the local Producer submit FIRST (workspace-
 * protocol.md §9 — a new issue created from `.gateflow/submit/` is
 * discoverable in the SAME cycle), then dispatch fresh intents and sync
 * every outbox dispatch.
 */
export async function runOnce(deps: DriverDeps): Promise<DriverOnceResult> {
  const paths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);
  await ensureWorkspace(paths);
  const repositoryInfo: RepositoryInfo = await deps.client.getRepository();
  assertUsableRepository(deps.config, repositoryInfo);
  // Submit before intents: new work enters first, so the issue created from
  // `.gateflow/submit/` is picked up by this cycle's discovery below.
  const submit = await processSubmit(deps, {
    owner: repositoryInfo.owner,
    repo: repositoryInfo.name,
    id: repositoryInfo.id,
  });
  const dispatched = await processIntents(deps, repositoryInfo);
  const synced = await syncAll(deps, repositoryInfo);
  return {
    ...(submit.action === 'empty' ? {} : { submit }),
    dispatched,
    synced,
  };
}

/**
 * Long-running mode: runOnce every `poll_interval_seconds`, plus an outbox
 * watcher whose settled events are drained after each cycle and every 5s
 * while idle (docs §6 — watcher debounce 500ms + stability polling; events
 * are only a latency optimization, syncDispatch revalidates everything).
 * SIGINT/SIGTERM close the watcher and exit cleanly.
 *
 * Single-instance guard (hardening §9): a `driver.lock` in the Driver-private
 * locks directory is acquired on start; a second Driver on the SAME machine
 * workspace fails fast instead of double-writing. The lock constrains
 * same-machine processes only — cross-machine exclusivity needs an external
 * coordinator (documented, never assumed).
 */
export async function startDriver(deps: DriverDeps): Promise<void> {
  const paths = resolveWorkspace(deps.projectRoot, deps.config.driver.workspaceDir);
  await ensureWorkspace(paths);
  const now = deps.now ?? (() => new Date());
  const lock = await acquireLock(driverLockFile(paths), DRIVER_LOCK_HOLDER, undefined, now);
  if (!lock.ok) {
    throw new Error(
      'another GateFlow driver instance appears to be running for this workspace ' +
        `(driver.lock held by ${lock.holder ? `${lock.holder.holder} pid ${lock.holder.pid}` : 'an unknown process'}); ` +
        'refusing to start a second instance (single-writer rule, hardening §9)',
    );
  }
  // Fail fast when repository identity is unresolvable; afterwards it is
  // cached for watcher-driven syncs between cycles (ids are stable).
  const repositoryInfo: RepositoryInfo = await deps.client.getRepository();
  assertUsableRepository(deps.config, repositoryInfo);
  const pollMs = Math.max(1, deps.config.driver.pollIntervalSeconds) * 1000;

  const pending = new Set<string>();
  let stopped = false;
  let cycling = false;
  let draining = false;

  const watcher: OutboxWatcher = watchOutbox(paths, { debounceMs: 500, pollIntervalMs: 2000 }, (id) => {
    try {
      pending.add(id);
    } catch {
      // A throwing watcher callback must never kill the process.
    }
  });

  const drain = async (): Promise<void> => {
    if (draining || cycling || stopped) return;
    draining = true;
    try {
      while (!stopped && !cycling && pending.size > 0) {
        const next = pending.values().next();
        const id = next.value;
        if (id === undefined) break;
        pending.delete(id);
        try {
          const outcome = await syncDispatch(deps, repositoryInfo, id);
          deps.log.info(`watcher sync ${outcome.dispatchId}: ${outcome.action} — ${outcome.detail}`);
        } catch (err) {
          deps.log.error(`watcher sync failed for ${id}: ${errorMessage(err)}`);
        }
      }
    } finally {
      draining = false;
    }
  };

  // Idle drain: latency helper only; the poll loop is the source of truth.
  const idleTimer = setInterval(() => {
    void drain();
  }, 5000);
  idleTimer.unref(); // the main loop keeps the process alive

  const onSignal = (): void => {
    if (stopped) return;
    stopped = true;
    deps.log.info('GateFlow driver shutting down (signal received)');
    void watcher
      .close()
      .catch(() => {
        // best-effort cleanup on the way out
      })
      .then(() => {
        void releaseLock(driverLockFile(paths), DRIVER_LOCK_HOLDER);
        process.exit(0);
      });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    while (!stopped) {
      cycling = true;
      try {
        const result = await runOnce(deps);
        const dispatchedCount = result.dispatched.filter((o) => o.dispatched).length;
        const submitNote = result.submit ? `, submit: ${result.submit.action}` : '';
        deps.log.info(
          `cycle complete: ${dispatchedCount} dispatched, ` +
            `${result.synced.filter((o) => o.action !== 'unchanged' && o.action !== 'skipped').length} synced (of ${result.synced.length} outbox dirs)` +
            submitNote,
        );
      } catch (err) {
        deps.log.error(`cycle failed: ${errorMessage(err)}`);
      }
      cycling = false;
      await drain();
      await sleep(pollMs);
    }
  } finally {
    stopped = true;
    clearInterval(idleTimer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await watcher.close().catch(() => {
      // best-effort cleanup
    });
    await releaseLock(driverLockFile(paths), DRIVER_LOCK_HOLDER);
  }
}
