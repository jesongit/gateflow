/**
 * SECURITY — Area E: gate command attacks (docs/protocol.md §3.1, docs/
 * security.md §3/§5). Strict parsing + identity at the gate boundary:
 * parameter smuggling must parse as null (a normal comment → zero API
 * operations), and Trusted Agents must never hold command rights.
 */
import { describe, expect, it } from 'vitest';

import { parseCommand } from '../../src/gate/commands';
import { runGate } from '../../src/gate/gate';
import { LABELS } from '../../src/gate/protocol';
import {
  gateLogger,
  gateWriteCount,
  makeGateHarness,
  makeGateInput,
} from './helpers';

describe('E. gate command attacks (protocol §3.1: anchored or nothing)', () => {
  it('rejects /approve parameter smuggling: malformed arguments parse as null', () => {
    const smuggles = [
      '/approve 12 34', // two ids
      '/approve 12\n/evil', // multi-line piggyback
      '/approve -1', // negative id
      '/approve 1.5', // float id
      '/approve 12; rm -rf /', // command injection attempt
      '/approve 0x10', // hex id
      '/approve 12abc', // trailing junk
      '/approve  12', // double space (not the anchored single-space form)
      '/approve +12',
      '/approve 12#comment',
    ];
    for (const body of smuggles) {
      expect(parseCommand(body), JSON.stringify(body)).toBeNull();
    }
    // Control: the anchored form still parses after outer-whitespace trim.
    expect(parseCommand('  /approve 12\n')).toMatchObject({
      command: '/approve',
      args: { planCommentId: 12 },
    });
  });

  it('bare /approve is a normal comment in V1: parseCommand null, zero API operations', async () => {
    expect(parseCommand('/approve')).toBeNull();
    expect(parseCommand('   /approve   ')).toBeNull();

    const h = makeGateHarness({ labels: [LABELS.review] });
    const log = gateLogger();
    await runGate(makeGateInput({ commentBody: '/approve' }), h.client, log);

    expect(gateWriteCount(h)).toBe(0);
    expect(h.calls.addReaction).toEqual([]); // not even a 👎: not a command anymore
    expect(h.calls.getIssue).toBe(0);
    expect(h.calls.getLabels).toBe(0);
    expect(h.calls.listComments).toBe(0);
    expect(h.calls.getComment).toEqual([]);
  });

  it('smuggled /approve bodies trigger zero gate operations end-to-end', async () => {
    for (const body of ['/approve 12 34', '/approve 12\n/evil', '/approve -1', '/approve 1.5']) {
      const h = makeGateHarness({ labels: [LABELS.review] });
      const log = gateLogger();
      await runGate(makeGateInput({ commentBody: body }), h.client, log);

      expect(gateWriteCount(h), body).toBe(0);
      expect(h.calls.addReaction, body).toEqual([]); // silent: normal comment
      expect(h.calls.getIssue, body).toBe(0);
      expect(h.calls.getLabels, body).toBe(0);
      expect(h.calls.listComments, body).toBe(0);
      expect(h.calls.getComment, body).toEqual([]);
      expect(log.warnings, body).toEqual([]);
    }
  });

  it('rejects Trusted-Agent /approve: exactly one 👎, zero label writes, zero API reads', async () => {
    for (const actor of ['ci-bot', 'gateflow-driver[bot]']) {
      const h = makeGateHarness({ labels: [LABELS.review] });
      const log = gateLogger();
      await runGate(
        makeGateInput({
          actor,
          trustedAgentsInput: actor,
          commentBody: '/approve 5',
        }),
        h.client,
        log,
      );

      // Agents never command: the only write is the 👎 feedback reaction.
      expect(h.calls.addReaction, actor).toEqual([{ commentId: 9001, content: '-1' }]);
      expect(h.calls.addLabels, actor).toEqual([]);
      expect(h.calls.removeLabel, actor).toEqual([]);
      expect(h.calls.editComment, actor).toEqual([]);
      // Rejected before any API read: parse + permission happen first.
      expect(h.calls.getIssue, actor).toBe(0);
      expect(h.calls.getLabels, actor).toBe(0);
      expect(h.calls.listComments, actor).toBe(0);
      expect(h.calls.getComment, actor).toEqual([]);
      expect(log.warnings, actor).toEqual([]);
      expect(gateWriteCount(h), actor).toBe(1);
    }
  });
});
