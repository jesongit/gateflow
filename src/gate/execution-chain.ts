/**
 * Pure helpers for the V1 execution-chain binding.
 *
 * The task id is the existing Workspace Protocol v3 identity.  Gate does not
 * create a second task schema: it only parses the id and compares it with the
 * current epoch/plan that it reads from GitHub.
 */
import { parseTaskId, type Mode } from '../workspace/protocol';

export interface DispatchBinding {
  repositoryId: number;
  issueNumber: number;
  workflowEpoch: string;
  mode: Mode;
  revision: string;
}

export type DispatchInspection =
  | { ok: true; id: string; binding: DispatchBinding }
  | { ok: false; reason: string };

const DISPATCH_ID_OCCURRENCE = /<!-- gateflow:dispatch-id: (\S+) -->/g;
const DISPATCH_ID_TOKEN = '<!-- gateflow:dispatch-id:';

/**
 * Extract exactly one dispatch-id anchor from a protocol comment.  The current
 * Driver protocol permits the anchor to share a line with other text; anchors
 * inside fenced code blocks and duplicate anchors do not identify a task.  This
 * deliberately does not grant any permission.
 */
export function findDispatchId(body: string | null | undefined): string | null {
  if (!body) return null;
  let insideFence = false;
  const ids: string[] = [];
  let malformedOccurrence = false;

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    const matches = [...trimmed.matchAll(DISPATCH_ID_OCCURRENCE)];
    if (matches.length > 0) {
      for (const match of matches) ids.push(match[1] as string);
      if (trimmed.split(DISPATCH_ID_TOKEN).length - 1 > matches.length) malformedOccurrence = true;
    } else if (trimmed.includes(DISPATCH_ID_TOKEN)) {
      malformedOccurrence = true;
    }
  }

  if (ids.length !== 1 || malformedOccurrence) return null;
  return ids[0] ?? null;
}

/** Parse and strictly normalize an existing Workspace Protocol task id. */
export function inspectDispatchId(id: string | null | undefined): DispatchInspection {
  if (typeof id !== 'string') return { ok: false, reason: 'dispatch id is missing' };
  const parsed = parseTaskId(id);
  if (
    parsed === null ||
    !Number.isSafeInteger(parsed.repositoryId) ||
    !Number.isSafeInteger(parsed.issueNumber) ||
    parsed.repositoryId < 1 ||
    parsed.issueNumber < 1
  ) {
    return { ok: false, reason: `dispatch id "${id}" has an invalid task-id shape` };
  }

  // parseTaskId intentionally validates the shared lexical grammar only. The
  // mode-specific revision is part of the Gate binding and is checked here.
  if (parsed.mode === 'plan' && !/^\d+$/.test(parsed.revision)) {
    return { ok: false, reason: `dispatch id "${id}" has a non-plan revision` };
  }
  if (parsed.mode === 'execute' && !/^p[1-9]\d*$/.test(parsed.revision)) {
    return { ok: false, reason: `dispatch id "${id}" has a non-execute revision` };
  }

  // Reject alternate spellings (leading zeroes, etc.) rather than accepting a
  // different string that happens to parse to the same numeric components.
  const canonical =
    `gf_r${parsed.repositoryId}_i${parsed.issueNumber}_w${parsed.epochCode}_` +
    `${parsed.mode}_${parsed.revision}`;
  if (id !== canonical) {
    return { ok: false, reason: `dispatch id "${id}" is not canonically encoded` };
  }

  return {
    ok: true,
    id,
    binding: {
      repositoryId: parsed.repositoryId,
      issueNumber: parsed.issueNumber,
      workflowEpoch: `wf_${parsed.epochCode}`,
      mode: parsed.mode,
      revision: parsed.revision,
    },
  };
}

/** Build the canonical planning task id used by the current Driver. */
export function expectedPlanDispatchId(
  repositoryId: number,
  issueNumber: number,
  workflowEpoch: string,
  revision: number,
): string | null {
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) return null;
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return null;
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  if (!/^wf_[0-9a-z]{12}$/.test(workflowEpoch)) return null;
  return `gf_r${repositoryId}_i${issueNumber}_w${workflowEpoch.slice(3)}_plan_${String(revision).padStart(2, '0')}`;
}

/** Build the canonical execution task id bound to the current Plan. */
export function expectedExecuteDispatchId(
  repositoryId: number,
  issueNumber: number,
  workflowEpoch: string,
  planCommentId: number,
): string | null {
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) return null;
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return null;
  if (!Number.isSafeInteger(planCommentId) || planCommentId < 1) return null;
  if (!/^wf_[0-9a-z]{12}$/.test(workflowEpoch)) return null;
  return `gf_r${repositoryId}_i${issueNumber}_w${workflowEpoch.slice(3)}_execute_p${planCommentId}`;
}

/** Compare one untrusted dispatch id with the exact expected task id. */
export function validateExpectedDispatchId(
  id: string | null | undefined,
  expected: string | null,
): { ok: true; binding: DispatchBinding } | { ok: false; reason: string } {
  const inspected = inspectDispatchId(id);
  if (!inspected.ok) return inspected;
  if (expected === null || inspected.id !== expected) {
    return {
      ok: false,
      reason: `dispatch id "${id ?? ''}" does not match current task "${expected ?? 'none'}"`,
    };
  }
  return { ok: true, binding: inspected.binding };
}
