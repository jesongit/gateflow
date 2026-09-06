/**
 * Hand-written validators for Workspace Protocol v1 machine files.
 *
 * This module is the executable source of truth; the JSON Schema mirror in
 * protocol/workspace-schema-v1.json is kept in sync manually (no ajv, no new
 * dependencies). Every constraint from docs/workspace-protocol.md §2 is
 * enforced here:
 * - `schema === 1` on every machine file (except receipts, which carry no
 *   schema field);
 * - strict objects: unknown keys are rejected;
 * - role/reason/result/state enums and per-role whitelists;
 * - executor/consumer field constraints (plan_comment_id, approval_comment_id,
 *   input.plan);
 * - parseable ISO 8601 timestamps and string length caps;
 * - human-only values (`approve` / `ready` / `cancel` / `human-close`) in
 *   result/state positions are rejected with an explicit error naming the
 *   value, in any casing variant (docs §4).
 */
import {
  HUMAN_ONLY_RESULTS,
  RECEIPT_STATUSES,
  ROLE_RESULT_WHITELIST,
  ROLE_STATE_WHITELIST,
  SUBMIT_KINDS,
  SUBMIT_MATURITY_HINTS,
  WORKSPACE_SCHEMA_VERSION,
  parseDispatchId,
} from './protocol';
import type {
  CurrentPointer,
  Dispatch,
  Receipt,
  ResultFile,
  ResultValue,
  Role,
  RunState,
  StatusFile,
  SubmitRequest,
  WorkspaceContext,
} from './protocol';

/** Result of a validation attempt: typed value or a list of error messages. */
export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Maximum length of status `phase` / `summary` (docs §2.3). */
export const PHASE_SUMMARY_MAX = 500;
/** Maximum length of result `reason` (docs §2.4). */
export const REASON_MAX = 1000;
/** Maximum length of submit `title` (docs §9). */
export const TITLE_MAX = 256;
/** Maximum length of dispatch `repository` (`owner/name`). */
export const REPOSITORY_MAX = 256;

/** ISO 8601 timestamp with an explicit UTC designator or numeric offset. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Lowercase hex sha256 digest, as produced by inbox.sha256Hex. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

type Obj = Record<string, unknown>;

function isRecord(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(what: string, message: string): { ok: false; errors: string[] } {
  return { ok: false, errors: [`${what}: ${message}`] };
}

function checkUnknownKeys(raw: Obj, allowed: readonly string[], what: string, errors: string[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      errors.push(`${what}: unknown key "${key}"`);
    }
  }
}

function checkRequiredKeys(raw: Obj, required: readonly string[], what: string, errors: string[]): void {
  for (const key of required) {
    if (!(key in raw)) {
      errors.push(`${what}: missing required key "${key}"`);
    }
  }
}

/** `schema` must be present and exactly 1 (docs §2 preamble). */
function checkSchema(value: unknown, what: string, errors: string[]): void {
  if (value === undefined) return; // absence is reported by checkRequiredKeys
  if (value !== WORKSPACE_SCHEMA_VERSION) {
    errors.push(`${what}: schema must be ${WORKSPACE_SCHEMA_VERSION}, got ${JSON.stringify(value)}`);
  }
}

function checkString(
  value: unknown,
  what: string,
  errors: string[],
  opts: { min?: number; max?: number } = {},
): void {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    errors.push(`${what}: must be a string, got ${typeof value}`);
    return;
  }
  if (opts.min !== undefined && value.length < opts.min) {
    errors.push(`${what}: must be at least ${opts.min} character(s)`);
  }
  if (opts.max !== undefined && value.length > opts.max) {
    errors.push(`${what}: exceeds maximum length of ${opts.max}`);
  }
}

function checkPositiveInt(value: unknown, what: string, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    errors.push(`${what}: must be a positive integer, got ${JSON.stringify(value)}`);
  }
}

function checkNonNegativeInt(value: unknown, what: string, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    errors.push(`${what}: must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

/** Value must be exactly `null` (consumer-only fields, docs §2.1). */
function checkNull(value: unknown, what: string, errors: string[]): void {
  if (value === undefined) return;
  if (value !== null) {
    errors.push(`${what}: must be null, got ${JSON.stringify(value)}`);
  }
}

/** Parseable ISO 8601 timestamp with explicit zone (docs §2.1). */
function checkIsoDate(value: unknown, what: string, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    errors.push(`${what}: must be an ISO 8601 date string, got ${JSON.stringify(value)}`);
  }
}

/**
 * Reject human-only action values in any casing variant, with an explicit
 * error naming the offending value (docs §4, frozen).
 */
function checkHumanOnly(value: string, what: string, errors: string[]): void {
  const normalized = value.toLowerCase();
  for (const word of HUMAN_ONLY_RESULTS) {
    if (normalized === word) {
      errors.push(
        `${what}: human-only value "${value}" is reserved for humans and must never appear in agent files`,
      );
      return;
    }
  }
}

/** Validate a dispatch_id string; returns the value when well-formed. */
function checkDispatchId(value: unknown, what: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || parseDispatchId(value) === null) {
    errors.push(`${what}: must match the frozen dispatch_id format, got ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

function checkRole(value: unknown, what: string, errors: string[]): Role | undefined {
  if (value === undefined) return undefined;
  if (value !== 'consumer' && value !== 'executor') {
    errors.push(`${what}: must be "consumer" or "executor", got ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

const DISPATCH_KEYS = [
  'schema',
  'dispatch_id',
  'repository',
  'repository_id',
  'issue_number',
  'role',
  'reason',
  'created_at',
  'plan_comment_id',
  'approval_comment_id',
  'input',
] as const;

/**
 * Validate inbox/<id>/dispatch.json (docs §2.1): role/reason coupling,
 * executor-only plan/approval comment ids, and the fixed input file names.
 */
export function validateDispatch(raw: unknown): Validation<Dispatch> {
  const what = 'dispatch';
  if (!isRecord(raw)) return fail(what, 'expected a JSON object');
  const errors: string[] = [];
  checkUnknownKeys(raw, DISPATCH_KEYS, what, errors);
  checkRequiredKeys(raw, DISPATCH_KEYS, what, errors);
  checkSchema(raw['schema'], what, errors);

  const role = checkRole(raw['role'], `${what}.role`, errors);

  const dispatchId = checkDispatchId(raw['dispatch_id'], `${what}.dispatch_id`, errors);
  if (dispatchId !== undefined && role !== undefined) {
    const parsed = parseDispatchId(dispatchId);
    if (parsed !== null && parsed.role !== role) {
      errors.push(`${what}.dispatch_id: role component "${parsed.role}" does not match role "${role}"`);
    }
  }

  checkString(raw['repository'], `${what}.repository`, errors, { min: 1, max: REPOSITORY_MAX });
  checkPositiveInt(raw['repository_id'], `${what}.repository_id`, errors);
  checkPositiveInt(raw['issue_number'], `${what}.issue_number`, errors);
  checkIsoDate(raw['created_at'], `${what}.created_at`, errors);

  if (role === 'consumer') {
    if (raw['reason'] !== undefined && raw['reason'] !== 'planning' && raw['reason'] !== 'feedback_applied') {
      errors.push(
        `${what}.reason: consumer reason must be "planning" or "feedback_applied", got ${JSON.stringify(raw['reason'])}`,
      );
    }
    checkNull(raw['plan_comment_id'], `${what}.plan_comment_id`, errors);
    checkNull(raw['approval_comment_id'], `${what}.approval_comment_id`, errors);
  } else if (role === 'executor') {
    if (raw['reason'] !== undefined && raw['reason'] !== 'approved_plan') {
      errors.push(`${what}.reason: executor reason must be "approved_plan", got ${JSON.stringify(raw['reason'])}`);
    }
    checkPositiveInt(raw['plan_comment_id'], `${what}.plan_comment_id`, errors);
    checkPositiveInt(raw['approval_comment_id'], `${what}.approval_comment_id`, errors);
  }

  const input = raw['input'];
  if (input !== undefined) {
    if (!isRecord(input)) {
      errors.push(`${what}.input: expected a JSON object`);
    } else {
      const inputWhat = `${what}.input`;
      checkUnknownKeys(input, ['task', 'plan', 'feedback'], inputWhat, errors);
      checkRequiredKeys(input, ['task', 'plan', 'feedback'], inputWhat, errors);
      if (input['task'] !== undefined && input['task'] !== 'TASK.md') {
        errors.push(`${inputWhat}.task: must be "TASK.md", got ${JSON.stringify(input['task'])}`);
      }
      if (role === 'executor') {
        if (input['plan'] !== undefined && input['plan'] !== 'PLAN.md') {
          errors.push(`${inputWhat}.plan: executor input.plan must be "PLAN.md", got ${JSON.stringify(input['plan'])}`);
        }
      } else if (role === 'consumer') {
        if (input['plan'] !== undefined && input['plan'] !== null) {
          errors.push(`${inputWhat}.plan: consumer input.plan must be null, got ${JSON.stringify(input['plan'])}`);
        }
      }
      if (input['feedback'] !== undefined && input['feedback'] !== null && input['feedback'] !== 'FEEDBACK.md') {
        errors.push(`${inputWhat}.feedback: must be "FEEDBACK.md" or null, got ${JSON.stringify(input['feedback'])}`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as Dispatch };
}

const CONTEXT_KEYS = ['schema', 'dispatch_id', 'plan_comment_id', 'plan_sha256', 'feedback_count'] as const;
const CONTEXT_REQUIRED = ['schema', 'dispatch_id', 'feedback_count'] as const;

/**
 * Validate inbox/<id>/context.json (docs §2.2). The file carries no role
 * field, so the role is derived from the dispatch_id: executors must carry
 * plan_comment_id and plan_sha256, consumers must not.
 */
export function validateContext(raw: unknown): Validation<WorkspaceContext> {
  const what = 'context';
  if (!isRecord(raw)) return fail(what, 'expected a JSON object');
  const errors: string[] = [];
  checkUnknownKeys(raw, CONTEXT_KEYS, what, errors);
  checkRequiredKeys(raw, CONTEXT_REQUIRED, what, errors);
  checkSchema(raw['schema'], what, errors);

  const dispatchId = checkDispatchId(raw['dispatch_id'], `${what}.dispatch_id`, errors);
  const parsed = dispatchId !== undefined ? parseDispatchId(dispatchId) : null;
  const role = parsed?.role;

  if (role === 'executor') {
    if (raw['plan_comment_id'] === undefined) {
      errors.push(`${what}.plan_comment_id: required for executor dispatches`);
    }
    checkPositiveInt(raw['plan_comment_id'], `${what}.plan_comment_id`, errors);
    if (raw['plan_sha256'] === undefined) {
      errors.push(`${what}.plan_sha256: required for executor dispatches`);
    }
    if (typeof raw['plan_sha256'] !== 'undefined' && (typeof raw['plan_sha256'] !== 'string' || !SHA256_PATTERN.test(raw['plan_sha256']))) {
      errors.push(`${what}.plan_sha256: must be a 64-character hex sha256, got ${JSON.stringify(raw['plan_sha256'])}`);
    }
  } else if (role === 'consumer') {
    if (raw['plan_comment_id'] !== undefined && raw['plan_comment_id'] !== null) {
      errors.push(`${what}.plan_comment_id: must be absent or null for consumer dispatches`);
    }
    if (raw['plan_sha256'] !== undefined && raw['plan_sha256'] !== null) {
      errors.push(`${what}.plan_sha256: must be absent or null for consumer dispatches`);
    }
  }

  checkNonNegativeInt(raw['feedback_count'], `${what}.feedback_count`, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as WorkspaceContext };
}

const STATUS_KEYS = ['schema', 'dispatch_id', 'role', 'state', 'phase', 'summary', 'updated_at'] as const;
const STATUS_REQUIRED = ['schema', 'dispatch_id', 'role', 'state', 'updated_at'] as const;

/**
 * Validate outbox/<id>/status.json (docs §2.3): state must be in the role's
 * whitelist, human-only values are rejected, phase/summary are capped at 500
 * characters.
 */
export function validateStatus(raw: unknown): Validation<StatusFile> {
  const what = 'status';
  if (!isRecord(raw)) return fail(what, 'expected a JSON object');
  const errors: string[] = [];
  checkUnknownKeys(raw, STATUS_KEYS, what, errors);
  checkRequiredKeys(raw, STATUS_REQUIRED, what, errors);
  checkSchema(raw['schema'], what, errors);

  const role = checkRole(raw['role'], `${what}.role`, errors);
  checkDispatchId(raw['dispatch_id'], `${what}.dispatch_id`, errors);

  const state = raw['state'];
  if (state !== undefined) {
    if (typeof state !== 'string') {
      errors.push(`${what}.state: must be a string, got ${typeof state}`);
    } else {
      checkHumanOnly(state, `${what}.state`, errors);
      if (role !== undefined && !ROLE_STATE_WHITELIST[role].includes(state as RunState)) {
        errors.push(`${what}.state: "${state}" is not allowed for role "${role}"`);
      }
    }
  }

  checkString(raw['phase'], `${what}.phase`, errors, { max: PHASE_SUMMARY_MAX });
  checkString(raw['summary'], `${what}.summary`, errors, { max: PHASE_SUMMARY_MAX });
  checkIsoDate(raw['updated_at'], `${what}.updated_at`, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as StatusFile };
}

const RESULT_KEYS = [
  'schema',
  'dispatch_id',
  'role',
  'result',
  'plan_file',
  'report_file',
  'validation',
  'reason',
] as const;
const RESULT_REQUIRED = ['schema', 'dispatch_id', 'role', 'result'] as const;

/** All terminal result values across roles, for shape-level validation. */
const ALL_RESULT_VALUES: readonly ResultValue[] = [
  ...new Set<ResultValue>([...ROLE_RESULT_WHITELIST.consumer, ...ROLE_RESULT_WHITELIST.executor]),
];

/**
 * Validate the shape of outbox/<id>/result.json (docs §2.4). Cross-field
 * "iff" constraints (plan_file / report_file / validation / reason presence)
 * are enforced by validation.validateOutboxResult, which layers on top of
 * this validator together with the dispatch_id/role match and role whitelist.
 */
export function validateResult(raw: unknown): Validation<ResultFile> {
  const what = 'result';
  if (!isRecord(raw)) return fail(what, 'expected a JSON object');
  const errors: string[] = [];
  checkUnknownKeys(raw, RESULT_KEYS, what, errors);
  checkRequiredKeys(raw, RESULT_REQUIRED, what, errors);
  checkSchema(raw['schema'], what, errors);

  const role = checkRole(raw['role'], `${what}.role`, errors);
  checkDispatchId(raw['dispatch_id'], `${what}.dispatch_id`, errors);

  const result = raw['result'];
  if (result !== undefined) {
    if (typeof result !== 'string') {
      errors.push(`${what}.result: must be a string, got ${typeof result}`);
    } else {
      checkHumanOnly(result, `${what}.result`, errors);
      if (!ALL_RESULT_VALUES.includes(result as ResultValue)) {
        errors.push(`${what}.result: "${result}" is not a valid result value`);
      }
    }
  }

  if (raw['plan_file'] !== undefined && raw['plan_file'] !== 'PLAN.md') {
    errors.push(`${what}.plan_file: must be "PLAN.md", got ${JSON.stringify(raw['plan_file'])}`);
  }
  if (raw['report_file'] !== undefined && raw['report_file'] !== 'REPORT.md') {
    errors.push(`${what}.report_file: must be "REPORT.md", got ${JSON.stringify(raw['report_file'])}`);
  }
  if (raw['validation'] !== undefined && raw['validation'] !== 'passed' && raw['validation'] !== 'failed') {
    errors.push(`${what}.validation: must be "passed" or "failed", got ${JSON.stringify(raw['validation'])}`);
  }
  checkString(raw['reason'], `${what}.reason`, errors, { min: 1, max: REASON_MAX });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as ResultFile };
}

const CURRENT_KEYS = ['schema', 'dispatch_id', 'role', 'issue_number', 'updated_at'] as const;

/** Validate .gateflow/current.json (docs §2.5). */
export function validateCurrent(raw: unknown): Validation<CurrentPointer> {
  const what = 'current';
  if (!isRecord(raw)) return fail(what, 'expected a JSON object');
  const errors: string[] = [];
  checkUnknownKeys(raw, CURRENT_KEYS, what, errors);
  checkRequiredKeys(raw, CURRENT_KEYS, what, errors);
  checkSchema(raw['schema'], what, errors);
  checkDispatchId(raw['dispatch_id'], `${what}.dispatch_id`, errors);
  checkRole(raw['role'], `${what}.role`, errors);
  checkPositiveInt(raw['issue_number'], `${what}.issue_number`, errors);
  checkIsoDate(raw['updated_at'], `${what}.updated_at`, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as CurrentPointer };
}

const RECEIPT_KEYS = [
  'dispatch_id',
  'status',
  'attempts',
  'tracker_comment_id',
  'last_progress_sha256',
  'last_feedback_comment_id',
  'last_sync_at',
  'error',
  'last_notice_state',
] as const;
const RECEIPT_REQUIRED = ['dispatch_id', 'status', 'attempts'] as const;

/**
 * Validate receipts/<id>.json (docs §2.6). Receipts are a Driver-local cache
 * and carry no `schema` field; a stray one is rejected as an unknown key.
 */
export function validateReceipt(raw: unknown): Validation<Receipt> {
  const what = 'receipt';
  if (!isRecord(raw)) return fail(what, 'expected a JSON object');
  const errors: string[] = [];
  checkUnknownKeys(raw, RECEIPT_KEYS, what, errors);
  checkRequiredKeys(raw, RECEIPT_REQUIRED, what, errors);
  checkDispatchId(raw['dispatch_id'], `${what}.dispatch_id`, errors);

  const status = raw['status'];
  if (status !== undefined && !RECEIPT_STATUSES.includes(status as (typeof RECEIPT_STATUSES)[number])) {
    errors.push(`${what}.status: must be one of ${RECEIPT_STATUSES.join('|')}, got ${JSON.stringify(status)}`);
  }
  checkPositiveInt(raw['attempts'], `${what}.attempts`, errors);
  checkPositiveInt(raw['tracker_comment_id'], `${what}.tracker_comment_id`, errors);
  checkPositiveInt(raw['last_feedback_comment_id'], `${what}.last_feedback_comment_id`, errors);
  checkString(raw['last_progress_sha256'], `${what}.last_progress_sha256`, errors, { min: 1 });
  checkIsoDate(raw['last_sync_at'], `${what}.last_sync_at`, errors);

  const error = raw['error'];
  if (error !== undefined && error !== null) {
    checkString(error, `${what}.error`, errors, { min: 1, max: 2000 });
  }
  checkString(raw['last_notice_state'], `${what}.last_notice_state`, errors, { min: 1, max: 64 });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as Receipt };
}

const SUBMIT_KEYS = ['schema', 'title', 'kind', 'maturity_hint', 'created_at'] as const;

/** Validate submit/submit.json (docs §9). */
export function validateSubmit(raw: unknown): Validation<SubmitRequest> {
  const what = 'submit';
  if (!isRecord(raw)) return fail(what, 'expected a JSON object');
  const errors: string[] = [];
  checkUnknownKeys(raw, SUBMIT_KEYS, what, errors);
  checkRequiredKeys(raw, SUBMIT_KEYS, what, errors);
  checkSchema(raw['schema'], what, errors);
  checkString(raw['title'], `${what}.title`, errors, { min: 1, max: TITLE_MAX });

  const kind = raw['kind'];
  if (kind !== undefined && !SUBMIT_KINDS.includes(kind as (typeof SUBMIT_KINDS)[number])) {
    errors.push(`${what}.kind: must be one of ${SUBMIT_KINDS.join('|')}, got ${JSON.stringify(kind)}`);
  }
  const maturity = raw['maturity_hint'];
  if (maturity !== undefined && !SUBMIT_MATURITY_HINTS.includes(maturity as (typeof SUBMIT_MATURITY_HINTS)[number])) {
    errors.push(`${what}.maturity_hint: must be one of ${SUBMIT_MATURITY_HINTS.join('|')}, got ${JSON.stringify(maturity)}`);
  }
  checkIsoDate(raw['created_at'], `${what}.created_at`, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as SubmitRequest };
}
