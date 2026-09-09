/**
 * Gate-issued protocol records (docs/plans/v1_hardening_decisions.md §4,
 * hardening plan GF-H02 / Phase 2 + Phase 3).
 *
 * A record is a GitHub comment published by a trusted runtime (the Gate; the
 * Driver only bootstraps `workflow_epoch` records for Producer-submitted
 * issues). Frozen body layout:
 *
 *     <!-- gateflow:<kind>:v2 -->
 *
 *     ```json
 *     { ...record JSON... }
 *     ```
 *
 * Parsing rules (frozen):
 *  - the record marker line must occupy a line of its own (trim-equal);
 *  - the JSON is the content of the FIRST fenced block after the marker line;
 *  - the JSON must be an object whose keys are EXACTLY the frozen field set
 *    of the kind (unknown or missing keys reject the record);
 *  - records are invisible to the workflow marker machinery: record markers
 *    are NOT workflow markers and never trigger T1/T3/T6.
 *
 * Authorization classes (frozen):
 *  - `workflow_epoch`   — issued by the Gate or the Driver (bootstrap);
 *  - `approval`         — issued by the Gate ONLY;
 *  - `feedback_accepted`— issued by the Gate ONLY.
 *
 * These records are comment-borne: a protected publishing identity plus
 * fail-closed validation makes them auditable and revocation-safe, but NOT
 * strongly tamper-proof (docs/plans/v1_hardening_decisions.md §3).
 */
import { isWorkflowEpoch } from './epoch';

/** GitHub Protocol schema version carried by every record. */
export const RECORD_SCHEMA_VERSION = 2 as const;

/** Record marker for a workflow epoch record. */
export const EPOCH_RECORD_MARKER = '<!-- gateflow:workflow:v2 -->' as const;
/** Record marker for a Gate approval record. */
export const APPROVAL_RECORD_MARKER = '<!-- gateflow:approval:v2 -->' as const;
/** Record marker for a Gate-accepted human feedback event. */
export const FEEDBACK_RECORD_MARKER = '<!-- gateflow:feedback:v2 -->' as const;

export const ALL_RECORD_MARKERS: readonly string[] = [
  EPOCH_RECORD_MARKER,
  APPROVAL_RECORD_MARKER,
  FEEDBACK_RECORD_MARKER,
];

/** workflow_epoch record: names one formal workflow round of an issue. */
export interface WorkflowEpochRecord {
  schema: typeof RECORD_SCHEMA_VERSION;
  kind: 'workflow_epoch';
  repository_id: number;
  issue_number: number;
  workflow_epoch: string;
  created_at: string;
  issued_by: string;
  operation_id: string;
}

/** approval record: the durable proof that the Gate accepted an /approve. */
export interface ApprovalRecord {
  schema: typeof RECORD_SCHEMA_VERSION;
  kind: 'approval';
  repository_id: number;
  issue_number: number;
  workflow_epoch: string;
  plan_comment_id: number;
  plan_sha256: string;
  approval_command_comment_id: number;
  approved_by_id: number;
  approved_by_login: string;
  gate_login: string;
  gate_user_id: number;
  created_at: string;
  operation_id: string;
}

/** feedback_accepted record: the Gate accepted one /change. */
export interface FeedbackAcceptedRecord {
  schema: typeof RECORD_SCHEMA_VERSION;
  kind: 'feedback_accepted';
  repository_id: number;
  issue_number: number;
  workflow_epoch: string;
  event_id: string;
  feedback_comment_id: number;
  feedback_kind: 'change';
  gate_login: string;
  gate_user_id: number;
  created_at: string;
  operation_id: string;
}

export type GateRecord = WorkflowEpochRecord | ApprovalRecord | FeedbackAcceptedRecord;

/** Any parse/validation failure detail for logging (never thrown at callers). */
export type RecordParseResult =
  | { ok: true; commentId: number; record: GateRecord }
  | { ok: false; reason: string };

type Obj = Record<string, unknown>;

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/**
 * GitHub login shape. Bot identities carry the `github-actions[bot]`-style
 * `[bot]` suffix (the Gate's default identity!), so the suffix is part of
 * the frozen pattern.
 */
const LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?!$)){0,37}(\[bot\])?$/;
const OPERATION_ID = /^[a-z]+(:[\w.-]+)+$/;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Operation IDs (frozen grammar, docs/plans/v1_hardening_decisions.md §7).
 * Content/task-bound; retries NEVER mint a new one.
 */
export function epochOperationId(repositoryId: number, issueNumber: number, epoch: string): string {
  return `epoch:${repositoryId}:${issueNumber}:${epoch}`;
}

export function approvalOperationId(
  repositoryId: number,
  issueNumber: number,
  epoch: string,
  planCommentId: number,
): string {
  return `approval:${repositoryId}:${issueNumber}:${epoch}:p${planCommentId}`;
}

export function feedbackOperationId(
  repositoryId: number,
  issueNumber: number,
  epoch: string,
  feedbackCommentId: number,
): string {
  return `feedback:${repositoryId}:${issueNumber}:${epoch}:${feedbackCommentId}`;
}

/** Build the record comment body (marker line, blank, fenced JSON). */
export function buildRecordBody(record: GateRecord): string {
  return `${recordMarkerFor(record.kind)}\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
}

function recordMarkerFor(kind: GateRecord['kind']): string {
  switch (kind) {
    case 'workflow_epoch':
      return EPOCH_RECORD_MARKER;
    case 'approval':
      return APPROVAL_RECORD_MARKER;
    case 'feedback_accepted':
      return FEEDBACK_RECORD_MARKER;
  }
}

/** Which record kind (if any) a comment body carries; null otherwise. */
export function recordKindOf(body: string): GateRecord['kind'] | null {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === EPOCH_RECORD_MARKER) return 'workflow_epoch';
    if (trimmed === APPROVAL_RECORD_MARKER) return 'approval';
    if (trimmed === FEEDBACK_RECORD_MARKER) return 'feedback_accepted';
  }
  return null;
}

/**
 * Parse + strictly validate the record carried by a comment body.
 * Never throws: every failure mode comes back as `{ ok: false, reason }`.
 */
export function parseRecord(commentId: number, body: string): RecordParseResult {
  const lines = body.split(/\r?\n/);
  let markerIdx = -1;
  let kind: GateRecord['kind'] | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    const detected = recordKindOf(trimmed);
    if (detected !== null) {
      markerIdx = i;
      kind = detected;
      break;
    }
  }
  if (markerIdx === -1 || kind === null) {
    return { ok: false, reason: 'no record marker' };
  }
  // The marker line must own its line — a suffix/prefix around it rejects.
  if (((lines[markerIdx] ?? '').trim() !== recordMarkerFor(kind))) {
    return { ok: false, reason: 'record marker does not own its line' };
  }
  // First fenced block after the marker.
  let jsonLines: string[] | null = null;
  for (let i = markerIdx + 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() !== '```json') {
      continue;
    }
    const content: string[] = [];
    let closed = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      if ((lines[j] ?? '').trim() === '```') {
        closed = true;
        break;
      }
      content.push(lines[j] ?? '');
    }
    if (!closed) {
      return { ok: false, reason: 'record JSON fence is not closed' };
    }
    jsonLines = content;
    break;
  }
  if (jsonLines === null) {
    return { ok: false, reason: 'no ```json fence after the record marker' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(jsonLines.join('\n')) as unknown;
  } catch (err) {
    return { ok: false, reason: `record JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isObj(raw)) {
    return { ok: false, reason: 'record JSON is not an object' };
  }
  switch (kind) {
    case 'workflow_epoch':
      return validateEpochRecord(commentId, raw);
    case 'approval':
      return validateApprovalRecord(commentId, raw);
    case 'feedback_accepted':
      return validateFeedbackRecord(commentId, raw);
  }
}

function checkFields(
  raw: Obj,
  required: readonly string[],
  what: string,
  errors: string[],
): void {
  for (const key of Object.keys(raw)) {
    if (!required.includes(key)) {
      errors.push(`${what}: unknown key "${key}"`);
    }
  }
  for (const key of required) {
    if (!(key in raw)) {
      errors.push(`${what}: missing key "${key}"`);
    }
  }
}

function str(raw: Obj, key: string, pattern: RegExp, errors: string[]): string | null {
  const value = raw[key];
  if (typeof value !== 'string' || !pattern.test(value)) {
    errors.push(`${key}: expected string matching ${pattern.source}, got ${JSON.stringify(value)}`);
    return null;
  }
  return value;
}

function num(raw: Obj, key: string, errors: string[]): number | null {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    errors.push(`${key}: expected a non-negative integer, got ${JSON.stringify(value)}`);
    return null;
  }
  return value;
}

function validateEpochRecord(commentId: number, raw: Obj): RecordParseResult {
  const errors: string[] = [];
  const required = [
    'schema', 'kind', 'repository_id', 'issue_number', 'workflow_epoch',
    'created_at', 'issued_by', 'operation_id',
  ] as const;
  checkFields(raw, required, 'workflow_epoch record', errors);
  if ((raw['schema'] as unknown) !== RECORD_SCHEMA_VERSION) {
    errors.push(`schema: expected ${RECORD_SCHEMA_VERSION}, got ${JSON.stringify(raw['schema'])}`);
  }
  if ((raw['kind'] as unknown) !== 'workflow_epoch') {
    errors.push(`kind: expected "workflow_epoch", got ${JSON.stringify(raw['kind'])}`);
  }
  const repositoryId = num(raw, 'repository_id', errors);
  const issueNumber = num(raw, 'issue_number', errors);
  const epoch = isWorkflowEpoch(raw['workflow_epoch']) ? (raw['workflow_epoch'] as string) : null;
  if (epoch === null) errors.push('workflow_epoch: malformed epoch string');
  const createdAt = str(raw, 'created_at', ISO_DATE, errors);
  const issuedBy = str(raw, 'issued_by', LOGIN, errors);
  const operationId = str(raw, 'operation_id', OPERATION_ID, errors);
  if (errors.length > 0 || repositoryId === null || issueNumber === null || epoch === null || createdAt === null || issuedBy === null || operationId === null) {
    return { ok: false, reason: `invalid workflow_epoch record: ${errors.join('; ')}` };
  }
  if (operationId !== epochOperationId(repositoryId, issueNumber, epoch)) {
    return { ok: false, reason: `invalid workflow_epoch record: operation_id "${operationId}" does not bind repository/issue/epoch` };
  }
  return {
    ok: true,
    commentId,
    record: {
      schema: RECORD_SCHEMA_VERSION,
      kind: 'workflow_epoch',
      repository_id: repositoryId,
      issue_number: issueNumber,
      workflow_epoch: epoch,
      created_at: createdAt,
      issued_by: issuedBy,
      operation_id: operationId,
    },
  };
}

function validateApprovalRecord(commentId: number, raw: Obj): RecordParseResult {
  const errors: string[] = [];
  const required = [
    'schema', 'kind', 'repository_id', 'issue_number', 'workflow_epoch',
    'plan_comment_id', 'plan_sha256', 'approval_command_comment_id',
    'approved_by_id', 'approved_by_login', 'gate_login', 'gate_user_id',
    'created_at', 'operation_id',
  ] as const;
  checkFields(raw, required, 'approval record', errors);
  if ((raw['schema'] as unknown) !== RECORD_SCHEMA_VERSION) {
    errors.push(`schema: expected ${RECORD_SCHEMA_VERSION}, got ${JSON.stringify(raw['schema'])}`);
  }
  if ((raw['kind'] as unknown) !== 'approval') {
    errors.push(`kind: expected "approval", got ${JSON.stringify(raw['kind'])}`);
  }
  const repositoryId = num(raw, 'repository_id', errors);
  const issueNumber = num(raw, 'issue_number', errors);
  const epoch = isWorkflowEpoch(raw['workflow_epoch']) ? (raw['workflow_epoch'] as string) : null;
  if (epoch === null) errors.push('workflow_epoch: malformed epoch string');
  const planCommentId = num(raw, 'plan_comment_id', errors);
  const planSha = str(raw, 'plan_sha256', HEX64, errors);
  const commandCommentId = num(raw, 'approval_command_comment_id', errors);
  const approvedById = num(raw, 'approved_by_id', errors);
  const approvedByLogin = str(raw, 'approved_by_login', LOGIN, errors);
  const gateLogin = str(raw, 'gate_login', LOGIN, errors);
  const gateUserId = num(raw, 'gate_user_id', errors);
  const createdAt = str(raw, 'created_at', ISO_DATE, errors);
  const operationId = str(raw, 'operation_id', OPERATION_ID, errors);
  if (
    errors.length > 0 || repositoryId === null || issueNumber === null || epoch === null ||
    planCommentId === null || planSha === null || commandCommentId === null ||
    approvedById === null || approvedByLogin === null || gateLogin === null ||
    gateUserId === null || createdAt === null || operationId === null
  ) {
    return { ok: false, reason: `invalid approval record: ${errors.join('; ')}` };
  }
  const expectedOperation = approvalOperationId(repositoryId, issueNumber, epoch, planCommentId);
  if (operationId !== expectedOperation) {
    return { ok: false, reason: `invalid approval record: operation_id "${operationId}" does not bind repository/issue/epoch/plan` };
  }
  return {
    ok: true,
    commentId,
    record: {
      schema: RECORD_SCHEMA_VERSION,
      kind: 'approval',
      repository_id: repositoryId,
      issue_number: issueNumber,
      workflow_epoch: epoch,
      plan_comment_id: planCommentId,
      plan_sha256: planSha,
      approval_command_comment_id: commandCommentId,
      approved_by_id: approvedById,
      approved_by_login: approvedByLogin,
      gate_login: gateLogin,
      gate_user_id: gateUserId,
      created_at: createdAt,
      operation_id: operationId,
    },
  };
}

function validateFeedbackRecord(commentId: number, raw: Obj): RecordParseResult {
  const errors: string[] = [];
  const required = [
    'schema', 'kind', 'repository_id', 'issue_number', 'workflow_epoch',
    'event_id', 'feedback_comment_id', 'feedback_kind', 'gate_login',
    'gate_user_id', 'created_at', 'operation_id',
  ] as const;
  checkFields(raw, required, 'feedback record', errors);
  if ((raw['schema'] as unknown) !== RECORD_SCHEMA_VERSION) {
    errors.push(`schema: expected ${RECORD_SCHEMA_VERSION}, got ${JSON.stringify(raw['schema'])}`);
  }
  if ((raw['kind'] as unknown) !== 'feedback_accepted') {
    errors.push(`kind: expected "feedback_accepted", got ${JSON.stringify(raw['kind'])}`);
  }
  const repositoryId = num(raw, 'repository_id', errors);
  const issueNumber = num(raw, 'issue_number', errors);
  const epoch = isWorkflowEpoch(raw['workflow_epoch']) ? (raw['workflow_epoch'] as string) : null;
  if (epoch === null) errors.push('workflow_epoch: malformed epoch string');
  const eventId = str(raw, 'event_id', /^fe\d+$/, errors);
  const feedbackCommentId = num(raw, 'feedback_comment_id', errors);
  const feedbackKind = raw['feedback_kind'];
  if (feedbackKind !== 'change') {
    errors.push(`feedback_kind: expected "change", got ${JSON.stringify(feedbackKind)}`);
  }
  const gateLogin = str(raw, 'gate_login', LOGIN, errors);
  const gateUserId = num(raw, 'gate_user_id', errors);
  const createdAt = str(raw, 'created_at', ISO_DATE, errors);
  const operationId = str(raw, 'operation_id', OPERATION_ID, errors);
  if (
    errors.length > 0 || repositoryId === null || issueNumber === null || epoch === null ||
    eventId === null || feedbackCommentId === null || gateLogin === null ||
    gateUserId === null || createdAt === null || operationId === null ||
    feedbackKind !== 'change'
  ) {
    return { ok: false, reason: `invalid feedback record: ${errors.join('; ')}` };
  }
  if (eventId !== `fe${feedbackCommentId}`) {
    return { ok: false, reason: `invalid feedback record: event_id "${eventId}" does not match feedback_comment_id ${feedbackCommentId}` };
  }
  if (operationId !== feedbackOperationId(repositoryId, issueNumber, epoch, feedbackCommentId)) {
    return { ok: false, reason: `invalid feedback record: operation_id "${operationId}" does not bind repository/issue/epoch/feedback` };
  }
  return {
    ok: true,
    commentId,
    record: {
      schema: RECORD_SCHEMA_VERSION,
      kind: 'feedback_accepted',
      repository_id: repositoryId,
      issue_number: issueNumber,
      workflow_epoch: epoch,
      event_id: eventId,
      feedback_comment_id: feedbackCommentId,
      feedback_kind: feedbackKind,
      gate_login: gateLogin,
      gate_user_id: gateUserId,
      created_at: createdAt,
      operation_id: operationId,
    },
  };
}

/** A parsed record together with the comment that carries it. */
export interface ParsedRecord<T extends GateRecord = GateRecord, C extends { id: number; body: string } = { id: number; body: string }> {
  commentId: number;
  record: T;
  comment: C;
}

/**
 * Whether parsed approval records that share an Operation ID are semantically
 * identical (a benign retry re-issued the same record) or CONFLICTING
 * (same operation id, different authorization facts — fail closed).
 * `created_at` is audit metadata and deliberately NOT compared.
 */
export function approvalRecordsConflict(
  records: ReadonlyArray<{ commentId: number; record: ApprovalRecord }>,
): { conflict: boolean; reason: string | null } {
  const byOperation = new Map<string, ApprovalRecord>();
  const firstCommentIdByOperation = new Map<string, number>();
  for (const { commentId, record } of records) {
    const existing = byOperation.get(record.operation_id);
    if (existing === undefined) {
      byOperation.set(record.operation_id, record);
      firstCommentIdByOperation.set(record.operation_id, commentId);
      continue;
    }
    const sameContent =
      existing.workflow_epoch === record.workflow_epoch &&
      existing.plan_comment_id === record.plan_comment_id &&
      existing.plan_sha256 === record.plan_sha256 &&
      existing.approval_command_comment_id === record.approval_command_comment_id &&
      existing.approved_by_id === record.approved_by_id &&
      existing.approved_by_login.toLowerCase() === record.approved_by_login.toLowerCase() &&
      existing.gate_login.toLowerCase() === record.gate_login.toLowerCase() &&
      existing.gate_user_id === record.gate_user_id &&
      existing.repository_id === record.repository_id &&
      existing.issue_number === record.issue_number;
    if (!sameContent) {
      return {
        conflict: true,
        reason:
          `conflicting approval records for operation ${record.operation_id}: comment ` +
          `${firstCommentIdByOperation.get(record.operation_id)} vs ${commentId}`,
      };
    }
  }
  return { conflict: false, reason: null };
}

/**
 * Parse every record of one kind from a full comment list (id-ascending).
 * The comment type is preserved (callers may need `user` etc.). Unparseable
 * records are returned separately so callers can fail closed on tampering
 * instead of silently skipping.
 */
export function parseRecords<T extends GateRecord['kind'], C extends { id: number; body: string } = { id: number; body: string }>(
  kind: T,
  comments: ReadonlyArray<C>,
): {
  records: Array<ParsedRecord<Extract<GateRecord, { kind: T }>, C>>;
  invalid: Array<{ commentId: number; reason: string }>;
} {
  const records: Array<ParsedRecord<Extract<GateRecord, { kind: T }>, C>> = [];
  const invalid: Array<{ commentId: number; reason: string }> = [];
  for (const comment of comments) {
    if (recordKindOf(comment.body) !== kind) continue;
    const parsed = parseRecord(comment.id, comment.body);
    if (parsed.ok && parsed.record.kind === kind) {
      records.push({
        commentId: comment.id,
        record: parsed.record as Extract<GateRecord, { kind: T }>,
        comment,
      });
    } else {
      invalid.push({ commentId: comment.id, reason: parsed.ok ? 'kind mismatch' : parsed.reason });
    }
  }
  return { records, invalid };
}
