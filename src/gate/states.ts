/**
 * Workflow state reading and transition legality (docs/protocol.md section 2).
 *
 * src/protocol.ts is the single source of truth: this module only derives a
 * workflow snapshot from a label list and validates transitions against the
 * frozen TRANSITIONS table. It never hardcodes its own state machine.
 */
import {
  ALL_LABELS,
  LABEL_TO_STATE,
  STATES,
  TRANSITIONS,
  type Label,
  type State,
} from './protocol';

/**
 * Workflow snapshot derived from the labels freshly read from the GitHub API.
 *  - outside:     no ai:* label, the issue is not (yet) in the workflow;
 *  - in-workflow: exactly one ai:* label, the expected protocol shape;
 *  - ambiguous:   more than one ai:* label (manual protocol violation);
 *                 no command except /cancel may act on it.
 */
export type WorkflowSnapshot =
  | { status: 'outside' }
  | { status: 'in-workflow'; state: State; label: Label }
  | { status: 'ambiguous'; labels: Label[] };

/** Returns the ai:* workflow labels contained in a raw label-name list. */
export function aiLabelsIn(labels: readonly string[]): Label[] {
  const known = new Set<string>(ALL_LABELS);
  return labels.filter((name): name is Label => known.has(name));
}

/**
 * Classifies a raw label-name list (as returned by the API right before a
 * potential migration) into a WorkflowSnapshot.
 */
export function readSnapshot(labels: readonly string[]): WorkflowSnapshot {
  const aiLabels = aiLabelsIn(labels);
  if (aiLabels.length === 0) {
    return { status: 'outside' };
  }
  if (aiLabels.length > 1) {
    return { status: 'ambiguous', labels: aiLabels };
  }
  const label = aiLabels[0] as Label;
  return { status: 'in-workflow', state: LABEL_TO_STATE[label], label };
}

/**
 * Whether `from -> to` is a legal transition of the frozen state machine.
 * `from === null` means "issue not in the workflow" (the T0 entry).
 * Exiting the workflow via /cancel (removal of all ai:* labels) is not a
 * transition in the table and is validated by the gate itself.
 */
export function isLegalTransition(from: State | null, to: State): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/** True when the given state is the frozen terminal state DONE. */
export function isTerminalState(state: State): boolean {
  return state === STATES.done;
}
