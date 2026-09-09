/**
 * Comment marker detection (docs/protocol.md section 4).
 *
 * Rules frozen in docs/protocol.md:
 *  - A comment marker must occupy a line of its own: that line, after trim,
 *    equals the marker string exactly. Inline / list / code-block occurrences
 *    do not count. Code blocks are approximated by ``` fence toggling: while
 *    inside a fenced block no marker occurrence is counted at all.
 *  - A comment may contain at most ONE marker occurrence (counted, not
 *    deduplicated): a comment with several marker occurrences — same or mixed
 *    kinds — is invalid and is treated as normal content (anti-spoofing /
 *    anti-format-abuse).
 *  - Markers are structural hints only and are NEVER proof of permission.
 *    Marker-triggered transitions (T1 / T3 / T6) additionally require a
 *    Trusted Human or Trusted Agent publisher and a matching re-read state;
 *    that policy lives in gate.ts, not here.
 *
 * V1 SIMPLIFICATION: the Producer issue-body schema block is gone — issues
 * are plain GitHub issues and work enters the workflow via /ai-plan.
 */
import { ALL_MARKERS, type Marker } from './protocol';

/**
 * Detects the single comment marker of a comment body.
 * Returns null when there is no valid marker: no marker at all, more than one
 * occurrence, or an occurrence that does not own its line (protocol 4.3).
 * Never throws.
 */
export function detectCommentMarker(body: string | null | undefined): Marker | null {
  const inspection = inspectCommentMarkers(body);
  return inspection.kind === 'valid' ? inspection.marker : null;
}

/** Why a comment carried no usable marker, distinguished for gate logging. */
export type CommentMarkerInspection =
  | { kind: 'none' }
  | { kind: 'valid'; marker: Marker }
  | { kind: 'invalid'; reason: 'multiple-marker-occurrences' | 'marker-not-line-exclusive' };

/**
 * Full marker inspection with the rejection reason, so the gate can log
 * spoofing / format abuse distinctly from plain comments (protocol 4.3):
 *  - exactly one marker occurrence AND that occurrence owns its line -> valid;
 *  - more than one occurrence (same or mixed markers) -> invalid;
 *  - a single occurrence sharing its line with other text -> invalid.
 * Occurrences inside fenced code blocks (``` toggling) never count at all
 * (protocol 4.3: "代码块中的不算"), so quoting a marker cannot trigger it.
 */
export function inspectCommentMarkers(body: string | null | undefined): CommentMarkerInspection {
  if (!body) {
    return { kind: 'none' };
  }
  let exclusiveCount = 0;
  let inlineCount = 0;
  let exclusiveMarker: Marker | undefined;
  let insideFence = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      continue; // fenced code-block occurrences never count (protocol 4.3)
    }
    for (const marker of ALL_MARKERS) {
      if (trimmed === marker) {
        exclusiveCount += 1;
        exclusiveMarker = marker;
      } else if (trimmed.includes(marker)) {
        inlineCount += 1;
      }
    }
  }
  if (exclusiveCount === 1 && inlineCount === 0) {
    return { kind: 'valid', marker: exclusiveMarker as Marker };
  }
  if (exclusiveCount + inlineCount > 1) {
    return { kind: 'invalid', reason: 'multiple-marker-occurrences' };
  }
  if (inlineCount === 1) {
    return { kind: 'invalid', reason: 'marker-not-line-exclusive' };
  }
  return { kind: 'none' };
}
