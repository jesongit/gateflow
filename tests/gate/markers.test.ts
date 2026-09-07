import { describe, expect, it } from 'vitest';
import { MARKERS } from '../../src/gate/protocol';
import { detectCommentMarker, inspectCommentMarkers, parseIssueSchemaBlock } from '../../src/gate/markers';

describe('comment marker detection (Phase 1 skeleton)', () => {
  it('recognizes a marker that occupies its own line', () => {
    expect(detectCommentMarker('<!-- ai-workflow:plan:v1 -->')).toBe(MARKERS.plan);
    expect(
      detectCommentMarker('some text\n\n<!-- ai-workflow:execution-tracker:v1 -->\n\nmore'),
    ).toBe(MARKERS.executionTracker);
  });

  it('tolerates indentation but nothing else on the marker line', () => {
    expect(detectCommentMarker('  <!-- ai-workflow:append:v1 -->  ')).toBe(MARKERS.append);
    expect(detectCommentMarker('- <!-- ai-workflow:plan:v1 -->')).toBeNull();
    expect(detectCommentMarker('text <!-- ai-workflow:plan:v1 --> text')).toBeNull();
  });

  it('rejects comments containing more than one marker line', () => {
    expect(
      detectCommentMarker('<!-- ai-workflow:plan:v1 -->\n<!-- ai-workflow:plan:v1 -->'),
    ).toBeNull();
    expect(
      detectCommentMarker('<!-- ai-workflow:plan:v1 -->\n<!-- ai-workflow:append:v1 -->'),
    ).toBeNull();
  });

  it('returns null for comments without markers', () => {
    expect(detectCommentMarker('just a normal comment')).toBeNull();
    expect(detectCommentMarker('')).toBeNull();
    expect(detectCommentMarker(null)).toBeNull();
    expect(detectCommentMarker(undefined)).toBeNull();
  });
});

describe('comment marker inspection with reasons (Phase 2, protocol 4.3)', () => {
  it('reports multiple occurrences of the same marker', () => {
    expect(
      inspectCommentMarkers('<!-- ai-workflow:plan:v1 -->\n<!-- ai-workflow:plan:v1 -->'),
    ).toEqual({ kind: 'invalid', reason: 'multiple-marker-occurrences' });
  });

  it('reports mixed marker kinds as multiple occurrences', () => {
    expect(
      inspectCommentMarkers('<!-- ai-workflow:plan:v1 -->\n<!-- ai-workflow:completion-report:v1 -->'),
    ).toEqual({ kind: 'invalid', reason: 'multiple-marker-occurrences' });
  });

  it('reports an inline occurrence sharing its line as not line-exclusive', () => {
    expect(inspectCommentMarkers('plan: <!-- ai-workflow:plan:v1 -->')).toEqual({
      kind: 'invalid',
      reason: 'marker-not-line-exclusive',
    });
  });

  it('reports an inline occurrence counted on top of an exclusive one as invalid', () => {
    expect(
      inspectCommentMarkers('<!-- ai-workflow:plan:v1 -->\nsee <!-- ai-workflow:plan:v1 --> above'),
    ).toEqual({ kind: 'invalid', reason: 'multiple-marker-occurrences' });
  });

  it('ignores occurrences inside fenced code blocks entirely (protocol 4.3)', () => {
    // Quoting a marker must never trigger it.
    expect(detectCommentMarker('```\n<!-- ai-workflow:plan:v1 -->\n```')).toBeNull();
    expect(
      detectCommentMarker('Example:\n\n```md\n<!-- ai-workflow:execution-tracker:v1 -->\n```\n'),
    ).toBeNull();
    // A fenced occurrence does not count against a real one outside the fence.
    expect(
      detectCommentMarker('<!-- ai-workflow:plan:v1 -->\n```\n<!-- ai-workflow:plan:v1 -->\n```'),
    ).toBe(MARKERS.plan);
  });

  it('treats an issue-body style schema block inside a comment as no marker', () => {
    expect(
      detectCommentMarker(
        '<!-- ai-workflow\nschema: 2\nsource: producer\nkind: feature\nmaturity_hint: solution\n-->',
      ),
    ).toBeNull();
  });
});

describe('issue body schema block parsing (Phase 2, protocol 4.1)', () => {
  // Hardening: the Producer schema block carries protocol schema 2.
  const validBlock =
    '<!-- ai-workflow\nschema: 2\nsource: producer\nkind: feature\nmaturity_hint: solution\n-->';

  it('parses a valid block into its frozen metadata', () => {
    expect(parseIssueSchemaBlock(`## Goal\n\nwork\n\n${validBlock}`)).toEqual({
      status: 'valid',
      metadata: { schema: 2, source: 'producer', kind: 'feature', maturityHint: 'solution' },
    });
  });

  it('returns absent for bodies without a schema block', () => {
    expect(parseIssueSchemaBlock('plain issue body')).toEqual({ status: 'absent' });
    expect(parseIssueSchemaBlock('')).toEqual({ status: 'absent' });
    expect(parseIssueSchemaBlock(null)).toEqual({ status: 'absent' });
  });

  it('invalidates the whole block on unknown keys', () => {
    expect(parseIssueSchemaBlock(`${validBlock.slice(0, -3)}\npriority: high\n-->`)).toEqual({
      status: 'invalid',
      reason: 'unknown schema key "priority"',
    });
  });

  it('invalidates the whole block on duplicate keys', () => {
    expect(
      parseIssueSchemaBlock(
        '<!-- ai-workflow\nschema: 2\nschema: 2\nsource: producer\nkind: bug\nmaturity_hint: direction\n-->',
      ),
    ).toEqual({ status: 'invalid', reason: 'duplicate schema key "schema"' });
  });

  it('invalidates the whole block on missing keys', () => {
    expect(
      parseIssueSchemaBlock('<!-- ai-workflow\nschema: 2\nsource: producer\nkind: bug\n-->'),
    ).toEqual({ status: 'invalid', reason: 'missing required schema key(s)' });
  });

  it('invalidates the whole block on illegal enum values or version', () => {
    expect(parseIssueSchemaBlock(validBlock.replace('kind: feature', 'kind: epic'))).toEqual({
      status: 'invalid',
      reason: 'unknown kind "epic"',
    });
    expect(
      parseIssueSchemaBlock(validBlock.replace('maturity_hint: solution', 'maturity_hint: vibes')),
    ).toEqual({ status: 'invalid', reason: 'unknown maturity_hint "vibes"' });
    expect(parseIssueSchemaBlock(validBlock.replace('schema: 2', 'schema: 3'))).toEqual({
      status: 'invalid',
      reason: 'unsupported schema version "3"',
    });
    expect(parseIssueSchemaBlock(validBlock.replace('source: producer', 'source: ai'))).toEqual({
      status: 'invalid',
      reason: 'unsupported source "ai"',
    });
  });

  it('invalidates an unterminated block', () => {
    expect(parseIssueSchemaBlock('<!-- ai-workflow\nschema: 2\n')).toEqual({
      status: 'invalid',
      reason: 'schema block is not terminated by "-->"',
    });
  });
});
