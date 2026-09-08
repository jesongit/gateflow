/**
 * Shared identity resolution (hardening plan Phase 9 — "Gate / Driver /
 * Bootstrap 共用同一个 Identity Resolver").
 *
 * ONE resolver decides, for every runtime (Gate action, local Driver,
 * epoch bootstrap), who counts as:
 *  - an Effective Trusted Human:
 *      personal repo (owner type "User", verified via the API):
 *        repo owner + configured trusted humans;
 *      any other owner type (Organization, ...):
 *        configured trusted humans ONLY;
 *  - an Effective Trusted Agent:
 *      configured trusted agents (never derived from the owner);
 *  - an Effective Bootstrap Driver (V1.1, Phase 2 epoch trust):
 *      the identities allowed to publish `driver_bootstrap` epoch records.
 *      Configured allowlist; when it is empty AND the repo is personal
 *      (owner type "User") it defaults to the repo owner — the owner is the
 *      terminal authority of a personal repo and typically runs the local
 *      Driver under their own PAT. Organization repos get NO default and
 *      must configure bootstrap drivers explicitly (fail closed, same
 *      philosophy as require-explicit-humans).
 *
 * Secure Mode constraint (frozen): Effective Humans ∩ Effective Agents must
 * be empty, and Bootstrap Drivers must never overlap Effective Humans.
 * Violations are configuration errors: callers fail closed.
 *
 * The owner TYPE must be verified against the GitHub API (repos.get →
 * owner.type) before calling — never taken from an event payload.
 */

export interface IdentityResolverInput {
  /** Owner login as verified via the API. */
  owner: string;
  /** Owner type as verified via the API ("User", "Organization", ...). */
  ownerType: string;
  /** Configured trusted humans (WITHOUT the owner; may be empty). */
  trustedHumans: readonly string[];
  /** Configured trusted agents (may be empty). */
  trustedAgents: readonly string[];
  /**
   * Configured bootstrap-driver allowlist (epoch record issuers of kind
   * `driver_bootstrap`). Empty means "default rule" (see module header).
   */
  bootstrapDrivers?: readonly string[];
  /**
   * When true (default), a non-personal owner with no configured humans is
   * a hard configuration error (GF-H10).
   */
  requireExplicitHumans?: boolean;
}

/** The resolved, authoritative identity sets every runtime codes against. */
export interface EffectiveIdentities {
  /** Effective Trusted Humans (lowercased). */
  humans: ReadonlySet<string>;
  /** Effective Trusted Agents (lowercased). */
  agents: ReadonlySet<string>;
  /** Effective Bootstrap Drivers (lowercased). */
  bootstrapDrivers: ReadonlySet<string>;
  /** True when the owner login itself is an Effective Trusted Human. */
  ownerIsHuman: boolean;
}

export type IdentityResolution =
  | { ok: true; identities: EffectiveIdentities }
  | { ok: false; reason: string };

function normalize(login: string): string {
  return login.trim().toLowerCase();
}

function normalizeList(list: readonly string[] | undefined): string[] {
  return (list ?? []).map(normalize).filter((login) => login.length > 0);
}

/**
 * Resolves and validates the full identity model. Pure function; callers
 * log `reason` and fail closed when not ok.
 */
export function resolveIdentities(input: IdentityResolverInput): IdentityResolution {
  const humans = new Set(normalizeList(input.trustedHumans));
  const agents = new Set(normalizeList(input.trustedAgents));
  const owner = normalize(input.owner);
  const isPersonalOwner = input.ownerType === 'User';

  if (isPersonalOwner && owner.length > 0) {
    humans.add(owner);
  }

  // Bootstrap drivers: explicit allowlist wins; otherwise the personal-repo
  // owner default. Never derived from the agent list.
  const configuredBootstrap = normalizeList(input.bootstrapDrivers);
  const explicitBootstrap = configuredBootstrap.length > 0;
  let bootstrapDrivers: Set<string>;
  if (explicitBootstrap) {
    bootstrapDrivers = new Set(configuredBootstrap);
  } else if (isPersonalOwner && owner.length > 0) {
    bootstrapDrivers = new Set([owner]);
  } else {
    bootstrapDrivers = new Set();
  }

  if (!isPersonalOwner && humans.size === 0 && (input.requireExplicitHumans ?? true)) {
    return {
      ok: false,
      reason:
        `repository owner "${input.owner}" has GitHub type "${input.ownerType}", so the ` +
        'repo-owner login is NOT accepted as a Trusted Human by default. Configure an ' +
        'explicit trusted-humans allowlist (or knowingly disable the explicit-humans ' +
        'requirement). Refusing to run: no safe identity model.',
    };
  }

  for (const human of humans) {
    if (agents.has(human)) {
      return {
        ok: false,
        reason:
          `identity overlap: "${human}" is configured as BOTH a Trusted Human and a ` +
          'Trusted Agent. The two roles are separate concepts and must never share a ' +
          'login. Fix the configuration; refusing to run.',
      };
    }
  }
  for (const bootstrap of bootstrapDrivers) {
    if (!humans.has(bootstrap)) continue;
    // The ONLY tolerated human/bootstrap overlap is the personal-repo owner:
    // the owner is the terminal authority AND the default bootstrap driver.
    if (isPersonalOwner && bootstrap === owner) continue;
    return {
      ok: false,
      reason:
        `identity overlap: "${bootstrap}" is a bootstrap driver AND an Effective Trusted ` +
        'Human. Bootstrap drivers publish workflow epoch records and must be machine ' +
        'identities (only exception: the owner of a personal repository). Refusing to run.',
    };
  }

  return {
    ok: true,
    identities: {
      humans,
      agents,
      bootstrapDrivers,
      ownerIsHuman: humans.has(owner),
    },
  };
}

/** Case-insensitive membership test against a resolved identity set. */
export function identitySetHas(set: ReadonlySet<string>, login: string | null | undefined): boolean {
  if (!login) return false;
  return set.has(login.trim().toLowerCase());
}

/**
 * Convenience for runtimes that only need the BOOTSTRAP DRIVER set (V1.1
 * Phase 2): the epoch-record issuers of class `driver_bootstrap`. Same rule
 * as resolveIdentities: explicit configuration wins; otherwise the owner of
 * a personal (User-type, API-verified) repository.
 */
export function bootstrapDriverSetOf(input: {
  owner: string;
  ownerType: string;
  bootstrapDrivers?: readonly string[];
}): ReadonlySet<string> {
  const configured = normalizeList(input.bootstrapDrivers);
  if (configured.length > 0) {
    return new Set(configured);
  }
  if (input.ownerType === 'User' && input.owner.trim().length > 0) {
    return new Set([input.owner.trim().toLowerCase()]);
  }
  return new Set();
}
