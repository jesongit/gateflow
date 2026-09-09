/**
 * gateflow.config.yml loading and validation.
 *
 * V1 SIMPLIFIED CONFIG (docs/plans/v1-simplification-plan.md §7): only the
 * repository, the workspace location and the identity allowlists remain.
 * The role-routing, agent and activation sections are gone — V1 has one
 * skill, two modes and Manual Activation (the printed prompt).
 *
 * FROZEN CONSTRAINTS owned by the Driver as a whole:
 * - The Driver NEVER calls an LLM; it only prepares tasks and syncs results.
 * - The Driver NEVER transitions labels or issue state — that is the Gate's
 *   exclusive power; it only publishes protocol comments after validating
 *   task outputs.
 * - GitHub credentials live only in the Driver process environment
 *   (GITHUB_TOKEN) and are never written to `.gateflow/` or the config file.
 *
 * Config rules:
 * - `version` must be exactly 1; anything else is a ConfigError.
 * - Unknown keys are ignored (forward compatibility).
 * - Invalid value types are ConfigErrors with a clear message — a broken
 *   config must fail fast, never silently degrade into surprising behavior.
 * - A MISSING config file is normal: the all-defaults config applies.
 */
import { readFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { parse } from 'yaml';
import { isRepositorySlug } from '../workspace/binding';

/** Strongly-typed driver configuration. */
export interface DriverConfig {
  version: 1;
  /** `owner/name` Control Repository; retained as the bootstrap config key. */
  repository?: string;
  /** Explicit spelling for the Control Repository. Takes precedence over `repository`. */
  controlRepository?: string;
  driver: {
    /** Runtime directory name under the project root. */
    workspaceDir: string;
    /** Automatic retry ceiling per task. */
    maxAttempts: number;
  };
  /** Trusted humans besides the repo owner (command authors). */
  trustedHumans: string[];
  /**
   * GitHub logins allowed to have authored Gate records (approval /
   * feedback_accepted). The Driver independently re-validates Gate-issued
   * records against this allowlist (default `['github-actions[bot]']`).
   * NEVER include the Driver's own identity here: the Gate and the Driver
   * must be separate protected identities.
   */
  gateLogins: string[];
  /**
   * Fail-closed Organization rule: when the repository owner is not a
   * personal User and trustedHumans is empty, the Driver refuses to run.
   * Default true.
   */
  requireExplicitHumans: boolean;
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
      workspaceDir: '.gateflow',
      maxAttempts: 3,
    },
    trustedHumans: [],
    gateLogins: ['github-actions[bot]'],
    requireExplicitHumans: true,
  };
}

/** `owner/name` shape (used for the resolved repository). */
const REPOSITORY_PATTERN = isRepositorySlug;

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
      `config version must be exactly 1, got ${JSON.stringify(version)} — this build speaks config v1 only`,
    );
  }

  const config = defaultConfig();

  const repository = optionalString(raw, 'repository', errors);
  if (repository !== undefined) {
    if (!REPOSITORY_PATTERN(repository)) {
      errors.push(`repository: must be a GitHub owner/name slug, got ${JSON.stringify(repository)}`);
    } else {
      config.repository = repository;
    }
  }
  const controlRepository = optionalString(raw, 'control_repository', errors);
  if (controlRepository !== undefined) {
    if (!REPOSITORY_PATTERN(controlRepository)) {
      errors.push(`control_repository: must be a GitHub owner/name slug, got ${JSON.stringify(controlRepository)}`);
    } else {
      config.controlRepository = controlRepository;
    }
  }
  if (
    config.repository !== undefined &&
    config.controlRepository !== undefined &&
    config.repository.toLowerCase() !== config.controlRepository.toLowerCase()
  ) {
    errors.push('repository and control_repository must identify the same Control Repository');
  }

  const driver = section(raw, 'driver', errors);
  const workspaceDir = optionalString(driver, 'workspace_dir', errors, 'driver.workspace_dir');
  if (workspaceDir !== undefined) config.driver.workspaceDir = workspaceDir;
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
 * GitHub forms: `https://github.com/owner/name(.git)` and
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
 * Resolve the target repository as `owner/name` (frozen order):
 * config.controlRepository ?? config.repository ?? GATEFLOW_REPOSITORY ?? git remote origin ?? throw.
 */
export function resolveRepository(
  config: DriverConfig,
  env: { GATEFLOW_REPOSITORY?: string },
  gitRemoteUrl: string | null,
): string {
  const candidate =
    config.controlRepository ?? config.repository ?? env.GATEFLOW_REPOSITORY ?? parseGitRemoteRepository(gitRemoteUrl);
  if (candidate === undefined || candidate === null) {
    throw new ConfigError(
      'Control Repository could not be resolved: set `control_repository: owner/name` ' +
        '(or the bootstrap alias `repository: owner/name`) in gateflow.config.yml, ' +
        'export GATEFLOW_REPOSITORY=owner/name, or add a GitHub git remote named "origin"',
    );
  }
  if (!REPOSITORY_PATTERN(candidate)) {
    throw new ConfigError(`Control Repository must be a GitHub owner/name slug, got ${JSON.stringify(candidate)}`);
  }
  return candidate;
}
