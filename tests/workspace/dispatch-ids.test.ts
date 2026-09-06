import { describe, expect, it } from 'vitest';

import {
  DISPATCH_DIR_PATTERN,
  HUMAN_ONLY_RESULTS,
  ROLE_RESULT_WHITELIST,
  ROLE_STATE_WHITELIST,
  makeConsumerDispatchId,
  makeExecutorDispatchId,
  parseDispatchId,
} from '../../src/workspace/protocol';

describe('dispatch id construction', () => {
  it('builds zero-padded consumer ids', () => {
    expect(makeConsumerDispatchId(1, 2, 1)).toBe('gf_r1_i2_consumer_01');
    expect(makeConsumerDispatchId(123, 42, 9)).toBe('gf_r123_i42_consumer_09');
  });

  it('keeps rounds >= 100 in plain decimal form', () => {
    expect(makeConsumerDispatchId(1, 2, 12)).toBe('gf_r1_i2_consumer_12');
    expect(makeConsumerDispatchId(1, 2, 99)).toBe('gf_r1_i2_consumer_99');
    expect(makeConsumerDispatchId(1, 2, 100)).toBe('gf_r1_i2_consumer_100');
  });

  it('binds executor ids to the plan comment id', () => {
    expect(makeExecutorDispatchId(1, 2, 3472198451)).toBe('gf_r1_i2_executor_p3472198451');
  });

  it('rejects non-positive or non-integer inputs', () => {
    expect(() => makeConsumerDispatchId(1, 2, 0)).toThrow(RangeError);
    expect(() => makeConsumerDispatchId(0, 2, 1)).toThrow(RangeError);
    expect(() => makeConsumerDispatchId(1, 2, 1.5)).toThrow(RangeError);
    expect(() => makeExecutorDispatchId(1, 2, 0)).toThrow(RangeError);
    expect(() => makeExecutorDispatchId(1, 2, Number.NaN)).toThrow(RangeError);
  });
});

describe('dispatch id parsing', () => {
  it('round-trips constructed ids', () => {
    const consumer = makeConsumerDispatchId(123, 42, 7);
    expect(parseDispatchId(consumer)).toEqual({
      repositoryId: 123,
      issueNumber: 42,
      role: 'consumer',
      revision: '07',
    });

    const executor = makeExecutorDispatchId(123, 42, 3472198451);
    expect(parseDispatchId(executor)).toEqual({
      repositoryId: 123,
      issueNumber: 42,
      role: 'executor',
      revision: 'p3472198451',
    });
  });

  it('rejects garbage and traversal attempts', () => {
    expect(parseDispatchId('garbage')).toBeNull();
    expect(parseDispatchId('')).toBeNull();
    expect(parseDispatchId('gf_r1_i2_consumer')).toBeNull();
    expect(parseDispatchId('gf_r1_i2_consumer_01x')).toBeNull();
    expect(parseDispatchId('gf_r1_i2_human_01')).toBeNull();
    expect(parseDispatchId('gf_r1_i2_consumer_01/../../etc')).toBeNull();
    expect(parseDispatchId('..%2Fgf_r1_i2_consumer_01')).toBeNull();
    expect(parseDispatchId('gf_rx_i2_consumer_01')).toBeNull();
  });
});

describe('frozen whitelists', () => {
  it('exposes the human-only actions', () => {
    expect([...HUMAN_ONLY_RESULTS]).toEqual(['approve', 'ready', 'cancel', 'human-close']);
  });

  it('matches the role output whitelist of docs §4', () => {
    expect(ROLE_RESULT_WHITELIST.consumer).toEqual(['plan_ready', 'question', 'failed']);
    expect(ROLE_RESULT_WHITELIST.executor).toEqual(['completed', 'blocked', 'question', 'failed']);
    expect(ROLE_STATE_WHITELIST.consumer).toEqual(['working', 'blocked', 'failed']);
    expect(ROLE_STATE_WHITELIST.executor).toEqual(['working', 'blocked', 'failed']);
  });

  it('anchors the frozen directory grammar', () => {
    expect(DISPATCH_DIR_PATTERN.test('gf_r123_i42_consumer_01')).toBe(true);
    expect(DISPATCH_DIR_PATTERN.test('gf_r1_i2_executor_p3472198451')).toBe(true);
    expect(DISPATCH_DIR_PATTERN.test('gf_r1_i2_consumer_01 ')).toBe(false);
    expect(DISPATCH_DIR_PATTERN.test('gf_r1_i2_consumer_+1')).toBe(false);
    expect(DISPATCH_DIR_PATTERN.test('gf_r1_i2_consumer_0x1')).toBe(false);
  });
});
