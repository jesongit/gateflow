import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { watchOutbox } from '../../src/workspace/watcher';
import type { OutboxWatcher } from '../../src/workspace/watcher';
import { makeWorkspace, sleep, statusFile, waitFor } from './helpers';

let fixture: Awaited<ReturnType<typeof makeWorkspace>>;

afterEach(async () => {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
  if (fixture) await fixture.cleanup();
});

let watcher: OutboxWatcher | null = null;

async function fresh() {
  fixture = await makeWorkspace();
  return fixture;
}

async function writeStatus(outbox: string, id: string, body: string): Promise<void> {
  await mkdir(nodePath.join(outbox, id), { recursive: true });
  await writeFile(nodePath.join(outbox, id, 'status.json'), body, 'utf8');
}

describe('watchOutbox', () => {
  it('fires for a dispatch dir after debounce once sizes are stable', async () => {
    const { paths } = await fresh();
    const fired: string[] = [];
    watcher = watchOutbox(paths, { debounceMs: 120, pollIntervalMs: 40 }, (id) => fired.push(id));

    const id = 'gf_r1_i2_wabcdef012345_consumer_01';
    await writeStatus(paths.outbox, id, JSON.stringify(statusFile()));
    await waitFor(() => fired.includes(id), 2500);
    expect(fired.filter((entry) => entry === id)).toHaveLength(1);
  }, 10000);

  it('coalesces rapid rewrites into a single event', async () => {
    const { paths } = await fresh();
    const fired: string[] = [];
    watcher = watchOutbox(paths, { debounceMs: 200, pollIntervalMs: 40 }, (id) => fired.push(id));

    const id = 'gf_r1_i2_wabcdef012345_consumer_01';
    await writeStatus(paths.outbox, id, JSON.stringify(statusFile()));
    await sleep(20);
    await writeStatus(paths.outbox, id, JSON.stringify({ ...statusFile(), phase: 'coding' }));
    await waitFor(() => fired.includes(id), 2500);
    await sleep(250);
    expect(fired.filter((entry) => entry === id)).toHaveLength(1);
  }, 10000);

  it('never fires for junk directories', async () => {
    const { paths } = await fresh();
    const fired: string[] = [];
    watcher = watchOutbox(paths, { debounceMs: 100, pollIntervalMs: 40 }, (id) => fired.push(id));

    await writeStatus(paths.outbox, 'junk-dir', '{}');
    await writeStatus(paths.outbox, 'gf_r1_i2_consumer_01_backup', '{}');
    await writeFile(nodePath.join(paths.outbox, 'loose-file.json'), '{}', 'utf8');
    await sleep(600);
    expect(fired).toEqual([]);
  }, 10000);

  it('close() stops all further events', async () => {
    const { paths } = await fresh();
    const fired: string[] = [];
    watcher = watchOutbox(paths, { debounceMs: 100, pollIntervalMs: 40 }, (id) => fired.push(id));

    const id = 'gf_r1_i2_wabcdef012345_consumer_01';
    await writeStatus(paths.outbox, id, JSON.stringify(statusFile()));
    await waitFor(() => fired.includes(id), 2500);

    await watcher.close();
    watcher = null;

    await writeStatus(paths.outbox, id, JSON.stringify({ ...statusFile(), state: 'blocked' }));
    await mkdir(nodePath.join(paths.outbox, 'gf_r1_i2_wabcdef012345_consumer_02'), { recursive: true });
    await writeFile(
      nodePath.join(paths.outbox, 'gf_r1_i2_wabcdef012345_consumer_02', 'status.json'),
      JSON.stringify(statusFile({ dispatch_id: 'gf_r1_i2_wabcdef012345_consumer_02' })),
      'utf8',
    );
    await sleep(500);
    expect(fired.filter((entry) => entry === id)).toHaveLength(1);
    expect(fired).not.toContain('gf_r1_i2_wabcdef012345_consumer_02');
  }, 10000);

  it('re-fires when a previously fired dispatch changes again', async () => {
    const { paths } = await fresh();
    const fired: string[] = [];
    watcher = watchOutbox(paths, { debounceMs: 100, pollIntervalMs: 40 }, (id) => fired.push(id));

    const id = 'gf_r1_i2_wabcdef012345_consumer_01';
    await writeStatus(paths.outbox, id, JSON.stringify(statusFile()));
    await waitFor(() => fired.length === 1, 2500);
    await sleep(60);
    await writeStatus(paths.outbox, id, JSON.stringify({ ...statusFile(), state: 'blocked' }));
    await waitFor(() => fired.length === 2, 2500);
    expect(new Set(fired)).toEqual(new Set([id]));
  }, 10000);
});
