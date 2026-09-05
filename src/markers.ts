/**
 * Comment marker detection and issue-body schema parsing (docs/protocol.md
 * section 4).
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
 *  - The issue body schema block (`<!-- ai-workflow ... -->`) is Producer
 *    metadata (kind / maturity_hint). It is parsed for observability only and
 *    never triggers a state transition.
 */
import {
  ALL_MARKERS,
  KINDS,
  MATURITY_HINTS,
  SCHEMA_VERSION,
  type Kind,
  type Marker,
  type MaturityHint,
} from './protocol';

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

/** Parsed issue-body schema block metadata (protocol 4.1, values frozen). */
export interface IssueSchemaMetadata {
  schema: typeof SCHEMA_VERSION;
  source: 'producer';
  kind: Kind;
  maturityHint: MaturityHint;
}

export type IssueSchemaBlock =
  | { status: 'valid'; metadata: IssueSchemaMetadata }
  | { status: 'absent' }
  | { status: 'invalid'; reason: string };

const SCHEMA_OPENER = '<!-- ai-workflow';
const SCHEMA_CLOSER = '-->';
const SCHEMA_KEYS: ReadonlySet<string> = new Set(['schema', 'source', 'kind', 'maturity_hint']);

/**
 * Parses the Producer schema block from an issue body (protocol 4.1).
 * Observability only: the gate never derives state or permissions from it.
 * The opener must occupy its own line; unknown keys, duplicate keys, missing
 * keys or illegal values invalidate the WHOLE block (the issue is then treated
 * as a plain issue).
 */
export function parseIssueSchemaBlock(body: string | null | undefined): IssueSchemaBlock {
  if (!body) {
    return { status: 'absent' };
  }
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const openIdx = lines.indexOf(SCHEMA_OPENER);
  if (openIdx === -1) {
    return { status: 'absent' };
  }
  let closeIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i += 1) {
    if (lines[i] === SCHEMA_CLOSER) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { status: 'invalid', reason: 'schema block is not terminated by "-->"' };
  }

  const fields = new Map<string, string>();
  for (let i = openIdx + 1; i < closeIdx; i += 1) {
    const line = lines[i] ?? '';
    if (line.length === 0) {
      continue; // tolerate blank lines inside the block
    }
    const match = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (match === null) {
      return { status: 'invalid', reason: `unparseable schema line "${line}"` };
    }
    const key = match[1] ?? '';
    const value = (match[2] ?? '').trim();
    if (!SCHEMA_KEYS.has(key)) {
      return { status: 'invalid', reason: `unknown schema key "${key}"` };
    }
    if (fields.has(key)) {
      return { status: 'invalid', reason: `duplicate schema key "${key}"` };
    }
    fields.set(key, value);
  }

  const schema = fields.get('schema');
  const source = fields.get('source');
  const kind = fields.get('kind');
  const maturityHint = fields.get('maturity_hint');
  if (
    schema === undefined ||
    source === undefined ||
    kind === undefined ||
    maturityHint === undefined
  ) {
    return { status: 'invalid', reason: 'missing required schema key(s)' };
  }
  if (schema !== String(SCHEMA_VERSION)) {
    return { status: 'invalid', reason: `unsupported schema version "${schema}"` };
  }
  if (source !== 'producer') {
    return { status: 'invalid', reason: `unsupported source "${source}"` };
  }
  if (!(KINDS as readonly string[]).includes(kind)) {
    return { status: 'invalid', reason: `unknown kind "${kind}"` };
  }
  if (!(MATURITY_HINTS as readonly string[]).includes(maturityHint)) {
    return { status: 'invalid', reason: `unknown maturity_hint "${maturityHint}"` };
  }
  return {
    status: 'valid',
    metadata: {
      schema: SCHEMA_VERSION,
      source: 'producer',
      kind: kind as Kind,
      maturityHint: maturityHint as MaturityHint,
    },
  };
}
