import { describe, expect, it } from 'vitest';
import { MARKERS } from '../src/protocol';
import { detectCommentMarker } from '../src/markers';

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
