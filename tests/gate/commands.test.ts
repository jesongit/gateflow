/**
 * Command parsing (src/gate/commands.ts): V1 commands are /ai-plan,
 * /approve <id>, /change <text>, /cancel. /choose is GONE; a bare /approve
 * is a normal comment.
 */
import { describe, expect, it } from 'vitest';

import { parseCommand } from '../../src/gate/commands';

describe('parseCommand — exact commands', () => {
  it('parses /ai-plan and tolerates surrounding whitespace', () => {
    expect(parseCommand('/ai-plan')).toEqual({ command: '/ai-plan', args: null });
    expect(parseCommand('  /ai-plan  \n')).toEqual({ command: '/ai-plan', args: null });
  });

  it('parses /cancel', () => {
    expect(parseCommand('/cancel')).toEqual({ command: '/cancel', args: null });
  });

  it('never matches substrings or extra words', () => {
    expect(parseCommand('please /ai-plan')).toBeNull();
    expect(parseCommand('/ai-plan now')).toBeNull();
    expect(parseCommand('/cancel all')).toBeNull();
  });
});

describe('parseCommand — /approve <plan-comment-id>', () => {
  it('parses the decimal plan comment id', () => {
    expect(parseCommand('/approve 1728394951')).toEqual({
      command: '/approve',
      args: { planCommentId: 1728394951 },
    });
  });

  it('rejects a bare /approve (it is a normal comment now)', () => {
    expect(parseCommand('/approve')).toBeNull();
  });

  it('rejects malformed arguments', () => {
    expect(parseCommand('/approve abc')).toBeNull();
    expect(parseCommand('/approve 123 extra')).toBeNull();
    expect(parseCommand('/approve 123\n456')).toBeNull();
    expect(parseCommand('/approve 999999999999999999999999999999')).toBeNull();
    expect(parseCommand('/approve 0')).toBeNull();
  });
});

describe('parseCommand — /change <feedback>', () => {
  it('parses free text verbatim (trimmed)', () => {
    expect(parseCommand('/change 用方案 B，减少状态数量')).toEqual({
      command: '/change',
      args: { text: '用方案 B，减少状态数量' },
    });
  });

  it('rejects a bare /change and multi-line bodies', () => {
    expect(parseCommand('/change')).toBeNull();
    expect(parseCommand('/change 第一行\n第二行')).toBeNull();
  });

  it('is case-sensitive: /CHANGE is not a command', () => {
    expect(parseCommand('/CHANGE do it')).toBeNull();
  });
});

describe('parseCommand — removed /choose (V1 merged into /change)', () => {
  it('/choose bodies are plain comments now', () => {
    expect(parseCommand('/choose q1 yes')).toBeNull();
  });

  it('normal comments never parse', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    expect(parseCommand('hello world')).toBeNull();
  });
});
