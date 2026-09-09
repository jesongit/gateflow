import { describe, expect, it } from 'vitest';

import {
  expectedExecuteDispatchId,
  expectedPlanDispatchId,
  findDispatchId,
  inspectDispatchId,
  validateExpectedDispatchId,
} from '../../src/gate/execution-chain';

const EPOCH = 'wf_abc123def456';
const PLAN = 'gf_r123_i7_wabc123def456_plan_01';
const EXECUTE = 'gf_r123_i7_wabc123def456_execute_p347';
const anchor = (id: string): string => `<!-- gateflow:dispatch-id: ${id} -->`;

describe('Gate execution-chain dispatch binding', () => {
  it('uses the current Workspace task-id grammar and builds canonical ids', () => {
    expect(expectedPlanDispatchId(123, 7, EPOCH, 1)).toBe(PLAN);
    expect(expectedExecuteDispatchId(123, 7, EPOCH, 347)).toBe(EXECUTE);
    expect(inspectDispatchId(PLAN)).toMatchObject({
      ok: true,
      binding: {
        repositoryId: 123,
        issueNumber: 7,
        workflowEpoch: EPOCH,
        mode: 'plan',
        revision: '01',
      },
    });
  });

  it('rejects wrong mode revisions, alternate spellings, and mismatched ids', () => {
    expect(inspectDispatchId('gf_r123_i7_wabc123def456_plan_p347').ok).toBe(false);
    expect(inspectDispatchId('gf_r123_i7_wabc123def456_execute_01').ok).toBe(false);
    expect(inspectDispatchId('gf_r0123_i7_wabc123def456_plan_01').ok).toBe(false);
    expect(validateExpectedDispatchId('gf_r123_i8_wabc123def456_plan_01', PLAN).ok).toBe(false);
  });

  it('requires exactly one line-owned anchor outside fenced code', () => {
    expect(findDispatchId(`marker\n${anchor(PLAN)}\nbody`)).toBe(PLAN);
    expect(findDispatchId(`\`\`\`\n${anchor(PLAN)}\n\`\`\``)).toBeNull();
    expect(findDispatchId(`${anchor(PLAN)}\n${anchor(PLAN)}`)).toBeNull();
    expect(findDispatchId(`prefix ${anchor(PLAN)}`)).toBe(PLAN);
  });
});
