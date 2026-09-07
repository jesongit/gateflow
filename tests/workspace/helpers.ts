/**
 * Shared fixtures for workspace tests: throwaway workspaces under os.tmpdir()
 * plus canonical dispatch/file builders matching the frozen contract
 * (Workspace Protocol schema 2 — dispatch ids bind the workflow epoch,
 * contexts carry the input snapshot hash, submits carry a submission_id).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import type { CurrentPointer, Dispatch, Receipt, ResultFile, StatusFile, SubmitRequest, WorkspaceContext } from '../../src/workspace/protocol';
import { WORKSPACE_SCHEMA_VERSION } from '../../src/workspace/protocol';
import { ensureWorkspace, resolveWorkspace } from '../../src/workspace/paths';
import type { WorkspacePaths } from '../../src/workspace/paths';

/** A disposable workspace with all directories created. */
export interface WorkspaceFixture {
  projectRoot: string;
  paths: WorkspacePaths;
  cleanup: () => Promise<void>;
}

/** Create a unique temp workspace (`.gateflow` layout) for one test. */
export async function makeWorkspace(): Promise<WorkspaceFixture> {
  const projectRoot = await mkdtemp(nodePath.join(tmpdir(), 'gateflow-ws-'));
  const paths = resolveWorkspace(projectRoot);
  await ensureWorkspace(paths);
  return {
    projectRoot,
    paths,
    cleanup: async () => {
      await rm(projectRoot, { recursive: true, force: true });
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `cond` until true or the timeout elapses (then fail the test). */
export async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(stepMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

export const CREATED_AT = '2026-09-06T17:00:00Z';
export const UPDATED_AT = '2026-09-06T17:30:00Z';

/** Canonical workflow epoch for fixtures (`wf_` + 12 base36 chars, schema 2). */
export const WORKFLOW_EPOCH = 'wf_abcdef012345';
/** The epoch code embedded in dispatch ids (epoch without its `wf_` prefix). */
export const EPOCH_CODE = 'abcdef012345';
/** Schema-2 consumer dispatch id for repository 1 / issue 2 / round 1. */
export const CONSUMER_DISPATCH_ID = `gf_r1_i2_w${EPOCH_CODE}_consumer_01`;
/** Schema-2 executor dispatch id for repository 1 / issue 2 / plan comment 100. */
export const EXECUTOR_DISPATCH_ID = `gf_r1_i2_w${EPOCH_CODE}_executor_p100`;
/** Fixture inbox snapshot hash (64 hex chars, schema 2). */
export const INPUT_SNAPSHOT_SHA256 = 'b'.repeat(64);

/** Canonical valid consumer dispatch with per-field overrides. */
export function consumerDispatch(overrides: Partial<Dispatch> = {}, inputOverrides: Partial<Dispatch['input']> = {}): Dispatch {
  const base: Dispatch = {
    schema: WORKSPACE_SCHEMA_VERSION,
    dispatch_id: CONSUMER_DISPATCH_ID,
    repository: 'owner/name',
    repository_id: 1,
    issue_number: 2,
    workflow_epoch: WORKFLOW_EPOCH,
    role: 'consumer',
    reason: 'planning',
    created_at: CREATED_AT,
    plan_comment_id: null,
    approval_comment_id: null,
    input: { task: 'TASK.md', plan: null, feedback: null },
  };
  return { ...base, ...overrides, input: { ...base.input, ...inputOverrides } };
}

/** Canonical valid executor dispatch with per-field overrides. */
export function executorDispatch(overrides: Partial<Dispatch> = {}, inputOverrides: Partial<Dispatch['input']> = {}): Dispatch {
  const base: Dispatch = {
    schema: WORKSPACE_SCHEMA_VERSION,
    dispatch_id: EXECUTOR_DISPATCH_ID,
    repository: 'owner/name',
    repository_id: 1,
    issue_number: 2,
    workflow_epoch: WORKFLOW_EPOCH,
    role: 'executor',
    reason: 'approved_plan',
    created_at: CREATED_AT,
    plan_comment_id: 100,
    approval_comment_id: 200,
    input: { task: 'TASK.md', plan: 'PLAN.md', feedback: null },
  };
  return { ...base, ...overrides, input: { ...base.input, ...inputOverrides } };
}

export function consumerContext(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    schema: WORKSPACE_SCHEMA_VERSION,
    dispatch_id: CONSUMER_DISPATCH_ID,
    workflow_epoch: WORKFLOW_EPOCH,
    feedback_count: 0,
    input_snapshot_sha256: INPUT_SNAPSHOT_SHA256,
    ...overrides,
  };
}

export function executorContext(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    schema: WORKSPACE_SCHEMA_VERSION,
    dispatch_id: EXECUTOR_DISPATCH_ID,
    workflow_epoch: WORKFLOW_EPOCH,
    plan_comment_id: 100,
    plan_sha256: 'a'.repeat(64),
    feedback_count: 0,
    input_snapshot_sha256: INPUT_SNAPSHOT_SHA256,
    ...overrides,
  };
}

export function statusFile(overrides: Partial<StatusFile> = {}): StatusFile {
  return {
    schema: WORKSPACE_SCHEMA_VERSION,
    dispatch_id: CONSUMER_DISPATCH_ID,
    role: 'consumer',
    state: 'working',
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

export function resultFile(overrides: Partial<ResultFile> = {}): ResultFile {
  return {
    schema: WORKSPACE_SCHEMA_VERSION,
    dispatch_id: CONSUMER_DISPATCH_ID,
    role: 'consumer',
    result: 'plan_ready',
    plan_file: 'PLAN.md',
    ...overrides,
  };
}

export function currentPointer(overrides: Partial<CurrentPointer> = {}): CurrentPointer {
  return {
    schema: WORKSPACE_SCHEMA_VERSION,
    dispatch_id: CONSUMER_DISPATCH_ID,
    role: 'consumer',
    issue_number: 2,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

export function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    dispatch_id: CONSUMER_DISPATCH_ID,
    status: 'dispatched',
    attempts: 1,
    workflow_epoch: WORKFLOW_EPOCH,
    ...overrides,
  };
}

export function submitRequest(overrides: Partial<SubmitRequest> = {}): SubmitRequest {
  return {
    schema: WORKSPACE_SCHEMA_VERSION,
    submission_id: 'sub_0123456789abcdef',
    title: 'Add dark mode',
    kind: 'feature',
    maturity_hint: 'requirement',
    created_at: CREATED_AT,
    ...overrides,
  };
}
