import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKSPACE_DIR,
  ensureWorkspace,
  inboxDispatchDir,
  outboxDispatchDir,
  resolveWorkspace,
} from '../../src/workspace/paths';

describe('resolveWorkspace', () => {
  it('defaults to .gateflow and wires every location', () => {
    const paths = resolveWorkspace('/proj');
    expect(nodePath.basename(paths.root)).toBe(DEFAULT_WORKSPACE_DIR);
    expect(paths.current).toBe(nodePath.join(paths.root, 'current.json'));
    expect(paths.inbox).toBe(nodePath.join(paths.root, 'inbox'));
    expect(paths.outbox).toBe(nodePath.join(paths.root, 'outbox'));
    expect(paths.receipts).toBe(nodePath.join(paths.root, 'receipts'));
    expect(paths.submit).toBe(nodePath.join(paths.root, 'submit'));
    expect(paths.logs).toBe(nodePath.join(paths.root, 'logs'));
  });

  it('honours a custom workspace_dir from config', () => {
    const paths = resolveWorkspace('/proj', 'gf');
    expect(paths.root).toBe(nodePath.resolve('/proj', 'gf'));
    expect(paths.inbox).toBe(nodePath.join(nodePath.resolve('/proj', 'gf'), 'inbox'));
  });

  it('resolves to absolute paths', () => {
    const paths = resolveWorkspace('.');
    expect(nodePath.isAbsolute(paths.root)).toBe(true);
  });
});

describe('dispatch directory traversal defense', () => {
  const paths = resolveWorkspace('/proj');

  it('resolves valid ids inside the inbox', () => {
    expect(inboxDispatchDir(paths, 'gf_r1_i2_consumer_01')).toBe(
      nodePath.join(paths.inbox, 'gf_r1_i2_consumer_01'),
    );
    expect(outboxDispatchDir(paths, 'gf_r1_i2_executor_p3472198451')).toBe(
      nodePath.join(paths.outbox, 'gf_r1_i2_executor_p3472198451'),
    );
  });

  it('rejects traversal, encoded traversal, absolutes and junk in the inbox', () => {
    const bad = [
      '..%2Fgf_r1_i2_consumer_01',
      'gf_r1_i2_consumer_01/../../etc',
      'x/../../etc',
      '../gf_r1_i2_consumer_01',
      '/etc/passwd',
      'C:\\evil',
      'junk',
      'gf_r1_i2_consumer_01 ',
      '',
      'gf_r1_i2_consumer_01\n',
    ];
    for (const id of bad) {
      expect(() => inboxDispatchDir(paths, id)).toThrow();
    }
  });

  it('rejects the same set in the outbox', () => {
    const bad = ['..%2Fgf_r1_i2_consumer_01', 'gf_r1_i2_consumer_01/../../etc', '/etc', 'D:\\x', 'junk'];
    for (const id of bad) {
      expect(() => outboxDispatchDir(paths, id)).toThrow();
    }
  });

  it('keeps resolved dispatch dirs lexically contained in the roots', () => {
    for (const id of ['gf_r1_i2_consumer_01', 'gf_r1_i2_executor_p1']) {
      const inboxDir = nodePath.resolve(inboxDispatchDir(paths, id));
      expect(inboxDir.startsWith(nodePath.resolve(paths.inbox) + nodePath.sep)).toBe(true);
      const outboxDir = nodePath.resolve(outboxDispatchDir(paths, id));
      expect(outboxDir.startsWith(nodePath.resolve(paths.outbox) + nodePath.sep)).toBe(true);
    }
  });
});

describe('ensureWorkspace', () => {
  it('creates every directory and is idempotent', async () => {
    const root = nodePath.resolve('/nonexistent-proj-fixture');
    const paths = resolveWorkspace(root);
    await ensureWorkspace(paths);
    await ensureWorkspace(paths);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(paths.root);
    expect(entries.sort()).toEqual(['inbox', 'logs', 'outbox', 'receipts', 'submit']);
  });
});
