/**
 * Outbox validation rules the Driver must apply before syncing anything to
 * GitHub (docs/workspace-protocol.md §5, frozen). A failed validation means
 * the file is logged and skipped — never a crash.
 *
 * Layering:
 * - schemas.ts owns per-file shape validation (strict keys, enums, caps).
 * - This module adds outbox-specific rules: dispatch_id/role agreement with
 *   the dispatch being processed, per-role result/state whitelists, the
 *   human-only blacklist, and the §2.4 cross-field "iff" constraints.
 */
import {
  HUMAN_ONLY_RESULTS,
  ROLE_RESULT_WHITELIST,
  ROLE_STATE_WHITELIST,
  DISPATCH_DIR_PATTERN,
} from './protocol';
import type { ResultFile, Role, StatusFile } from './protocol';
import { validateResult, validateStatus } from './schemas';
import type { Validation } from './schemas';

/** Hard per-file size cap: 512 KB (docs §5.7, anti-oversized defense). */
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

/**
 * True when `name` is a valid dispatch directory name (frozen §5.7 grammar).
 */
export function validateDispatchDirName(name: string): boolean {
  return DISPATCH_DIR_PATTERN.test(name);
}

/**
 * Validate outbox/<id>/status.json against the expected dispatch:
 * shape validation (schemas.validateStatus) plus dispatch_id/role agreement,
 * the role state whitelist and the human-only blacklist.
 */
export function validateOutboxStatus(
  raw: unknown,
  expected: { dispatchId: string; role: Role },
): Validation<StatusFile> {
  const shape = validateStatus(raw);
  if (!shape.ok) return shape;
  const value = shape.value;

  const errors: string[] = [];
  if (value.dispatch_id !== expected.dispatchId) {
    errors.push(`status: dispatch_id "${value.dispatch_id}" does not match expected "${expected.dispatchId}"`);
  }
  if (value.role !== expected.role) {
    errors.push(`status: role "${value.role}" does not match expected "${expected.role}"`);
  }
  if (!ROLE_STATE_WHITELIST[expected.role].includes(value.state)) {
    errors.push(`status: state "${value.state}" is not allowed for role "${expected.role}"`);
  }
  const humanOnly = (HUMAN_ONLY_RESULTS as readonly string[]).includes(value.state.toLowerCase());
  if (humanOnly) {
    errors.push(`status: human-only value "${value.state}" is reserved for humans and must never appear in agent files`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Validate outbox/<id>/result.json against the expected dispatch:
 * shape validation plus dispatch_id/role agreement, the role result
 * whitelist, the human-only blacklist, and the frozen §2.4 field
 * constraints:
 * - plan_file required and equal to "PLAN.md" iff consumer && plan_ready;
 * - report_file ("REPORT.md") and validation required iff executor &&
 *   completed;
 * - reason required and non-empty iff result is blocked | question | failed;
 *   presence outside those cases is rejected.
 */
export function validateOutboxResult(
  raw: unknown,
  expected: { dispatchId: string; role: Role },
): Validation<ResultFile> {
  const shape = validateResult(raw);
  if (!shape.ok) return shape;
  const value = shape.value;

  const errors: string[] = [];
  if (value.dispatch_id !== expected.dispatchId) {
    errors.push(`result: dispatch_id "${value.dispatch_id}" does not match expected "${expected.dispatchId}"`);
  }
  if (value.role !== expected.role) {
    errors.push(`result: role "${value.role}" does not match expected "${expected.role}"`);
  }
  if (!ROLE_RESULT_WHITELIST[expected.role].includes(value.result)) {
    errors.push(`result: "${value.result}" is not allowed for role "${expected.role}"`);
  }
  const humanOnly = (HUMAN_ONLY_RESULTS as readonly string[]).includes(value.result.toLowerCase());
  if (humanOnly) {
    errors.push(`result: human-only value "${value.result}" is reserved for humans and must never appear in agent files`);
  }

  const isConsumer = value.role === 'consumer';
  const isExecutor = value.role === 'executor';

  if (isConsumer && value.result === 'plan_ready') {
    if (value.plan_file === undefined) {
      errors.push('result: plan_file is required when a consumer reports result=plan_ready');
    }
  } else if (value.plan_file !== undefined) {
    errors.push('result: plan_file is only allowed when a consumer reports result=plan_ready');
  }

  if (isExecutor && value.result === 'completed') {
    if (value.report_file === undefined) {
      errors.push('result: report_file is required when an executor reports result=completed');
    }
    if (value.validation === undefined) {
      errors.push('result: validation is required when an executor reports result=completed');
    }
  } else {
    if (value.report_file !== undefined) {
      errors.push('result: report_file is only allowed when an executor reports result=completed');
    }
    if (value.validation !== undefined) {
      errors.push('result: validation is only allowed when an executor reports result=completed');
    }
  }

  const reasonExpected =
    value.result === 'blocked' || value.result === 'question' || value.result === 'failed';
  if (reasonExpected) {
    if (value.reason === undefined || value.reason.trim().length === 0) {
      errors.push(`result: a non-empty reason is required when result is "${value.result}"`);
    }
  } else if (value.reason !== undefined) {
    errors.push('result: reason is only allowed when result is blocked, question or failed');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}
