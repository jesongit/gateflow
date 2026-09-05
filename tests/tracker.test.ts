import { describe, expect, it } from 'vitest';
import { parseTrackerStatus, TRACKER_STATUSES } from '../src/tracker';

const TRACKER_BODY = [
  '<!-- ai-workflow:execution-tracker:v1 -->',
  '',
  '## Execution Tracker',
  '',
  '**Status:** In Progress',
  '',
  '### Phase 1',
  '',
  '- [ ] implement the downloader',
].join('\n');

describe('tracker Status machine-value parsing (Phase 6, protocol 2.1 T4/T5)', () => {
  it('freezes the three machine values', () => {
    expect(TRACKER_STATUSES).toEqual(['In Progress', 'Blocked', 'Completed']);
  });

  it('parses the three machine values exactly', () => {
    for (const status of TRACKER_STATUSES) {
      expect(parseTrackerStatus(`**Status:** ${status}`)).toEqual({ kind: 'valid', status });
    }
  });

  it('parses the Status line out of a full tracker body', () => {
    expect(parseTrackerStatus(TRACKER_BODY)).toEqual({ kind: 'valid', status: 'In Progress' });
  });

  it('tolerates extra whitespace around the value and line indentation', () => {
    expect(parseTrackerStatus('**Status:**   Blocked   ')).toEqual({
      kind: 'valid',
      status: 'Blocked',
    });
    expect(parseTrackerStatus('  **Status:** Blocked')).toEqual({
      kind: 'valid',
      status: 'Blocked',
    });
    expect(parseTrackerStatus('**Status:**Completed')).toEqual({
      kind: 'valid',
      status: 'Completed',
    });
  });

  it('uses the first Status line when several exist', () => {
    expect(parseTrackerStatus('**Status:** Blocked\nlater: **Status:** In Progress')).toEqual({
      kind: 'valid',
      status: 'Blocked',
    });
  });

  it('rejects non-machine values without guessing (case-sensitive)', () => {
    expect(parseTrackerStatus('**Status:** in progress')).toEqual({
      kind: 'unknown',
      raw: 'in progress',
    });
    expect(parseTrackerStatus('**Status:** BLOCKED')).toEqual({ kind: 'unknown', raw: 'BLOCKED' });
    expect(parseTrackerStatus('**Status:** Done')).toEqual({ kind: 'unknown', raw: 'Done' });
    expect(parseTrackerStatus('**Status:**')).toEqual({ kind: 'unknown', raw: '' });
  });

  it('ignores Status lines inside fenced code blocks (quoted templates never trigger)', () => {
    expect(parseTrackerStatus('Example:\n\n```md\n**Status:** Blocked\n```\n')).toEqual({
      kind: 'absent',
    });
    // A fenced occurrence does not shadow a real one outside the fence.
    expect(
      parseTrackerStatus('```\n**Status:** Blocked\n```\n\n**Status:** In Progress'),
    ).toEqual({ kind: 'valid', status: 'In Progress' });
  });

  it('requires the exact bold `**Status:**` label at the start of the line', () => {
    expect(parseTrackerStatus('Status: Blocked')).toEqual({ kind: 'absent' });
    expect(parseTrackerStatus('__Status:** Blocked')).toEqual({ kind: 'absent' });
    expect(parseTrackerStatus('**status:** Blocked')).toEqual({ kind: 'absent' });
    // A list item does not own the Status line: the template keeps the field
    // at the top level, and the gate never scrapes look-alikes.
    expect(parseTrackerStatus('- **Status:** Blocked')).toEqual({ kind: 'absent' });
    expect(parseTrackerStatus('**Status:** Blocked (since yesterday)')).toEqual({
      kind: 'unknown',
      raw: 'Blocked (since yesterday)',
    });
  });

  it('returns absent for bodies without any Status line', () => {
    expect(parseTrackerStatus('just some progress notes')).toEqual({ kind: 'absent' });
    expect(parseTrackerStatus('')).toEqual({ kind: 'absent' });
    expect(parseTrackerStatus(null)).toEqual({ kind: 'absent' });
    expect(parseTrackerStatus(undefined)).toEqual({ kind: 'absent' });
  });
});
