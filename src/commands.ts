/**
 * Strict comment command parsing (docs/protocol.md section 3.1).
 *
 * Rules implemented here:
 *  - Input is the raw issue-comment body.
 *  - Leading/trailing whitespace is tolerated (trim first), nothing else is.
 *  - Parameterless commands (/ai-plan, /approve, /cancel) must match the whole
 *    comment exactly after trim. Substring/prefix matching (body.includes)
 *    is forbidden and never used.
 *  - Matching is case-sensitive: "/Approve" is NOT a command.
 *  - Anything that does not exactly match is a normal comment -> null, which
 *    must never trigger any gate logic.
 *
 * Phase 1 only routes /ai-plan, /approve and /cancel. /choose and /change are
 * frozen in the protocol but deliberately return null here until Phase 2; a
 * Phase-1 build must treat them as normal comments (silent no-op).
 */
import { COMMANDS, type CommandName } from './protocol';

/** Commands handled by the Phase 1 gate. */
export type GateCommand = Extract<CommandName, '/ai-plan' | '/approve' | '/cancel'>;

const EXACT_COMMANDS: ReadonlyMap<string, GateCommand> = new Map([
  [COMMANDS.aiPlan, COMMANDS.aiPlan],
  [COMMANDS.approve, COMMANDS.approve],
  [COMMANDS.cancel, COMMANDS.cancel],
]);

/**
 * Parses an issue-comment body into a GateCommand.
 * Returns null for normal comments and for commands not implemented yet
 * (/choose, /change arrive in Phase 2). Never throws on any input.
 */
export function parseCommand(body: string | null | undefined): GateCommand | null {
  if (body === null || body === undefined) {
    return null;
  }
  return EXACT_COMMANDS.get(body.trim()) ?? null;
}
