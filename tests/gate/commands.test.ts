import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/gate/commands';
import { COMMANDS } from '../../src/gate/protocol';

describe('strict command parsing (protocol 3.1)', () => {
  it('accepts the frozen commands when the comment matches the whole body', () => {
    expect(parseCommand('/ai-plan')).toEqual({ command: COMMANDS.aiPlan, args: null });
    expect(parseCommand('/cancel')).toEqual({ command: COMMANDS.cancel, args: null });
  });

  it('parses the V1 anchored /approve <plan-comment-id> (protocol 3.2 / 3.4)', () => {
    expect(parseCommand('/approve 3472198451')).toEqual({
      command: COMMANDS.approve,
      args: { planCommentId: 3472198451 },
    });
    expect(parseCommand('/approve 123')).toEqual({
      command: COMMANDS.approve,
      args: { planCommentId: 123 },
    });
  });

  it('tolerates leading/trailing whitespace (trim before match)', () => {
    expect(parseCommand('  /approve 123  ')).toEqual({
      command: '/approve',
      args: { planCommentId: 123 },
    });
    expect(parseCommand('\t/ai-plan\n')).toEqual({ command: '/ai-plan', args: null });
    expect(parseCommand('/cancel\r\n')).toEqual({ command: '/cancel', args: null });
  });

  it('V1 breaking change: a bare /approve is no longer a command (normal comment, rule 7)', () => {
    expect(parseCommand('/approve')).toBeNull();
    expect(parseCommand('  /approve  ')).toBeNull(); // trims to the bare command
    expect(parseCommand('/approve\n')).toBeNull();
  });

  it('rejects substring and embedded occurrences (no includes matching)', () => {
    expect(parseCommand('请看 /approve 123')).toBeNull();
    expect(parseCommand('x/approve 123')).toBeNull();
    expect(parseCommand('text /approve text')).toBeNull();
    expect(parseCommand('/approve/approve')).toBeNull();
    expect(parseCommand('/approve/approve 123')).toBeNull();
    expect(parseCommand('/approve please')).toBeNull();
    expect(parseCommand('/approve 123 please')).toBeNull();
    expect(parseCommand('/approve\nsomeone else')).toBeNull();
  });

  it('is case-sensitive', () => {
    expect(parseCommand('/Approve')).toBeNull();
    expect(parseCommand('/Approve 123')).toBeNull();
    expect(parseCommand('/APPROVE 123')).toBeNull();
    expect(parseCommand('/Cancel')).toBeNull();
    expect(parseCommand('/AI-PLAN')).toBeNull();
  });

  it('rejects malformed /approve arguments (normal comments, rule 7)', () => {
    expect(parseCommand('/approve abc')).toBeNull(); // non-numeric argument
    expect(parseCommand('/approve 12abc')).toBeNull(); // trailing garbage in the token
    expect(parseCommand('/approve 123 extra')).toBeNull(); // more than one argument
    expect(parseCommand('/approve 12.5')).toBeNull(); // not decimal digits
    expect(parseCommand('/approve -5')).toBeNull(); // sign is not a digit
    expect(parseCommand('/approve 0x10')).toBeNull(); // hex is not decimal digits
    expect(parseCommand('/approve 123 456')).toBeNull();
    expect(parseCommand('/approve ')).toBeNull(); // trims to the bare command
    expect(parseCommand('/approve\t123')).toBeNull(); // tab is not the single required space
    expect(parseCommand('/approve  123')).toBeNull(); // double space after the command word
  });

  it('rejects a multi-line /approve (`.` never crosses newlines, anchored match)', () => {
    expect(parseCommand('/approve 123\n456')).toBeNull();
    expect(parseCommand('/approve\n123')).toBeNull();
    expect(parseCommand('/approve 123\n/approve 123')).toBeNull();
  });

  it('rejects near-misses, punctuation and non-commands', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
    expect(parseCommand('approve')).toBeNull();
    expect(parseCommand('/ approve')).toBeNull();
    expect(parseCommand('/approve.')).toBeNull();
    expect(parseCommand('/ai-plant')).toBeNull();
    expect(parseCommand('/cancell')).toBeNull();
    expect(parseCommand('look at this feature request')).toBeNull();
  });

  it('parses /choose and /change since Phase 2 (anchored regexes, protocol 3.2)', () => {
    expect(parseCommand('/choose 1 B')).toEqual({
      command: COMMANDS.choose,
      args: { questionId: '1', choice: 'B' },
    });
    expect(parseCommand('/change 还需要考虑离线安装')).toEqual({
      command: COMMANDS.change,
      args: { text: '还需要考虑离线安装' },
    });
  });

  it('handles missing bodies defensively', () => {
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });
});

describe('/choose and /change strict parsing (Phase 2, protocol 3.2)', () => {
  it('parses /choose into exactly two non-whitespace arguments', () => {
    expect(parseCommand('/choose Q-12 option-A')).toEqual({
      command: '/choose',
      args: { questionId: 'Q-12', choice: 'option-A' },
    });
  });

  it('keeps the /change free text verbatim (untrusted data, protocol 3.3)', () => {
    expect(parseCommand('/change V1 暂时不要做自动更新, 只保留手动更新')).toEqual({
      command: '/change',
      args: { text: 'V1 暂时不要做自动更新, 只保留手动更新' },
    });
    expect(parseCommand('/change   spaced   out  ')).toEqual({
      command: '/change',
      args: { text: 'spaced   out' },
    });
  });

  it('tolerates surrounding whitespace for parameterized commands', () => {
    expect(parseCommand('  /choose 1 B  ')).toEqual({
      command: '/choose',
      args: { questionId: '1', choice: 'B' },
    });
    expect(parseCommand('\n/change hello\n')).toEqual({
      command: '/change',
      args: { text: 'hello' },
    });
  });

  it('rejects command-shaped bodies with malformed /choose arguments (normal comments, rule 7)', () => {
    expect(parseCommand('/choose')).toBeNull();
    expect(parseCommand('/choose 1')).toBeNull();
    expect(parseCommand('/choose 1 B C')).toBeNull();
    expect(parseCommand('/choose  1 B')).toBeNull(); // double space after the command word
    expect(parseCommand('/choose 1 ')).toBeNull();
  });

  it('rejects a bare /change and a multi-line /change (`.` never crosses newlines)', () => {
    expect(parseCommand('/change')).toBeNull();
    expect(parseCommand('/change   ')).toBeNull(); // trims to the bare command
    expect(parseCommand('/change line1\nline2')).toBeNull();
  });

  it('rejects embedded /choose and /change occurrences (anchored match only)', () => {
    expect(parseCommand('请 /choose 1 B')).toBeNull();
    expect(parseCommand('/choose 1 B thanks')).toBeNull();
    expect(parseCommand('please /change it')).toBeNull();
    expect(parseCommand('/change it\n/approve 123')).toBeNull();
  });
});
