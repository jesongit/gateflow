/**
 * Workspace Protocol v3 constants and types.
 *
 * Single source of truth: docs/workspace-protocol.md. Every schema and rule
 * in that document is normative; any change here is a protocol upgrade and
 * must be mirrored in docs/workspace-protocol.md.
 *
 * SCHEMA 3 (V1 simplification, docs/plans/v1-simplification-plan.md §6):
 *  - ONE task directory per task: `.gateflow/tasks/<task-id>/` holds the
 *    driver-written inputs (task.md / plan.md / feedback.md) AND the
 *    agent-written outputs (plan.md or report.md + result.json). There is no
 *    inbox/outbox split and no agent-visible receipt; input integrity is
 *    enforced by the driver-private input snapshot hash instead.
 *  - The two roles (consumer/executor) become two MODES of one skill:
 *    `plan` and `execute`.
 *  - Agent output is a single minimal result.json; transient status.json and
 *    PROGRESS.md are gone (progress is GitHub's tracker comment, managed by
 *    the driver).
 *  - Driver-private state lives in `.gateflow/driver/state.json` (merged
 *    receipts); agents never need to read it.
 *
 * Principles (unchanged):
 * - Machine files are strict JSON; long content is Markdown and is never
 *   semantically parsed by the Driver.
 * - Human-only actions (approve / ready / cancel / human-close) never pass
 *   validation in any agent-written file.
 */

/** Machine file schema version (schema 3 since the V1 simplification). */
export const WORKSPACE_SCHEMA_VERSION = 3 as const;

/**
 * What the agent is asked to do with the task. `plan` produces plan.md;
 * `execute` consumes the approved plan.md and produces report.md.
 */
export type Mode = 'plan' | 'execute';

/**
 * Reason a task was prepared. Constraint: plan tasks use `planning` |
 * `feedback_applied`; execute tasks are always `approved_plan`.
 */
export type TaskReason = 'planning' | 'feedback_applied' | 'approved_plan';

/** Terminal results allowed in result.json (both modes). */
export type ResultStatus = 'completed' | 'blocked' | 'question' | 'failed';

/**
 * Human-only status values. These must NEVER pass validation in any machine
 * file written by an agent, in any casing variant.
 */
export const HUMAN_ONLY_STATUSES = ['approve', 'ready', 'cancel', 'human-close'] as const;

/**
 * Frozen task-id grammar, schema 3:
 * `gf_r<repo>_i<issue>_w<epoch_code>_<mode>_<rev>` where the epoch code is
 * the workflow epoch without its `wf_` prefix (12 base36 chars), the mode is
 * `plan` | `execute`, and the revision is a zero-padded plan round (`01`,
 * `02`, ...) or an execute plan-comment reference (`p<plan_comment_id>`).
 */
export const TASK_ID_PATTERN: RegExp = /^gf_r(\d+)_i(\d+)_w([0-9a-z]{12})_(plan|execute)_(\d+|p\d+)$/;

/**
 * A parsed task_id. `revision` is the raw revision component, e.g. `'01'` or
 * `'p3472198451'`.
 */
export interface ParsedTaskId {
  repositoryId: number;
  issueNumber: number;
  epochCode: string;
  mode: Mode;
  revision: string;
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
}

/**
 * Build a plan task_id for a planning round. `round` starts at 1 and is
 * zero-padded to two digits (`01`, `02`, ...); rounds >= 100 keep their plain
 * decimal form (`100`).
 */
export function makePlanTaskId(
  repositoryId: number,
  issueNumber: number,
  epoch: string,
  round: number,
): string {
  assertPositiveInt(repositoryId, 'repositoryId');
  assertPositiveInt(issueNumber, 'issueNumber');
  assertPositiveInt(round, 'round');
  if (!/^wf_[0-9a-z]{12}$/.test(epoch)) {
    throw new RangeError(`epoch must be a workflow epoch string, got ${JSON.stringify(epoch)}`);
  }
  const revision = String(round).padStart(2, '0');
  return `gf_r${repositoryId}_i${issueNumber}_w${epoch.slice(3)}_plan_${revision}`;
}

/**
 * Build an execute task_id bound to the approved Plan comment and the
 * workflow epoch.
 */
export function makeExecuteTaskId(
  repositoryId: number,
  issueNumber: number,
  epoch: string,
  planCommentId: number,
): string {
  assertPositiveInt(repositoryId, 'repositoryId');
  assertPositiveInt(issueNumber, 'issueNumber');
  assertPositiveInt(planCommentId, 'planCommentId');
  if (!/^wf_[0-9a-z]{12}$/.test(epoch)) {
    throw new RangeError(`epoch must be a workflow epoch string, got ${JSON.stringify(epoch)}`);
  }
  return `gf_r${repositoryId}_i${issueNumber}_w${epoch.slice(3)}_execute_p${planCommentId}`;
}

/**
 * Parse a task_id into its components. Returns null when the id does not
 * match the frozen grammar (callers must treat unknown ids as hostile).
 */
export function parseTaskId(id: string): ParsedTaskId | null {
  const match = TASK_ID_PATTERN.exec(id);
  if (match === null) return null;
  const repositoryId = match[1];
  const issueNumber = match[2];
  const epochCode = match[3];
  const mode = match[4];
  const revision = match[5];
  if (
    repositoryId === undefined ||
    issueNumber === undefined ||
    epochCode === undefined ||
    mode === undefined ||
    revision === undefined
  ) {
    return null;
  }
  if (mode !== 'plan' && mode !== 'execute') return null;
  return {
    repositoryId: Number(repositoryId),
    issueNumber: Number(issueNumber),
    epochCode,
    mode,
    revision,
  };
}

/** Input file names of a task (names relative to the task directory). */
export interface TaskInput {
  /** Always `'task.md'`. */
  task: string;
  /** `'plan.md'` for execute tasks, null for plan tasks. */
  plan: string | null;
  /** `'feedback.md'` when human feedback is projected, otherwise null. */
  feedback: string | null;
}

/**
 * tasks/<task_id>/task.json — machine task binding, written LAST by the
 * Driver (ready-marker convention). The agent reads it to learn the task
 * identity, mode and which input files exist.
 */
export interface TaskFile {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  task_id: string;
  /** `owner/name` of the target repository. */
  repository: string;
  repository_id: number;
  issue_number: number;
  /** The workflow epoch this task belongs to. */
  workflow_epoch: string;
  mode: Mode;
  reason: TaskReason;
  /** ISO 8601 UTC timestamp. */
  created_at: string;
  /** Approved Plan comment id; required for execute tasks, null for plan tasks. */
  plan_comment_id: number | null;
  /** Gate-issued approval record comment id; required for execute, null for plan. */
  approval_comment_id: number | null;
  input: TaskInput;
}

/**
 * tasks/<task_id>/result.json — the ONLY agent-written machine file
 * (schema 3). It states what the agent produced; it never claims GitHub
 * workflow state (approvals and transitions are Gate-owned).
 */
export interface ResultFile {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  /** Must equal the task_id of the directory the file sits in. */
  task_id: string;
  /** Must equal the task's mode. */
  mode: Mode;
  status: ResultStatus;
  /**
   * The produced content file: required and always `'plan.md'` when
   * mode=plan && status=completed; required and always `'report.md'` when
   * mode=execute && status=completed.
   */
  report?: string;
  /** Required and always `'passed'` when mode=execute && status=completed. */
  validation?: 'passed' | 'failed';
  /** Required non-empty when status is blocked | question | failed (<= 1000 chars). */
  reason?: string;
}

/** .gateflow/current.json — pointer to the active task (single-active-task rule). */
export interface CurrentPointer {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  task_id: string;
  mode: Mode;
  issue_number: number;
  updated_at: string;
}

/**
 * Driver-private task states (`.gateflow/driver/state.json`). This is an
 * internal synchronization cache — rebuildable from GitHub and the task
 * directories — never agent-facing, never official state.
 *
 *  - `prepared`   — task directory built, waiting for the agent to work;
 *  - `publishing` — a GitHub write is in flight (crash-recovery marker);
 *  - `published`  — the plan/report comment is confirmed on GitHub;
 *  - `accepted`   — the Gate consumed the output (approval record / ai:done);
 *  - `failed`     — recoverable failure; retry via `gateflow retry`;
 *  - `obsolete`   — the task lost its authorization (cancel / new epoch /
 *                   plan change / issue closed).
 */
export const TASK_STATES = [
  'prepared',
  'publishing',
  'published',
  'accepted',
  'failed',
  'obsolete',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** States at which later result.json overwrites are rejected (replay guard). */
export const TASK_TERMINAL_PUBLISHED: readonly TaskState[] = ['published', 'accepted'];

/**
 * One task's driver-private record inside state.json.
 */
export interface TaskRecord {
  task_id: string;
  status: TaskState;
  /** Task preparations so far (starts at 1). */
  attempts: number;
  mode: Mode;
  issue_number: number;
  workflow_epoch: string;
  /** sha256 over the input snapshot this task was prepared with. */
  input_snapshot_sha256?: string;
  plan_comment_id?: number;
  approval_comment_id?: number;
  tracker_comment_id?: number;
  /** Comment id of the published plan (plan mode) or report (execute mode). */
  published_comment_id?: number;
  /**
   * Key of the last non-terminal notice posted to GitHub (sha256 prefix of
   * the notice body). Notices are non-state-bearing and must NOT move the
   * record to `published`; the key just makes them post-once.
   */
  last_notice_key?: string;
  last_sync_at?: string;
  error?: string | null;
}

/** .gateflow/driver/state.json — driver-private cache (merged receipts). */
export interface DriverStateFile {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  updated_at: string;
  tasks: Record<string, TaskRecord>;
}
