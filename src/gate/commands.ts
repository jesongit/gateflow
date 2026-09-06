/**
 * Strict comment command parsing (docs/protocol.md section 3.1).
 *
 * Rules implemented here:
 *  - Input is the raw issue-comment body.
 *  - Leading/trailing whitespace is tolerated (trim first), nothing else is.
 *  - Parameterless commands (/ai-plan, /approve, /cancel) must match the whole
 *    comment exactly after trim. Substring/prefix matching (body.includes)
 *    is forbidden and never used.
 *  - Parameterized commands (/choose, /change) use ANCHORED regexes over the
 *    trimmed body: the whole comment must be the command. `.` never matches a
 *    newline, so multi-line bodies can never match.
 *  - Matching is case-sensitive: "/Approve" is NOT a command.
 *  - Anything that does not match is a normal comment -> null, which must
 *    never trigger any gate logic. Command-SHAPED bodies with malformed
 *    arguments (e.g. "/choose 1", "/choose 1 B C", a bare "/change", or a
 *    multi-line "/change") are also null: they are normal comments and are
 *    silently ignored (protocol 3.1 rule 7), not "invalid commands".
 *  - /choose and /change arguments are parsed but NEVER interpreted by the
 *    gate: they are forwarded verbatim to the Consumer as untrusted data
 *    (protocol 3.3).
 *
 * Since Phase 2 the gate routes all five frozen commands.
 */
import { COMMANDS, type CommandName } from './protocol';

/** All five frozen commands are routed as of Phase 2. */
export type GateCommand = CommandName;

/** Commands that take no arguments (exact whole-body match after trim). */
export type ExactCommand = Extract<GateCommand, '/ai-plan' | '/approve' | '/cancel'>;

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
  | { command: Extract<GateCommand, '/choose'>; args: ChooseArgs }
  | { command: Extract<GateCommand, '/change'>; args: ChangeArgs };

const EXACT_COMMANDS: ReadonlySet<string> = new Set<string>([
  COMMANDS.aiPlan,
  COMMANDS.approve,
  COMMANDS.cancel,
]);

// Anchored patterns (protocol 3.1 rule 4). Applied to the trimmed body: the
// trailing `$` forbids trailing content and `.` never crosses newlines.
const CHOOSE_PATTERN = /^\/choose (\S+) (\S+)$/;
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
