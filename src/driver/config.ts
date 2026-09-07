/**
 * gateflow.config.yml loading and validation (docs/workspace-protocol.md
 * §10, frozen).
 *
 * FROZEN CONSTRAINTS owned by the Driver as a whole (stated once here, and
 * per-module in the other driver files):
 * - The Driver NEVER calls an LLM; it only discovers, dispatches and syncs.
 * - The Driver NEVER transitions labels or issue state — that is the Gate's
 *   exclusive power (docs/architecture-v1.md §6); it only publishes protocol
 *   comments after validating outbox files.
 * - GitHub credentials live only in the Driver process environment
 *   (GITHUB_TOKEN) and are never written to `.gateflow/` or the config file.
 *
 * Config rules (docs §10):
 * - `version` must be exactly 1; anything else is a ConfigError.
 * - Unknown keys are ignored (forward compatibility).
 * - Invalid value types are ConfigErrors with a clear message — a broken
 *   config must fail fast, never silently degrade into surprising behavior.
 * - A MISSING config file is normal: the all-defaults config applies
 *   (manual activation, `.gateflow` workspace, 30s polling, 3 attempts).
 * - `routing.consumer` / `routing.executor` may be absent: that role then has
 *   no agent and activation resolution falls through to the fallback adapter
 *   (manual) via resolveAdapterForAgent('__none__', ...).
 */
import { readFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { parse } from 'yaml';

import type { ActivationAgentConfig, ActivationKind } from '../activation';

/** Strongly-typed driver configuration (docs/workspace-protocol.md §10). */
export interface DriverConfig {
  version: 1;
  /** `owner/name`; optional — resolution order in resolveRepository. */
  repository?: string;
  driver: {
    /** `start` mode poll interval. */
    pollIntervalSeconds: number;
    /** Runtime directory name under the project root. */
    workspaceDir: string;
    /** Tracker edit debounce (progress sync). */
    progressSyncSeconds: number;
    /** Automatic retry ceiling per dispatch. */
    maxAttempts: number;
  };
  /** Trusted humans besides the repo owner (approval/feedback authors). */
  trustedHumans: string[];
  /**
   * GitHub logins allowed to have authored Gate records (approval /
   * feedback_accepted). The Driver independently re-validates Gate-issued
   * records against this allowlist (schema 2 hardening; default
   * `['github-actions[bot]']`). NEVER include the Driver's own identity
   * here: the Gate and the Driver must be separate protected identities.
   */
  gateLogins: string[];
  /**
   * Fail-closed Organization rule (hardening §8): when the repository owner
   * is not a personal User and trustedHumans is empty, the Driver refuses to
   * run. Default true.
   */
  requireExplicitHumans: boolean;
  /** Role → agent name; an absent role gets no activation agent. */
  routing: { consumer?: string; executor?: string };
  /** Agent name → activation config. */
  agents: Record<string, ActivationAgentConfig>;
  /** Fallback activation kind when an agent is unknown or its probe fails. */
  activation: { fallback: ActivationKind };
}

/** Raised for every invalid or unusable configuration input. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** All-defaults configuration (also the result of a missing config file). */
export function defaultConfig(): DriverConfig {
  return {
    version: 1,
    driver: {
      pollIntervalSeconds: 30,
      workspaceDir: '.gateflow',
      progressSyncSeconds: 60,
      maxAttempts: 3,
    },
    trustedHumans: [],
    gateLogins: ['github-actions[bot]'],
    requireExplicitHumans: true,
    routing: {},
    agents: {},
    activation: { fallback: 'manual' },
  };
}

const ACTIVATION_KINDS: readonly ActivationKind[] = ['manual', 'chatgpt', 'zcode'];

/** `owner/name` shape (used for the resolved repository, docs §10). */
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

type Obj = Record<string, unknown>;

function isRecord(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a nested section, ignoring absence; arrays/other types are errors. */
function section(raw: Obj, key: string, errors: string[]): Obj {
  const value = raw[key];
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    errors.push(`${key}: expected a mapping, got ${typeof value}`);
    return {};
  }
  return value;
}

function optionalString(raw: Obj, key: string, errors: string[], what?: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${what ?? key}: must be a non-empty string, got ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

function optionalNumber(
  raw: Obj,
  key: string,
  errors: string[],
  opts: { min: number },
): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < opts.min) {
    errors.push(`${key}: must be a number >= ${opts.min}, got ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

function optionalActivationKind(raw: Obj, key: string, what: string, errors: string[]): ActivationKind | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(ACTIVATION_KINDS as readonly string[]).includes(value)) {
    errors.push(`${what}: must be one of ${ACTIVATION_KINDS.join('|')}, got ${JSON.stringify(value)}`);
    return undefined;
  }
  return value as ActivationKind;
}

/** Parse the `agents:` mapping; unknown keys inside an agent entry are ignored. */
function parseAgents(raw: Obj, errors: string[]): Record<string, ActivationAgentConfig> {
  const agents: Record<string, ActivationAgentConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      errors.push(`agents.${name}: expected a mapping, got ${typeof value}`);
      continue;
    }
    const activation = optionalActivationKind(value, 'activation', `agents.${name}.activation`, errors);
    if (activation === undefined) continue; // error already recorded above
    const agent: ActivationAgentConfig = { activation };
    const autoStart = value['autoStart'];
    if (autoStart !== undefined) {
      if (typeof autoStart !== 'boolean') {
        errors.push(`agents.${name}.autoStart: must be a boolean, got ${JSON.stringify(autoStart)}`);
      } else {
        agent.autoStart = autoStart;
      }
    }
    const command = optionalString(value, 'command', errors, `agents.${name}.command`);
    if (command !== undefined) agent.command = command;
    const envPassthrough = value['env_passthrough'];
    if (envPassthrough !== undefined) {
      if (
        !Array.isArray(envPassthrough) ||
        envPassthrough.some((k) => typeof k !== 'string' || k.length === 0)
      ) {
        errors.push(`agents.${name}.env_passthrough: must be a list of non-empty strings`);
      } else {
        agent.envPassthrough = envPassthrough as string[];
      }
    }
    agents[name] = agent;
  }
  return agents;
}

/**
 * Parse raw key/value pairs (already YAML-decoded) into a DriverConfig.
 * Exported for tests; `loadConfig` is the normal entry point.
 */
export function parseConfig(raw: unknown): DriverConfig {
  if (!isRecord(raw)) {
    throw new ConfigError('gateflow config must be a YAML mapping at the top level');
  }
  const errors: string[] = [];

  const version = raw['version'];
  if (version !== 1) {
    throw new ConfigError(
      `config version must be exactly 1, got ${JSON.stringify(version)} — this build speaks protocol v1 only`,
    );
  }

  const config = defaultConfig();

  const repository = optionalString(raw, 'repository', errors);
  if (repository !== undefined) {
    if (!REPOSITORY_PATTERN.test(repository)) {
      errors.push(`repository: must be "owner/name", got ${JSON.stringify(repository)}`);
    } else {
      config.repository = repository;
    }
  }

  const driver = section(raw, 'driver', errors);
  const pollIntervalSeconds = optionalNumber(driver, 'poll_interval_seconds', errors, { min: 1 });
  if (pollIntervalSeconds !== undefined) config.driver.pollIntervalSeconds = pollIntervalSeconds;
  const workspaceDir = optionalString(driver, 'workspace_dir', errors, 'driver.workspace_dir');
  if (workspaceDir !== undefined) config.driver.workspaceDir = workspaceDir;
  const progressSyncSeconds = optionalNumber(driver, 'progress_sync_seconds', errors, { min: 0 });
  if (progressSyncSeconds !== undefined) config.driver.progressSyncSeconds = progressSyncSeconds;
  const maxAttempts = optionalNumber(driver, 'max_attempts', errors, { min: 1 });
  if (maxAttempts !== undefined) config.driver.maxAttempts = maxAttempts;

  const trusted = raw['trusted_humans'];
  if (trusted !== undefined) {
    if (!Array.isArray(trusted) || trusted.some((h) => typeof h !== 'string' || h.length === 0)) {
      errors.push('trusted_humans: must be a list of non-empty strings');
    } else {
      config.trustedHumans = trusted as string[];
    }
  }

  const gateLogins = raw['gate_logins'];
  if (gateLogins !== undefined) {
    if (!Array.isArray(gateLogins) || gateLogins.some((h) => typeof h !== 'string' || h.length === 0)) {
      errors.push('gate_logins: must be a list of non-empty strings');
    } else {
      config.gateLogins = gateLogins as string[];
    }
  }

  const requireExplicitHumans = raw['require_explicit_humans'];
  if (requireExplicitHumans !== undefined) {
    if (typeof requireExplicitHumans !== 'boolean') {
      errors.push('require_explicit_humans: must be a boolean');
    } else {
      config.requireExplicitHumans = requireExplicitHumans;
    }
  }

  const routing = section(raw, 'routing', errors);
  const consumer = optionalString(routing, 'consumer', errors, 'routing.consumer');
  if (consumer !== undefined) config.routing.consumer = consumer;
  const executor = optionalString(routing, 'executor', errors, 'routing.executor');
  if (executor !== undefined) config.routing.executor = executor;

  const agents = section(raw, 'agents', errors);
  config.agents = parseAgents(agents, errors);

  const activation = section(raw, 'activation', errors);
  const fallback = optionalActivationKind(activation, 'fallback', 'activation.fallback', errors);
  if (fallback !== undefined) config.activation.fallback = fallback;

  if (errors.length > 0) {
    throw new ConfigError(`invalid gateflow config: ${errors.join('; ')}`);
  }
  return config;
}

/**
 * Load `gateflow.config.yml` from `projectRoot`. A missing file yields the
 * all-defaults config; a present-but-invalid file throws ConfigError.
 */
export async function loadConfig(projectRoot: string, fileName = 'gateflow.config.yml'): Promise<DriverConfig> {
  const file = nodePath.resolve(projectRoot, fileName);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultConfig();
    }
    throw new ConfigError(`cannot read config file ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigError(`config file ${file} is not valid YAML: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

/**
 * Parse an `owner/name` slug out of a git remote URL. Supports the two
 * GitHub forms (docs §10): `https://github.com/owner/name(.git)` and
 * `git@github.com:owner/name.git`. Returns null for anything else.
 */
export function parseGitRemoteRepository(gitRemoteUrl: string | null): string | null {
  if (gitRemoteUrl === null) return null;
  const url = gitRemoteUrl.trim();
  if (url.length === 0) return null;
  const https = /^https?:\/\/[^/]+\/([^/\s]+?)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  if (https !== null) {
    const owner = https[1];
    const name = https[2];
    if (owner && name) return `${owner}/${name}`;
  }
  const ssh = /^git@[^:\s]+:([^/\s]+?)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  if (ssh !== null) {
    const owner = ssh[1];
    const name = ssh[2];
    if (owner && name) return `${owner}/${name}`;
  }
  return null;
}

/**
 * Resolve the target repository as `owner/name` (docs §10, frozen order):
 * config.repository ?? GATEFLOW_REPOSITORY ?? git remote origin ?? throw.
 */
export function resolveRepository(
  config: DriverConfig,
  env: { GATEFLOW_REPOSITORY?: string },
  gitRemoteUrl: string | null,
): string {
  const candidate = config.repository ?? env.GATEFLOW_REPOSITORY ?? parseGitRemoteRepository(gitRemoteUrl);
  if (candidate === undefined || candidate === null) {
    throw new ConfigError(
      'repository could not be resolved: set `repository: owner/name` in gateflow.config.yml, ' +
        'export GATEFLOW_REPOSITORY=owner/name, or add a GitHub git remote named "origin"',
    );
  }
  if (!REPOSITORY_PATTERN.test(candidate)) {
    throw new ConfigError(`repository must be "owner/name", got ${JSON.stringify(candidate)}`);
  }
  return candidate;
}
