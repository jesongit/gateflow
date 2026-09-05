import { describe, expect, it } from 'vitest';
import {
  ALL_COMMANDS,
  ALL_LABELS,
  ALL_MARKERS,
  COMMANDS,
  KINDS,
  LABELS,
  LABEL_COLORS,
  LABEL_TO_STATE,
  MARKERS,
  MATURITY_HINTS,
  SCHEMA_VERSION,
  STATES,
  TRANSITIONS,
} from '../src/protocol';
import { GATE_VERSION } from '../src/index';

describe('Phase 0 protocol freeze (docs/protocol.md <-> src/protocol.ts)', () => {
  it('freezes the schema version', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('freezes the six workflow labels', () => {
    expect(ALL_LABELS).toEqual([
      'ai:planning',
      'ai:review',
      'ai:ready',
      'ai:working',
      'ai:blocked',
      'ai:done',
    ]);
  });

  it('maps every label to exactly one state', () => {
    expect(Object.keys(LABEL_TO_STATE)).toHaveLength(6);
    expect(LABEL_TO_STATE[LABELS.blocked]).toBe(STATES.blocked);
    expect(LABEL_TO_STATE[LABELS.done]).toBe(STATES.done);
  });

  it('freezes the five commands', () => {
    expect(Object.values(COMMANDS)).toEqual([
      '/ai-plan',
      '/approve',
      '/choose',
      '/change',
      '/cancel',
    ]);
    expect(ALL_COMMANDS).toHaveLength(5);
  });

  it('freezes the four comment markers with exact v1 syntax', () => {
    expect(MARKERS.append).toBe('<!-- ai-workflow:append:v1 -->');
    expect(MARKERS.plan).toBe('<!-- ai-workflow:plan:v1 -->');
    expect(MARKERS.executionTracker).toBe('<!-- ai-workflow:execution-tracker:v1 -->');
    expect(MARKERS.completionReport).toBe('<!-- ai-workflow:completion-report:v1 -->');
    expect(ALL_MARKERS).toHaveLength(4);
  });

  it('freezes the state machine transition table (7 legal transitions)', () => {
    expect(TRANSITIONS).toEqual([
      { from: null, to: STATES.planning }, // T0
      { from: STATES.planning, to: STATES.review }, // T1
      { from: STATES.review, to: STATES.ready }, // T2
      { from: STATES.ready, to: STATES.working }, // T3
      { from: STATES.working, to: STATES.blocked }, // T4
      { from: STATES.blocked, to: STATES.working }, // T5
      { from: STATES.working, to: STATES.done }, // T6
    ]);
  });

  it('freezes kind and maturity_hint enums', () => {
    expect(KINDS).toEqual(['feature', 'bug', 'refactor', 'docs', 'chore']);
    expect(MATURITY_HINTS).toEqual(['requirement', 'direction', 'solution', 'execution_plan']);
  });

  it('suggests a color for every label (bootstrap, Phase 8)', () => {
    for (const label of ALL_LABELS) {
      expect(LABEL_COLORS[label]).toMatch(/^[0-9a-f]{6}$/);
    }
  });

  it('has a gate entry stub with a version', () => {
    expect(GATE_VERSION).toBe('0.0.1');
  });
});
