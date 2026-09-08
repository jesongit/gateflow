/**
 * Gate-issued protocol records (docs/plans/v1_hardening_decisions.md §4,
 * hardening plan GF-H02 / Phase 2 + Phase 3; V1.1 adds gate_transition).
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
 *  - `workflow_epoch`   — issued by the GATE (`created_by: "gate"`) or by an
 *                         explicit Bootstrap Driver identity for
 *                         Producer-submitted planning issues
 *                         (`created_by: "driver_bootstrap"`; V1.1 Phase 2
 *                         Epoch Record Trust);
 *  - `approval`         — issued by the Gate ONLY;
 *  - `feedback_accepted`— issued by the Gate ONLY;
 *  - `gate_transition`  — issued by the Gate ONLY (V1.1 Phase 4: the durable
 *                         audit fact that a specific source comment was
 *                         accepted and a specific label migration performed).
 *
 * These records are comment-borne: a protected publishing identity plus
 * fail-closed validation makes them auditable and revocation-safe, but NOT
 * strongly tamper-proof (docs/plans/v1_hardening_decisions.md §3).
 */
import { isWorkflowEpoch } from './epoch';
import { DISPATCH_DIR_PATTERN } from '../workspace/protocol';

/** GitHub Protocol schema version carried by every record. */
export const RECORD_SCHEMA_VERSION = 2 as const;

/** Record marker for a workflow epoch record. */
export const EPOCH_RECORD_MARKER = '<!-- gateflow:workflow:v2 -->' as const;
/** Record marker for a Gate approval record. */
export const APPROVAL_RECORD_MARKER = '<!-- gateflow:approval:v2 -->' as const;
/** Record marker for a Gate-accepted human feedback event. */
export const FEEDBACK_RECORD_MARKER = '<!-- gateflow:feedback:v2 -->' as const;
/** Record marker for a Gate transition record (V1.1 Phase 4). */
export const TRANSITION_RECORD_MARKER = '<!-- gateflow:transition:v2 -->' as const;

export const ALL_RECORD_MARKERS: readonly string[] = [
  EPOCH_RECORD_MARKER,
  APPROVAL_RECORD_MARKER,
  FEEDBACK_RECORD_MARKER,
  TRANSITION_RECORD_MARKER,
];

/**
 * WHO issued a workflow_epoch record (V1.1 Phase 2, frozen enum):
 *  - `gate`             — the Gate itself (T0 /ai-plan); the record comment
 *                         MUST be authored by a Gate identity;
 *  - `driver_bootstrap` — an explicit Bootstrap Driver identity (Producer-
 *                         submitted planning issues); the record comment
 *                         MUST be authored by a configured bootstrap-driver
 *                         identity. Second-class by construction: the field
 *                         distinguishes bootstrap from gate epochs.
 */
export type EpochIssuer = 'gate' | 'driver_bootstrap';

/** workflow_epoch record: names one formal workflow round of an issue. */
export interface WorkflowEpochRecord {
  schema: typeof RECORD_SCHEMA_VERSION;
  kind: 'workflow_epoch';
  repository_id: number;
  issue_number: number;
  workflow_epoch: string;
  /** WHO issued this epoch (V1.1 Phase 2; drives the issuer identity check). */
  created_by: EpochIssuer;
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

/** feedback_accepted record: the Gate accepted one /choose or /change. */
export interface FeedbackAcceptedRecord {
  schema: typeof RECORD_SCHEMA_VERSION;
  kind: 'feedback_accepted';
  repository_id: number;
  issue_number: number;
  workflow_epoch: string;
  event_id: string;
  feedback_comment_id: number;
  feedback_kind: 'choose' | 'change';
  gate_login: string;
  gate_user_id: number;
  created_at: string;
  operation_id: string;
}

/**
 * The six frozen state-machine transitions (gate/protocol TRANSITIONS rows),
 * used as the `transition` discriminator of a gate_transition record.
 */
export type TransitionId = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';

/**
 * gate_transition record (V1.1 Phase 4): the durable audit fact that the
 * Gate accepted a SPECIFIC source object (the command or marker comment with
 * `source_comment_id`) and performed the SPECIFIC label migration. This is
 * what a Driver receipt's `accepted` must bind to — never a bare label
 * observation (plan Phase 5). `dispatch_id` is the dispatch the source
 * object belongs to (null for dispatch-less transitions, i.e. T2).
 */
export interface GateTransitionRecord {
  schema: typeof RECORD_SCHEMA_VERSION;
  kind: 'gate_transition';
  repository_id: number;
  issue_number: number;
  workflow_epoch: string;
  /** Dispatch the source object belongs to; null when none (T2). */
  dispatch_id: string | null;
  transition: TransitionId;
  from_label: string;
  to_label: string;
  /** Comment id of the accepted source object (command / marker comment). */
  source_comment_id: number;
  gate_login: string;
  gate_user_id: number;
  gate_version: string;
  created_at: string;
  operation_id: string;
}

export type GateRecord =
  | WorkflowEpochRecord
  | ApprovalRecord
  | FeedbackAcceptedRecord
  | GateTransitionRecord;

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
 *
 * V1.1 (Phase 3 + Phase 6): epoch operation ids are DETERMINISTIC per logical
 * operation, no longer embedding the random epoch value — a retried /ai-plan
 * (same command comment, or a redelivered event) resolves to the SAME
 * operation id, so the recovery path can search-and-adopt instead of
 * minting a second epoch:
 *   gate T0:        `epoch:<repo>:<issue>:c<command_comment_id>`
 *   driver bootstrap: `epoch:<repo>:<issue>:bootstrap`
 */
export function gateEpochOperationId(
  repositoryId: number,
  issueNumber: number,
  commandCommentId: number,
): string {
  return `epoch:${repositoryId}:${issueNumber}:c${commandCommentId}`;
}

export function bootstrapEpochOperationId(repositoryId: number, issueNumber: number): string {
  return `epoch:${repositoryId}:${issueNumber}:bootstrap`;
}

/**
 * Whether `operationId` is a well-formed epoch operation id binding
 * `<repositoryId>`/`<issueNumber>` (either the gate T0 or the bootstrap
 * form). The epoch VALUE is intentionally not part of the id.
 */
export function isEpochOperationId(
  operationId: string,
  repositoryId: number,
  issueNumber: number,
): boolean {
  if (operationId === bootstrapEpochOperationId(repositoryId, issueNumber)) {
    return true;
  }
  const commandCommentId = extractEpochCommandCommentId(operationId);
  return (
    commandCommentId !== null &&
    operationId === gateEpochOperationId(repositoryId, issueNumber, commandCommentId)
  );
}

/** `epoch:<r>:<i>:c<id>` → `<id>`; null for other shapes. */
export function extractEpochCommandCommentId(operationId: string): number | null {
  const match = /^epoch:(\d+):(\d+):c(\d+)$/.exec(operationId);
  if (match === null) return null;
  const id = Number(match[3]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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

/**
 * Transition records are idempotent per (epoch, transition, source comment):
 * a redelivered event re-derives the same operation id and adopts the
 * existing record instead of duplicating it (V1.1 Phase 4).
 */
export function transitionOperationId(
  repositoryId: number,
  issueNumber: number,
  epoch: string,
  transition: TransitionId,
  sourceCommentId: number,
): string {
  return `transition:${repositoryId}:${issueNumber}:${epoch}:${transition}:${sourceCommentId}`;
}

/** Producer submit source-id operation (`submit:<submission_id>`). */
export function submitOperationId(submissionId: string): string {
  return `submit:${submissionId}`;
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
    case 'gate_transition':
      return TRANSITION_RECORD_MARKER;
  }
}

/** Which record kind (if any) a comment body carries; null otherwise. */
export function recordKindOf(body: string): GateRecord['kind'] | null {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === EPOCH_RECORD_MARKER) return 'workflow_epoch';
    if (trimmed === APPROVAL_RECORD_MARKER) return 'approval';
    if (trimmed === FEEDBACK_RECORD_MARKER) return 'feedback_accepted';
    if (trimmed === TRANSITION_RECORD_MARKER) return 'gate_transition';
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
    case 'gate_transition':
      return validateTransitionRecord(commentId, raw);
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
    'created_by', 'created_at', 'issued_by', 'operation_id',
  ] as const;
  checkFields(raw, required, 'workflow_epoch record', errors);
  if ((raw['schema'] as unknown) !== RECORD_SCHEMA_VERSION) {
    errors.push(`schema: expected ${RECORD_SCHEMA_VERSION}, got ${JSON.stringify(raw['schema'])}`);
  }
  if ((raw['kind'] as unknown) !== 'workflow_epoch') {
    errors.push(`kind: expected "workflow_epoch", got ${JSON.stringify(raw['kind'])}`);
  }
  const createdBy = raw['created_by'];
  if (createdBy !== 'gate' && createdBy !== 'driver_bootstrap') {
    errors.push(`created_by: expected "gate"|"driver_bootstrap", got ${JSON.stringify(createdBy)}`);
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
  // V1.1 Phase 3: the operation id binds repo/issue (and the issuing command
  // for gate epochs) — never the random epoch value itself.
  if (!isEpochOperationId(operationId, repositoryId, issueNumber)) {
    return { ok: false, reason: `invalid workflow_epoch record: operation_id "${operationId}" does not bind repository/issue` };
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
      created_by: createdBy as EpochIssuer,
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
  if (feedbackKind !== 'choose' && feedbackKind !== 'change') {
    errors.push(`feedback_kind: expected "choose"|"change", got ${JSON.stringify(feedbackKind)}`);
  }
  const gateLogin = str(raw, 'gate_login', LOGIN, errors);
  const gateUserId = num(raw, 'gate_user_id', errors);
  const createdAt = str(raw, 'created_at', ISO_DATE, errors);
  const operationId = str(raw, 'operation_id', OPERATION_ID, errors);
  if (
    errors.length > 0 || repositoryId === null || issueNumber === null || epoch === null ||
    eventId === null || feedbackCommentId === null || gateLogin === null ||
    gateUserId === null || createdAt === null || operationId === null ||
    (feedbackKind !== 'choose' && feedbackKind !== 'change')
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

const TRANSITION_IDS: readonly TransitionId[] = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
const LABEL_PATTERN = /^ai:(planning|review|ready|working|blocked|done)$/;

function validateTransitionRecord(commentId: number, raw: Obj): RecordParseResult {
  const errors: string[] = [];
  const required = [
    'schema', 'kind', 'repository_id', 'issue_number', 'workflow_epoch',
    'dispatch_id', 'transition', 'from_label', 'to_label', 'source_comment_id',
    'gate_login', 'gate_user_id', 'gate_version', 'created_at', 'operation_id',
  ] as const;
  checkFields(raw, required, 'gate_transition record', errors);
  if ((raw['schema'] as unknown) !== RECORD_SCHEMA_VERSION) {
    errors.push(`schema: expected ${RECORD_SCHEMA_VERSION}, got ${JSON.stringify(raw['schema'])}`);
  }
  if ((raw['kind'] as unknown) !== 'gate_transition') {
    errors.push(`kind: expected "gate_transition", got ${JSON.stringify(raw['kind'])}`);
  }
  const repositoryId = num(raw, 'repository_id', errors);
  const issueNumber = num(raw, 'issue_number', errors);
  const epoch = isWorkflowEpoch(raw['workflow_epoch']) ? (raw['workflow_epoch'] as string) : null;
  if (epoch === null) errors.push('workflow_epoch: malformed epoch string');
  const rawDispatchId = raw['dispatch_id'];
  const dispatchId =
    rawDispatchId === null
      ? null
      : typeof rawDispatchId === 'string' && DISPATCH_DIR_PATTERN.test(rawDispatchId)
        ? rawDispatchId
        : (errors.push(`dispatch_id: expected a dispatch id or null, got ${JSON.stringify(rawDispatchId)}`), null);
  const rawTransition = raw['transition'];
  const transition =
    typeof rawTransition === 'string' && TRANSITION_IDS.includes(rawTransition as TransitionId)
      ? (rawTransition as TransitionId)
      : (errors.push(`transition: expected one of ${TRANSITION_IDS.join('|')}, got ${JSON.stringify(rawTransition)}`), null);
  const fromLabel = str(raw, 'from_label', LABEL_PATTERN, errors);
  const toLabel = str(raw, 'to_label', LABEL_PATTERN, errors);
  const sourceCommentId = num(raw, 'source_comment_id', errors);
  const gateLogin = str(raw, 'gate_login', LOGIN, errors);
  const gateUserId = num(raw, 'gate_user_id', errors);
  const gateVersion = str(raw, 'gate_version', /^[0-9]+\.[0-9]+\.[0-9]+$/, errors);
  const createdAt = str(raw, 'created_at', ISO_DATE, errors);
  const operationId = str(raw, 'operation_id', OPERATION_ID, errors);
  if (
    errors.length > 0 || repositoryId === null || issueNumber === null || epoch === null ||
    transition === null ||
    fromLabel === null || toLabel === null || sourceCommentId === null ||
    gateLogin === null || gateUserId === null || gateVersion === null ||
    createdAt === null || operationId === null
  ) {
    return { ok: false, reason: `invalid gate_transition record: ${errors.join('; ')}` };
  }
  if (operationId !== transitionOperationId(repositoryId, issueNumber, epoch, transition, sourceCommentId)) {
    return { ok: false, reason: `invalid gate_transition record: operation_id "${operationId}" does not bind repository/issue/epoch/transition/source` };
  }
  return {
    ok: true,
    commentId,
    record: {
      schema: RECORD_SCHEMA_VERSION,
      kind: 'gate_transition',
      repository_id: repositoryId,
      issue_number: issueNumber,
      workflow_epoch: epoch,
      dispatch_id: dispatchId,
      transition,
      from_label: fromLabel,
      to_label: toLabel,
      source_comment_id: sourceCommentId,
      gate_login: gateLogin,
      gate_user_id: gateUserId,
      gate_version: gateVersion,
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
 * V1.1 Phase 2 (Epoch Record Trust): parsed epoch records that share an
 * operation id must agree on the epoch VALUE. Identical → a benign retry
 * adopted the record; divergent → someone published two different epochs for
 * the same logical operation: CONFLICT, fail closed (never "latest wins").
 */
export function epochRecordsConflict(
  records: ReadonlyArray<{ commentId: number; record: WorkflowEpochRecord }>,
): { conflict: boolean; reason: string | null } {
  const byOperation = new Map<string, WorkflowEpochRecord>();
  const firstCommentIdByOperation = new Map<string, number>();
  for (const { commentId, record } of records) {
    const existing = byOperation.get(record.operation_id);
    if (existing === undefined) {
      byOperation.set(record.operation_id, record);
      firstCommentIdByOperation.set(record.operation_id, commentId);
      continue;
    }
    if (
      existing.workflow_epoch !== record.workflow_epoch ||
      existing.created_by !== record.created_by ||
      existing.issued_by.toLowerCase() !== record.issued_by.toLowerCase()
    ) {
      return {
        conflict: true,
        reason:
          `conflicting workflow_epoch records for operation ${record.operation_id}: comment ` +
          `${firstCommentIdByOperation.get(record.operation_id)} vs ${commentId} ` +
          `(epoch ${existing.workflow_epoch} vs ${record.workflow_epoch})`,
      };
    }
  }
  return { conflict: false, reason: null };
}

/**
 * The `gateflow:source-id` HTML comment embedded in Producer-submitted issue
 * bodies (`submit:<submission_id>` Operation ID, docs/plans/
 * v1_hardening_decisions.md §7). Reconciliation finds a created issue by this
 * anchor instead of by title.
 */
export function sourceIdComment(operationId: string): string {
  return `<!-- gateflow:source-id: ${operationId} -->`;
}

const SOURCE_ID_PATTERN = /<!--\s*gateflow:source-id:\s*(submit:sub_[0-9a-z]{16})\s*-->/;

/**
 * Extracts the source-id Operation ID from an issue body; null when absent
 * or when the anchor names a foreign operation kind (only `submit:` anchors
 * identify Producer submissions).
 */
export function findSourceIdInBody(body: string): string | null {
  return SOURCE_ID_PATTERN.exec(body)?.[1] ?? null;
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
