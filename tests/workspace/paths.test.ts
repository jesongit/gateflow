import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKSPACE_DIR,
  ensureWorkspace,
  inboxDispatchDir,
  outboxDispatchDir,
  resolveWorkspace,
} from '../../src/workspace/paths';
import { EPOCH_CODE } from './helpers';

const CONSUMER_ID = `gf_r1_i2_w${EPOCH_CODE}_consumer_01`;
const EXECUTOR_ID = `gf_r1_i2_w${EPOCH_CODE}_executor_p3472198451`;

describe('resolveWorkspace', () => {
  it('defaults to .gateflow and wires every location', () => {
    const paths = resolveWorkspace('/proj');
    expect(nodePath.basename(paths.root)).toBe(DEFAULT_WORKSPACE_DIR);
    expect(paths.current).toBe(nodePath.join(paths.root, 'current.json'));
    expect(paths.inbox).toBe(nodePath.join(paths.root, 'inbox'));
    expect(paths.outbox).toBe(nodePath.join(paths.root, 'outbox'));
    expect(paths.submit).toBe(nodePath.join(paths.root, 'submit'));
    // Schema 2: driver-private state moved under .gateflow/driver/.
    expect(paths.driver).toBe(nodePath.join(paths.root, 'driver'));
    expect(paths.receipts).toBe(nodePath.join(paths.root, 'driver', 'receipts'));
    expect(paths.locks).toBe(nodePath.join(paths.root, 'driver', 'locks'));
    expect(paths.logs).toBe(nodePath.join(paths.root, 'driver', 'logs'));
  });

  it('honours a custom workspace_dir from config', () => {
    const paths = resolveWorkspace('/proj', 'gf');
    expect(paths.root).toBe(nodePath.resolve('/proj', 'gf'));
    expect(paths.inbox).toBe(nodePath.join(nodePath.resolve('/proj', 'gf'), 'inbox'));
    expect(paths.receipts).toBe(nodePath.join(nodePath.resolve('/proj', 'gf'), 'driver', 'receipts'));
  });

  it('resolves to absolute paths', () => {
    const paths = resolveWorkspace('.');
    expect(nodePath.isAbsolute(paths.root)).toBe(true);
  });
});

describe('dispatch directory traversal defense', () => {
  const paths = resolveWorkspace('/proj');

  it('resolves valid ids inside the inbox', () => {
    expect(inboxDispatchDir(paths, CONSUMER_ID)).toBe(
      nodePath.join(paths.inbox, CONSUMER_ID),
    );
    expect(outboxDispatchDir(paths, EXECUTOR_ID)).toBe(
      nodePath.join(paths.outbox, EXECUTOR_ID),
    );
  });

  it('rejects traversal, encoded traversal, absolutes and junk in the inbox', () => {
    const bad = [
      '..%2F' + CONSUMER_ID,
      CONSUMER_ID + '/../../etc',
      'x/../../etc',
      '../' + CONSUMER_ID,
      '/etc/passwd',
      'C:\\evil',
      'junk',
      CONSUMER_ID + ' ',
      '',
      CONSUMER_ID + '\n',
      // Schema-1 ids (no epoch component) are no longer valid directory names.
      'gf_r1_i2_consumer_01',
      // Epoch code must be exactly 12 base36 chars.
      `gf_r1_i2_w${EPOCH_CODE}f_consumer_01`,
      `gf_r1_i2_w${EPOCH_CODE.slice(0, -1)}_consumer_01`,
    ];
    for (const id of bad) {
      expect(() => inboxDispatchDir(paths, id)).toThrow();
    }
  });

  it('rejects the same set in the outbox', () => {
    const bad = ['..%2F' + CONSUMER_ID, CONSUMER_ID + '/../../etc', '/etc', 'D:\\x', 'junk'];
    for (const id of bad) {
      expect(() => outboxDispatchDir(paths, id)).toThrow();
    }
  });

  it('keeps resolved dispatch dirs lexically contained in the roots', () => {
    for (const id of [CONSUMER_ID, `gf_r1_i2_w${EPOCH_CODE}_executor_p1`]) {
      const inboxDir = nodePath.resolve(inboxDispatchDir(paths, id));
      expect(inboxDir.startsWith(nodePath.resolve(paths.inbox) + nodePath.sep)).toBe(true);
      const outboxDir = nodePath.resolve(outboxDispatchDir(paths, id));
      expect(outboxDir.startsWith(nodePath.resolve(paths.outbox) + nodePath.sep)).toBe(true);
    }
  });
});

describe('ensureWorkspace', () => {
  it('creates every directory and is idempotent', async () => {
    // A unique temp root: a shared fixed path would pick up stale layout
    // leftovers from older test runs (e.g. schema-1 root-level receipts/).
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(nodePath.join(tmpdir(), 'gateflow-paths-'));
    try {
      const paths = resolveWorkspace(root);
      await ensureWorkspace(paths);
      await ensureWorkspace(paths);
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(paths.root);
      expect(entries.sort()).toEqual(['driver', 'inbox', 'outbox', 'submit']);
      const driverEntries = await readdir(paths.driver);
      expect(driverEntries.sort()).toEqual(['locks', 'logs', 'receipts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
