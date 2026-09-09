/**
 * Strict comment command parsing (docs/protocol.md section 3.1).
 *
 * Rules implemented here:
 *  - Input is the raw issue-comment body.
 *  - Leading/trailing whitespace is tolerated (trim first), nothing else is.
 *  - Parameterless commands (/ai-plan, /cancel) must match the whole comment
 *    exactly after trim. Substring/prefix matching (body.includes)
 *    is forbidden and never used.
 *  - Parameterized commands (/change, /approve) use ANCHORED regexes
 *    over the trimmed body: the whole comment must be the command. `.` never
 *    matches a newline, so multi-line bodies can never match.
 *  - /approve carries the plan comment id it approves:
 *    "/approve <plan-comment-id>" where <plan-comment-id> is a run of decimal
 *    digits. The bare command "/approve" is NOT a command — it is a normal
 *    comment and is silently ignored (protocol 3.1 rule 7).
 *  - Matching is case-sensitive: "/Approve" is NOT a command.
 *  - Anything that does not match is a normal comment -> null, which must
 *    never trigger any gate logic. Command-SHAPED bodies with malformed
 *    arguments (a bare "/change", a multi-line "/change", "/approve abc" or
 *    "/approve 123 extra") are also null: they are normal comments and are
 *    silently ignored (protocol 3.1 rule 7), not "invalid commands".
 *  - V1 SIMPLIFICATION: /choose is gone. Free-form questions or decisions are
 *    expressed through "/change <feedback>" — one feedback channel instead of
 *    two (docs/plans/v1-simplification-plan.md §5.2).
 *  - /change arguments are parsed but NEVER interpreted by the gate: they are
 *    forwarded verbatim to the planner as untrusted data (protocol 3.3).
 */
import { COMMANDS, type CommandName } from './protocol';

/** All frozen commands are routed here. */
export type GateCommand = CommandName;

/** Commands that take no arguments (exact whole-body match after trim). */
export type ExactCommand = Extract<GateCommand, '/ai-plan' | '/cancel'>;

/** Strictly parsed /approve argument: the plan comment id being approved. */
export interface ApproveArgs {
  planCommentId: number;
}

/** Strictly parsed /change argument: the free text after the command word. */
export interface ChangeArgs {
  text: string;
}

/** A parsed comment command: the command plus its (possibly absent) args. */
export type ParsedCommand =
  | { command: ExactCommand; args: null }
  | { command: Extract<GateCommand, '/approve'>; args: ApproveArgs }
  | { command: Extract<GateCommand, '/change'>; args: ChangeArgs };

const EXACT_COMMANDS: ReadonlySet<string> = new Set<string>([
  COMMANDS.aiPlan,
  COMMANDS.cancel,
]);

// Anchored patterns (protocol 3.1 rule 4). Applied to the trimmed body: the
// trailing `$` forbids trailing content and `.` never crosses newlines.
const APPROVE_PATTERN = /^\/approve (\d+)$/;
const CHANGE_PATTERN = /^\/change (.+)$/;

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
