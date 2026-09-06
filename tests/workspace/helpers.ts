/**
 * Shared fixtures for workspace tests: throwaway workspaces under os.tmpdir()
 * plus canonical dispatch/file builders matching the frozen contract.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import type { CurrentPointer, Dispatch, Receipt, ResultFile, StatusFile, SubmitRequest, WorkspaceContext } from '../../src/workspace/protocol';
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

/** Canonical valid consumer dispatch with per-field overrides. */
export function consumerDispatch(overrides: Partial<Dispatch> = {}, inputOverrides: Partial<Dispatch['input']> = {}): Dispatch {
  const base: Dispatch = {
    schema: 1,
    dispatch_id: 'gf_r1_i2_consumer_01',
    repository: 'owner/name',
    repository_id: 1,
    issue_number: 2,
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
    schema: 1,
    dispatch_id: 'gf_r1_i2_executor_p100',
    repository: 'owner/name',
    repository_id: 1,
    issue_number: 2,
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
    schema: 1,
    dispatch_id: 'gf_r1_i2_consumer_01',
    feedback_count: 0,
    ...overrides,
  };
}

export function executorContext(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    schema: 1,
    dispatch_id: 'gf_r1_i2_executor_p100',
    plan_comment_id: 100,
    plan_sha256: 'a'.repeat(64),
    feedback_count: 0,
    ...overrides,
  };
}

export function statusFile(overrides: Partial<StatusFile> = {}): StatusFile {
  return {
    schema: 1,
    dispatch_id: 'gf_r1_i2_consumer_01',
    role: 'consumer',
    state: 'working',
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

export function resultFile(overrides: Partial<ResultFile> = {}): ResultFile {
  return {
    schema: 1,
    dispatch_id: 'gf_r1_i2_consumer_01',
    role: 'consumer',
    result: 'plan_ready',
    plan_file: 'PLAN.md',
    ...overrides,
  };
}

export function currentPointer(overrides: Partial<CurrentPointer> = {}): CurrentPointer {
  return {
    schema: 1,
    dispatch_id: 'gf_r1_i2_consumer_01',
    role: 'consumer',
    issue_number: 2,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

export function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    dispatch_id: 'gf_r1_i2_consumer_01',
    status: 'dispatched',
    attempts: 1,
    ...overrides,
  };
}

export function submitRequest(overrides: Partial<SubmitRequest> = {}): SubmitRequest {
  return {
    schema: 1,
    title: 'Add dark mode',
    kind: 'feature',
    maturity_hint: 'requirement',
    created_at: CREATED_AT,
    ...overrides,
  };
}
