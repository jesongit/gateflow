#!/usr/bin/env node
/**
 * Shared context for the release E2E suite.
 *
 * Scenario files should consume this context instead of implementing their own
 * process, GitHub, timeout, or cleanup protocol.  The context is deliberately
 * plain data plus injected functions so scenarios remain easy to unit test.
 */
import { access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { createGhClient, E2EError, runProcess } from './github.mjs';

export { E2EError };

export const RELEASE_SCENARIOS = Object.freeze([
  { name: 'workflow', file: 'scenarios/workflow.mjs', required: true },
  { name: 'reconnect', file: 'scenarios/reconnect.mjs', required: true },
  { name: 'security', file: 'scenarios/security.mjs', required: false },
]);

export const REQUIRED_LOCAL_SCRIPTS = Object.freeze(['typecheck', 'test', 'build', 'check:dist']);
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

function defaultLog(message) {
  console.log(message);
}

function defaultError(message) {
  console.error(message);
}

function positiveTimeout(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new E2EError(`${label} must be a positive number of milliseconds, got ${JSON.stringify(value)}`);
  }
  return Math.floor(value);
}

export function normalizeReleaseOptions(options = {}) {
  const timeoutMs = positiveTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, '--timeout-ms');
  const pollIntervalMs = positiveTimeout(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    '--poll-interval-ms',
  );
  return {
    keep: options.keep === true,
    repoName: options.repoName ?? null,
    owner: options.owner ?? null,
    skipSecurity: options.skipSecurity === true,
    prepareAgent: options.prepareAgent === true,
    timeoutMs,
    pollIntervalMs,
  };
}

/**
 * Create one injectable suite context. `deps` is intended for unit tests and
 * must not be used by scenarios to bypass the gh/process wrappers.
 */
export function createReleaseContext(options = {}, deps = {}) {
  const normalized = normalizeReleaseOptions(options);
  const root = resolve(deps.root ?? process.cwd());
  const tempRoot = deps.tempRoot ?? tmpdir();
  // Local gates must not inherit a caller-provided GitHub credential.  The
  // authenticated token obtained during preflight is added later only to the
  // Bootstrap, Driver, and gh environments.
  const baseEnv = { ...(deps.env ?? process.env) };
  for (const key of Object.keys(baseEnv)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === 'GITHUB_TOKEN' || normalizedKey === 'GH_TOKEN') delete baseEnv[key];
  }
  const localEnv = { ...baseEnv };
  const bootstrapEnv = { ...baseEnv };
  const driverEnv = { ...baseEnv };
  const ghEnv = { ...baseEnv };
  const log = deps.log ?? defaultLog;
  const error = deps.error ?? defaultError;
  const processRunner = deps.runProcess ?? runProcess;
  const gh = deps.gh ?? createGhClient({
    runProcess: processRunner,
    command: deps.ghCommand,
    defaultTimeoutMs: normalized.timeoutMs,
    defaultEnv: ghEnv,
  });
  const runWithDriverEnv = (program, args, options = {}) => processRunner(program, args, {
    env: driverEnv,
    ...options,
  });

  return {
    root,
    tempRoot,
    env: baseEnv,
    baseEnv,
    localEnv,
    bootstrapEnv,
    driverEnv,
    ghEnv,
    options: normalized,
    log,
    error,
    runProcess: runWithDriverEnv,
    gh,
    // Lazy imports avoid a context ↔ wait module initialization cycle while
    // presenting the object-shaped contract used by release scenarios.
    waitFor: async (labelOrOptions, check, waitOptions) => {
      const waiter = await import('./wait.mjs');
      if (labelOrOptions !== null && typeof labelOrOptions === 'object') {
        return waiter.waitFor(labelOrOptions.description, labelOrOptions.check, {
          timeoutMs: labelOrOptions.timeoutMs,
          intervalMs: labelOrOptions.intervalMs,
        });
      }
      return waiter.waitFor(labelOrOptions, check, waitOptions);
    },
    waitForGh: async (label, check, waitOptions) => {
      const waiter = await import('./wait.mjs');
      return waiter.waitForGh(label, check, waitOptions);
    },
    paths: {
      clone: null,
    },
    repository: null,
    preflight: null,
    localChecks: [],
    stages: [],
    currentStage: null,
    githubToken: null,
    actionRef: null,
    bootstrapResult: null,
    workflowResult: null,
    firstRound: null,
    prepareAgentIssue: null,
    prepareAgentResult: null,
    scenarioModules: [],
    scenarioModulesOverride: deps.scenarioModules ?? null,
    cleanup: {
      remoteCreated: false,
      completed: false,
    },
  };
}

export async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

export async function readPackageScripts(root) {
  const file = resolve(root, 'package.json');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    throw new E2EError(`cannot read package.json at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level JSON value is not an object');
    }
    return parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {};
  } catch (error) {
    throw new E2EError(`package.json at ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
