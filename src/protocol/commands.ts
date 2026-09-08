/**
 * Shared command parsing (docs/protocol.md section 3.1) — the ONE copy of
 * the frozen command grammar (hardening plan Phase 8: "Gate / Driver 不再
 * 各自解析命令").
 *
 * Both the Gate (authorization) and the Driver (feedback projection,
 * approval-anchor re-validation) import from here; neither keeps a second
 * regex table. Rules (frozen):
 *  - Input is the raw issue-comment body; leading/trailing whitespace is
 *    tolerated (trim first), nothing else is.
 *  - Parameterless commands (/ai-plan, /cancel) must match the whole comment
 *    exactly after trim. Substring/prefix matching is forbidden.
 *  - Parameterized commands (/choose, /change, /approve) use ANCHORED
 *    regexes over the trimmed body: the whole comment must be the command.
 *    `.` never matches a newline, so multi-line bodies can never match.
 *  - V1: /approve carries the plan comment id ("/approve <plan-comment-id>").
 *    The bare "/approve" is a normal comment, silently ignored.
 *  - Matching is case-sensitive: "/CHANGE" is not a command.
 *  - Command-SHAPED bodies with malformed arguments (e.g. "/choose 1",
 *    a bare "/change", "/approve abc") are normal comments (null), never
 *    "invalid commands".
 *  - /choose and /change arguments are parsed but NEVER interpreted:
 *    forwarded verbatim to the Consumer as untrusted data.
 */
import { COMMANDS, type CommandName } from '../gate/protocol';

/** All five frozen commands are routed. */
export type GateCommand = CommandName;

/** Commands that take no arguments (exact whole-body match after trim). */
export type ExactCommand = Extract<GateCommand, '/ai-plan' | '/cancel'>;

/** Strictly parsed /approve argument: the plan comment id being approved. */
export interface ApproveArgs {
  planCommentId: number;
}

/** Strictly parsed /choose arguments: exactly two non-whitespace tokens. */
export interface ChooseArgs {
  questionId: string;
  choice: string;
}

/** Strictly parsed /change argument: the free text after the command word. */
export interface ChangeArgs {
  text: string;
}

/** A parsed comment command: the command plus its (possibly absent) args. */
export type ParsedCommand =
  | { command: ExactCommand; args: null }
  | { command: Extract<GateCommand, '/approve'>; args: ApproveArgs }
  | { command: Extract<GateCommand, '/choose'>; args: ChooseArgs }
  | { command: Extract<GateCommand, '/change'>; args: ChangeArgs };

export const EXACT_COMMANDS: ReadonlySet<string> = new Set<string>([
  COMMANDS.aiPlan,
  COMMANDS.cancel,
]);

// Anchored patterns (protocol 3.1 rule 4). Applied to the trimmed body: the
// trailing `$` forbids trailing content and `.` never crosses newlines.
// V1: /approve takes exactly one argument, a decimal-digit comment id.
export const APPROVE_PATTERN = /^\/approve (\d+)$/;
export const CHOOSE_PATTERN = /^\/choose (\S+) (\S+)$/;
export const CHANGE_PATTERN = /^\/change (.+)$/;

/**
 * Parses an issue-comment body into a ParsedCommand.
 * Returns null for normal comments — including texts that merely contain a
 * command word and command-shaped bodies with malformed arguments. Never
 * throws on any input.
 */
export function parseCommand(body: string | null | undefined): ParsedCommand | null {
  if (body === null || body === undefined) {
    return null;
  }
  const trimmed = body.trim();

  if (EXACT_COMMANDS.has(trimmed)) {
    return { command: trimmed as ExactCommand, args: null };
  }

  const approve = APPROVE_PATTERN.exec(trimmed);
  if (approve !== null) {
    return {
      command: COMMANDS.approve,
      args: { planCommentId: Number(approve[1] ?? '0') },
    };
  }

  const choose = CHOOSE_PATTERN.exec(trimmed);
  if (choose !== null) {
    return {
      command: COMMANDS.choose,
      args: { questionId: choose[1] ?? '', choice: choose[2] ?? '' },
    };
  }

  const change = CHANGE_PATTERN.exec(trimmed);
  if (change !== null) {
    const text = (change[1] ?? '').trim();
    if (text.length === 0) {
      // Defensive: the body was trimmed, so `(.+)` already guarantees at
      // least one character. Protocol 3.2 requires non-empty free text.
      return null;
    }
    return { command: COMMANDS.change, args: { text } };
  }

  return null;
}

/**
 * Whether the trimmed body is an anchored /choose (respectively /change)
 * command of the given kind. Shared by the Driver's accepted-feedback
 * anchoring and the feedback text extraction.
 */
export function isFeedbackCommand(
  trimmedBody: string,
  kind: 'choose' | 'change',
): boolean {
  return kind === 'choose'
    ? CHOOSE_PATTERN.exec(trimmedBody) !== null
    : CHANGE_PATTERN.exec(trimmedBody) !== null;
}
