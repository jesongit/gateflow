/**
 * Identity checks (docs/protocol.md section 6).
 *
 * V0 rules:
 *  - Trusted Human = repository owner login, extensible via the
 *    `trusted-humans` action input (comma-separated login allowlist).
 *    Only Trusted Humans may execute commands.
 *  - Trusted Agent = independent bot / GitHub App identity registered via the
 *    `trusted-agents` action input. V0 default: empty.
 *
 * Trusted Human and Trusted Agent are two DIFFERENT concepts and are never
 * merged in code: a Trusted Agent can never run a command (not even
 * coincidentally, because isTrustedHuman never consults the agent list);
 * the agent concept only matters for marker-triggered transitions
 * (T1 / T3 / T6, wired in a later phase).
 *
 * Future extensions intentionally kept out of V0: permission-level checks
 * (maintain/admin), team-based allowlists, GitHub App identity verification.
 * They would extend isTrustedHuman / isTrustedAgent, not blend them.
 */

/**
 * Parses a comma-separated login list from an action input.
 * Splitting tolerates commas and surrounding whitespace (YAML inputs may
 * contain line breaks); GitHub logins never contain whitespace, so folding
 * all whitespace into the separator is safe.
 */
export function parseLoginList(input: string | null | undefined): string[] {
  if (!input) {
    return [];
  }
  return input
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** GitHub logins are case-insensitive for comparison purposes. */
function loginEquals(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Whether `actor` may act as a Trusted Human:
 * the repository owner, or a login in the `trusted-humans` allowlist.
 */
export function isTrustedHuman(
  actor: string | null | undefined,
  repoOwner: string | null | undefined,
  trustedHumansInput: string | null | undefined,
): boolean {
  if (!actor) {
    return false;
  }
  if (repoOwner && loginEquals(actor, repoOwner)) {
    return true;
  }
  return parseLoginList(trustedHumansInput).some((login) => loginEquals(actor, login));
}

/**
 * Whether `actor` is a registered Trusted Agent (independent bot identity).
 * Default (empty `trusted-agents` input): always false.
 * This NEVER grants command rights; it only legitimizes marker publishing
 * for marker-triggered transitions.
 */
export function isTrustedAgent(
  actor: string | null | undefined,
  trustedAgentsInput: string | null | undefined,
): boolean {
  if (!actor) {
    return false;
  }
  return parseLoginList(trustedAgentsInput).some((login) => loginEquals(actor, login));
}
