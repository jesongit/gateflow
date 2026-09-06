import { readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  atomicWriteJson,
  atomicWriteText,
  readCurrent,
  readInboxDispatch,
  sha256Hex,
  writeCurrent,
  writeInbox,
} from '../../src/workspace/inbox';
import {
  OversizedFileError,
  listOutboxDispatchIds,
  listReceipts,
  readOutboxMarkdown,
  readOutboxResult,
  readOutboxStatus,
  readReceipt,
  writeReceipt,
} from '../../src/workspace/outbox';
import { MAX_FILE_BYTES } from '../../src/workspace/validation';
import {
  consumerContext,
  consumerDispatch,
  currentPointer,
  executorContext,
  executorDispatch,
  makeWorkspace,
  receipt,
  resultFile,
  statusFile,
} from './helpers';

let fixture: Awaited<ReturnType<typeof makeWorkspace>>;

afterEach(async () => {
  if (fixture) await fixture.cleanup();
});

async function fresh() {
  fixture = await makeWorkspace();
  return fixture;
}

describe('atomic writes', () => {
  it('leave no temp files behind', async () => {
    const { paths } = await fresh();
    const file = nodePath.join(paths.root, 'atomic.txt');
    await atomicWriteText(file, 'hello');
    await atomicWriteJson(nodePath.join(paths.root, 'atomic.json'), { a: 1 });
    const entries = await readdir(paths.root);
    expect(entries.sort()).toEqual(['atomic.json', 'atomic.txt', 'inbox', 'logs', 'outbox', 'receipts', 'submit']);
    expect(await readFile(file, 'utf8')).toBe('hello');
    expect(await readFile(nodePath.join(paths.root, 'atomic.json'), 'utf8')).toBe('{\n  "a": 1\n}\n');
  });

  it('overwrite existing targets in place', async () => {
    const { paths } = await fresh();
    const file = nodePath.join(paths.root, 'over.txt');
    await atomicWriteText(file, 'one');
    await atomicWriteText(file, 'two');
    expect(await readFile(file, 'utf8')).toBe('two');
    const entries = await readdir(paths.root);
    expect(entries.filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});

describe('inbox build', () => {
  it('writes TASK.md, context.json and dispatch.json (ready marker last)', async () => {
    const { paths } = await fresh();
    const dispatch = consumerDispatch();
    await writeInbox(paths, {
      dispatch,
      context: consumerContext(),
      task: '# Issue\n\nBody',
      plan: null,
      feedback: null,
    });
    const dir = nodePath.join(paths.inbox, 'gf_r1_i2_consumer_01');
    const entries = (await readdir(dir)).sort();
    expect(entries).toEqual(['TASK.md', 'context.json', 'dispatch.json']);
    expect(await readFile(nodePath.join(dir, 'TASK.md'), 'utf8')).toBe('# Issue\n\nBody');
    expect(await readInboxDispatch(paths, 'gf_r1_i2_consumer_01')).toEqual(dispatch);
  });

  it('projects PLAN.md and FEEDBACK.md only when present', async () => {
    const { paths } = await fresh();
    const dispatch = executorDispatch({}, { feedback: 'FEEDBACK.md' });
    const plan = '# Plan\n\nstep 1';
    await writeInbox(paths, {
      dispatch,
      context: executorContext({ feedback_count: 1 }),
      task: 'TASK',
      plan,
      feedback: '# Human Feedback\n\n## 1',
    });
    const dir = nodePath.join(paths.inbox, 'gf_r1_i2_executor_p100');
    const entries = (await readdir(dir)).sort();
    expect(entries).toEqual(['FEEDBACK.md', 'PLAN.md', 'TASK.md', 'context.json', 'dispatch.json']);
    expect(await readFile(nodePath.join(dir, 'PLAN.md'), 'utf8')).toBe(plan);
  });

  it('is idempotent on rewrite and keeps the dispatch readable', async () => {
    const { paths } = await fresh();
    const dispatch = consumerDispatch();
    const build = { dispatch, context: consumerContext(), task: 'v1', plan: null, feedback: null };
    await writeInbox(paths, build);
    await writeInbox(paths, { ...build, task: 'v2' });
    const dir = nodePath.join(paths.inbox, 'gf_r1_i2_consumer_01');
    expect(await readFile(nodePath.join(dir, 'TASK.md'), 'utf8')).toBe('v2');
    expect(await readInboxDispatch(paths, 'gf_r1_i2_consumer_01')).toEqual(dispatch);
    const entries = await readdir(dir);
    expect(entries.filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('refuses to write into an invalid dispatch directory', async () => {
    const { paths } = await fresh();
    const dispatch = consumerDispatch({ dispatch_id: '../escape' });
    await expect(
      writeInbox(paths, { dispatch, context: consumerContext(), task: 'x', plan: null, feedback: null }),
    ).rejects.toThrow();
  });

  it('treats missing / corrupt / invalid dispatch.json as unreadable', async () => {
    const { paths } = await fresh();
    expect(await readInboxDispatch(paths, 'gf_r1_i2_consumer_01')).toBeNull();

    const dir = nodePath.join(paths.inbox, 'gf_r1_i2_consumer_01');
    await mkdir(dir, { recursive: true });
    await writeFile(nodePath.join(dir, 'dispatch.json'), '{not json', 'utf8');
    expect(await readInboxDispatch(paths, 'gf_r1_i2_consumer_01')).toBeNull();

    await writeFile(nodePath.join(dir, 'dispatch.json'), JSON.stringify({ schema: 7 }), 'utf8');
    expect(await readInboxDispatch(paths, 'gf_r1_i2_consumer_01')).toBeNull();
  });
});

describe('current pointer', () => {
  it('round-trips and returns null when missing or corrupt', async () => {
    const { paths } = await fresh();
    expect(await readCurrent(paths)).toBeNull();
    const pointer = currentPointer();
    await writeCurrent(paths, pointer);
    expect(await readCurrent(paths)).toEqual(pointer);
    await writeFile(paths.current, ' garbage ', 'utf8');
    expect(await readCurrent(paths)).toBeNull();
  });
});

describe('sha256Hex', () => {
  it('matches the known sha256 test vectors', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('outbox reads', () => {
  it('reads raw status/result JSON without semantic validation', async () => {
    const { paths } = await fresh();
    const dir = nodePath.join(paths.outbox, 'gf_r1_i2_consumer_01');
    await mkdir(dir, { recursive: true });
    expect(await readOutboxStatus(paths, 'gf_r1_i2_consumer_01')).toBeNull();

    await writeFile(nodePath.join(dir, 'status.json'), JSON.stringify(statusFile()), 'utf8');
    expect(await readOutboxStatus(paths, 'gf_r1_i2_consumer_01')).toEqual(statusFile());

    // Raw parse: even schema-violating JSON is returned as-is.
    await writeFile(nodePath.join(dir, 'status.json'), JSON.stringify({ schema: 99, junk: true }), 'utf8');
    expect(await readOutboxStatus(paths, 'gf_r1_i2_consumer_01')).toEqual({ schema: 99, junk: true });

    await writeFile(nodePath.join(dir, 'status.json'), 'nope{', 'utf8');
    expect(await readOutboxStatus(paths, 'gf_r1_i2_consumer_01')).toBeNull();

    expect(await readOutboxResult(paths, 'gf_r1_i2_consumer_01')).toBeNull();
    await writeFile(nodePath.join(dir, 'result.json'), JSON.stringify(resultFile()), 'utf8');
    expect(await readOutboxResult(paths, 'gf_r1_i2_consumer_01')).toEqual(resultFile());
  });

  it('reads markdown, null on missing/empty, throws OversizedFileError beyond 512KB', async () => {
    const { paths } = await fresh();
    const id = 'gf_r1_i2_consumer_01';
    const dir = nodePath.join(paths.outbox, id);
    await mkdir(dir, { recursive: true });
    expect(await readOutboxMarkdown(paths, id, 'PLAN.md')).toBeNull();

    await writeFile(nodePath.join(dir, 'PLAN.md'), '# Plan', 'utf8');
    expect(await readOutboxMarkdown(paths, id, 'PLAN.md')).toBe('# Plan');

    await writeFile(nodePath.join(dir, 'PLAN.md'), '', 'utf8');
    expect(await readOutboxMarkdown(paths, id, 'PLAN.md')).toBeNull();

    const oversized = 'x'.repeat(MAX_FILE_BYTES + 1);
    await writeFile(nodePath.join(dir, 'PLAN.md'), oversized, 'utf8');
    const err = await readOutboxMarkdown(paths, id, 'PLAN.md').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OversizedFileError);
    const oversizedErr = err as OversizedFileError;
    expect(oversizedErr.size).toBe(MAX_FILE_BYTES + 1);
    expect(oversizedErr.maxBytes).toBe(MAX_FILE_BYTES);

    await rm(nodePath.join(dir, 'PLAN.md'));
    expect(await readOutboxMarkdown(paths, id, 'PROGRESS.md')).toBeNull();
  });

  it('lists only dispatch-shaped directories', async () => {
    const { paths } = await fresh();
    for (const name of ['gf_r1_i2_consumer_01', 'gf_r1_i2_executor_p100']) {
      await mkdir(nodePath.join(paths.outbox, name), { recursive: true });
    }
    await mkdir(nodePath.join(paths.outbox, 'junk'), { recursive: true });
    await mkdir(nodePath.join(paths.outbox, 'gf_r1_i2_consumer_01', 'nested'), { recursive: true });
    await writeFile(nodePath.join(paths.outbox, 'afile.txt'), 'x', 'utf8');
    expect(await listOutboxDispatchIds(paths)).toEqual(['gf_r1_i2_consumer_01', 'gf_r1_i2_executor_p100']);
  });

  it('returns [] when the outbox does not exist', async () => {
    const { paths } = await fresh();
    await rm(paths.outbox, { recursive: true, force: true });
    expect(await listOutboxDispatchIds(paths)).toEqual([]);
  });
});

describe('receipts', () => {
  it('round-trips and lists valid receipts', async () => {
    const { paths } = await fresh();
    const first = receipt({ status: 'synced', attempts: 2, tracker_comment_id: 7 });
    const second = receipt({ dispatch_id: 'gf_r1_i2_executor_p100', status: 'dispatched' });
    await writeReceipt(paths, first);
    await writeReceipt(paths, second);
    expect(await readReceipt(paths, 'gf_r1_i2_consumer_01')).toEqual(first);
    expect(await readReceipt(paths, 'gf_r1_i2_executor_p100')).toEqual(second);
    expect(await listReceipts(paths)).toEqual([first, second]);
  });

  it('returns null for missing/invalid receipts and rejects invalid writes', async () => {
    const { paths } = await fresh();
    expect(await readReceipt(paths, 'gf_r1_i2_consumer_01')).toBeNull();
    expect(await readReceipt(paths, '../escape')).toBeNull();
    await writeReceipt(paths, receipt());
    const file = nodePath.join(paths.receipts, 'gf_r1_i2_consumer_01.json');
    await writeFile(file, '}', 'utf8');
    expect(await readReceipt(paths, 'gf_r1_i2_consumer_01')).toBeNull();
    await expect(writeReceipt(paths, receipt({ dispatch_id: 'junk' }))).rejects.toThrow();
  });

  it('writes receipts atomically (no temp litter)', async () => {
    const { paths } = await fresh();
    await writeReceipt(paths, receipt());
    const entries = await readdir(paths.receipts);
    expect(entries).toEqual(['gf_r1_i2_consumer_01.json']);
    const info = await stat(nodePath.join(paths.receipts, 'gf_r1_i2_consumer_01.json'));
    expect(info.isFile()).toBe(true);
  });
});
