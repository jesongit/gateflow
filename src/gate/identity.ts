/**
 * Identity-config validation for the gate (hardening GF-H10, docs/plans/
 * v1_hardening_decisions.md §8): Organization repositories must have an
 * explicit Trusted Human allowlist, and the Human / Agent identities must
 * never overlap.
 *
 * The owner TYPE is verified against the GitHub API (repos.get → owner.type),
 * never against the event payload: an attacker who can shape event payloads
 * must not be able to relax identity rules.
 *
 * Fail-closed contract: any validation failure means the gate refuses to run
 * AT ALL (the caller sets the action failed) — a misconfigured identity model
 * must never silently fall back to "owner login counts as a Human".
 */

export interface IdentityConfigInput {
  /** Owner login as verified via the API. */
  owner: string;
  /** Owner type as verified via the API ("User", "Organization", ...). */
  ownerType: string;
  /** Parsed `trusted-humans` allowlist (without the owner). */
  trustedHumans: readonly string[];
  /** Parsed `trusted-agents` allowlist. */
  trustedAgents: readonly string[];
  /**
   * `require-explicit-humans` action input (default true): an Organization
   * (any owner type other than "User") with an empty allowlist is a hard
   * configuration error.
   */
  requireExplicitHumans: boolean;
}

export type IdentityConfigVerdict = { ok: true } | { ok: false; reason: string };

function loginEquals(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Validates the gate's identity configuration before ANY state mutation.
 * Pure function; the caller logs `reason` and fails the run when not ok.
 */
export function validateIdentityConfig(input: IdentityConfigInput): IdentityConfigVerdict {
  const humans = input.trustedHumans.map((h) => h.trim()).filter((h) => h.length > 0);
  const agents = input.trustedAgents.map((a) => a.trim()).filter((a) => a.length > 0);

  for (const human of humans) {
    for (const agent of agents) {
      if (loginEquals(human, agent)) {
        return {
          ok: false,
          reason:
            `identity overlap: "${human}" is configured as BOTH a Trusted Human and a ` +
            'Trusted Agent. The two roles are separate concepts and must never share a ' +
            'login (docs/plans/v1_hardening_decisions.md §3). Fix the gate inputs; refusing to run.',
        };
      }
    }
  }

  const isPersonalOwner = input.ownerType === 'User';
  if (!isPersonalOwner && humans.length === 0 && input.requireExplicitHumans) {
    return {
      ok: false,
      reason:
        `repository owner "${input.owner}" has GitHub type "${input.ownerType}", so the ` +
        'repo-owner login is NOT accepted as a Trusted Human by default. Configure an ' +
        'explicit `trusted-humans` allowlist (or set `require-explicit-humans: false` to ' +
        'accept the risk knowingly). Refusing to run: an Organization repo without an ' +
        'explicit Human allowlist has no safe identity model.',
    };
  }

  return { ok: true };
}
