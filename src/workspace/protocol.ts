/**
 * Workspace Protocol v2 constants and types (frozen contract).
 *
 * Single source of truth: docs/workspace-protocol.md. Every schema, rule and
 * whitelist in that document is normative; any change here is a protocol
 * upgrade and must be mirrored in docs/workspace-protocol.md and
 * protocol/workspace-schema-v2.json.
 *
 * SCHEMA 2 (hardening, docs/plans/v1_hardening_decisions.md):
 *  - dispatch ids bind the workflow epoch;
 *  - receipts distinguish published from accepted (the single `synced` is
 *    gone) and carry `obsolete` for invalidated dispatches;
 *  - dispatch/context bind workflow_epoch, approval record and plan hash;
 *  - Producer submissions carry a stable submission_id (Operation ID).
 *
 * Principles (unchanged):
 * - State and actions are JSON with strict schemas; long content is Markdown
 *   and is never semantically parsed by the Driver.
 * - Human-only actions (approve / ready / cancel / human-close) never appear
 *   in any agent-facing schema.
 */

/** Machine file schema version (schema 2 since the hardening). */
export const WORKSPACE_SCHEMA_VERSION = 2 as const;

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

/**
 * Receipt statuses (Driver-local cache; rebuildable at any time).
 *
 * The schema-1 single `synced` token is SPLIT (hardening §1, frozen):
 *  - `published` — the Driver confirmed the remote protocol object exists;
 *  - `accepted`  — the Gate consumed it and moved the canonical state
 *                  (observed via labels on a later cycle);
 *  - `obsolete`  — the dispatch lost its authorization (cancel / new epoch /
 *                  plan change / issue closed): outbox writes are refused.
 * `publishing` marks a write in flight; `failed` keeps recoverable context.
 */
export const RECEIPT_STATUSES = [
  'dispatched',
  'publishing',
  'published',
  'accepted',
  'failed',
  'obsolete',
] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** Statuses at which later result.json overwrites are rejected (replay guard). */
export const RECEIPT_PUBLISHED_OR_LATER: readonly ReceiptStatus[] = ['published', 'accepted'];

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
 * Frozen dispatch_id grammar, schema 2 (docs/workspace-protocol.md §3):
 * `gf_r<repo>_i<issue>_w<epoch_code>_<role>_<rev>` where the epoch code is
 * the workflow epoch without its `wf_` prefix (12 base36 chars) and revision
 * is a zero-padded consumer round (`01`, `02`, ...) or an executor plan
 * comment reference (`p<plan_comment_id>`).
 */
export const DISPATCH_DIR_PATTERN: RegExp = /^gf_r(\d+)_i(\d+)_w([0-9a-z]{12})_(consumer|executor)_(\d+|p\d+)$/;

/**
 * A parsed dispatch_id. `revision` is the raw revision component, e.g.
 * `'01'` or `'p3472198451'`.
 */
export interface ParsedDispatchId {
  repositoryId: number;
  issueNumber: number;
  epochCode: string;
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
export function makeConsumerDispatchId(
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
  return `gf_r${repositoryId}_i${issueNumber}_w${epoch.slice(3)}_consumer_${revision}`;
}

/**
 * Build an executor dispatch_id bound to the approved Plan comment and the
 * workflow epoch (docs/workspace-protocol.md §3, schema 2).
 */
export function makeExecutorDispatchId(
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
  return `gf_r${repositoryId}_i${issueNumber}_w${epoch.slice(3)}_executor_p${planCommentId}`;
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
  const epochCode = match[3];
  const role = match[4];
  const revision = match[5];
  if (
    repositoryId === undefined ||
    issueNumber === undefined ||
    epochCode === undefined ||
    role === undefined ||
    revision === undefined
  ) {
    return null;
  }
  if (role !== 'consumer' && role !== 'executor') return null;
  return {
    repositoryId: Number(repositoryId),
    issueNumber: Number(issueNumber),
    epochCode,
    role,
    revision,
  };
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
  /** The workflow epoch this dispatch belongs to (schema 2, frozen). */
  workflow_epoch: string;
  role: Role;
  reason: DispatchReason;
  /** ISO 8601 UTC timestamp. */
  created_at: string;
  /** Approved Plan comment id; required number for executors, null for consumers. */
  plan_comment_id: number | null;
  /** Approval RECORD comment id; required number for executors, null for consumers. */
  approval_comment_id: number | null;
  input: DispatchInput;
}

/**
 * inbox/<dispatch_id>/context.json — source anchors (docs §2.2).
 * `plan_comment_id` / `plan_sha256` are only present for executor dispatches.
 * `input_snapshot_sha256` binds the inbox content: a same-id dispatch with a
 * different snapshot is refused instead of silently overwriting a running
 * task (schema 2, hardening §9).
 */
export interface WorkspaceContext {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  dispatch_id: string;
  /** The workflow epoch this dispatch belongs to (schema 2). */
  workflow_epoch: string;
  /** Approved Plan comment id (executor only). */
  plan_comment_id?: number;
  /** Hex sha256 of the projected PLAN.md content (executor only). */
  plan_sha256?: string;
  /** Number of feedback entries projected into FEEDBACK.md (0 when absent). */
  feedback_count: number;
  /** sha256 over the JSON of {task, plan, feedback} inbox content (schema 2). */
  input_snapshot_sha256: string;
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
 * What the Driver knows about how a dispatch reached the agent (schema 2,
 * hardening §9). `notified` = a notification/notice reached the human or a
 * client process was started; it is NEVER proof the agent accepted the task
 * (no ack channel in V1 — `started` is only claimed by adapters that truly
 * spawned a client process, and even then not that the session loaded the
 * dispatch).
 */
export interface ActivationObservation {
  /** adapter name (manual | chatgpt | zcode | ...). */
  adapter: string;
  state: 'notified' | 'started' | 'failed';
  detail?: string;
  /** ISO 8601 UTC timestamp of the observation. */
  at: string;
}

/**
 * receipts/<dispatch_id>.json — Driver-local dispatch cache (docs §2.6).
 * Lives under `.gateflow/driver/receipts/` (Driver-private state, schema 2).
 * Not official state; rebuildable by scanning GitHub and the outbox.
 */
export interface Receipt {
  dispatch_id: string;
  status: ReceiptStatus;
  /** Dispatch attempts so far (starts at 1). */
  attempts: number;
  /** The workflow epoch this dispatch is bound to (schema 2). */
  workflow_epoch?: string;
  plan_comment_id?: number;
  /** The Gate-issued approval record comment id (executor only). */
  approval_comment_id?: number;
  tracker_comment_id?: number;
  /** Comment id of the published plan (consumer) or report (executor). */
  published_comment_id?: number;
  /** sha256 of the last synced PROGRESS.md content. */
  last_progress_sha256?: string;
  /** Latest human feedback command comment id already projected. */
  last_feedback_comment_id?: number;
  last_sync_at?: string;
  error?: string | null;
  /**
   * Key of the last non-terminal notice posted to GitHub (sha256 prefix of
   * the notice body). Status notices must NOT move the receipt to
   * `published` — that token is reserved for a confirmed remote protocol
   * object — so the notice itself is remembered to avoid re-posting every
   * cycle. Losing the receipt may re-post a notice (notices are
   * non-state-bearing; that is acceptable and documented).
   */
  last_notice_key?: string;
  /** How the dispatch reached the agent (schema 2; never an ack). */
  activation?: ActivationObservation;
  /** sha256 of the inbox content snapshot this dispatch was built with. */
  input_snapshot_sha256?: string;
}

/** submit/submit.json — Producer local task submission (docs §9). */
export interface SubmitRequest {
  schema: typeof WORKSPACE_SCHEMA_VERSION;
  /**
   * Stable Operation-ID anchor (`sub_` + 16 base36 chars), schema 2. Written
   * by the Producer; issue creation reconciles by it instead of re-POSTing
   * after an unknown API outcome.
   */
  submission_id: string;
  /** Non-empty, <= 256 chars. */
  title: string;
  kind: SubmitKind;
  maturity_hint: SubmitMaturityHint;
  /** ISO 8601 timestamp. */
  created_at: string;
}
