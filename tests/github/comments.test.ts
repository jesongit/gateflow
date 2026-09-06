import { describe, expect, it } from 'vitest';
import {
  DISPATCH_ID_COMMENT_PATTERN,
  buildCompletionReportBody,
  buildPlanCommentBody,
  buildTrackerCommentBody,
  findDispatchIdInComment,
  findTrackerStatus,
  setTrackerStatus,
} from '../../src/github/comments';

/*
 * Offline tests for Driver protocol-comment assembly. Every expected body
 * below is written out in full so a change in the frozen layout cannot slip
 * through unnoticed.
 */

const PLAN_MARKER = '<!-- ai-workflow:plan:v1 -->';
const TRACKER_MARKER = '<!-- ai-workflow:execution-tracker:v1 -->';
const COMPLETION_MARKER = '<!-- ai-workflow:completion-report:v1 -->';
const DISPATCH_01 = 'gf_r1_i2_consumer_01';
const DISPATCH_EXE = 'gf_r1_i2_executor_p5';
const dispatchComment = (id: string) => `<!-- gateflow:dispatch-id: ${id} -->`;

describe('comment body builders', () => {
  it('buildPlanCommentBody starts with the exact marker line and carries the dispatch-id comment', () => {
    const body = buildPlanCommentBody('  \n# Plan\n\nDo it.\n\n', DISPATCH_01);
    expect(body).toBe(
      `${PLAN_MARKER}\n\n${dispatchComment(DISPATCH_01)}\n\n# Plan\n\nDo it.\n`,
    );
  });

  it('buildPlanCommentBody trims surrounding whitespace of the plan markdown', () => {
    const body = buildPlanCommentBody('   ', DISPATCH_01);
    expect(body).toBe(`${PLAN_MARKER}\n\n${dispatchComment(DISPATCH_01)}\n\n\n`);
  });

  it('buildTrackerCommentBody contains the exact machine Status line and trimmed progress', () => {
    const body = buildTrackerCommentBody({
      dispatchId: DISPATCH_EXE,
      issueNumber: 2,
      status: 'In Progress',
      progressMarkdown: '  did stuff  ',
    });
    expect(body).toBe(
      `${TRACKER_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}\n\n**Status:** In Progress\n\ndid stuff\n`,
    );
    expect(body).toContain('**Status:** In Progress');
  });

  it('buildTrackerCommentBody supports the Blocked status and omits empty progress cleanly', () => {
    const blocked = buildTrackerCommentBody({
      dispatchId: DISPATCH_EXE,
      issueNumber: 2,
      status: 'Blocked',
      progressMarkdown: '',
    });
    expect(blocked).toBe(
      `${TRACKER_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}\n\n**Status:** Blocked\n`,
    );
  });

  it('buildCompletionReportBody starts with the completion marker and trims the report', () => {
    const body = buildCompletionReportBody('  done\n\nall green  ', DISPATCH_EXE);
    expect(body).toBe(
      `${COMPLETION_MARKER}\n\n${dispatchComment(DISPATCH_EXE)}\n\ndone\n\nall green\n`,
    );
  });
});

describe('setTrackerStatus', () => {
  it('replaces the status line and keeps every other byte identical', () => {
    const body = [
      TRACKER_MARKER,
      '',
      dispatchComment(DISPATCH_EXE),
      '',
      '**Status:** In Progress',
      '',
      'step 1 done',
      '',
    ].join('\n');
    const next = setTrackerStatus(body, 'Blocked');
    expect(next).toBe(
      [
        TRACKER_MARKER,
        '',
        dispatchComment(DISPATCH_EXE),
        '',
        '**Status:** Blocked',
        '',
        'step 1 done',
        '',
      ].join('\n'),
    );
  });

  it('ignores **Status:** lines inside code fences (first outside-fence line wins)', () => {
    const body = [
      TRACKER_MARKER,
      '',
      dispatchComment(DISPATCH_EXE),
      '',
      '```markdown',
      '**Status:** Completed',
      '```',
      '',
      '**Status:** In Progress',
      '',
      'working',
    ].join('\n');
    const next = setTrackerStatus(body, 'Blocked');
    expect(next).toContain('**Status:** Completed'); // fenced text untouched
    expect(next).not.toContain('**Status:** In Progress');
    expect(next.split('\n').filter((line) => line === '**Status:** Blocked')).toHaveLength(1);
  });

  it('replaces only the FIRST status line when several exist outside fences', () => {
    const body = '**Status:** Blocked\nmid\n**Status:** In Progress\n';
    const next = setTrackerStatus(body, 'Blocked');
    expect(next).toBe('**Status:** Blocked\nmid\n**Status:** In Progress\n');
  });

  it('preserves original line endings (\\r\\n) byte-identically', () => {
    const body = 'a\r\n**Status:** Blocked\r\nb';
    expect(setTrackerStatus(body, 'In Progress')).toBe('a\r\n**Status:** In Progress\r\nb');
  });

  it('keeps the indentation of a replaced status line', () => {
    const body = 'intro\n  **Status:** Blocked\nend';
    expect(setTrackerStatus(body, 'In Progress')).toBe('intro\n  **Status:** In Progress\nend');
  });

  it('inserts a status line right after the dispatch-id comment when absent', () => {
    const body = [TRACKER_MARKER, '', dispatchComment(DISPATCH_EXE), '', 'no status yet'].join('\n');
    const next = setTrackerStatus(body, 'In Progress');
    expect(next).toBe(
      [TRACKER_MARKER, '', dispatchComment(DISPATCH_EXE), '**Status:** In Progress', '', 'no status yet'].join('\n'),
    );
  });

  it('inserts a status line right after the marker line when no dispatch-id comment exists', () => {
    const body = `${TRACKER_MARKER}\n\nplain progress`;
    const next = setTrackerStatus(body, 'Blocked');
    expect(next).toBe(`${TRACKER_MARKER}\n**Status:** Blocked\n\nplain progress`);
  });

  it('prepends a status line when neither dispatch-id nor marker exists (never throws)', () => {
    expect(setTrackerStatus('just text', 'Blocked')).toBe('**Status:** Blocked\njust text');
    expect(setTrackerStatus('', 'In Progress')).toBe('**Status:** In Progress\n');
  });
});

describe('dispatch-id comment detection', () => {
  it('DISPATCH_ID_COMMENT_PATTERN captures the frozen dispatch_id shape', () => {
    expect(
      DISPATCH_ID_COMMENT_PATTERN.test(dispatchComment('gf_r123_i42_consumer_01')),
    ).toBe(true);
    expect(
      DISPATCH_ID_COMMENT_PATTERN.test(dispatchComment('gf_r1_i2_executor_p3472198451')),
    ).toBe(true);
    expect(DISPATCH_ID_COMMENT_PATTERN.test(dispatchComment('gf_r1_i2_producer_01'))).toBe(false);
    expect(DISPATCH_ID_COMMENT_PATTERN.test(dispatchComment('hello'))).toBe(false);
  });

  it('findDispatchIdInComment accepts valid ids, even inline among other text', () => {
    expect(
      findDispatchIdInComment(`see below\n${dispatchComment('gf_r123_i42_consumer_01')}\nend`),
    ).toBe('gf_r123_i42_consumer_01');
    expect(
      findDispatchIdInComment(`prefix ${dispatchComment('gf_r1_i2_executor_p3472198451')} suffix`),
    ).toBe('gf_r1_i2_executor_p3472198451');
  });

  it('findDispatchIdInComment rejects junk', () => {
    expect(findDispatchIdInComment(dispatchComment('gf_r_i42_consumer_01'))).toBeNull(); // missing repo digits
    expect(findDispatchIdInComment(dispatchComment('not-a-dispatch'))).toBeNull();
    expect(findDispatchIdInComment('no comment here')).toBeNull();
    expect(findDispatchIdInComment('')).toBeNull();
  });
});

describe('findTrackerStatus', () => {
  it('delegates to the gate parser and returns the machine value', () => {
    expect(findTrackerStatus('x\n**Status:** Blocked\n')).toBe('Blocked');
    expect(findTrackerStatus('**Status:** In Progress\nwork\n')).toBe('In Progress');
    expect(findTrackerStatus('```\n**Status:** Blocked\n```\n**Status:** Completed')).toBe(
      'Completed',
    );
  });

  it('returns null for unknown values, fenced-only status lines, and absent status', () => {
    expect(findTrackerStatus('**Status:** pending review')).toBeNull();
    expect(findTrackerStatus('```\n**Status:** Blocked\n```')).toBeNull();
    expect(findTrackerStatus('no status line')).toBeNull();
  });
});
