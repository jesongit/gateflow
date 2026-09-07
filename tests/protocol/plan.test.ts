/**
 * Frozen Plan canonicalization + hash test vectors (hardening GF-H03,
 * docs/plans/v1_hardening_decisions.md §6).
 *
 * These vectors are the contract: the Gate (approval issuance) and the Driver
 * (dispatch/sync preflight) MUST hash the same bytes for the same Plan
 * comment. If one of these tests breaks, the protocol changed — not the test.
 */
import { describe, expect, it } from 'vitest';

import { canonicalPlanContent, planSha256, sha256Hex } from '../../src/protocol/plan';

describe('canonicalPlanContent', () => {
  it('drops the plan marker line and the dispatch-id comment line', () => {
    const body = [
      '<!-- ai-workflow:plan:v1 -->',
      '',
      '<!-- gateflow:dispatch-id: gf_r1_i2_w000000000001_executor_p3 -->',
      '',
      '# Plan',
      'Do things.',
    ].join('\n');
    expect(canonicalPlanContent(body)).toBe('# Plan\nDo things.');
  });

  it('drops gate record marker lines but keeps other HTML comments', () => {
    const body = [
      '<!-- ai-workflow:plan:v2 -->',
      '<!-- gateflow:approval:v2 -->',
      '<!-- keep me -->',
      'body',
    ].join('\n');
    expect(canonicalPlanContent(body)).toBe('<!-- keep me -->\nbody');
  });

  it('normalizes CRLF and CR line endings to LF', () => {
    expect(canonicalPlanContent('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('drops marker-shaped lines even inside fences (line-based frozen rule)', () => {
    const body = ['<!-- ai-workflow:plan:v1 -->', '', '```', '<!-- ai-workflow:plan:v1 -->', '```'].join('\n');
    // Canonicalization is deliberately line-based and fence-INDEPENDENT:
    // any marker-shaped line is protocol content and never part of the
    // hashed plan text. What remains are the fence lines.
    expect(canonicalPlanContent(body)).toBe('```\n```');
  });

  it('returns the empty string for protocol-only bodies', () => {
    expect(canonicalPlanContent('<!-- ai-workflow:plan:v1 -->\r\n')).toBe('');
  });
});

describe('planSha256', () => {
  it('is the sha256 of the canonical bytes', () => {
    const body = '<!-- ai-workflow:plan:v1 -->\n\n<!-- gateflow:dispatch-id: x -->\nPlan A\n';
    expect(planSha256(body)).toBe(sha256Hex('Plan A'));
  });

  it('empty content hashes to the well-known empty sha256', () => {
    expect(planSha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('differs when any content byte changes (edit detection)', () => {
    const before = planSha256('step 1\nstep 2');
    const after = planSha256('step 1\nstep 2 edited');
    expect(before).not.toBe(after);
  });

  it('is insensitive to line-ending and trailing-whitespace normalization only', () => {
    expect(planSha256('a\r\nb\r\n')).toBe(planSha256('a\nb'));
  });
});
