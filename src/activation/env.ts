/**
 * Agent process environment builder (hardening GF-H10 / Phase 6.2,
 * docs/plans/v1_hardening_decisions.md §8).
 *
 * FROZEN RULE: a Driver NEVER passes its full `process.env` to an agent
 * child process. The agent environment is built from a fixed allowlist of
 * OS-level keys the client needs to run, plus the per-agent
 * `env_passthrough` config list. Secret-shaped keys (GitHub tokens, private
 * keys, webhook secrets, anything GATEFLOW-prefixed) are stripped even when
 * explicitly requested — a config mistake must not leak credentials.
 *
 * Documented limitation (kept honest): environment filtering reduces
 * ACCIDENTAL secret inheritance. When the agent and the Driver run as the
 * same OS user, the agent can still read the Driver's credential stores
 * directly — that is a Personal-Mode boundary, not a security guarantee
 * (Secure Mode requires separate identities / OS-level isolation).
 */

/**
 * Base allowlist: keys an interactive client needs on Windows / POSIX.
 * Everything else is dropped by default.
 */
const BASE_ALLOWLIST: readonly string[] = [
  // Process/OS essentials
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'OS',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'USERPROFILE',
  'USERNAME',
  'DOMAINNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'COMMONPROGRAMFILES',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'DISPLAY',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SHELL',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

/**
 * Keys NEVER copied into an agent environment, not even via
 * `env_passthrough`: Driver/GitHub credentials and GateFlow runtime secrets.
 * Matched case-insensitively (Windows envs are case-insensitive).
 */
const DENYLIST: readonly string[] = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'HUB_TOKEN',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GATEFLOW_TOKEN',
  'GATEFLOW_WEBHOOK_SECRET',
  'GATEFLOW_APP_KEY',
  'GATEFLOW_APP_PRIVATE_KEY',
  'NODE_OPTIONS',
];

export class CredentialInPassthroughError extends Error {
  constructor(readonly keys: string[]) {
    super(
      `env_passthrough requested secret-shaped key(s) that are never passed to agents: ` +
        `${keys.join(', ')}`,
    );
    this.name = 'CredentialInPassthroughError';
  }
}

function isDenied(key: string): boolean {
  const upper = key.trim().toUpperCase();
  if (DENYLIST.includes(upper)) return true;
  // Any GATEFLOW-prefixed runtime variable is Driver-private by convention.
  return upper.startsWith('GATEFLOW_');
}

/**
 * Build the agent process environment from the Driver environment:
 * base allowlist ∩ actually-present keys, plus present, non-denied
 * `passthrough` keys. `source` defaults to `process.env` (injectable for
 * tests). Secrets on the denylist inside `passthrough` throw
 * CredentialInPassthroughError — fail closed instead of silently leaking.
 */
export function buildAgentEnv(
  passthrough: readonly string[] = [],
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const deniedRequested: string[] = [];
  const env: Record<string, string> = {};

  const wanted = new Set<string>(BASE_ALLOWLIST);
  for (const key of passthrough) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (isDenied(key)) {
      deniedRequested.push(key);
      continue;
    }
    wanted.add(key);
  }
  if (deniedRequested.length > 0) {
    throw new CredentialInPassthroughError(deniedRequested);
  }

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isDenied(key)) continue;
    if (wanted.has(key)) {
      env[key] = value;
    }
  }
  return env;
}
