/**
 * Workspace Protocol schema 3 core: task-id grammar and path safety.
 */
import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_SCHEMA_VERSION,
  TASK_ID_PATTERN,
  makePlanTaskId,
  makeExecuteTaskId,
  parseTaskId,
} from '../../src/workspace/protocol';
import {
  resolveWorkspace,
  ensureWorkspace,
  taskDir,
  assertTaskId,
  listTaskDirs,
} from '../../src/workspace/paths';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

describe('task-id grammar', () => {
  it('builds plan ids with zero-padded rounds', () => {
    expect(makePlanTaskId(123, 7, 'wf_abc123def456', 1)).toBe('gf_r123_i7_wabc123def456_plan_01');
    expect(makePlanTaskId(123, 7, 'wf_abc123def456', 12)).toBe('gf_r123_i7_wabc123def456_plan_12');
  });

  it('builds execute ids bound to the plan comment', () => {
    expect(makeExecuteTaskId(123, 7, 'wf_abc123def456', 987654321)).toBe(
      'gf_r123_i7_wabc123def456_execute_p987654321',
    );
  });

  it('rejects malformed inputs', () => {
    expect(() => makePlanTaskId(0, 7, 'wf_abc123def456', 1)).toThrow();
    expect(() => makePlanTaskId(123, 7, 'not-an-epoch', 1)).toThrow();
    expect(() => makeExecuteTaskId(123, 7, 'wf_abc123def456', 0)).toThrow();
  });

  it('parses valid ids into components and rejects everything else', () => {
    const parsed = parseTaskId('gf_r123_i7_wabc123def456_execute_p900');
    expect(parsed).toEqual({
      repositoryId: 123,
      issueNumber: 7,
      epochCode: 'abc123def456',
      mode: 'execute',
      revision: 'p900',
    });
    expect(parseTaskId('gf_r123_i7_wabc123def456_plan_02')?.mode).toBe('plan');
    // Hostile shapes: traversal, separators, wrong epoch size, old roles.
    expect(parseTaskId('../escape')).toBeNull();
    expect(parseTaskId('gf_r123_i7_wabc_plan_01')).toBeNull();
    expect(parseTaskId('gf_r123_i7_wabc123def456_consumer_01')).toBeNull();
    expect(parseTaskId('gf_r123_i7_wabc123def456')).toBeNull();
    expect(TASK_ID_PATTERN.test('gf_r123_i7_wabc123def456_plan_extra_01')).toBe(false);
  });

  it('schema version is 3', () => {
    expect(WORKSPACE_SCHEMA_VERSION).toBe(3);
  });
});

describe('workspace paths', () => {
  it('resolves the schema-3 layout', () => {
    const paths = resolveWorkspace('C:\\proj', '.gateflow');
    expect(nodePath.basename(paths.tasks)).toBe('tasks');
    expect(paths.state).toBe(nodePath.join(paths.driver, 'state.json'));
    expect(paths.current).toBe(nodePath.join(paths.root, 'current.json'));
  });

  it('taskDir rejects ids violating the frozen grammar (traversal, junk)', () => {
    const paths = resolveWorkspace('/proj');
    for (const bad of ['..', 'foo/bar', 'gf_r1_i1_wx_plan_1', '', '.hidden', 'gf_r123_i7_wabc123def456_plan_01/extra']) {
      expect(() => taskDir(paths, bad)).toThrow();
      expect(() => assertTaskId(bad)).toThrow();
    }
  });

  it('taskDir stays lexically inside the tasks root', () => {
    const paths = resolveWorkspace('/proj');
    expect(taskDir(paths, 'gf_r123_i7_wabc123def456_plan_01')).toBe(
      nodePath.resolve(nodePath.join(paths.tasks, 'gf_r123_i7_wabc123def456_plan_01')),
    );
  });

  it('listTaskDirs returns only valid ids, sorted, and ignores junk', async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'gateflow-paths-'));
    try {
      const paths = resolveWorkspace(root);
      await ensureWorkspace(paths);
      await mkdir(nodePath.join(paths.tasks, 'gf_r123_i9_wabc123def456_plan_02'), { recursive: true });
      await mkdir(nodePath.join(paths.tasks, 'gf_r123_i7_wabc123def456_plan_01'), { recursive: true });
      await mkdir(nodePath.join(paths.tasks, 'junk'), { recursive: true });
      const ids = await listTaskDirs(paths.tasks);
      expect(ids).toEqual(['gf_r123_i7_wabc123def456_plan_01', 'gf_r123_i9_wabc123def456_plan_02']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
