/**
 * Workspace Protocol v1 constants and types (frozen contract).
 *
 * Single source of truth: docs/workspace-protocol.md. Every schema, rule and
 * whitelist in that document is normative; any change here is a protocol
 * upgrade and must be mirrored in docs/workspace-protocol.md and
 * protocol/workspace-schema-v1.json.
 *
 * Principles:
 * - State and actions are JSON with strict schemas; long content is Markdown
 *   and is never semantically parsed by the Driver.
 * - Human-only actions (approve / ready / cancel / human-close) never appear
 *   in any agent-facing schema.
 */

/** Machine file schema version, frozen for V1. */
export const WORKSPACE_SCHEMA_VERSION = 1 as const;

/** Role of the agent a dispatch is addressed to. */
export type Role = 'consumer' | 'executor';

/**
 * Reason for a dispatch. Constraint (frozen): consumer dispatches use
 * `planning` | `feedback_applied`; executor dispatches are always
 * `approved_plan`.
 */
export type DispatchReason = 'planning' | 'feedback_applied' | 'approved_plan';

/**
 * Transient run state (status.json). A `failed` state here means the agent
 * gave up mid-run; terminal outcomes are expressed by result.json.
 */
export type RunState = 'working' | 'blocked' | 'failed';

/** Terminal results allowed for a consumer dispatch. */
export type ConsumerResult = 'plan_ready' | 'question' | 'failed';

/** Terminal results allowed for an executor dispatch. */
export type ExecutorResult = 'completed' | 'blocked' | 'question' | 'failed';

/** Any terminal result value across roles. */
export type ResultValue = ConsumerResult | ExecutorResult;

/** Receipt sync status values (Driver-local cache; rebuildable at any time). */
export const RECEIPT_STATUSES = ['dispatched', 'syncing', 'synced', 'failed'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** Producer submit `kind` enum (docs/workspace-protocol.md §9). */
export const SUBMIT_KINDS = ['feature', 'bug', 'refactor', 'docs', 'chore'] as const;
export type SubmitKind = (typeof SUBMIT_KINDS)[number];

/** Producer submit `maturity_hint` enum (docs/workspace-protocol.md §9). */
export const SUBMIT_MATURITY_HINTS = ['requirement', 'direction', 'solution', 'execution_plan'] as const;
export type SubmitMaturityHint = (typeof SUBMIT_MATURITY_HINTS)[number];

/**
 * Human-only actions. These values must NEVER pass validation in any machine
 * file written by an agent, in any casing variant (docs §4).
 */
export const HUMAN_ONLY_RESULTS = ['approve', 'ready', 'cancel', 'human-close'] as const;
export type HumanOnlyResult = (typeof HUMAN_ONLY_RESULTS)[number];

/** Terminal results whitelisted per role (docs/workspace-protocol.md §4). */
export const ROLE_RESULT_WHITELIST: Record<Role, readonly ResultValue[]> = {
  consumer: ['plan_ready', 'question', 'failed'],
  executor: ['completed', 'blocked', 'question', 'failed'],
};

/** Run states whitelisted per role (docs/workspace-protocol.md §4). */
export const ROLE_STATE_WHITELIST: Record<Role, readonly RunState[]> = {
  consumer: ['working', 'blocked', 'failed'],
  executor: ['working', 'blocked', 'failed'],
};

/**
 * Frozen dispatch_id grammar (docs/workspace-protocol.md §3):
 * `gf_r<repository_id>_i<issue_number>_<role>_<revision>` where revision is
 * either a zero-padded consumer round (`01`, `02`, ... `100`) or an executor
 * plan comment reference (`p<plan_comment_id>`).
 */
export const DISPATCH_DIR_PATTERN: RegExp = /^gf_r(\d+)_i(\d+)_(consumer|executor)_(\d+|p\d+)$/;

/**
 * A parsed dispatch_id. `revision` is the raw revision component, e.g.
 * `'01'` or `'p3472198451'`.
 */
export interface ParsedDispatchId {
  repositoryId: number;
  issueNumber: number;
  role: Role;
  revision: string;
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
}

/**
 * Build a consumer dispatch_id for a planning round. `round` starts at 1 and
 * is zero-padded to two digits (`01`, `02`, ...); rounds >= 100 keep their
 * plain decimal form (`100`).
 */
export function makeConsumerDispatchId(repositoryId: number, issueNumber: number, round: number): string {
  assertPositiveInt(repositoryId, 'repositoryId');
  assertPositiveInt(issueNumber, 'issueNumber');
  assertPositiveInt(round, 'round');
  const revision = String(round).padStart(2, '0');
  return `gf_r${repositoryId}_i${issueNumber}_consumer_${revision}`;
}

/**
 * Build an executor dispatch_id bound to the approved Plan comment.
 * The revision is `p<plan_comment_id>` (docs/workspace-protocol.md §3).
 */
export function makeExecutorDispatchId(repositoryId: number, issueNumber: number, planCommentId: number): string {
  assertPositiveInt(repositoryId, 'repositoryId');
  assertPositiveInt(issueNumber, 'issueNumber');
  assertPositiveInt(planCommentId, 'planCommentId');
  return `gf_r${repositoryId}_i${issueNumber}_executor_p${planCommentId}`;
}

/**
 * Parse a dispatch_id into its components. Returns null when the id does not
 * match the frozen grammar (callers must treat unknown ids as hostile).
 */
export function parseDispatchId(id: string): ParsedDispatchId | null {
  const match = DISPATCH_DIR_PATTERN.exec(id);
  if (match === null) return null;
  const repositoryId = match[1];
  const issueNumber = match[2];
  const role = match[3];
  const revision = match[4];
  if (repositoryId === undefined || issueNumber === undefined || role === undefined || revision === undefined) {
    return null;
  }
  if (role !== 'consumer' && role !== 'executor') return null;
  return { repositoryId: Number(repositoryId), issueNumber: Number(issueNumber), role, revision };
}

/** Input file projection of a dispatch (names relative to the inbox dir). */
export interface DispatchInput {
  /** Always `'TASK.md'`. */
  task: string;
  /** `'PLAN.md'` for executors, null for consumers. */
  plan: string | null;
  /** `'FEEDBACK.md'` when human feedback is projected, otherwise null. */
  feedback: string | null;
}

/** inbox/<dispatch_id>/dispatch.json — machine task description (docs §2.1). */
export interface Dispatch {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  dispatch_id: string;
  /** `owner/name` of the target repository. */
  repository: string;
  repository_id: number;
  issue_number: number;
  role: Role;
  reason: DispatchReason;
  /** ISO 8601 UTC timestamp. */
  created_at: string;
  /** Approved Plan comment id; required number for executors, null for consumers. */
  plan_comment_id: number | null;
  /** Approval Record comment id; required number for executors, null for consumers. */
  approval_comment_id: number | null;
  input: DispatchInput;
}

/**
 * inbox/<dispatch_id>/context.json — source anchors (docs §2.2).
 * `plan_comment_id` / `plan_sha256` are only present for executor dispatches.
 */
export interface WorkspaceContext {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  dispatch_id: string;
  /** Approved Plan comment id (executor only). */
  plan_comment_id?: number;
  /** Hex sha256 of the projected PLAN.md content (executor only). */
  plan_sha256?: string;
  /** Number of feedback entries projected into FEEDBACK.md (0 when absent). */
  feedback_count: number;
}

/** outbox/<dispatch_id>/status.json — transient run state (docs §2.3). */
export interface StatusFile {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  dispatch_id: string;
  role: Role;
  state: RunState;
  /** Optional human-readable phase (<= 500 chars); never drives state. */
  phase?: string;
  /** Optional human-readable summary (<= 500 chars); never drives state. */
  summary?: string;
  /** ISO 8601 timestamp of the last write. */
  updated_at: string;
}

/** outbox/<dispatch_id>/result.json — terminal result (docs §2.4). */
export interface ResultFile {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  dispatch_id: string;
  role: Role;
  result: ResultValue;
  /** Required and always `'PLAN.md'` iff consumer && result=plan_ready. */
  plan_file?: string;
  /** Required and always `'REPORT.md'` iff executor && result=completed. */
  report_file?: string;
  /** Required iff executor && result=completed. */
  validation?: 'passed' | 'failed';
  /** Required non-empty iff result is blocked | question | failed (<= 1000 chars). */
  reason?: string;
}

/** .gateflow/current.json — pointer to the most recent dispatch (docs §2.5). */
export interface CurrentPointer {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  dispatch_id: string;
  role: Role;
  issue_number: number;
  updated_at: string;
}

/**
 * receipts/<dispatch_id>.json — Driver-local dispatch cache (docs §2.6).
 * Not official state; rebuildable by scanning GitHub and the outbox.
 */
export interface Receipt {
  dispatch_id: string;
  status: ReceiptStatus;
  /** Dispatch attempts so far (starts at 1). */
  attempts: number;
  tracker_comment_id?: number;
  /** sha256 of the last synced PROGRESS.md content. */
  last_progress_sha256?: string;
  /** Latest human feedback command comment id already projected. */
  last_feedback_comment_id?: number;
  last_sync_at?: string;
  error?: string | null;
}

/** submit/submit.json — Producer local task submission (docs §9). */
export interface SubmitRequest {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  /** Non-empty, <= 256 chars. */
  title: string;
  kind: SubmitKind;
  maturity_hint: SubmitMaturityHint;
  /** ISO 8601 timestamp. */
  created_at: string;
}
