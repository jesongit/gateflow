/**
 * Workflow epoch identity tests (hardening Phase 3.1):
 * CSPRNG-shaped, never derived from time/counters, round-trippable through
 * the dispatch-id epoch code.
 */
import { describe, expect, it } from 'vitest';

import { epochCode, epochFromCode, isWorkflowEpoch, newWorkflowEpoch } from '../../src/protocol/epoch';

describe('newWorkflowEpoch', () => {
  it('produces well-formed epochs', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(isWorkflowEpoch(newWorkflowEpoch())).toBe(true);
    }
  });

  it('does not repeat across a reasonable sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(newWorkflowEpoch());
    }
    expect(seen.size).toBe(200);
  });
});

describe('epochCode round trip', () => {
  it('strips and restores the wf_ prefix', () => {
    const epoch = newWorkflowEpoch();
    const code = epochCode(epoch);
    expect(code).not.toBeNull();
    expect(code).toHaveLength(12);
    expect(epochFromCode(code ?? '')).toBe(epoch);
  });

  it('rejects malformed epochs', () => {
    expect(epochCode('not-an-epoch')).toBeNull();
    expect(epochCode('wf_short')).toBeNull();
    expect(epochCode('wf_UPPERCASE')).toBeNull();
    expect(epochFromCode('UPPERCASE789')).toBeNull();
  });

  it('isWorkflowEpoch rejects non-strings and junk', () => {
    expect(isWorkflowEpoch(42)).toBe(false);
    expect(isWorkflowEpoch('wf_0123456789ab')).toBe(true); // 12 chars
    expect(isWorkflowEpoch('wf_0123456789a')).toBe(false); // 11 chars
    expect(isWorkflowEpoch('wf_0123456789abc')).toBe(false); // 13 chars
    expect(isWorkflowEpoch('wf_0123456789A_')).toBe(false); // uppercase/junk
  });
});
