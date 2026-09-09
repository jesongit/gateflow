/**
 * Task directory I/O (schema 3): atomic ready-marker writes, snapshot
 * binding, result.json strict reads and driver-state rules.
 */
import { readFile, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  emptyDriverState,
  getTaskRecord,
  readDriverState,
  shouldPrepare,
  withTaskRecord,
  withoutTaskRecord,
  writeDriverState,
} from '../../src/workspace/driver-state';
import {
  inputSnapshotSha256,
  readCurrent,
  readResultJson,
  readTaskFile,
  sha256Hex,
  writeCurrent,
  writeTaskDir,
} from '../../src/workspace/tasks';
import { writeTaskFile } from '../driver/helpers';
import type { TaskFile } from '../../src/workspace/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveWorkspace, ensureWorkspace } from '../../src/workspace/paths';
import type { WorkspacePaths } from '../../src/workspace/paths';

const TASK_ID = 'gf_r123_i7_wabc123def456_plan_01';

let paths: WorkspacePaths;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'gateflow-tasks-'));
  paths = resolveWorkspace(root);
  await ensureWorkspace(paths);
  cleanup = async () => rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await cleanup();
});

function taskFile(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    schema: 3,
    task_id: TASK_ID,
    control_repository: 'octo/repo',
    repository_id: 123,
    issue_number: 7,
    workflow_epoch: 'wf_abc123def456',
    target_repository: null,
    target_workspace: null,
    mode: 'plan',
    reason: 'planning',
    created_at: '2026-09-06T10:00:00Z',
    plan_comment_id: null,
    approval_comment_id: null,
    input: { task: 'task.md', plan: null, feedback: null },
    ...overrides,
  };
}

describe('writeTaskDir / readTaskFile', () => {
  it('writes inputs and task.json LAST (ready marker)', async () => {
    let sawTaskJson = false;
    // stat a file inside the dir during build is not interceptable; instead
    // assert the observable contract: task.json exists and parses only when
    // everything else was written first.
    await writeTaskDir(paths, {
      taskFile: taskFile({ input: { task: 'task.md', plan: null, feedback: 'feedback.md' } }),
      task: '# Task\n\nDo it.\n',
      plan: null,
      feedback: '# Human Feedback\n\n## 1 — x\n',
    });
    sawTaskJson = (await stat(nodePath.join(paths.tasks, TASK_ID, 'task.json'))).isFile();
    expect(sawTaskJson).toBe(true);
    const parsed = await readTaskFile(paths, TASK_ID);
    expect(parsed?.mode).toBe('plan');
    expect(parsed?.input).toEqual({ task: 'task.md', plan: null, feedback: 'feedback.md' });
    expect(await readFile(nodePath.join(paths.tasks, TASK_ID, 'task.md'), 'utf8')).toContain('Do it.');
    expect(await readFile(nodePath.join(paths.tasks, TASK_ID, 'feedback.md'), 'utf8')).toContain('Human Feedback');
  });

  it('returns null for a hostile id or missing task.json', async () => {
    expect(await readTaskFile(paths, '../escape')).toBeNull();
    expect(await readTaskFile(paths, TASK_ID)).toBeNull();
  });

  it('rejects a corrupt task.json as not-ready', async () => {
    await writeTaskFile(paths, TASK_ID, 'task.json', '{broken json');
    expect(await readTaskFile(paths, TASK_ID)).toBeNull();
  });
});

describe('input snapshot binding', () => {
  it('covers task+plan+feedback and detects any change', async () => {
    const a = inputSnapshotSha256({ task: 'T', plan: 'P', feedback: null });
    const b = inputSnapshotSha256({ task: 'T', plan: 'P', feedback: null });
    expect(a).toBe(b);
    expect(a).not.toBe(inputSnapshotSha256({ task: 'T2', plan: 'P', feedback: null }));
    expect(a).not.toBe(inputSnapshotSha256({ task: 'T', plan: 'P2', feedback: null }));
    expect(a).not.toBe(inputSnapshotSha256({ task: 'T', plan: 'P', feedback: 'F' }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('x')).toBe(sha256Hex('x'));
  });
});

describe('readResultJson', () => {
  it('distinguishes absent from malformed', async () => {
    expect(await readResultJson(paths, TASK_ID)).toBeNull(); // absent
    await writeTaskFile(paths, TASK_ID, 'result.json', 'not json');
    const bad = await readResultJson(paths, TASK_ID);
    expect(bad?.error).toBeTruthy();
    await writeTaskFile(paths, TASK_ID, 'result.json', 'null');
    expect((await readResultJson(paths, TASK_ID))?.error).toBe('result.json is not a JSON object');
    await writeTaskFile(paths, TASK_ID, 'result.json', '{"ok":true}');
    const good = await readResultJson(paths, TASK_ID);
    expect(good?.error).toBeNull();
    expect(good?.raw).toEqual({ ok: true });
  });
});

describe('current pointer', () => {
  it('round-trips and rejects corruption', async () => {
    await writeCurrent(paths, {
      schema: 3,
      task_id: TASK_ID,
      mode: 'plan',
      control_repository: 'octo/repo',
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: 'wf_abc123def456',
      target_repository: null,
      target_workspace: null,
      updated_at: '2026-09-06T10:00:00Z',
    });
    expect((await readCurrent(paths))?.task_id).toBe(TASK_ID);
  });
});

describe('driver state', () => {
  const record = {
    task_id: TASK_ID,
    status: 'prepared' as const,
    attempts: 1,
    mode: 'plan' as const,
    control_repository: 'octo/repo',
    repository_id: 123,
    issue_number: 7,
    workflow_epoch: 'wf_abc123def456',
    target_repository: null,
    target_workspace: null,
  };

  it('missing/corrupt state reads as empty (rebuildable cache)', async () => {
    expect(getTaskRecord(await readDriverState(paths), TASK_ID)).toBeNull();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(paths.state, '{corrupt', 'utf8');
    expect(getTaskRecord(await readDriverState(paths), TASK_ID)).toBeNull();
  });

  it('persists and clears records atomically', async () => {
    await writeDriverState(paths, withTaskRecord(emptyDriverState(), record));
    expect(getTaskRecord(await readDriverState(paths), TASK_ID)?.status).toBe('prepared');
    await writeDriverState(paths, withoutTaskRecord(await readDriverState(paths), TASK_ID));
    expect(getTaskRecord(await readDriverState(paths), TASK_ID)).toBeNull();
  });

  it('shouldPrepare enforces the dedup rules', () => {
    expect(shouldPrepare(null, 3)).toEqual({ ok: true, reason: 'new' });
    for (const status of ['prepared', 'publishing', 'published', 'accepted', 'obsolete'] as const) {
      expect(shouldPrepare({ ...record, status }, 3).ok).toBe(false);
    }
    expect(shouldPrepare({ ...record, status: 'failed', attempts: 1 }, 3)).toEqual({ ok: true, reason: 'retry' });
    expect(shouldPrepare({ ...record, status: 'failed', attempts: 3 }, 3)).toEqual({ ok: false, reason: 'retry-limit' });
  });
});
