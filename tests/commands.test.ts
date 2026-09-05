import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/commands';
import { COMMANDS } from '../src/protocol';

describe('strict command parsing (protocol 3.1)', () => {
  it('accepts the three Phase 1 commands when the comment is exactly the command', () => {
    expect(parseCommand('/ai-plan')).toBe(COMMANDS.aiPlan);
    expect(parseCommand('/approve')).toBe(COMMANDS.approve);
    expect(parseCommand('/cancel')).toBe(COMMANDS.cancel);
  });

  it('tolerates leading/trailing whitespace (trim before match)', () => {
    expect(parseCommand('  /approve  ')).toBe('/approve');
    expect(parseCommand('\t/ai-plan\n')).toBe('/ai-plan');
    expect(parseCommand('/cancel\r\n')).toBe('/cancel');
  });

  it('rejects substring and embedded occurrences (no includes matching)', () => {
    expect(parseCommand('请看 /approve')).toBeNull();
    expect(parseCommand('x/approve')).toBeNull();
    expect(parseCommand('text /approve text')).toBeNull();
    expect(parseCommand('/approve/approve')).toBeNull();
    expect(parseCommand('/approve please')).toBeNull();
    expect(parseCommand('/approve\nsomeone else')).toBeNull();
  });

  it('is case-sensitive', () => {
    expect(parseCommand('/Approve')).toBeNull();
    expect(parseCommand('/APPROVE')).toBeNull();
    expect(parseCommand('/Cancel')).toBeNull();
    expect(parseCommand('/AI-PLAN')).toBeNull();
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

  it('treats /choose and /change as normal comments until Phase 2', () => {
    expect(parseCommand('/choose 1 B')).toBeNull();
    expect(parseCommand('/change 还需要考虑离线安装')).toBeNull();
  });

  it('handles missing bodies defensively', () => {
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });
});
