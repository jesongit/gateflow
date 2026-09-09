/**
 * Protocol-comment assembly for the Driver (docs/architecture-v1.md
 * section 5: "评论模板 — marker 拼装只在 Driver 侧发生").
 *
 * Every protocol comment body the Driver publishes is built here and ONLY
 * here. Gate markers come from ../gate/protocol (the gate's single source
 * of truth; marker detection semantics live in ../gate/markers). The
 * tracker's `**Status:**` line must stay
 * byte-compatible with the gate's deterministic parser in ../gate/tracker.ts
 * (`**Status:** In Progress` / `**Status:** Blocked` / `**Status:**
 * Completed`).
 *
 * Frozen body layout (blank lines between sections for readability):
 *   line 1:  marker (must own its line, docs/protocol.md section 4.3)
 *   (blank)
 *   dispatch-id comment: <!-- gateflow:dispatch-id: <dispatch_id> -->
 *   (blank)
 *   **Status:** <value>            (execution tracker only)
 *   (blank)
 *   trimmed content                (plan / progress / report)
 *
 * setTrackerStatus is a pure text transformation using the same ``` fence
 * convention as ../gate/tracker.ts and ../gate/markers.ts: lines inside a
 * fenced code block never count. It never throws, and it leaves every other
 * byte of the body — including \r\n line endings — untouched.
 *
 * Markers are structural hints only; whether a body moves state is decided
 * by the Gate, never by the Driver.
 */
import { MARKERS } from '../gate/protocol';
import { parseTrackerStatus, type TrackerStatus } from '../gate/tracker';
import { parseTaskId } from '../workspace/protocol';

/**
 * Matches the dispatch-id HTML comment and captures a schema-3 id. The mode
 * tokens are exactly `plan` | `execute`; old `consumer` / `executor` ids and
 * ids without the epoch segment are intentionally not protocol comments.
 * Not anchored to a line: discovery is string-level, while the captured token
 * is checked again by `parseTaskId` in `findDispatchIdInComment`.
 */
export const DISPATCH_ID_COMMENT_PATTERN: RegExp =
  /<!-- gateflow:dispatch-id: (gf_r\d+_i\d+_w[0-9a-z]{12}_(?:plan_\d+|execute_p\d+)) -->/;

const DISPATCH_ID_OCCURRENCE = /<!-- gateflow:dispatch-id: (\S+) -->/g;
const DISPATCH_ID_TOKEN = '<!-- gateflow:dispatch-id:';

/**
 * Matches a tracker Status machine line: literal bold label, optional
 * whitespace, any value — the same shape the gate parses in
 * ../gate/tracker.ts.
 */
export const STATUS_LINE_PATTERN: RegExp = /^\*\*Status:\*\*\s*(.*)$/;

/** Extracts the dispatch id from a comment body; null when absent/junk. */
export function findDispatchIdInComment(body: string): string | null {
  let insideFence = false;
  const ids: string[] = [];
  let malformedOccurrence = false;

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    const matches = [...trimmed.matchAll(DISPATCH_ID_OCCURRENCE)];
    for (const match of matches) {
      const candidate = match[1] ?? '';
      if (isSchema3DispatchId(candidate)) {
        ids.push(candidate);
      } else {
        malformedOccurrence = true;
      }
    }
    // A dispatch token without the exact closing shape is malformed rather
    // than an excuse to accept another valid-looking occurrence on the line.
    if (trimmed.split(DISPATCH_ID_TOKEN).length - 1 > matches.length) {
      malformedOccurrence = true;
    }
  }

  return ids.length === 1 && !malformedOccurrence ? (ids[0] ?? null) : null;
}

function isSchema3DispatchId(id: string): boolean {
  const parsed = parseTaskId(id);
  if (
    parsed === null ||
    !Number.isSafeInteger(parsed.repositoryId) ||
    parsed.repositoryId < 1 ||
    !Number.isSafeInteger(parsed.issueNumber) ||
    parsed.issueNumber < 1
  ) {
    return false;
  }
  // Keep the mode/revision relationship aligned with the schema-3 builders;
  // parseTaskId owns the overall grammar, this only checks its cross-field
  // meaning for comments.
  return parsed.mode === 'plan'
    ? /^\d+$/.test(parsed.revision)
    : /^p[1-9]\d*$/.test(parsed.revision);
}

/** The dispatch-id HTML comment line for a dispatch. */
function dispatchIdComment(dispatchId: string): string {
  return `<!-- gateflow:dispatch-id: ${dispatchId} -->`;
}

/**
 * Builds a Plan comment body (gate marker T1 trigger). The plan markdown is
 * passed through verbatim apart from outer-whitespace trimming; the body
 * always ends with a newline.
 */
export function buildPlanCommentBody(planMarkdown: string, dispatchId: string): string {
  return `${MARKERS.plan}\n\n${dispatchIdComment(dispatchId)}\n\n${planMarkdown.trim()}\n`;
}

/** Options for building an Execution Tracker comment body. */
export interface TrackerCommentOptions {
  taskId: string;
  /**
   * Accepted for call-site parity with the task record; the frozen body
   * layout does NOT render it separately because task_id already embeds
   * `i<issueNumber>`.
   */
  issueNumber: number;
  status: 'In Progress' | 'Blocked';
  /** Optional progress tail (V1 keeps trackers minimal). */
  progressMarkdown?: string;
}

/**
 * Builds an Execution Tracker comment body (gate marker T3 trigger). The
 * `**Status:**` line is the exact machine format the gate parses for T4/T5.
 * An empty (or whitespace-only) progress section is omitted cleanly.
 */
export function buildTrackerCommentBody(opts: TrackerCommentOptions): string {
  const head = [
    MARKERS.executionTracker,
    '',
    dispatchIdComment(opts.taskId),
    '',
    `**Status:** ${opts.status}`,
  ].join('\n');
  const progress = (opts.progressMarkdown ?? '').trim();
  return progress.length > 0 ? `${head}\n\n${progress}\n` : `${head}\n`;
}

/**
 * Builds a Completion Report comment body (gate marker T6 trigger). The
 * report markdown is passed through verbatim apart from outer-whitespace
 * trimming; the body always ends with a newline.
 */
export function buildCompletionReportBody(reportMarkdown: string, dispatchId: string): string {
  return `${MARKERS.completionReport}\n\n${dispatchIdComment(dispatchId)}\n\n${reportMarkdown.trim()}\n`;
}

/**
 * Replaces the FIRST `**Status:** <value>` line OUTSIDE ``` fences with
 * `**Status:** <status>` (toggle fence state per line, same convention as
 * ../gate/tracker.ts). Later status lines — and anything inside fences —
 * are left untouched, and every other byte of the body (line endings
 * included) is preserved.
 *
 * When no status line exists outside fences, one is inserted right after
 * the dispatch-id comment line, or right after the tracker marker line when
 * there is no dispatch-id comment; if neither exists (defensive, corrupted
 * body) the status line is prepended so the machine value still exists.
 * Never throws on any input.
 */
export function setTrackerStatus(body: string, status: 'In Progress' | 'Blocked'): string {
  // Split keeping the original terminators: even indices are line content,
  // odd indices the \r\n | \r | \n that followed them. Rejoining with
  // Array.prototype.join('') restores the body byte-identically.
  const parts = body.split(/(\r\n|\r|\n)/);
  let insideFence = false;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      continue; // fenced occurrences never count (gate convention)
    }
    if (STATUS_LINE_PATTERN.test(trimmed)) {
      // Preserve the original indentation; the gate matches trimmed lines.
      const indent = line.slice(0, line.length - line.trimStart().length);
      parts[i] = `${indent}**Status:** ${status}`;
      return parts.join('');
    }
  }

  // No status line outside fences: insert one after the best anchor.
  const eol = /(\r\n|\r|\n)/.exec(body)?.[0] ?? '\n';
  const statusLine = `**Status:** ${status}`;
  let anchor = -1;
  for (let i = 0; i < parts.length; i += 2) {
    if (DISPATCH_ID_COMMENT_PATTERN.test((parts[i] ?? '').trim())) {
      anchor = i;
      break;
    }
  }
  if (anchor === -1) {
    for (let i = 0; i < parts.length; i += 2) {
      if ((parts[i] ?? '').trim() === MARKERS.executionTracker) {
        anchor = i;
        break;
      }
    }
  }
  if (anchor === -1) {
    // Defensive: no dispatch-id comment and no marker to anchor on.
    return body.length === 0 ? `${statusLine}\n` : `${statusLine}${eol}${body}`;
  }
  const terminator = parts[anchor + 1];
  const lineEol = typeof terminator === 'string' && terminator.length > 0 ? terminator : eol;
  const insertIdx = anchor + (terminator === undefined ? 1 : 2);
  parts.splice(insertIdx, 0, statusLine, lineEol);
  return parts.join('');
}

/**
 * Extracts the tracker's machine status via the gate's own parser
 * (../gate/tracker.ts): 'In Progress' | 'Blocked' | 'Completed', or null
 * when the body carries no valid Status line outside fences.
 */
export function findTrackerStatus(body: string): TrackerStatus | null {
  const inspection = parseTrackerStatus(body);
  return inspection.kind === 'valid' ? inspection.status : null;
}
