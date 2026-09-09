/**
 * Hand-written validators for Workspace Protocol v3 machine files.
 *
 * This module is the executable source of truth for machine-file shapes.
 * Every constraint from docs/workspace-protocol.md is enforced here:
 * - `schema === 3` on every machine file;
 * - strict objects: unknown keys are rejected;
 * - mode/reason enums and the result cross-field constraints;
 * - the workflow epoch binding on task files;
 * - task_id/mode agreement between a result.json and the task it sits in;
 * - parseable ISO 8601 timestamps and string length caps;
 * - human-only status values (`approve` / `ready` / `cancel` /
 *   `human-close`) are rejected with an explicit error naming the value, in
 *   any casing variant.
 */
import {
  HUMAN_ONLY_STATUSES,
  TASK_STATES,
  WORKSPACE_SCHEMA_VERSION,
  parseTaskId,
} from './protocol';
import type {
  CurrentPointer,
  DriverStateFile,
  Mode,
  ResultFile,
  ResultStatus,
  TaskFile,
  TaskRecord,
} from './protocol';

/** Result of a validation attempt: typed value or a list of error messages. */
export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Maximum length of a result `reason`. */
export const REASON_MAX = 1000;
/** Maximum length of task `repository` (`owner/name`). */
export const REPOSITORY_MAX = 256;
/** Hard per-file size cap: 512 KB (anti-oversized defense). */
export const MAX_FILE_BYTES = 512 * 1024;

/** Raised when a content file exceeds MAX_FILE_BYTES. */
export class OversizedFileError extends Error {
  /** Path of the offending file. */
  readonly file: string;
  /** Actual size in bytes. */
  readonly size: number;
  /** Allowed maximum in bytes. */
  readonly maxBytes: number;

  constructor(file: string, size: number, maxBytes: number) {
    super(`file exceeds ${maxBytes} bytes: ${file} (${size} bytes)`);
    this.name = 'OversizedFileError';
    this.file = file;
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

/** True when `name` is a valid task directory name (frozen grammar). */
export function validateTaskDirName(name: string): boolean {
  return parseTaskId(name) !== null;
}

/** ISO 8601 timestamp with an explicit UTC designator or numeric offset. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Lowercase hex sha256 digest. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

/** `wf_` + 12 base36 chars — the frozen workflow epoch shape. */
const EPOCH_SHAPE = /^wf_[0-9a-z]{12}$/;

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

/** `schema` must be present and exactly the current workspace schema. */
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

function checkNull(value: unknown, what: string, errors: string[]): void {
  if (value === undefined) return;
  if (value !== null) {
    errors.push(`${what}: must be null, got ${JSON.stringify(value)}`);
  }
}

function checkIsoDate(value: unknown, what: string, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    errors.push(`${what}: must be an ISO 8601 date string, got ${JSON.stringify(value)}`);
  }
}

/**
 * Reject human-only status values in any casing variant, with an explicit
 * error naming the offending value.
 */
function checkHumanOnly(value: string, what: string, errors: string[]): void {
  const normalized = value.toLowerCase();
  for (const word of HUMAN_ONLY_STATUSES) {
    if (normalized === word) {
      errors.push(
        `${what}: human-only value "${value}" is reserved for humans and must never appear in agent files`,
      );
      return;
    }
  }
}

/** Validate a task_id string; returns the value when well-formed. */
function checkTaskId(value: unknown, what: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || parseTaskId(value) === null) {
    errors.push(`${what}: must match the frozen task_id format, got ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

function checkMode(value: unknown, what: string, errors: string[]): Mode | undefined {
  if (value === undefined) return undefined;
  if (value !== 'plan' && value !== 'execute') {
    errors.push(`${what}: must be "plan" or "execute", got ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

const TASK_FILE_KEYS = [
  'schema',
  'task_id',
  'repository',
  'repository_id',
  'issue_number',
  'workflow_epoch',
  'mode',
  'reason',
  'created_at',
  'plan_comment_id',
  'approval_comment_id',
  'input',
] as const;

/**
 * Validate tasks/<id>/task.json: mode/reason coupling, execute-only
 * plan/approval comment ids, the workflow epoch binding, and the fixed input
 * file names.
 */
export function validateTaskFile(raw: unknown): Validation<TaskFile> {
  const what = 'task';
  if (!isRecord(raw)) return fail(what, 'expected a JSON object');
  const errors: string[] = [];
  checkUnknownKeys(raw, TASK_FILE_KEYS, what, errors);
  checkRequiredKeys(raw, TASK_FILE_KEYS, what, errors);
  checkSchema(raw['schema'], what, errors);

  const mode = checkMode(raw['mode'], `${what}.mode`, errors);

  const taskId = checkTaskId(raw['task_id'], `${what}.task_id`, errors);
  if (taskId !== undefined && mode !== undefined) {
    const parsed = parseTaskId(taskId);
    if (parsed !== null && parsed.mode !== mode) {
      errors.push(`${what}.task_id: mode component "${parsed.mode}" does not match mode "${mode}"`);
    }
    // The task_id epoch code must agree with the explicit epoch field.
    if (parsed !== null && typeof raw['workflow_epoch'] === 'string') {
      const expected = `wf_${parsed.epochCode}`;
      if (raw['workflow_epoch'] !== expected) {
        errors.push(
          `${what}.workflow_epoch "${String(raw['workflow_epoch'])}" does not match the ` +
            `task_id epoch code (expected "${expected}")`,
        );
      }
    }
  }

  checkString(raw['repository'], `${what}.repository`, errors, { min: 1, max: REPOSITORY_MAX });
  checkPositiveInt(raw['repository_id'], `${what}.repository_id`, errors);
  checkPositiveInt(raw['issue_number'], `${what}.issue_number`, errors);
  if (raw['workflow_epoch'] !== undefined) {
    if (typeof raw['workflow_epoch'] !== 'string' || !EPOCH_SHAPE.test(raw['workflow_epoch'])) {
      errors.push(
        `${what}.workflow_epoch: must be a workflow epoch ("wf_" + 12 base36 chars), got ${JSON.stringify(raw['workflow_epoch'])}`,
      );
    }
  }
  checkIsoDate(raw['created_at'], `${what}.created_at`, errors);

  if (mode === 'plan') {
    if (raw['reason'] !== undefined && raw['reason'] !== 'planning' && raw['reason'] !== 'feedback_applied') {
      errors.push(
        `${what}.reason: plan-mode reason must be "planning" or "feedback_applied", got ${JSON.stringify(raw['reason'])}`,
      );
    }
    checkNull(raw['plan_comment_id'], `${what}.plan_comment_id`, errors);
    checkNull(raw['approval_comment_id'], `${what}.approval_comment_id`, errors);
  } else if (mode === 'execute') {
    if (raw['reason'] !== undefined && raw['reason'] !== 'approved_plan') {
      errors.push(`${what}.reason: execute-mode reason must be "approved_plan", got ${JSON.stringify(raw['reason'])}`);
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
      if (input['task'] !== undefined && input['task'] !== 'task.md') {
        errors.push(`${inputWhat}.task: must be "task.md", got ${JSON.stringify(input['task'])}`);
      }
      if (mode === 'execute') {
        if (input['plan'] !== undefined && input['plan'] !== 'plan.md') {
          errors.push(`${inputWhat}.plan: execute input.plan must be "plan.md", got ${JSON.stringify(input['plan'])}`);
        }
      } else if (mode === 'plan') {
        if (input['plan'] !== undefined && input['plan'] !== null) {
          errors.push(`${inputWhat}.plan: plan-mode input.plan must be null, got ${JSON.stringify(input['plan'])}`);
        }
      }
      if (input['feedback'] !== undefined && input['feedback'] !== null && input['feedback'] !== 'feedback.md') {
        errors.push(`${inputWhat}.feedback: must be "feedback.md" or null, got ${JSON.stringify(input['feedback'])}`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as TaskFile };
}

const RESULT_KEYS = ['schema', 'task_id', 'mode', 'status', 'report', 'validation', 'reason'] as const;
const RESULT_REQUIRED = ['schema', 'task_id', 'mode', 'status'] as const;

const RESULT_STATUSES: readonly ResultStatus[] = ['completed', 'blocked', 'question', 'failed'];

/**
 * Validate result.json shape (strict keys, enums, caps, human-only).
 * Cross-task agreement (task_id/mode match) is layered by
 * validateResultForTask.
 */
export function validateResult(raw: unknown): Validation<ResultFile> {
  const what = 'result';
  if (!isRecord(raw)) return fail(what, 'expected a JSON object');
  const errors: string[] = [];
  checkUnknownKeys(raw, RESULT_KEYS, what, errors);
  checkRequiredKeys(raw, RESULT_REQUIRED, what, errors);
  checkSchema(raw['schema'], what, errors);

  checkMode(raw['mode'], `${what}.mode`, errors);
  checkTaskId(raw['task_id'], `${what}.task_id`, errors);

  const status = raw['status'];
  if (status !== undefined) {
    if (typeof status !== 'string') {
      errors.push(`${what}.status: must be a string, got ${typeof status}`);
    } else {
      checkHumanOnly(status, `${what}.status`, errors);
      if (!RESULT_STATUSES.includes(status as ResultStatus)) {
        errors.push(`${what}.status: "${status}" is not a valid result status`);
      }
    }
  }

  if (raw['report'] !== undefined && raw['report'] !== 'plan.md' && raw['report'] !== 'report.md') {
    errors.push(`${what}.report: must be "plan.md" or "report.md", got ${JSON.stringify(raw['report'])}`);
  }
  if (raw['validation'] !== undefined && raw['validation'] !== 'passed' && raw['validation'] !== 'failed') {
    errors.push(`${what}.validation: must be "passed" or "failed", got ${JSON.stringify(raw['validation'])}`);
  }
  checkString(raw['reason'], `${what}.reason`, errors, { min: 1, max: REASON_MAX });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as ResultFile };
}

/**
 * Validate result.json against the task it sits in: shape validation plus
 * task_id/mode agreement, the status whitelist and the frozen cross-field
 * constraints:
 * - report required: "plan.md" iff mode=plan && completed; "report.md" iff
 *   mode=execute && completed;
 * - validation required and "passed" for a publishable execute completion;
 * - reason required and non-empty iff status is blocked | question | failed.
 */
export function validateResultForTask(
  raw: unknown,
  expected: { taskId: string; mode: Mode },
): Validation<ResultFile> {
  const shape = validateResult(raw);
  if (!shape.ok) return shape;
  const value = shape.value;

  const errors: string[] = [];
  if (value.task_id !== expected.taskId) {
    errors.push(`result: task_id "${value.task_id}" does not match expected "${expected.taskId}"`);
  }
  if (value.mode !== expected.mode) {
    errors.push(`result: mode "${value.mode}" does not match expected "${expected.mode}"`);
  }
  checkHumanOnly(value.status, 'result.status', errors);

  if (expected.mode === 'plan' && value.status === 'completed') {
    if (value.report === undefined) {
      errors.push('result: report is required when a plan task reports status=completed');
    } else if (value.report !== 'plan.md') {
      errors.push(`result: a plan task's report must be "plan.md", got ${JSON.stringify(value.report)}`);
    }
    if (value.validation !== undefined) {
      errors.push('result: validation is only allowed when an execute task reports status=completed');
    }
  } else if (expected.mode === 'execute' && value.status === 'completed') {
    if (value.report === undefined) {
      errors.push('result: report is required when an execute task reports status=completed');
    } else if (value.report !== 'report.md') {
      errors.push(`result: an execute task's report must be "report.md", got ${JSON.stringify(value.report)}`);
    }
    if (value.validation === undefined) {
      errors.push('result: validation is required when an execute task reports status=completed');
    }
  } else {
    if (value.report !== undefined) {
      errors.push('result: report is only allowed when status is completed');
    }
    if (value.validation !== undefined) {
      errors.push('result: validation is only allowed when an execute task reports status=completed');
    }
  }

  const reasonExpected = value.status === 'blocked' || value.status === 'question' || value.status === 'failed';
  if (reasonExpected) {
    if (value.reason === undefined || value.reason.trim().length === 0) {
      errors.push(`result: a non-empty reason is required when status is "${value.status}"`);
    }
  } else if (value.reason !== undefined) {
    errors.push('result: reason is only allowed when status is blocked, question or failed');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

const CURRENT_KEYS = ['schema', 'task_id', 'mode', 'issue_number', 'updated_at'] as const;

/** Validate .gateflow/current.json. */
export function validateCurrent(raw: unknown): Validation<CurrentPointer> {
  const what = 'current';
  if (!isRecord(raw)) return fail(what, 'expected a JSON object');
  const errors: string[] = [];
  checkUnknownKeys(raw, CURRENT_KEYS, what, errors);
  checkRequiredKeys(raw, CURRENT_KEYS, what, errors);
  checkSchema(raw['schema'], what, errors);
  checkTaskId(raw['task_id'], `${what}.task_id`, errors);
  checkMode(raw['mode'], `${what}.mode`, errors);
  checkPositiveInt(raw['issue_number'], `${what}.issue_number`, errors);
  checkIsoDate(raw['updated_at'], `${what}.updated_at`, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as CurrentPointer };
}

const TASK_RECORD_KEYS = [
  'task_id',
  'status',
  'attempts',
  'mode',
  'issue_number',
  'workflow_epoch',
  'input_snapshot_sha256',
  'plan_comment_id',
  'approval_comment_id',
  'tracker_comment_id',
  'published_comment_id',
  'last_notice_key',
  'last_sync_at',
  'error',
] as const;
const TASK_RECORD_REQUIRED = ['task_id', 'status', 'attempts', 'mode', 'issue_number', 'workflow_epoch'] as const;

function validateTaskRecord(rawObj: unknown, what: string, errors: string[]): void {
  if (!isRecord(rawObj)) {
    errors.push(`${what}: expected a JSON object`);
    return;
  }
  const raw: Obj = rawObj;
  checkUnknownKeys(raw, TASK_RECORD_KEYS, what, errors);
  checkRequiredKeys(raw, TASK_RECORD_REQUIRED, what, errors);
  checkTaskId(raw['task_id'], `${what}.task_id`, errors);
  const status = raw['status'];
  if (status !== undefined && !TASK_STATES.includes(status as (typeof TASK_STATES)[number])) {
    errors.push(`${what}.status: must be one of ${TASK_STATES.join('|')}, got ${JSON.stringify(status)}`);
  }
  checkPositiveInt(raw['attempts'], `${what}.attempts`, errors);
  checkMode(raw['mode'], `${what}.mode`, errors);
  checkPositiveInt(raw['issue_number'], `${what}.issue_number`, errors);
  if (raw['workflow_epoch'] !== undefined) {
    if (typeof raw['workflow_epoch'] !== 'string' || !EPOCH_SHAPE.test(raw['workflow_epoch'])) {
      errors.push(`${what}.workflow_epoch: malformed epoch string`);
    }
  }
  if (
    raw['input_snapshot_sha256'] !== undefined &&
    (typeof raw['input_snapshot_sha256'] !== 'string' || !SHA256_PATTERN.test(raw['input_snapshot_sha256']))
  ) {
    errors.push(`${what}.input_snapshot_sha256: must be a 64-character hex sha256`);
  }
  checkPositiveInt(raw['plan_comment_id'], `${what}.plan_comment_id`, errors);
  checkPositiveInt(raw['approval_comment_id'], `${what}.approval_comment_id`, errors);
  checkPositiveInt(raw['tracker_comment_id'], `${what}.tracker_comment_id`, errors);
  checkPositiveInt(raw['published_comment_id'], `${what}.published_comment_id`, errors);
  checkString(raw['last_notice_key'], `${what}.last_notice_key`, errors, { min: 1, max: 64 });
  if (typeof raw['last_notice_key'] === 'string' && !/^[0-9a-f]{16}$/.test(raw['last_notice_key'])) {
    errors.push(`${what}.last_notice_key: must be a 16-character lowercase hex sha256 prefix`);
  }
  checkIsoDate(raw['last_sync_at'], `${what}.last_sync_at`, errors);
  const error = raw['error'];
  if (error !== undefined && error !== null) {
    checkString(error, `${what}.error`, errors, { min: 1, max: 2000 });
  }
}

const STATE_KEYS = ['schema', 'updated_at', 'tasks'] as const;
const STATE_REQUIRED = ['schema', 'updated_at', 'tasks'] as const;

/**
 * Validate .gateflow/driver/state.json (Driver-private; a broken state file
 * is never fatal — callers treat it as an empty cache — but a corrupt one
 * must not be silently half-applied either).
 */
export function validateDriverState(raw: unknown): Validation<DriverStateFile> {
  const what = 'driver state';
  if (!isRecord(raw)) return fail(what, 'expected a JSON object');
  const errors: string[] = [];
  checkUnknownKeys(raw, STATE_KEYS, what, errors);
  checkRequiredKeys(raw, STATE_REQUIRED, what, errors);
  checkSchema(raw['schema'], what, errors);
  checkIsoDate(raw['updated_at'], `${what}.updated_at`, errors);

  const tasks = raw['tasks'];
  if (tasks !== undefined) {
    if (!isRecord(tasks)) {
      errors.push(`${what}.tasks: expected a JSON object`);
    } else {
      for (const [taskId, entry] of Object.entries(tasks)) {
        if (!isRecord(entry)) {
          errors.push(`${what}.tasks.${taskId}: expected a JSON object`);
          continue;
        }
        validateTaskRecord(entry, `${what}.tasks.${taskId}`, errors);
        if (taskId !== entry['task_id']) {
          errors.push(`${what}.tasks.${taskId}: key does not match task_id ${JSON.stringify(entry['task_id'])}`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as DriverStateFile };
}

export type { TaskRecord };
