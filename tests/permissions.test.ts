import { describe, expect, it } from 'vitest';
import { isTrustedAgent, isTrustedHuman, parseLoginList } from '../src/permissions';

describe('trusted humans', () => {
  it('accepts the repository owner', () => {
    expect(isTrustedHuman('owner-user', 'owner-user', '')).toBe(true);
  });

  it('compares logins case-insensitively (GitHub login semantics)', () => {
    expect(isTrustedHuman('Owner-User', 'owner-user', '')).toBe(true);
    expect(isTrustedHuman('owner-user', 'OWNER-USER', '')).toBe(true);
  });

  it('accepts logins from the trusted-humans allowlist', () => {
    expect(isTrustedHuman('alice', 'owner-user', 'alice, bob')).toBe(true);
    expect(isTrustedHuman('Bob', 'owner-user', 'alice,bob')).toBe(true);
  });

  it('tolerates whitespace and empty entries in the allowlist', () => {
    expect(isTrustedHuman('carol', 'owner-user', ' alice ,  carol ,')).toBe(true);
    expect(parseLoginList('  alice , bob \n carol ')).toEqual(['alice', 'bob', 'carol']);
    expect(parseLoginList('')).toEqual([]);
    expect(parseLoginList(undefined)).toEqual([]);
    expect(parseLoginList(null)).toEqual([]);
  });

  it('rejects anyone who is neither owner nor allowlisted', () => {
    expect(isTrustedHuman('mallory', 'owner-user', 'alice, bob')).toBe(false);
    expect(isTrustedHuman('mallory', 'owner-user', '')).toBe(false);
  });

  it('rejects missing actors defensively', () => {
    expect(isTrustedHuman('', 'owner-user', '')).toBe(false);
    expect(isTrustedHuman(undefined, 'owner-user', 'alice')).toBe(false);
    expect(isTrustedHuman(null, null, null)).toBe(false);
  });

  it('never consults the trusted-agents list (concepts stay separate)', () => {
    // A registered agent is not a human even if its login is in trusted-agents.
    expect(isTrustedHuman('ci-bot', 'owner-user', '')).toBe(false);
    // And a human check with an owner-shaped agent list still fails.
    expect(isTrustedHuman('owner-user', 'somebody-else', '')).toBe(false);
  });
});

describe('trusted agents', () => {
  it('is false for everyone with the V0 default (empty input)', () => {
    expect(isTrustedAgent('ci-bot', '')).toBe(false);
    expect(isTrustedAgent('owner-user', '')).toBe(false);
    expect(isTrustedAgent('ci-bot', undefined)).toBe(false);
  });

  it('accepts registered agent logins (future bot / GitHub App identities)', () => {
    expect(isTrustedAgent('ci-bot', 'ci-bot, deploy-bot')).toBe(true);
    expect(isTrustedAgent('CI-Bot', 'ci-bot',)).toBe(true);
    expect(isTrustedAgent('deploy-bot', 'ci-bot, deploy-bot')).toBe(true);
  });

  it('rejects unregistered actors', () => {
    expect(isTrustedAgent('mallory', 'ci-bot')).toBe(false);
    expect(isTrustedAgent('', 'ci-bot')).toBe(false);
  });

  it('does not merge with the human concept in either direction', () => {
    const agents = 'ci-bot';
    const humans = 'alice';
    // A registered agent is not a Trusted Human (its login is not in the
    // human owner/allowlist inputs, and the agent input is never consulted).
    expect(isTrustedHuman('ci-bot', 'nobody', humans)).toBe(false);
    expect(isTrustedAgent('ci-bot', agents)).toBe(true);
    // A Trusted Human is not a Trusted Agent.
    expect(isTrustedAgent('alice', agents)).toBe(false);
    expect(isTrustedHuman('alice', 'nobody', humans)).toBe(true);
  });
});
