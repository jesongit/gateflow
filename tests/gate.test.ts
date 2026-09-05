import { describe, expect, it, vi } from 'vitest';
import { runGate, type GateInput, type GateLogger } from '../src/gate';
import type { GitHubClient, IssueRef } from '../src/github';
import { LABELS } from '../src/protocol';

/* ---------------------------------------------------------------- helpers */

interface Harness {
  client: GitHubClient;
  calls: {
    order: string[];
    getIssue: number;
    getLabels: number;
    addLabels: Array<{ labels: string[] }>;
    removeLabel: Array<{ label: string }>;
    addReaction: Array<{ commentId: number; content: string }>;
    editComment: Array<{ commentId: number; body: string }>;
  };
  /** Labels as returned by getIssue (the "payload-era" snapshot). */
  issueLabels: string[];
  /** Labels as returned by getLabels (the fresh re-read the gate must use). */
  labelStore: string[];
  issueState: string;
  setLabelStore(labels: string[]): void;
}

function makeHarness(options?: {
  labels?: string[];
  state?: string;
  actor?: string;
  trustedHumans?: string;
  trustedAgents?: string;
}): Harness {
  const h: Harness = {
    calls: {
      order: [],
      getIssue: 0,
      getLabels: 0,
      addLabels: [],
      removeLabel: [],
      addReaction: [],
      editComment: [],
    },
    issueLabels: [...(options?.labels ?? [])],
    labelStore: [...(options?.labels ?? [])],
    issueState: options?.state ?? 'open',
    setLabelStore(labels: string[]) {
      h.labelStore = [...labels];
    },
    client: {
      getIssue: vi.fn(async () => {
        h.calls.getIssue += 1;
        return { state: h.issueState, labels: [...h.issueLabels] };
      }),
      getLabels: vi.fn(async () => {
        h.calls.getLabels += 1;
        return [...h.labelStore];
      }),
      addLabels: vi.fn(async (_ref: IssueRef, labels: string[]) => {
        h.calls.order.push('addLabels');
        h.calls.addLabels.push({ labels: [...labels] });
        h.labelStore = [...new Set([...h.labelStore, ...labels])];
      }),
      removeLabel: vi.fn(async (_ref: IssueRef, label: string) => {
        h.calls.order.push('removeLabel');
        h.calls.removeLabel.push({ label });
        h.labelStore = h.labelStore.filter((l) => l !== label);
      }),
      addReaction: vi.fn(async (_ref: IssueRef, commentId: number, content: string) => {
        h.calls.addReaction.push({ commentId, content });
      }),
      editComment: vi.fn(async (_ref: IssueRef, commentId: number, body: string) => {
        h.calls.editComment.push({ commentId, body });
      }),
    },
  };
  return h;
}

function makeLogger() {
  return {
    infos: [] as string[],
    warnings: [] as string[],
    info(message: string) {
      this.infos.push(message);
    },
    warning(message: string) {
      this.warnings.push(message);
    },
  } satisfies GateLogger & { infos: string[]; warnings: string[] };
}

function makeInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    eventName: 'issue_comment',
    eventAction: 'created',
    actor: 'owner-user',
    repoOwner: 'owner-user',
    repo: 'demo',
    issueNumber: 7,
    commentId: 9001,
    commentBody: '/approve',
    trustedHumansInput: '',
    trustedAgentsInput: '',
    ...overrides,
  };
}

/** Every write operation the gate could ever perform. */
function writeCount(h: Harness): number {
  return (
    h.calls.addLabels.length +
    h.calls.removeLabel.length +
    h.calls.addReaction.length +
    h.calls.editComment.length
  );
}

/* ------------------------------------------------------------------ tests */

describe('Case 1: owner /approve on REVIEW transitions REVIEW -> READY', () => {
  it('adds ai:ready and removes ai:review (T2)', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve' }), h.client, log);

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
    expect(log.warnings).toEqual([]);
  });

  it('adds the new label before removing the old one', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    await runGate(makeInput(), h.client, makeLogger());
    expect(h.calls.order).toEqual(['addLabels', 'removeLabel']);
  });

  it('reacts with ✅ on the accepted /approve (Phase 2 feedback, best-effort only)', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    await runGate(makeInput(), h.client, makeLogger());
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '+1' }]);
    expect(h.calls.editComment).toEqual([]);
  });

  it('accepts "/approve" with surrounding whitespace', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    await runGate(makeInput({ commentBody: '  /approve\n' }), h.client, makeLogger());
    expect(h.calls.addLabels).toHaveLength(1);
  });
});

describe('Case 2: /approve from a non-trusted actor gets 👎 and is otherwise ignored', () => {
  it('only write is the 👎 reaction (invalid owner command); zero label writes', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();

    await runGate(makeInput({ actor: 'external-user' }), h.client, log);

    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '-1' }]);
    expect(h.calls.addLabels).toEqual([]);
    expect(h.calls.removeLabel).toEqual([]);
    expect(h.calls.editComment).toEqual([]);
    expect(log.warnings).toEqual([]);
    expect(log.infos.some((m) => m.includes('silently ignored'))).toBe(true);
  });

  it('does not even read the API (parse + permission happen first)', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    await runGate(makeInput({ actor: 'external-user' }), h.client, makeLogger());
    expect(h.calls.getIssue).toBe(0);
    expect(h.calls.getLabels).toBe(0);
  });

  it('a registered trusted agent can never approve (👎, no label writes)', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    await runGate(
      makeInput({ actor: 'ci-bot', trustedAgentsInput: 'ci-bot' }),
      h.client,
      makeLogger(),
    );
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '-1' }]);
    expect(h.calls.addLabels).toEqual([]);
    expect(h.calls.removeLabel).toEqual([]);
  });
});

describe('Case 3: owner /approve in a wrong state performs no transition', () => {
  const wrongStates: Array<{ labels: string[]; why: string }> = [
    { labels: [], why: 'not in workflow' },
    { labels: [LABELS.planning], why: 'PLANNING' },
    { labels: [LABELS.ready], why: 'READY' },
    { labels: [LABELS.working], why: 'WORKING' },
    { labels: [LABELS.blocked], why: 'BLOCKED' },
    { labels: [LABELS.done], why: 'DONE (terminal)' },
  ];

  for (const { labels, why } of wrongStates) {
    it(`no-op when current label state is: ${why}`, async () => {
      const h = makeHarness({ labels });
      const log = makeLogger();

      await runGate(makeInput(), h.client, log);

      expect(writeCount(h)).toBe(0);
      expect(log.warnings.length).toBeGreaterThan(0);
    });
  }

  it('no-op when labels are ambiguous (protocol violation state)', async () => {
    const h = makeHarness({ labels: [LABELS.review, LABELS.done] });
    await runGate(makeInput(), h.client, makeLogger());
    expect(writeCount(h)).toBe(0);
  });
});

describe('Case 4: concurrency — every migration re-reads labels from the API', () => {
  it('follows the fresh re-read, not the stale event snapshot (stale says REVIEW, API says none)', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    h.issueLabels = [LABELS.review]; // what the event payload still claims
    h.setLabelStore([]); // what the API says now (e.g. /cancel raced in first)

    await runGate(makeInput(), h.client, makeLogger());

    expect(h.calls.getLabels).toBe(1); // the re-read happened
    expect(writeCount(h)).toBe(0);
  });

  it('follows the fresh re-read, not the stale event snapshot (stale says none, API says REVIEW)', async () => {
    const h = makeHarness({ labels: [] });
    h.setLabelStore([LABELS.review]); // another run published a plan meanwhile

    await runGate(makeInput(), h.client, makeLogger());

    expect(h.calls.getLabels).toBe(1);
    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
  });

  it('two sequential runs with an external change in between: second run acts on re-read state', async () => {
    const h = makeHarness({ labels: [] });
    const log = makeLogger();

    // Run 1: /ai-plan on a plain issue -> ai:planning.
    await runGate(makeInput({ commentBody: '/ai-plan' }), h.client, log);
    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.planning] }]);

    // External change while nobody holds the lock (e.g. manual tampering or a
    // future marker-triggered transition): issue is now in REVIEW.
    h.setLabelStore([LABELS.review]);

    // Run 2: /approve re-reads labels and sees REVIEW, not the stale PLANNING.
    await runGate(makeInput({ commentBody: '/approve' }), h.client, log);
    expect(h.calls.addLabels).toEqual([
      { labels: [LABELS.planning] },
      { labels: [LABELS.ready] },
    ]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
  });

  it('duplicate /approve delivery: second run re-reads READY and no-ops', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();

    await runGate(makeInput(), h.client, log);
    await runGate(makeInput(), h.client, log); // same event delivered twice

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
    expect(h.calls.getLabels).toBe(2);
    expect(log.warnings.some((m) => m.includes('current state is READY'))).toBe(true);
  });
});

describe('Case 5: /ai-plan', () => {
  it('adds ai:planning to a plain issue (T0)', async () => {
    const h = makeHarness({ labels: ['bug'] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/ai-plan' }), h.client, log);

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.planning] }]);
    expect(h.calls.removeLabel).toEqual([]);
    expect(log.warnings).toEqual([]);
  });

  it('no-ops when the issue already carries any ai:* label', async () => {
    for (const label of [
      LABELS.planning,
      LABELS.review,
      LABELS.ready,
      LABELS.working,
      LABELS.blocked,
      LABELS.done,
    ]) {
      const h = makeHarness({ labels: [label] });
      await runGate(makeInput({ commentBody: '/ai-plan' }), h.client, makeLogger());
      expect(writeCount(h)).toBe(0);
    }
  });

  it('no-ops on ambiguous labels', async () => {
    const h = makeHarness({ labels: [LABELS.planning, LABELS.review] });
    await runGate(makeInput({ commentBody: '/ai-plan' }), h.client, makeLogger());
    expect(writeCount(h)).toBe(0);
  });

  it('from a non-trusted actor: 👎 only, no transition (Phase 2 feedback)', async () => {
    const h = makeHarness({ labels: [] });
    await runGate(
      makeInput({ commentBody: '/ai-plan', actor: 'external-user' }),
      h.client,
      makeLogger(),
    );
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '-1' }]);
    expect(h.calls.addLabels).toEqual([]);
    expect(h.calls.removeLabel).toEqual([]);
  });
});

describe('Case 6: /cancel removes all ai:* labels and never closes the issue', () => {
  for (const label of [
    LABELS.planning,
    LABELS.review,
    LABELS.ready,
    LABELS.working,
    LABELS.blocked,
    LABELS.done,
  ]) {
    it(`works from ${label} (including terminal DONE)`, async () => {
      const h = makeHarness({ labels: [label, 'bug'] });
      const log = makeLogger();

      await runGate(makeInput({ commentBody: '/cancel' }), h.client, log);

      expect(h.calls.removeLabel).toEqual([{ label }]);
      expect(h.calls.addLabels).toEqual([]);
      expect(log.warnings).toEqual([]);
    });
  }

  it('removes every ai:* label of an ambiguous (tampered) issue', async () => {
    const h = makeHarness({ labels: [LABELS.review, LABELS.working] });
    await runGate(makeInput({ commentBody: '/cancel' }), h.client, makeLogger());
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }, { label: LABELS.working }]);
  });

  it('no-ops when the issue has no ai:* label', async () => {
    const h = makeHarness({ labels: [] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/cancel' }), h.client, log);

    expect(writeCount(h)).toBe(0);
    expect(log.warnings.length).toBeGreaterThan(0);
  });
});

describe('Case 7+8: strict parsing at the gate boundary', () => {
  it('embedded "/approve" text is a normal comment: zero API operations at all', async () => {
    const h = makeHarness({ labels: [LABELS.review] });

    await runGate(makeInput({ commentBody: '请看 /approve' }), h.client, makeLogger());
    await runGate(makeInput({ commentBody: 'x/approve' }), h.client, makeLogger());
    await runGate(makeInput({ commentBody: '/Approve' }), h.client, makeLogger());

    expect(writeCount(h)).toBe(0);
    expect(h.calls.getIssue).toBe(0);
    expect(h.calls.getLabels).toBe(0);
  });

  it('/choose and /change from the owner on REVIEW are accepted: ✅ each, zero label writes (Phase 2)', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();
    await runGate(makeInput({ commentBody: '/choose 1 B' }), h.client, log);
    await runGate(makeInput({ commentBody: '/change please reconsider' }), h.client, log);
    expect(h.calls.addLabels).toEqual([]); // hand-off to the Consumer, never a migration
    expect(h.calls.removeLabel).toEqual([]);
    expect(h.calls.editComment).toEqual([]);
    expect(h.calls.addReaction).toEqual([
      { commentId: 9001, content: '+1' },
      { commentId: 9001, content: '+1' },
    ]);
    expect(log.infos.some((m) => m.includes('question "1"') && m.includes('choice "B"'))).toBe(true);
    expect(log.infos.some((m) => m.includes('please reconsider'))).toBe(true);
  });

  it('malformed /choose and /change arguments stay normal comments: zero API operations', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    await runGate(makeInput({ commentBody: '/choose 1' }), h.client, makeLogger());
    await runGate(makeInput({ commentBody: '/change' }), h.client, makeLogger());
    expect(writeCount(h)).toBe(0);
    expect(h.calls.getIssue).toBe(0);
    expect(h.calls.getLabels).toBe(0);
  });

  it('a plain question triggers nothing', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    await runGate(
      makeInput({ commentBody: 'When will this be released?' }),
      h.client,
      makeLogger(),
    );
    expect(writeCount(h)).toBe(0);
  });
});

describe('Case 9: trusted-humans allowlist', () => {
  it('an allowlisted non-owner counts as Trusted Human for /approve', async () => {
    const h = makeHarness({ labels: [LABELS.review] });

    await runGate(
      makeInput({ actor: 'maintainer-1', trustedHumansInput: 'maintainer-1, maintainer-2' }),
      h.client,
      makeLogger(),
    );

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
  });

  it('a non-owner outside the allowlist gets 👎 and no label writes', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    await runGate(
      makeInput({ actor: 'random-user', trustedHumansInput: 'maintainer-1' }),
      h.client,
      makeLogger(),
    );
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '-1' }]);
    expect(h.calls.addLabels).toEqual([]);
    expect(h.calls.removeLabel).toEqual([]);
  });

  it('an allowlisted non-owner can also /ai-plan and /cancel', async () => {
    const h1 = makeHarness({ labels: [] });
    await runGate(
      makeInput({ commentBody: '/ai-plan', actor: 'helper', trustedHumansInput: 'helper' }),
      h1.client,
      makeLogger(),
    );
    expect(h1.calls.addLabels).toEqual([{ labels: [LABELS.planning] }]);

    const h2 = makeHarness({ labels: [LABELS.done] });
    await runGate(
      makeInput({ commentBody: '/cancel', actor: 'helper', trustedHumansInput: 'helper' }),
      h2.client,
      makeLogger(),
    );
    expect(h2.calls.removeLabel).toEqual([{ label: LABELS.done }]);
  });
});

describe('event routing (frozen event matrix, protocol section 8)', () => {
  it('issues.opened does not auto-label', async () => {
    const h = makeHarness({ labels: [] });
    await runGate(
      makeInput({ eventName: 'issues', eventAction: 'opened', commentBody: undefined }),
      h.client,
      makeLogger(),
    );
    expect(writeCount(h)).toBe(0);
    expect(h.calls.getIssue).toBe(0);
  });

  it('issues.labeled only observes', async () => {
    const h = makeHarness({ labels: [LABELS.planning] });
    await runGate(
      makeInput({ eventName: 'issues', eventAction: 'labeled', commentBody: undefined }),
      h.client,
      makeLogger(),
    );
    expect(writeCount(h)).toBe(0);
  });

  it('issues.closed validates then silently ends without transition', async () => {
    const h = makeHarness({ labels: [LABELS.working], state: 'closed' });
    const log = makeLogger();

    await runGate(
      makeInput({ eventName: 'issues', eventAction: 'closed', commentBody: undefined }),
      h.client,
      log,
    );

    expect(h.calls.getIssue).toBe(1);
    expect(writeCount(h)).toBe(0);
    expect(log.warnings).toEqual([]);
  });

  it('issues.reopened is not handled in V0', async () => {
    const h = makeHarness({ labels: [LABELS.done], state: 'open' });
    await runGate(
      makeInput({ eventName: 'issues', eventAction: 'reopened', commentBody: undefined }),
      h.client,
      makeLogger(),
    );
    expect(writeCount(h)).toBe(0);
  });

  it('commands on a closed issue are ignored (closed is terminal)', async () => {
    const h = makeHarness({ labels: [LABELS.review], state: 'closed' });
    const log = makeLogger();

    await runGate(makeInput(), h.client, log);

    expect(h.calls.getIssue).toBe(1);
    expect(h.calls.getLabels).toBe(0); // never even reaches the re-read
    expect(writeCount(h)).toBe(0);
  });

  it('issue_comment.deleted and unknown events do nothing', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    await runGate(makeInput({ eventAction: 'deleted' }), h.client, makeLogger());
    await runGate(makeInput({ eventName: 'pull_request', eventAction: 'opened' }), h.client, makeLogger());
    expect(writeCount(h)).toBe(0);
    expect(h.calls.getIssue).toBe(0);
  });
});

describe('infrastructure failures may surface (everything else must not)', () => {
  it('API rejection during the pre-migration re-read propagates', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    h.client.getLabels = vi.fn(async () => {
      throw new Error('503 service unavailable');
    });

    await expect(runGate(makeInput(), h.client, makeLogger())).rejects.toThrow('503');
  });
});

/* ------------------------------------------------------- Phase 2: commands */

describe('Phase 2: /choose and /change (hand-off to the Consumer, never a migration)', () => {
  it('/choose outside REVIEW is a no-op: no reaction, no label writes, warning logged', async () => {
    for (const labels of [
      [],
      [LABELS.planning],
      [LABELS.ready],
      [LABELS.working],
      [LABELS.blocked],
      [LABELS.done],
      [LABELS.planning, LABELS.done], // ambiguous
    ]) {
      const h = makeHarness({ labels });
      const log = makeLogger();

      await runGate(makeInput({ commentBody: '/choose 1 B' }), h.client, log);

      expect(writeCount(h)).toBe(0);
      expect(log.warnings.length).toBeGreaterThan(0);
    }
  });

  it('/change outside REVIEW is a no-op: no reaction, no label writes, warning logged', async () => {
    for (const labels of [[], [LABELS.planning], [LABELS.ready], [LABELS.done]]) {
      const h = makeHarness({ labels });
      const log = makeLogger();

      await runGate(makeInput({ commentBody: '/change do it differently' }), h.client, log);

      expect(writeCount(h)).toBe(0);
      expect(log.warnings.length).toBeGreaterThan(0);
    }
  });

  it('/choose and /change on a closed issue are silently ignored (closed is terminal)', async () => {
    for (const body of ['/choose 1 B', '/change reconsider']) {
      const h = makeHarness({ labels: [LABELS.review], state: 'closed' });
      const log = makeLogger();

      await runGate(makeInput({ commentBody: body }), h.client, log);

      expect(h.calls.getIssue).toBe(1);
      expect(h.calls.getLabels).toBe(0); // never reaches the re-read
      expect(writeCount(h)).toBe(0);
      expect(log.warnings).toEqual([]);
    }
  });
});

describe('Phase 2: every command from a non-Trusted-Human gets exactly one 👎', () => {
  const commands = ['/ai-plan', '/approve', '/choose 1 B', '/change please reconsider', '/cancel'];

  it('external user: one -1 reaction per command, zero label writes, zero API reads', async () => {
    for (const body of commands) {
      const h = makeHarness({ labels: [LABELS.review] });
      const log = makeLogger();

      await runGate(makeInput({ commentBody: body, actor: 'external-user' }), h.client, log);

      expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '-1' }]);
      expect(h.calls.addLabels).toEqual([]);
      expect(h.calls.removeLabel).toEqual([]);
      expect(h.calls.editComment).toEqual([]);
      expect(h.calls.getIssue).toBe(0);
      expect(h.calls.getLabels).toBe(0);
      expect(log.warnings).toEqual([]);
    }
  });

  it('a registered trusted agent gets 👎 on /choose and /change too (agents never command)', async () => {
    for (const body of ['/choose 1 B', '/change please reconsider']) {
      const h = makeHarness({ labels: [LABELS.review] });
      await runGate(
        makeInput({ commentBody: body, actor: 'ai-bot', trustedAgentsInput: 'ai-bot' }),
        h.client,
        makeLogger(),
      );
      expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '-1' }]);
      expect(h.calls.addLabels).toEqual([]);
      expect(h.calls.removeLabel).toEqual([]);
    }
  });
});

/* -------------------------------------------------------- Phase 2: markers */

describe('Phase 2: marker-triggered transitions (T1 / T3 / T6, Trusted Human ∪ Trusted Agent)', () => {
  const PLAN_BODY = '## Execution Plan\n\n### Objective\n\nDo the thing.\n\n<!-- ai-workflow:plan:v1 -->';
  const TRACKER_BODY =
    '## Execution Tracker\n\n**Status:** In Progress\n\n- [x] first\n\n<!-- ai-workflow:execution-tracker:v1 -->';
  const REPORT_BODY =
    '## Completion Report\n\n### Result\n\nDone.\n\n<!-- ai-workflow:completion-report:v1 -->';

  it('plan marker from the owner at PLANNING triggers T1 (PLANNING -> REVIEW)', async () => {
    const h = makeHarness({ labels: [LABELS.planning] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: PLAN_BODY }), h.client, log);

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.review] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.planning }]);
    expect(h.calls.order).toEqual(['addLabels', 'removeLabel']);
    expect(h.calls.addReaction).toEqual([]); // markers never react
    expect(log.warnings).toEqual([]);
  });

  it('plan marker from a configured Trusted Agent triggers T1 too (agents may publish)', async () => {
    const h = makeHarness({ labels: [LABELS.planning] });
    await runGate(
      makeInput({ commentBody: PLAN_BODY, actor: 'ai-bot', trustedAgentsInput: 'ai-bot' }),
      h.client,
      makeLogger(),
    );
    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.review] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.planning }]);
  });

  it('plan marker from an unknown actor is plain text: no transition, no writes, no API reads', async () => {
    const h = makeHarness({ labels: [LABELS.planning] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: PLAN_BODY, actor: 'external-user' }), h.client, log);

    expect(writeCount(h)).toBe(0);
    expect(h.calls.getIssue).toBe(0);
    expect(h.calls.getLabels).toBe(0);
    expect(log.warnings.some((m) => m.includes('never permission'))).toBe(true);
  });

  it('plan marker in a wrong state is a no-op (including ambiguous)', async () => {
    for (const labels of [
      [],
      [LABELS.review],
      [LABELS.ready],
      [LABELS.working],
      [LABELS.done],
      [LABELS.planning, LABELS.done],
    ]) {
      const h = makeHarness({ labels });
      await runGate(makeInput({ commentBody: PLAN_BODY }), h.client, makeLogger());
      expect(writeCount(h)).toBe(0);
    }
  });

  it('execution-tracker marker from the owner at READY triggers T3 (READY -> WORKING)', async () => {
    const h = makeHarness({ labels: [LABELS.ready] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: TRACKER_BODY }), h.client, log);

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.working] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.ready }]);
    expect(log.warnings).toEqual([]);
  });

  it('execution-tracker marker in a wrong state is a no-op', async () => {
    for (const labels of [[LABELS.planning], [LABELS.review], [LABELS.done]]) {
      const h = makeHarness({ labels });
      await runGate(makeInput({ commentBody: TRACKER_BODY }), h.client, makeLogger());
      expect(writeCount(h)).toBe(0);
    }
  });

  it('completion-report marker from the owner at WORKING triggers T6 (WORKING -> DONE)', async () => {
    const h = makeHarness({ labels: [LABELS.working] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: REPORT_BODY }), h.client, log);

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.done] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.working }]);
    expect(log.warnings).toEqual([]);
  });

  it('completion-report marker in a wrong state is a no-op (DONE is terminal, no T6 repeat)', async () => {
    for (const labels of [[LABELS.ready], [LABELS.done], [LABELS.blocked]]) {
      const h = makeHarness({ labels });
      await runGate(makeInput({ commentBody: REPORT_BODY }), h.client, makeLogger());
      expect(writeCount(h)).toBe(0);
    }
  });

  it('a comment with two markers is invalid: no transition, no API reads (anti-spoofing)', async () => {
    const h = makeHarness({ labels: [LABELS.planning] });
    const log = makeLogger();

    await runGate(
      makeInput({
        commentBody: '<!-- ai-workflow:plan:v1 -->\n<!-- ai-workflow:execution-tracker:v1 -->',
      }),
      h.client,
      log,
    );

    expect(writeCount(h)).toBe(0);
    expect(h.calls.getIssue).toBe(0);
    expect(log.warnings.some((m) => m.includes('Invalid marker comment'))).toBe(true);
  });

  it('a marker that does not own its line is invalid: no transition', async () => {
    const h = makeHarness({ labels: [LABELS.planning] });
    const log = makeLogger();

    await runGate(
      makeInput({ commentBody: 'the plan follows: <!-- ai-workflow:plan:v1 -->' }),
      h.client,
      log,
    );

    expect(writeCount(h)).toBe(0);
    expect(log.warnings.some((m) => m.includes('Invalid marker comment'))).toBe(true);
  });

  it('a marker quoted inside a fenced code block never triggers (protocol 4.3)', async () => {
    const h = makeHarness({ labels: [LABELS.planning] });

    await runGate(
      makeInput({ commentBody: 'Example:\n\n```\n<!-- ai-workflow:plan:v1 -->\n```\n' }),
      h.client,
      makeLogger(),
    );

    expect(writeCount(h)).toBe(0);
    expect(h.calls.getIssue).toBe(0);
  });

  it('append marker is recorded only: no transition from any state, no reaction', async () => {
    for (const labels of [[], [LABELS.planning], [LABELS.review], [LABELS.working], [LABELS.done]]) {
      const h = makeHarness({ labels });
      const log = makeLogger();

      await runGate(
        makeInput({
          commentBody: '## AI Discussion Summary\n\nMore context.\n\n<!-- ai-workflow:append:v1 -->',
        }),
        h.client,
        log,
      );

      expect(writeCount(h)).toBe(0);
      expect(log.warnings).toEqual([]);
    }
  });

  it('duplicate plan marker delivery: second run re-reads REVIEW and no-ops', async () => {
    const h = makeHarness({ labels: [LABELS.planning] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: PLAN_BODY }), h.client, log);
    await runGate(makeInput({ commentBody: PLAN_BODY }), h.client, log); // same event delivered twice

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.review] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.planning }]);
    expect(h.calls.getLabels).toBe(2);
    expect(log.warnings.some((m) => m.includes('current state is REVIEW'))).toBe(true);
  });

  it('markers on a closed issue are ignored (closed is terminal)', async () => {
    const h = makeHarness({ labels: [LABELS.planning], state: 'closed' });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: PLAN_BODY }), h.client, log);

    expect(h.calls.getIssue).toBe(1);
    expect(h.calls.getLabels).toBe(0);
    expect(writeCount(h)).toBe(0);
    expect(log.warnings).toEqual([]);
  });
});

describe('Phase 2: issue body schema block is observability metadata only', () => {
  const SCHEMA_BODY =
    '## Goal\n\nDo it.\n\n<!-- ai-workflow\nschema: 1\nsource: producer\nkind: feature\nmaturity_hint: solution\n-->';

  it('issues.opened with a valid Producer schema block still does not auto-label', async () => {
    const h = makeHarness({ labels: [] });
    const log = makeLogger();

    await runGate(
      makeInput({ eventName: 'issues', eventAction: 'opened', commentBody: undefined, issueBody: SCHEMA_BODY }),
      h.client,
      log,
    );

    expect(writeCount(h)).toBe(0);
    expect(h.calls.getIssue).toBe(0);
    expect(log.infos.some((m) => m.includes('kind=feature') && m.includes('maturity_hint=solution'))).toBe(true);
    expect(log.infos.some((m) => m.includes('no auto-labeling'))).toBe(true);
  });

  it('an invalid schema block is reported and the issue stays plain (no transition)', async () => {
    const h = makeHarness({ labels: [] });
    const log = makeLogger();

    await runGate(
      makeInput({
        eventName: 'issues',
        eventAction: 'opened',
        commentBody: undefined,
        issueBody: '<!-- ai-workflow\nschema: 1\nsource: producer\nkind: feature\nmaturity_hint: vibes\n-->',
      }),
      h.client,
      log,
    );

    expect(writeCount(h)).toBe(0);
    expect(log.warnings.some((m) => m.includes('schema block invalid'))).toBe(true);
  });
});

describe('Phase 2: reaction feedback is best-effort and never load-bearing', () => {
  it('a failing reaction API call does not affect an accepted /approve migration', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    h.client.addReaction = vi.fn(async () => {
      throw new Error('500 reaction endpoint down');
    });
    const log = makeLogger();

    await runGate(makeInput(), h.client, log);

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
    expect(log.warnings.some((m) => m.includes('reaction') && m.includes('ignored'))).toBe(true);
  });

  it('a failing 👎 reaction still leaves the non-owner command ignored (no throw)', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    h.client.addReaction = vi.fn(async () => {
      throw new Error('403 forbidden');
    });
    const log = makeLogger();

    await runGate(makeInput({ actor: 'external-user' }), h.client, log);

    expect(h.calls.addLabels).toEqual([]);
    expect(h.calls.removeLabel).toEqual([]);
    expect(log.warnings.some((m) => m.includes('ignored'))).toBe(true);
  });

  it('a comment event without a comment id still migrates and only logs a warning', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();

    await runGate(makeInput({ commentId: undefined }), h.client, log);

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
    expect(log.warnings.some((m) => m.includes('no comment id'))).toBe(true);
  });
});
