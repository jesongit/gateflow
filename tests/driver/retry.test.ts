/**
 * Retry tests (src/driver/retry.ts → src/driver/dedup.ts): offline receipt
 * clearing semantics — hostile ids never touch the filesystem, missing
 * receipts are a no-op, clearing re-enables dispatch.
 */
import { describe, expect, it } from 'vitest';

import { retryDispatch } from '../../src/driver/retry';
import { clearReceipt } from '../../src/driver/dedup';
import { readCurrent, writeCurrent } from '../../src/workspace/inbox';
import { readReceipt, writeReceipt } from '../../src/workspace/outbox';
import { makeWorkspace } from './helpers';

const ID = 'gf_r123_i7_w000000000007_consumer_01';

describe('retryDispatch / clearReceipt', () => {
  it('clears an existing receipt so the next cycle may re-dispatch', async () => {
    const fixture = await makeWorkspace();
    try {
      await writeReceipt(fixture.paths, { dispatch_id: ID, status: 'failed', attempts: 3 });
      expect(await retryDispatch(fixture.paths, ID)).toBe(true);
      expect(await readReceipt(fixture.paths, ID)).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('returns false for a missing receipt (nothing to clear)', async () => {
    const fixture = await makeWorkspace();
    try {
      expect(await retryDispatch(fixture.paths, ID)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects hostile ids without touching the filesystem', async () => {
    const fixture = await makeWorkspace();
    try {
      for (const hostile of ['..', '../escape', 'gf_r1_i2_hacker_x', 'sub/dir/name', '']) {
        expect(await retryDispatch(fixture.paths, hostile)).toBe(false);
      }
      expect(await clearReceipt(fixture.paths, '..')).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('clearing a receipt leaves current.json alone (pointer is not state)', async () => {
    const fixture = await makeWorkspace();
    try {
      await writeReceipt(fixture.paths, { dispatch_id: ID, status: 'failed', attempts: 1 });
      await writeCurrent(fixture.paths, {
        schema: 2,
        dispatch_id: ID,
        role: 'consumer',
        issue_number: 7,
        updated_at: '2026-09-06T17:00:00Z',
      });
      await retryDispatch(fixture.paths, ID);
      expect((await readCurrent(fixture.paths))?.dispatch_id).toBe(ID);
    } finally {
      await fixture.cleanup();
    }
  });
});
