/**
 * Deterministic parsing of the Execution Tracker's `**Status:**` machine
 * value (docs/protocol.md section 2.1, transitions T4 / T5; guide sections
 * 17 / 18). This is the only piece of tracker content the gate ever reads.
 *
 * Rules (Phase 6, recorded in docs/protocol.md "实现备注"):
 *  - The tracker body is scanned line by line with the same ``` fence
 *    convention as markers.ts: lines inside a fenced code block never count,
 *    so quoting the template cannot trigger anything.
 *  - The FIRST line outside fences whose trimmed text matches
 *    `**Status:** <value>` decides the parsed status. Later occurrences are
 *    ignored (the template has exactly one such line; the first is canonical).
 *  - The value is compared case-sensitively against the three frozen machine
 *    values: "In Progress", "Blocked", "Completed". Any other text (different
 *    casing, prose, an empty value) is NOT a machine value: the gate logs and
 *    no-ops instead of guessing.
 *  - Parsing is pure text analysis: it confers no permission and never
 *    triggers anything by itself. The gate only consults it for tracker
 *    marker comments edited by a trusted publisher while the issue sits in
 *    WORKING / BLOCKED (see gate.ts).
 */
/** The three frozen machine values of the tracker Status field. */
export const TRACKER_STATUSES = ['In Progress', 'Blocked', 'Completed'] as const;

export type TrackerStatus = (typeof TRACKER_STATUSES)[number];

/** Outcome of parsing a tracker body, distinguished for gate logging. */
export type TrackerStatusInspection =
  | { kind: 'valid'; status: TrackerStatus }
  | { kind: 'unknown'; raw: string }
  | { kind: 'absent' };

/** Matches a Status line: literal bold label, optional whitespace, the value. */
const STATUS_PATTERN = /^\*\*Status:\*\*\s*(.*)$/;

/**
 * Parses the tracker Status machine value from a comment body.
 * Never throws on any input; returns 'absent' when no Status line exists
 * outside fenced code blocks and 'unknown' (with the raw text) when a Status
 * line exists but its value is not one of the three machine values.
 */
export function parseTrackerStatus(body: string | null | undefined): TrackerStatusInspection {
  if (!body) {
    return { kind: 'absent' };
  }
  let insideFence = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      continue; // fenced occurrences never count (same convention as markers.ts)
    }
    const match = STATUS_PATTERN.exec(trimmed);
    if (match === null) {
      continue;
    }
    const raw = (match[1] ?? '').trim();
    if ((TRACKER_STATUSES as readonly string[]).includes(raw)) {
      return { kind: 'valid', status: raw as TrackerStatus };
    }
    return { kind: 'unknown', raw };
  }
  return { kind: 'absent' };
}
