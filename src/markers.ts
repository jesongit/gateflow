/**
 * Comment marker detection (docs/protocol.md section 4).
 *
 * PHASE 1 SKELETON: only the structural recognition primitives live here.
 * The full marker semantics arrive in Phase 2:
 *  - actor validation for marker-triggered transitions (T1 / T3 / T6:
 *    publisher must be Trusted Human or Trusted Agent);
 *  - plan version tracking ("current plan" = last comment with a valid
 *    plan marker) for the Phase 5 /approve version check;
 *  - issue-body schema block parsing (Producer metadata).
 *
 * Reminders frozen in docs/protocol.md:
 *  - A comment marker must occupy a line of its own: that line, after trim,
 *    equals the marker string exactly. Inline / list / code-block occurrences
 *    do not count.
 *  - A comment may contain at most ONE marker (counted, not deduplicated):
 *    a comment with several markers of any kind is invalid and is treated as
 *    normal content.
 *  - Markers are structural hints only and are NEVER proof of permission.
 */
import { ALL_MARKERS, type Marker } from './protocol';

/**
 * Detects the single comment marker of a comment body.
 * Returns null when there is no line-exact marker, or when more than one
 * marker line is present (invalid per protocol 4.3). Never throws.
 */
export function detectCommentMarker(body: string | null | undefined): Marker | null {
  if (!body) {
    return null;
  }
  const found: Marker[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    for (const marker of ALL_MARKERS) {
      if (trimmed === marker) {
        found.push(marker);
      }
    }
  }
  return found.length === 1 ? (found[0] as Marker) : null;
}
