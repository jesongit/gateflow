import { describe, expect, it } from 'vitest';
import {
  LABELS,
  STATES,
  TRANSITIONS,
  type Label,
  type State,
} from '../../src/gate/protocol';
import { aiLabelsIn, isLegalTransition, readSnapshot } from '../../src/gate/states';

describe('state snapshot reading', () => {
  it('filters ai:* labels out of a raw label list', () => {
    expect(aiLabelsIn(['bug', 'ai:review', 'help wanted', 'ai:ready'])).toEqual([
      'ai:review',
      'ai:ready',
    ]);
    expect(aiLabelsIn(['bug', 'enhancement'])).toEqual([]);
    expect(aiLabelsIn([])).toEqual([]);
  });

  it('classifies an issue without ai:* labels as outside the workflow', () => {
    expect(readSnapshot([])).toEqual({ status: 'outside' });
    expect(readSnapshot(['bug', 'P1'])).toEqual({ status: 'outside' });
  });

  it('classifies each ai:* label as the corresponding workflow state', () => {
    const pairs: Array<[Label, State]> = [
      [LABELS.planning, STATES.planning],
      [LABELS.review, STATES.review],
      [LABELS.ready, STATES.ready],
      [LABELS.working, STATES.working],
      [LABELS.blocked, STATES.blocked],
      [LABELS.done, STATES.done],
    ];
    for (const [label, state] of pairs) {
      expect(readSnapshot([label])).toEqual({ status: 'in-workflow', state, label });
    }
  });

  it('flags multiple ai:* labels as ambiguous (manual protocol violation)', () => {
    const snapshot = readSnapshot(['ai:review', 'ai:done', 'bug']);
    expect(snapshot).toEqual({ status: 'ambiguous', labels: ['ai:review', 'ai:done'] });
  });

  it('ignores case variants of non-ai labels but matches ai:* labels exactly', () => {
    expect(readSnapshot(['AI:REVIEW'])).toEqual({ status: 'outside' });
  });
});

describe('transition legality against the frozen table', () => {
  // Rebuild the expected set independently so a protocol.ts regression here
  // is caught against docs/protocol.md section 2.1.
  const legal = new Set<string>(
    TRANSITIONS.map((t) => `${String(t.from)}>${t.to}`),
  );

  const expected = new Set<string>([
    'null>PLANNING', // T0
    'PLANNING>REVIEW', // T1
    'REVIEW>READY', // T2
    'READY>WORKING', // T3
    'WORKING>BLOCKED', // T4
    'BLOCKED>WORKING', // T5
    'WORKING>DONE', // T6
  ]);

  it('matches the frozen table exactly (7 rows)', () => {
    expect(legal).toEqual(expected);
  });

  it('accepts every legal transition (from state or from outside)', () => {
    expect(isLegalTransition(null, STATES.planning)).toBe(true);
    expect(isLegalTransition(STATES.planning, STATES.review)).toBe(true);
    expect(isLegalTransition(STATES.review, STATES.ready)).toBe(true);
    expect(isLegalTransition(STATES.ready, STATES.working)).toBe(true);
    expect(isLegalTransition(STATES.working, STATES.blocked)).toBe(true);
    expect(isLegalTransition(STATES.blocked, STATES.working)).toBe(true);
    expect(isLegalTransition(STATES.working, STATES.done)).toBe(true);
  });

  it('rejects every other combination (exhaustive)', () => {
    const allStates = Object.values(STATES);
    for (const from of [null, ...allStates]) {
      for (const to of allStates) {
        const key = `${String(from)}>${to}`;
        expect(isLegalTransition(from, to)).toBe(expected.has(key));
      }
    }
  });

  it('rejects protocol 2.3 examples explicitly', () => {
    expect(isLegalTransition(STATES.planning, STATES.ready)).toBe(false); // skip REVIEW
    expect(isLegalTransition(STATES.review, STATES.working)).toBe(false); // not approved
    expect(isLegalTransition(STATES.review, STATES.done)).toBe(false);
    expect(isLegalTransition(STATES.ready, STATES.done)).toBe(false);
    expect(isLegalTransition(STATES.blocked, STATES.ready)).toBe(false);
    expect(isLegalTransition(STATES.done, STATES.working)).toBe(false); // terminal
    expect(isLegalTransition(STATES.review, STATES.planning)).toBe(false); // no back-to-planning
  });
});
