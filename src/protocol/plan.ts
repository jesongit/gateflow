/**
 * Frozen Plan canonicalization + hash (docs/plans/v1_hardening_decisions.md
 * §6, hardening plan GF-H03).
 *
 * This module is the SINGLE implementation of the Plan content hash. The Gate
 * computes `plan_sha256` when it issues an Approval Record and the Driver
 * recomputes it from the CURRENT Plan comment body before every dispatch and
 * sync — both MUST import from here; a second implementation anywhere is a
 * protocol violation.
 *
 * Canonicalization (frozen):
 *  1. split the comment body on CRLF, CR or LF (all three normalize to LF);
 *  2. drop every line whose trimmed form is a workflow marker, a
 *     `gateflow:dispatch-id` HTML comment, or a `gateflow:<kind>:v2` record
 *     marker (line-based, fence-independent — a marker-shaped line is
 *     protocol content wherever it appears);
 *  3. join with "\n" and trim.
 *
 * `plan_sha256` is the hex sha256 over the UTF-8 bytes of the canonical
 * content. Any edit to the Plan comment that changes the canonical bytes
 * invalidates an existing Approval (fail closed).
 */
import { createHash } from 'node:crypto';

/** Line shapes dropped by the canonicalization (trimmed-line exact tests). */
const DROPPED_LINE_PATTERNS: readonly RegExp[] = [
  /^<!--\s*ai-workflow:[a-z-]+:v\d+\s*-->$/, // workflow markers (plan/tracker/report/append)
  /^<!--\s*gateflow:dispatch-id:\s*\S+\s*-->$/, // dispatch-id anchor comment
  /^<!--\s*gateflow:[a-z-]+:v\d+\s*-->$/, // gate record markers (workflow/approval/feedback)
];

/**
 * Canonical Plan content of a Plan comment body: the comment minus protocol
 * lines, line-ending-normalized (CRLF and CR both become LF), trimmed. This
 * exact text is projected into the executor's inbox PLAN.md and hashed into
 * `plan_sha256`.
 */
export function canonicalPlanContent(planCommentBody: string): string {
  const kept = planCommentBody
    .split(/(?:\r\n|\r|\n)/)
    .filter((line) => {
      const trimmed = line.trim();
      return !DROPPED_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
    })
    .join('\n');
  return kept.trim();
}

/** Hex sha256 over the UTF-8 bytes of a string. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * The frozen Plan content hash of a Plan comment body. Test vectors:
 *  - canonicalPlanContent('\r\n') === '' and
 *    planSha256('') === sha256 of the empty string;
 *  - dropping only affects protocol lines; every other byte (after line-ending
 *    normalization and trim) is hash-relevant (tests/protocol/plan.test.ts).
 */
export function planSha256(planCommentBody: string): string {
  return sha256Hex(canonicalPlanContent(planCommentBody));
}
