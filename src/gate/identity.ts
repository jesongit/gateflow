/**
 * Identity-config validation for the gate (hardening GF-H10, docs/plans/
 * v1_hardening_decisions.md §8; V1.1 Phase 9 delegates the resolution to the
 * SHARED resolver in src/protocol/identity.ts so the Gate, the Driver and
 * the epoch bootstrap all answer identity questions identically).
 *
 * The owner TYPE is verified against the GitHub API (repos.get → owner.type),
 * never against the event payload: an attacker who can shape event payloads
 * must not be able to relax identity rules.
 *
 * Fail-closed contract: any validation failure means the gate refuses to run
 * AT ALL (the caller sets the action failed) — a misconfigured identity model
 * must never silently fall back to "owner login counts as a Human".
 */
import { resolveIdentities } from '../protocol/identity';

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
   * Parsed `bootstrap-drivers` allowlist (V1.1 Phase 2: identities allowed to
   * issue `driver_bootstrap` epoch records). Empty = default rule (the owner
   * of a personal repository).
   */
  bootstrapDrivers?: readonly string[];
  /**
   * `require-explicit-humans` action input (default true): an Organization
   * (any owner type other than "User") with an empty allowlist is a hard
   * configuration error.
   */
  requireExplicitHumans: boolean;
}

export type IdentityConfigVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Validates the gate's identity configuration before ANY state mutation.
 * Pure function; the caller logs `reason` and fails the run when not ok.
 */
export function validateIdentityConfig(input: IdentityConfigInput): IdentityConfigVerdict {
  const resolution = resolveIdentities({
    owner: input.owner,
    ownerType: input.ownerType,
    trustedHumans: input.trustedHumans,
    trustedAgents: input.trustedAgents,
    bootstrapDrivers: input.bootstrapDrivers,
    requireExplicitHumans: input.requireExplicitHumans,
  });
  if (resolution.ok) {
    return { ok: true };
  }
  return { ok: false, reason: resolution.reason };
}

export { resolveIdentities, identitySetHas } from '../protocol/identity';
export type { EffectiveIdentities, IdentityResolution } from '../protocol/identity';
