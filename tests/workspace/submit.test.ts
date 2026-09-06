import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectSubmit, markSubmitProcessed, writeSubmitError } from '../../src/workspace/submit';
import type { WorkspacePaths } from '../../src/workspace/paths';
import { makeWorkspace, submitRequest } from './helpers';

let fixture: Awaited<ReturnType<typeof makeWorkspace>>;

afterEach(async () => {
  if (fixture) await fixture.cleanup();
});

async function fresh() {
  fixture = await makeWorkspace();
  return fixture;
}

async function seedSubmit(paths: WorkspacePaths, submitJson: string, task: string): Promise<void> {
  await mkdir(paths.submit, { recursive: true });
  await writeFile(nodePath.join(paths.submit, 'submit.json'), submitJson, 'utf8');
  await writeFile(nodePath.join(paths.submit, 'TASK.md'), task, 'utf8');
}

describe('inspectSubmit', () => {
  it('reports empty when the directory or both files are missing', async () => {
    const { paths } = await fresh();
    expect(await inspectSubmit(paths)).toEqual({ status: 'empty' });
    await rm(paths.submit, { recursive: true, force: true });
    expect(await inspectSubmit(paths)).toEqual({ status: 'empty' });
    await mkdir(paths.submit, { recursive: true });
    await writeFile(nodePath.join(paths.submit, 'unrelated.txt'), 'x', 'utf8');
    expect(await inspectSubmit(paths)).toEqual({ status: 'empty' });
  });

  it('reports ready with the validated request and task body', async () => {
    const { paths } = await fresh();
    await seedSubmit(paths, JSON.stringify(submitRequest()), '# Task\n\nDo the thing');
    const inspection = await inspectSubmit(paths);
    expect(inspection).toEqual({ status: 'ready', request: submitRequest(), task: '# Task\n\nDo the thing' });
  });

  it('reports invalid on any mismatch', async () => {
    const { paths } = await fresh();

    // TASK.md without submit.json
    await writeFile(nodePath.join(paths.submit, 'TASK.md'), 'body', 'utf8');
    let inspection = await inspectSubmit(paths);
    expect(inspection.status).toBe('invalid');
    if (inspection.status === 'invalid') expect(inspection.error).toContain('submit.json is missing');

    // submit.json without TASK.md
    await rm(paths.submit, { recursive: true, force: true });
    await mkdir(paths.submit, { recursive: true });
    await writeFile(nodePath.join(paths.submit, 'submit.json'), JSON.stringify(submitRequest()), 'utf8');
    inspection = await inspectSubmit(paths);
    expect(inspection.status).toBe('invalid');
    if (inspection.status === 'invalid') expect(inspection.error).toContain('TASK.md is missing');

    // Broken JSON
    await writeFile(nodePath.join(paths.submit, 'TASK.md'), 'body', 'utf8');
    await writeFile(nodePath.join(paths.submit, 'submit.json'), '{oops', 'utf8');
    inspection = await inspectSubmit(paths);
    expect(inspection.status).toBe('invalid');
    if (inspection.status === 'invalid') expect(inspection.error).toContain('not valid JSON');

    // Schema violation (bad kind)
    await writeFile(
      nodePath.join(paths.submit, 'submit.json'),
      JSON.stringify(submitRequest({ kind: 'hotfix' as 'feature' })),
      'utf8',
    );
    inspection = await inspectSubmit(paths);
    expect(inspection.status).toBe('invalid');
    if (inspection.status === 'invalid') expect(inspection.error).toContain('failed validation');

    // Empty TASK.md
    await writeFile(nodePath.join(paths.submit, 'submit.json'), JSON.stringify(submitRequest()), 'utf8');
    await writeFile(nodePath.join(paths.submit, 'TASK.md'), '', 'utf8');
    inspection = await inspectSubmit(paths);
    expect(inspection.status).toBe('invalid');
    if (inspection.status === 'invalid') expect(inspection.error).toContain('empty');
  });
});

describe('markSubmitProcessed', () => {
  it('moves the submission into processed-<timestamp>/ and prevents re-read', async () => {
    const { paths } = await fresh();
    await seedSubmit(paths, JSON.stringify(submitRequest()), '# Task\n\nBody');

    const dirName = await markSubmitProcessed(paths);
    expect(dirName).toMatch(/^processed-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);

    const processedDir = nodePath.join(paths.submit, dirName);
    expect(await readFile(nodePath.join(processedDir, 'submit.json'), 'utf8')).toContain('"title"');
    expect(await readFile(nodePath.join(processedDir, 'TASK.md'), 'utf8')).toBe('# Task\n\nBody');

    const entries = (await readdir(paths.submit)).sort();
    expect(entries).toEqual([dirName]);

    // No longer a pending submission.
    expect(await inspectSubmit(paths)).toEqual({ status: 'empty' });
  });

  it('creates the submit dir when missing and leaves error.json in place', async () => {
    const { paths } = await fresh();
    await rm(paths.submit, { recursive: true, force: true });
    const dirName = await markSubmitProcessed(paths);
    expect(dirName.startsWith('processed-')).toBe(true);

    await writeFile(nodePath.join(paths.submit, 'error.json'), '{"error":"bad"}', 'utf8');
    await markSubmitProcessed(paths);
    const entries = await readdir(paths.submit);
    expect(entries).toContain('error.json');
  });
});

describe('writeSubmitError', () => {
  it('writes an atomically-created error.json', async () => {
    const { paths } = await fresh();
    await writeSubmitError(paths, 'title too long');
    const raw = await readFile(nodePath.join(paths.submit, 'error.json'), 'utf8');
    const parsed = JSON.parse(raw) as { error: string; created_at: string };
    expect(parsed.error).toBe('title too long');
    expect(typeof parsed.created_at).toBe('string');
  });
});
