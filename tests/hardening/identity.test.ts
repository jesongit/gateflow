/**
 * Hardening tests — Gate identity configuration (GF-H10, docs/plans/
 * v1_hardening_decisions.md §8): Organization repositories require an
 * explicit Trusted Human allowlist; Human/Agent allowlists never overlap.
 */
import { describe, expect, it } from 'vitest';

import { validateIdentityConfig } from '../../src/gate/identity';

const BASE = {
  owner: 'octo-org',
  ownerType: 'User',
  trustedHumans: [] as readonly string[],
  trustedAgents: [] as readonly string[],
  requireExplicitHumans: true,
};

describe('validateIdentityConfig (fail closed)', () => {
  it('a personal repo without an allowlist is fine (owner is the Human)', () => {
    expect(validateIdentityConfig(BASE)).toEqual({ ok: true });
  });

  it('an Organization repo without trusted-humans is REJECTED', () => {
    const verdict = validateIdentityConfig({ ...BASE, ownerType: 'Organization' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/trusted-humans/);
    }
  });

  it('an Organization repo WITH an explicit allowlist is accepted', () => {
    expect(
      validateIdentityConfig({ ...BASE, ownerType: 'Organization', trustedHumans: ['alice'] }),
    ).toEqual({ ok: true });
  });

  it('require-explicit-humans=false knowingly accepts the risk', () => {
    expect(
      validateIdentityConfig({
        ...BASE,
        ownerType: 'Organization',
        requireExplicitHumans: false,
      }),
    ).toEqual({ ok: true });
  });

  it('Human/Agent allowlist overlap is REJECTED in any casing', () => {
    const verdict = validateIdentityConfig({
      ...BASE,
      trustedHumans: ['Alice'],
      trustedAgents: ['alice'],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/overlap/i);
    }
  });

  it('a non-User owner type that is not Organization is treated as non-personal', () => {
    // e.g. a renamed/unknown type: fail closed — the default requires an
    // explicit allowlist for anything that is not verifiably a personal user.
    expect(
      validateIdentityConfig({ ...BASE, ownerType: 'SomethingElse' }).ok,
    ).toBe(false);
  });
});
