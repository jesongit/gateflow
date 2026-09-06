/**
 * Frozen V0 protocol constants (schema 1).
 *
 * Single source of truth: docs/protocol.md. Any change here must be mirrored
 * in docs/protocol.md and treated as a protocol upgrade (bump schema version).
 * Markers are structural hints only and are NEVER proof of permission.
 *
 * V1 amendment (protocol v2 document, github-schema-v2.json): the /approve
 * command now carries the plan comment id it approves — "/approve
 * <plan-comment-id>" (docs/protocol.md section 3.4 "V1 审批证明
 * （Plan-ID 绑定）"). The issue-body schema block, all label strings, all
 * marker strings and SCHEMA_VERSION are unchanged (still 1); see
 * docs/protocol.md for the normative V1 wording.
 */

/** Protocol / marker schema version, frozen for V0. */
export const SCHEMA_VERSION = 1 as const;

/**
 * Workflow labels. An issue holds at most one ai:* label at any time;
 * BLOCKED is a sub-state of WORKING expressed by its own label.
 */
export const LABELS = {
  planning: 'ai:planning',
  review: 'ai:review',
  ready: 'ai:ready',
  working: 'ai:working',
  blocked: 'ai:blocked',
  done: 'ai:done',
} as const;

export type Label = (typeof LABELS)[keyof typeof LABELS];

export const ALL_LABELS: readonly Label[] = Object.values(LABELS);

/** Canonical workflow state names. */
export const STATES = {
  planning: 'PLANNING',
  review: 'REVIEW',
  ready: 'READY',
  working: 'WORKING',
  blocked: 'BLOCKED',
  done: 'DONE',
} as const;

export type State = (typeof STATES)[keyof typeof STATES];

/** Label -> state mapping. */
export const LABEL_TO_STATE: Readonly<Record<Label, State>> = {
  [LABELS.planning]: STATES.planning,
  [LABELS.review]: STATES.review,
  [LABELS.ready]: STATES.ready,
  [LABELS.working]: STATES.working,
  [LABELS.blocked]: STATES.blocked,
  [LABELS.done]: STATES.done,
};

/**
 * State -> label mapping. Purely derived from LABEL_TO_STATE (the inverse
 * view); not a separate protocol concept.
 */
export const STATE_TO_LABEL: Readonly<Record<State, Label>> = Object.fromEntries(
  Object.entries(LABEL_TO_STATE).map(([label, state]) => [state, label]),
) as Readonly<Record<State, Label>>;

/**
 * Legal transitions of the frozen state machine.
 * `from: null` means "issue not yet in the workflow" (no ai:* label).
 * T1/T3/T6 are marker-triggered; T2 is a Trusted Human command;
 * T4/T5 are parsed deterministically from the tracker Status field.
 */
export const TRANSITIONS: ReadonlyArray<{ from: State | null; to: State }> = [
  { from: null, to: STATES.planning }, // T0: /ai-plan by Trusted Human, or Producer CREATE
  { from: STATES.planning, to: STATES.review }, // T1: plan marker comment
  { from: STATES.review, to: STATES.ready }, // T2: /approve by Trusted Human
  { from: STATES.ready, to: STATES.working }, // T3: execution tracker marker comment
  { from: STATES.working, to: STATES.blocked }, // T4: tracker Status: Blocked
  { from: STATES.blocked, to: STATES.working }, // T5: tracker Status: In Progress
  { from: STATES.working, to: STATES.done }, // T6: completion report marker comment
];

/** Comment commands. Parsing is strict (exact / anchored match only). */
export const COMMANDS = {
  aiPlan: '/ai-plan',
  approve: '/approve',
  choose: '/choose',
  change: '/change',
  cancel: '/cancel',
} as const;

export type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS];

export const ALL_COMMANDS: readonly CommandName[] = Object.values(COMMANDS);

/**
 * Comment markers. Must appear on a line of their own (exact match after
 * trim). A comment containing more than one marker is invalid.
 */
export const MARKERS = {
  append: '<!-- ai-workflow:append:v1 -->',
  plan: '<!-- ai-workflow:plan:v1 -->',
  executionTracker: '<!-- ai-workflow:execution-tracker:v1 -->',
  completionReport: '<!-- ai-workflow:completion-report:v1 -->',
} as const;

export type Marker = (typeof MARKERS)[keyof typeof MARKERS];

export const ALL_MARKERS: readonly Marker[] = Object.values(MARKERS);

/** Work item kinds written into the issue body schema block (frozen enum). */
export const KINDS = ['feature', 'bug', 'refactor', 'docs', 'chore'] as const;

export type Kind = (typeof KINDS)[number];

/** Maturity hints written by the Producer. Hints only; never trusted blindly. */
export const MATURITY_HINTS = [
  'requirement',
  'direction',
  'solution',
  'execution_plan',
] as const;

export type MaturityHint = (typeof MATURITY_HINTS)[number];

/** Maturity levels evaluated by the Consumer (effective maturity). */
export const MATURITY_LEVELS = {
  l0: 'L0 Requirement',
  l1: 'L1 Direction',
  l2: 'L2 Solution',
  l3: 'L3 Execution Plan',
} as const;

/** Suggested label colors (hex, no leading '#') for bootstrap in Phase 8. */
export const LABEL_COLORS: Readonly<Record<Label, string>> = {
  [LABELS.planning]: 'd4c5f9',
  [LABELS.review]: 'fef2c0',
  [LABELS.ready]: 'c2e0c6',
  [LABELS.working]: '1d76db',
  [LABELS.blocked]: 'd93f0b',
  [LABELS.done]: '0e8a16',
};
