/**
 * Strict comment command parsing (docs/protocol.md section 3.1).
 *
 * SINCE THE V1.1 HARDENING (plan Phase 8) the grammar lives ONCE, in
 * src/protocol/commands.ts, and is shared by the Gate and the Driver. This
 * module is a thin re-export kept for the gate-facing import paths (tests
 * and gate.ts); no gate-local copy of the grammar exists anymore.
 */
export {
  parseCommand,
  isFeedbackCommand,
  APPROVE_PATTERN,
  CHOOSE_PATTERN,
  CHANGE_PATTERN,
  EXACT_COMMANDS,
} from '../protocol/commands';
export type {
  GateCommand,
  ExactCommand,
  ApproveArgs,
  ChooseArgs,
  ChangeArgs,
  ParsedCommand,
} from '../protocol/commands';
