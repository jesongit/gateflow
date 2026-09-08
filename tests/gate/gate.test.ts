import { describe, expect, it, vi } from 'vitest';
import { runGate, type GateInput, type GateLogger } from '../../src/gate/gate';
import type {
  AuthenticatedUser,
  GitHubClient,
  IssueRef,
  RepoIdentity,
} from '../../src/gate/github';
import type { GateComment } from '../../src/gate/approvals';
import { LABELS } from '../../src/gate/protocol';
import {
  approvalOperationId,
  buildRecordBody,
  feedbackOperationId,
  gateEpochOperationId,
  RECORD_SCHEMA_VERSION,
  transitionOperationId,
} from '../../src/protocol/records';
import { planSha256 } from '../../src/protocol/plan';

/* ---------------------------------------------------------------- helpers */

/**
 * NOTE ON RECORD PUBLICATION ORDER: every record the gate builds
 * (src/gate/gate.ts applyAiPlan / applyApprove / acceptFeedbackEvent) carries
 * the frozen `schema: 2` field and is VERIFIED against its own parser after
 * creation (publishRecord re-reads and re-parses the created comment). The
 * tests below assert the full sequence: record comment first, then any label
 * migration, then the ✅ reaction — and fail-closed (no labels, no reaction)
 * whenever the record write or verification fails.
 * The fake below is a FAITHFUL GitHub double: addComment stores the posted
 * body verbatim and getComment / listComments serve it back unchanged.
 */

/** A body that carries a valid plan marker (unique, line-owning). */
const PLAN_COMMENT_BODY =
  '## Execution Plan\n\n### Objective\n\nDo the thing.\n\n<!-- ai-workflow:plan:v1 -->';

/** The current plan of the default fixture issue, as the Consumer published it. */
const DEFAULT_PLAN_COMMENT: GateComment = {
  id: 123,
  user: 'consumer-bot',
  body: PLAN_COMMENT_BODY,
};

/** The Gate identity the fake token resolves to (LOGIN-regex-safe login). */
const GATE_IDENTITY: AuthenticatedUser = { id: 41898282, login: 'gate-bot' };

/** The epoch of the default fixture issue (Driver-bootstrap / earlier round). */
const WORKFLOW_EPOCH = 'wf_qrdeh6k30m1z';

/** Default repo identity served by getRepoIdentity (owner type API-verified). */
const DEFAULT_REPO_IDENTITY: RepoIdentity = {
  owner: 'owner-user',
  ownerType: 'User',
  id: 123,
};

type GateRecordLike = Parameters<typeof buildRecordBody>[0];

/**
 * Builds a record comment body through the frozen builder. The seeds carry
 * the frozen `schema: 2` field (as the Driver bootstrap / a fixed gate would
 * publish them), which is exactly what the gate's own records currently miss.
 */
function seedBody(kind: GateRecordLike['kind'], fields: Record<string, unknown>): string {
  return buildRecordBody({
    schema: RECORD_SCHEMA_VERSION,
    kind,
    ...fields,
  } as unknown as GateRecordLike);
}

/**
 * The deterministic epoch operation id of the fixture issue's round
 * (V1.1 Phase 3: `epoch:<repo>:<issue>:c<command>` — the /ai-plan command
 * comment this round was created from).
 */
const EPOCH_OP_ID = gateEpochOperationId(123, 7, 42);

/** A valid workflow_epoch record comment (schema 2, V1.1 trust fields). */
function epochRecordComment(id = 45, epoch = WORKFLOW_EPOCH): GateComment {
  return {
    id,
    user: GATE_IDENTITY.login,
    body: seedBody('workflow_epoch', {
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: epoch,
      created_by: 'gate',
      created_at: '2026-09-06T10:00:00Z',
      issued_by: GATE_IDENTITY.login,
      operation_id: EPOCH_OP_ID,
    }),
  };
}

/** A valid approval record comment (schema 2) binding plan comment 123. */
function approvalRecordComment(overrides: Record<string, unknown> = {}, id = 46): GateComment {
  return {
    id,
    user: GATE_IDENTITY.login,
    body: seedBody('approval', {
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: WORKFLOW_EPOCH,
      plan_comment_id: 123,
      plan_sha256: planSha256(PLAN_COMMENT_BODY),
      approval_command_comment_id: 9001,
      approved_by_id: 1001,
      approved_by_login: 'owner-user',
      gate_login: GATE_IDENTITY.login,
      gate_user_id: GATE_IDENTITY.id,
      created_at: '2026-09-06T10:05:00Z',
      operation_id: approvalOperationId(123, 7, WORKFLOW_EPOCH, 123),
      ...overrides,
    }),
  };
}

/** A valid feedback_accepted record comment (schema 2) for command comment 9001. */
function feedbackRecordComment(kind: 'choose' | 'change', id = 46): GateComment {
  return {
    id,
    user: GATE_IDENTITY.login,
    body: seedBody('feedback_accepted', {
      repository_id: 123,
      issue_number: 7,
      workflow_epoch: WORKFLOW_EPOCH,
      event_id: 'fe9001',
      feedback_comment_id: 9001,
      feedback_kind: kind,
      gate_login: GATE_IDENTITY.login,
      gate_user_id: GATE_IDENTITY.id,
      created_at: '2026-09-06T10:05:00Z',
      operation_id: feedbackOperationId(123, 7, WORKFLOW_EPOCH, 9001),
    }),
  };
}

/**
 * Comment store for the T2 "crash recovery" scenario: a valid epoch and a
 * valid approval record already exist (the record publish succeeded in an
 * earlier run; the label swap did not complete). Re-running /approve must
 * reuse the record by operation id and complete the label migration.
 */
function recoveryComments(): GateComment[] {
  return [DEFAULT_PLAN_COMMENT, epochRecordComment(), approvalRecordComment()];
}

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
    getComment: Array<{ commentId: number }>;
    listComments: number;
    addComment: Array<{ body: string }>;
    getAuthenticatedUser: number;
    getRepoIdentity: number;
  };
  /** Labels as returned by getIssue (the "payload-era" snapshot). */
  issueLabels: string[];
  /** Labels as returned by getLabels (the fresh re-read the gate must use). */
  labelStore: string[];
  issueState: string;
  /** All comments of the issue, as listComments / getComment serve them. */
  commentStore: GateComment[];
  /** Served by getRepoIdentity (owner type verified against the "API"). */
  repoIdentity: RepoIdentity;
  /** Served by getAuthenticatedUser (the Gate identity behind the token). */
  gateIdentity: AuthenticatedUser;
  setLabelStore(labels: string[]): void;
  setComments(comments: GateComment[]): void;
}

function makeHarness(options?: {
  labels?: string[];
  state?: string;
  comments?: GateComment[];
  /** Auto-seed a valid epoch record (default true; the issue had a round). */
  seedEpoch?: boolean;
  ownerType?: string;
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
      getComment: [],
      listComments: 0,
      addComment: [],
      getAuthenticatedUser: 0,
      getRepoIdentity: 0,
    },
    issueLabels: [...(options?.labels ?? [])],
    labelStore: [...(options?.labels ?? [])],
    issueState: options?.state ?? 'open',
    commentStore: [...(options?.comments ?? [DEFAULT_PLAN_COMMENT])],
    repoIdentity: { ...DEFAULT_REPO_IDENTITY, ownerType: options?.ownerType ?? 'User' },
    gateIdentity: { ...GATE_IDENTITY },
    setLabelStore(labels: string[]) {
      h.labelStore = [...labels];
    },
    setComments(comments: GateComment[]) {
      h.commentStore = [...comments];
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
      getComment: vi.fn(async (_ref: IssueRef, commentId: number) => {
        h.calls.getComment.push({ commentId });
        const found = h.commentStore.find((c) => c.id === commentId);
        return found === undefined ? null : { ...found };
      }),
      listComments: vi.fn(async () => {
        h.calls.listComments += 1;
        return [...h.commentStore].sort((a, b) => a.id - b.id);
      }),
      addComment: vi.fn(async (_ref: IssueRef, body: string) => {
        h.calls.order.push('addComment');
        h.calls.addComment.push({ body });
        // Faithful GitHub simulation: the comment exists afterwards.
        const created: GateComment = {
          id: 10000 + h.calls.addComment.length,
          user: h.gateIdentity.login,
          body,
        };
        h.commentStore.push(created);
        return { id: created.id };
      }),
      getAuthenticatedUser: vi.fn(async () => {
        h.calls.getAuthenticatedUser += 1;
        return { ...h.gateIdentity };
      }),
      getRepoIdentity: vi.fn(async (query: { owner: string; repo: string }) => {
        h.calls.getRepoIdentity += 1;
        return { ...h.repoIdentity, owner: query.owner };
      }),
    },
  };
  if (options?.seedEpoch !== false) {
    h.commentStore.push(epochRecordComment());
  }
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
    // Schema 2: the repository database id embedded into every gate record.
    repositoryId: 123,
    issueNumber: 7,
    commentId: 9001,
    // Schema 2: the approver's numeric id recorded in approval records.
    actorId: 1001,
    // V1: the default command approves the default fixture plan comment 123.
    commentBody: '/approve 123',
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

describe('Case 1: owner /approve 123 on REVIEW transitions REVIEW -> READY', () => {
  it('completes T2 from the valid approval record (reuse by operation id): adds ai:ready, removes ai:review', async () => {
    const h = makeHarness({ labels: [LABELS.review], comments: recoveryComments() });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 123' }), h.client, log);

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
    // Crash recovery: the APPROVAL record already exists — no duplicate
    // authorization object. V1.1: the T2 gate_transition record is new for
    // this source command and IS persisted (before the label swap).
    expect(h.calls.addComment).toHaveLength(1);
    expect(h.calls.addComment[0]?.body).toContain('<!-- gateflow:transition:v2 -->');
    expect(log.warnings).toEqual([]);
    expect(
      log.infos.some((m) => m.includes('T2 on #7') && m.includes('approving plan comment 123')),
    ).toBe(true);
  });

  it('persists the T2 transition record before the label swap (V1.1 record-first)', async () => {
    const h = makeHarness({ labels: [LABELS.review], comments: recoveryComments() });
    await runGate(makeInput(), h.client, makeLogger());
    expect(h.calls.order).toEqual(['addComment', 'addLabels', 'removeLabel']);
  });

  it('reacts with ✅ on the accepted /approve (Phase 2 feedback, best-effort only)', async () => {
    const h = makeHarness({ labels: [LABELS.review], comments: recoveryComments() });
    await runGate(makeInput(), h.client, makeLogger());
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '+1' }]);
    expect(h.calls.editComment).toEqual([]);
  });

  it('accepts "/approve 123" with surrounding whitespace', async () => {
    const h = makeHarness({ labels: [LABELS.review], comments: recoveryComments() });
    await runGate(makeInput({ commentBody: '  /approve 123\n' }), h.client, makeLogger());
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

  it('does not read the issue or its comments (identity check, parse + permission happen first)', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    await runGate(makeInput({ actor: 'external-user' }), h.client, makeLogger());
    // GF-H10: the one sanctioned pre-permission API read is the owner-type
    // verification; the issue and its comments are never touched.
    expect(h.calls.getRepoIdentity).toBe(1);
    expect(h.calls.getIssue).toBe(0);
    expect(h.calls.getLabels).toBe(0);
    expect(h.calls.listComments).toBe(0);
    expect(h.calls.getComment).toEqual([]);
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
      expect(h.calls.addComment).toEqual([]); // no record is attempted either
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
    const h = makeHarness({ labels: [], comments: recoveryComments() });
    h.setLabelStore([LABELS.review]); // another run published a plan meanwhile

    await runGate(makeInput(), h.client, makeLogger());

    expect(h.calls.getLabels).toBe(1);
    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
  });

  it('two sequential runs with an external change in between: second run acts on re-read state', async () => {
    const h = makeHarness({ labels: [] });
    const log = makeLogger();

    // Run 1: /ai-plan on a plain issue -> ai:planning (+ the round's epoch record).
    await runGate(makeInput({ commentBody: '/ai-plan' }), h.client, log);
    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.planning] }]);
    expect(h.calls.addComment).toHaveLength(1);
    expect(h.calls.addComment[0]?.body).toContain('<!-- gateflow:workflow:v2 -->');

    // External change while nobody holds the lock: the issue is now in REVIEW,
    // and the Driver reconciled the round's records (epoch + approval).
    h.setLabelStore([LABELS.review]);
    h.setComments(recoveryComments());

    // Run 2: /approve re-reads labels and sees REVIEW, not the stale PLANNING;
    // the record is reused by operation id instead of being duplicated.
    await runGate(makeInput({ commentBody: '/approve 123' }), h.client, log);
    expect(h.calls.addLabels).toEqual([
      { labels: [LABELS.planning] },
      { labels: [LABELS.ready] },
    ]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
    // Run 1's epoch record + run 2's T2 transition record (V1.1 Phase 4).
    expect(h.calls.addComment).toHaveLength(2);
  });

  it('duplicate /approve delivery: second run re-reads READY and no-ops', async () => {
    const h = makeHarness({ labels: [LABELS.review], comments: recoveryComments() });
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
  it('adds ai:planning to a plain issue (T0) and persists the round epoch record', async () => {
    const h = makeHarness({ labels: ['bug'] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/ai-plan' }), h.client, log);

    // V1.1 Phase 3 record-first: the epoch record is written BEFORE the
    // PLANNING label — no epoch record means NO migration.
    expect(h.calls.order).toEqual(['addComment', 'addLabels']);
    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.planning] }]);
    expect(h.calls.removeLabel).toEqual([]);
    // T0 accepted (✅).
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '+1' }]);
    // Schema 2: the epoch record comment is created (epoch is CSPRNG randomness).
    expect(h.calls.addComment).toHaveLength(1);
    const body = h.calls.addComment[0]?.body ?? '';
    expect(body).toContain('<!-- gateflow:workflow:v2 -->');
    expect(body).toContain('"created_by": "gate"');
    expect(body).toContain(`"operation_id": "${gateEpochOperationId(123, 7, 9001)}"`);
    expect(body).toContain('"schema": 2');
    expect(body).toContain('"kind": "workflow_epoch"');
    expect(body).toContain('"repository_id": 123');
    expect(body).toContain('"issue_number": 7');
    expect(body).toMatch(/"workflow_epoch": "wf_[0-9a-z]{12}"/);
    expect(body).toContain('"operation_id": "epoch:123:7:c9001"');
    expect(body).toContain(`"issued_by": "${GATE_IDENTITY.login}"`);
    // The record publish is verified against its own parse — no warnings.
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
      expect(h.calls.addComment).toEqual([]); // no epoch record outside T0
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

    await runGate(makeInput({ commentBody: '请看 /approve 123' }), h.client, makeLogger());
    await runGate(makeInput({ commentBody: 'x/approve' }), h.client, makeLogger());
    await runGate(makeInput({ commentBody: '/Approve' }), h.client, makeLogger());
    await runGate(makeInput({ commentBody: '/approve' }), h.client, makeLogger()); // V1: bare form is gone
    await runGate(makeInput({ commentBody: '/approve abc' }), h.client, makeLogger());

    expect(writeCount(h)).toBe(0);
    expect(h.calls.addReaction).toEqual([]); // not even a 👎: not a command anymore
    expect(h.calls.getIssue).toBe(0);
    expect(h.calls.getLabels).toBe(0);
    expect(h.calls.listComments).toBe(0);
    expect(h.calls.getComment).toEqual([]);
    expect(h.calls.addComment).toEqual([]);
  });

  it('/choose and /change from the owner on REVIEW are accepted: ✅ each, zero label writes, idempotent (Phase 2)', async () => {
    // A valid feedback record for command comment 9001 already exists (a prior
    // run published it and crashed before reacting) — re-delivery must accept
    // idempotently by operation id and never create a second record.
    const h = makeHarness({
      labels: [LABELS.review],
      comments: [
        DEFAULT_PLAN_COMMENT,
        epochRecordComment(),
        feedbackRecordComment('choose'),
      ],
    });
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
    // Idempotent acceptance: the existing record is reused, none is created.
    expect(h.calls.addComment).toEqual([]);
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
    expect(h.calls.addComment).toEqual([]);
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
    const h = makeHarness({
      labels: [LABELS.review],
      comments: [
        DEFAULT_PLAN_COMMENT,
        epochRecordComment(),
        approvalRecordComment({ approved_by_login: 'maintainer-1' }),
      ],
    });

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
      expect(h.calls.addComment).toEqual([]); // rejected commands never record
      expect(log.warnings.length).toBeGreaterThan(0);
    }
  });

  it('/change outside REVIEW is a no-op: no reaction, no label writes, warning logged', async () => {
    for (const labels of [[], [LABELS.planning], [LABELS.ready], [LABELS.done]]) {
      const h = makeHarness({ labels });
      const log = makeLogger();

      await runGate(makeInput({ commentBody: '/change do it differently' }), h.client, log);

      expect(writeCount(h)).toBe(0);
      expect(h.calls.addComment).toEqual([]);
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
  const commands = ['/ai-plan', '/approve 123', '/choose 1 B', '/change please reconsider', '/cancel'];

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

describe('Phase 2 + V1.1: marker-triggered transitions (T1 / T3 / T6 with dispatch-chain authorization)', () => {
  /** The consumer dispatch id of the fixture round (epoch-embedded, frozen grammar). */
  const CONSUMER_DISPATCH = 'gf_r123_i7_wqrdeh6k30m1z_consumer_01';
  const EXECUTOR_DISPATCH = 'gf_r123_i7_wqrdeh6k30m1z_executor_p123';

  /** Plan comment AS THE DRIVER PUBLISHES IT: marker + dispatch-id + content. */
  const PLAN_BODY_WITH_DISPATCH =
    '<!-- ai-workflow:plan:v1 -->\n\n' +
    `<!-- gateflow:dispatch-id: ${CONSUMER_DISPATCH} -->\n\n` +
    '## Execution Plan\n\n### Objective\n\nDo the thing.\n';
  const TRACKER_BODY_WITH_DISPATCH =
    '<!-- ai-workflow:execution-tracker:v1 -->\n\n' +
    `<!-- gateflow:dispatch-id: ${EXECUTOR_DISPATCH} -->\n\n` +
    '**Status:** In Progress\n\n- [x] first\n';
  const REPORT_BODY_WITH_DISPATCH =
    '<!-- ai-workflow:completion-report:v1 -->\n\n' +
    `<!-- gateflow:dispatch-id: ${EXECUTOR_DISPATCH} -->\n\n` +
    '## Completion Report\n\nDone.\n';

  const planComment123: GateComment = {
    id: 123,
    user: 'consumer-bot',
    body: PLAN_BODY_WITH_DISPATCH,
  };
  const trackerComment124: GateComment = {
    id: 124,
    user: 'executor-bot',
    body: TRACKER_BODY_WITH_DISPATCH,
  };
  /**
   * The human /approve command comment (the approval record's anchor): the
   * V1.1 shared chain re-validates that the record still anchors to a real,
   * trusted-human command comment on the issue.
   */
  const approveCommand: GateComment = { id: 9001, user: 'owner-user', body: '/approve 123' };
  /** Approval record whose hash binds the DISPATCH-CARRYING plan body. */
  const approvalForDispatchPlan = (): GateComment =>
    approvalRecordComment({ plan_sha256: planSha256(PLAN_BODY_WITH_DISPATCH) });

  it('plan marker from the owner at PLANNING with a CURRENT consumer dispatch triggers T1 (PLANNING -> REVIEW)', async () => {
    const h = makeHarness({
      labels: [LABELS.planning],
      comments: [planComment123, epochRecordComment()],
    });
    const log = makeLogger();

    await runGate(
      makeInput({ commentBody: PLAN_BODY_WITH_DISPATCH, commentId: 123 }),
      h.client,
      log,
    );

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.review] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.planning }]);
    // V1.1: the T1 transition record precedes the label swap.
    expect(h.calls.order).toEqual(['addComment', 'addLabels', 'removeLabel']);
    const record = JSON.parse(
      (h.calls.addComment[0]?.body ?? '').split('```json')[1]?.split('```')[0] ?? '{}',
    ) as Record<string, unknown>;
    expect(record['kind']).toBe('gate_transition');
    expect(record['transition']).toBe('T1');
    expect(record['source_comment_id']).toBe(123);
    expect(record['dispatch_id']).toBe(CONSUMER_DISPATCH);
    expect(record['workflow_epoch']).toBe(WORKFLOW_EPOCH);
    expect(log.warnings).toEqual([]);
  });

  it('plan marker from a configured Trusted Agent triggers T1 too (agents may publish)', async () => {
    const h = makeHarness({
      labels: [LABELS.planning],
      comments: [planComment123, epochRecordComment()],
    });
    await runGate(
      makeInput({
        commentBody: PLAN_BODY_WITH_DISPATCH,
        commentId: 123,
        actor: 'ai-bot',
        trustedAgentsInput: 'ai-bot',
      }),
      h.client,
      makeLogger(),
    );
    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.review] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.planning }]);
  });

  it('V1.1: a plan marker WITHOUT a dispatch binding is a logged no-op (fake plan object)', async () => {
    const h = makeHarness({ labels: [LABELS.planning] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: PLAN_COMMENT_BODY, commentId: 123 }), h.client, log);

    expect(writeCount(h)).toBe(0);
    expect(log.warnings.some((m) => m.includes('no gateflow dispatch-id comment'))).toBe(true);
  });

  it('V1.1: a plan marker whose dispatch binds an OLD epoch cannot trigger T1', async () => {
    const oldEpochPlan: GateComment = {
      id: 123,
      user: 'consumer-bot',
      body: PLAN_BODY_WITH_DISPATCH.replace('wqrdeh6k30m1z', 'waaaaabbbbbcc'),
    };
    const h = makeHarness({
      labels: [LABELS.planning],
      comments: [oldEpochPlan, epochRecordComment()],
    });
    const log = makeLogger();

    await runGate(
      makeInput({ commentBody: oldEpochPlan.body, commentId: 123 }),
      h.client,
      log,
    );

    expect(writeCount(h)).toBe(0);
    expect(log.warnings.some((m) => m.includes('is not the current epoch'))).toBe(true);
  });

  it('plan marker from an unknown actor is plain text: no transition, no writes, no API reads', async () => {
    const h = makeHarness({ labels: [LABELS.planning] });
    const log = makeLogger();

    await runGate(
      makeInput({ commentBody: PLAN_BODY_WITH_DISPATCH, actor: 'external-user' }),
      h.client,
      log,
    );

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
      await runGate(makeInput({ commentBody: PLAN_BODY_WITH_DISPATCH }), h.client, makeLogger());
      expect(writeCount(h)).toBe(0);
    }
  });

  it('V1.1: execution-tracker marker at READY with the CURRENT executor chain triggers T3 (READY -> WORKING)', async () => {
    const h = makeHarness({
      labels: [LABELS.ready],
      comments: [
        planComment123,
        epochRecordComment(),
        approveCommand,
        approvalForDispatchPlan(),
        trackerComment124,
      ],
    });
    const log = makeLogger();

    await runGate(
      makeInput({ commentBody: TRACKER_BODY_WITH_DISPATCH, commentId: 124 }),
      h.client,
      log,
    );

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.working] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.ready }]);
    expect(h.calls.order).toEqual(['addComment', 'addLabels', 'removeLabel']);
    const record = JSON.parse(
      (h.calls.addComment[0]?.body ?? '').split('```json')[1]?.split('```')[0] ?? '{}',
    ) as Record<string, unknown>;
    expect(record['transition']).toBe('T3');
    expect(record['dispatch_id']).toBe(EXECUTOR_DISPATCH);
    expect(log.warnings).toEqual([]);
  });

  it('V1.1: a tracker WITHOUT a valid approval record cannot trigger T3 (no approval, no WORKING)', async () => {
    const h = makeHarness({
      labels: [LABELS.ready],
      comments: [planComment123, epochRecordComment(), trackerComment124],
    });
    const log = makeLogger();

    await runGate(
      makeInput({ commentBody: TRACKER_BODY_WITH_DISPATCH, commentId: 124 }),
      h.client,
      log,
    );

    expect(writeCount(h)).toBe(0);
    expect(
      log.warnings.some((m) => m.includes('no valid Gate-issued approval record binds')),
    ).toBe(true);
  });

  it('V1.1: a tracker whose dispatch binds an OLD round (superseded epoch) cannot trigger T3', async () => {
    const oldTracker: GateComment = {
      ...trackerComment124,
      body: TRACKER_BODY_WITH_DISPATCH.replace('wqrdeh6k30m1z', 'waaaaabbbbbcc'),
    };
    const h = makeHarness({
      labels: [LABELS.ready],
      comments: [
        planComment123,
        epochRecordComment(),
        approveCommand,
        approvalForDispatchPlan(),
        oldTracker,
      ],
    });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: oldTracker.body, commentId: 124 }), h.client, log);

    expect(writeCount(h)).toBe(0);
    expect(log.warnings.some((m) => m.includes('is not the current epoch'))).toBe(true);
  });

  it('execution-tracker marker in a wrong state is a no-op', async () => {
    for (const labels of [[LABELS.planning], [LABELS.review], [LABELS.done]]) {
      const h = makeHarness({ labels });
      await runGate(
        makeInput({ commentBody: TRACKER_BODY_WITH_DISPATCH, commentId: 124 }),
        h.client,
        makeLogger(),
      );
      expect(writeCount(h)).toBe(0);
    }
  });

  it('V1.1: completion-report marker at WORKING with the executor chain AND its tracker triggers T6 (WORKING -> DONE)', async () => {
    const reportComment: GateComment = {
      id: 125,
      user: 'executor-bot',
      body: REPORT_BODY_WITH_DISPATCH,
    };
    const h = makeHarness({
      labels: [LABELS.working],
      comments: [
        planComment123,
        epochRecordComment(),
        approveCommand,
        approvalForDispatchPlan(),
        trackerComment124,
        reportComment,
      ],
    });
    const log = makeLogger();

    await runGate(
      makeInput({ commentBody: REPORT_BODY_WITH_DISPATCH, commentId: 125 }),
      h.client,
      log,
    );

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.done] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.working }]);
    const record = JSON.parse(
      (h.calls.addComment[0]?.body ?? '').split('```json')[1]?.split('```')[0] ?? '{}',
    ) as Record<string, unknown>;
    expect(record['transition']).toBe('T6');
    expect(record['dispatch_id']).toBe(EXECUTOR_DISPATCH);
    expect(record['source_comment_id']).toBe(125);
    expect(log.warnings).toEqual([]);
  });

  it('V1.1: an ORPHAN report (no tracker for its dispatch) can never trigger DONE', async () => {
    const reportComment: GateComment = {
      id: 125,
      user: 'executor-bot',
      body: REPORT_BODY_WITH_DISPATCH,
    };
    const h = makeHarness({
      labels: [LABELS.working],
      comments: [
        planComment123,
        epochRecordComment(),
        approveCommand,
        approvalForDispatchPlan(),
        reportComment,
      ],
    });
    const log = makeLogger();

    await runGate(
      makeInput({ commentBody: REPORT_BODY_WITH_DISPATCH, commentId: 125 }),
      h.client,
      log,
    );

    expect(writeCount(h)).toBe(0);
    expect(log.warnings.some((m) => m.includes('orphan report'))).toBe(true);
  });

  it('completion-report marker in a wrong state is a no-op (DONE is terminal, no T6 repeat)', async () => {
    for (const labels of [[LABELS.ready], [LABELS.done], [LABELS.blocked]]) {
      const h = makeHarness({ labels });
      await runGate(
        makeInput({ commentBody: REPORT_BODY_WITH_DISPATCH, commentId: 125 }),
        h.client,
        makeLogger(),
      );
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
          commentBody:
            '## AI Discussion Summary\n\nMore context.\n\n<!-- ai-workflow:append:v1 -->',
        }),
        h.client,
        log,
      );

      expect(writeCount(h)).toBe(0);
      expect(log.warnings).toEqual([]);
    }
  });

  it('duplicate plan marker delivery: second run re-reads REVIEW and no-ops', async () => {
    const h = makeHarness({
      labels: [LABELS.planning],
      comments: [planComment123, epochRecordComment()],
    });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: PLAN_BODY_WITH_DISPATCH, commentId: 123 }), h.client, log);
    await runGate(makeInput({ commentBody: PLAN_BODY_WITH_DISPATCH, commentId: 123 }), h.client, log);

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.review] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.planning }]);
    expect(log.warnings.some((m) => m.includes('current state is REVIEW'))).toBe(true);
  });

  it('markers on a closed issue are ignored (closed is terminal)', async () => {
    const h = makeHarness({ labels: [LABELS.planning], state: 'closed' });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: PLAN_BODY_WITH_DISPATCH, commentId: 123 }), h.client, log);

    expect(h.calls.getIssue).toBe(1);
    expect(h.calls.getLabels).toBe(0);
    expect(writeCount(h)).toBe(0);
    expect(log.warnings).toEqual([]);
  });
});

describe('Phase 2: issue body schema block is observability metadata only', () => {
  // Schema 2: the Producer block now carries the upgraded protocol version.
  const SCHEMA_BODY =
    '<!-- ai-workflow\nschema: 2\nsource: producer\nkind: feature\nmaturity_hint: solution\n-->';

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
        issueBody: '<!-- ai-workflow\nschema: 2\nsource: producer\nkind: feature\nmaturity_hint: vibes\n-->',
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
    const h = makeHarness({ labels: [LABELS.review], comments: recoveryComments() });
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

  it('a comment event without a comment id still migrates via /cancel and only warns (missing reaction target)', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/cancel', commentId: undefined }), h.client, log);

    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
    expect(log.warnings.some((m) => m.includes('no comment id'))).toBe(true);
  });
});

/* -------------------------------------- V1: plan-ID bound approval (3.4) */

describe('V1: /approve is bound to the current plan comment (protocol 3.4)', () => {
  const planComment = (id: number, body = PLAN_COMMENT_BODY, user = 'consumer-bot'): GateComment => ({
    id,
    user,
    body,
  });
  const plainComment = (id: number, body: string, user = 'bystander'): GateComment => ({
    id,
    user,
    body,
  });

  it('valid approval: REVIEW + referenced comment exists / is a plan marker / is the LAST one -> labels swapped + ✅', async () => {
    const h = makeHarness({ labels: [LABELS.review], comments: recoveryComments() });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 123' }), h.client, log);

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
    // V1.1: the T2 transition record is persisted before the label swap.
    expect(h.calls.order).toEqual(['addComment', 'addLabels', 'removeLabel']);
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '+1' }]);
    expect(h.calls.listComments).toBe(1); // exactly one comment-list read per approve handling
    // fetched with the parsed id + the V1.1 transition-record verification
    expect(h.calls.getComment).toEqual([{ commentId: 123 }, { commentId: 10001 }]);
    expect(log.warnings).toEqual([]);
    expect(log.infos.some((m) => m.includes('T2 on #7') && m.includes('approving plan comment 123'))).toBe(
      true,
    );
  });

  it('approving an OLD plan (a newer plan-marker comment exists) is a logged no-op without reaction', async () => {
    const h = makeHarness({
      labels: [LABELS.review],
      comments: [planComment(123), planComment(456)],
    });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 123' }), h.client, log);

    expect(writeCount(h)).toBe(0); // no transition, no reaction
    expect(h.calls.addComment).toEqual([]); // and no record either
    expect(h.calls.addLabels).toEqual([]);
    expect(h.calls.removeLabel).toEqual([]);
    expect(h.calls.addReaction).toEqual([]);
    expect(h.calls.listComments).toBe(1);
    expect(h.calls.getComment).toEqual([{ commentId: 123 }]);
    expect(log.warnings.some((m) => m.includes('not-current-plan') && m.includes('123'))).toBe(true);
  });

  it('approving the NEWEST plan binds the record to that plan id (sha256 + operation id), before any label write', async () => {
    const h = makeHarness({
      labels: [LABELS.review],
      comments: [planComment(123), planComment(456)],
    });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 456' }), h.client, log);

    // The approval record is published and bound to plan comment 456 ...
    expect(h.calls.addComment).toHaveLength(2); // approval record + T2 transition record (V1.1)
    const body = h.calls.addComment[0]?.body ?? '';
    expect(body).toContain('<!-- gateflow:approval:v2 -->');
    expect(body).toContain(`"plan_sha256": "${planSha256(PLAN_COMMENT_BODY)}"`);
    expect(body).toContain('"plan_comment_id": 456');
    expect(body).toContain(`"operation_id": "${approvalOperationId(123, 7, WORKFLOW_EPOCH, 456)}"`);
    expect(body).toContain('"approval_command_comment_id": 9001');
    expect(body).toContain('"approved_by_login": "owner-user"');
    expect(body).toContain('"approved_by_id": 1001');
    expect(body).toContain(`"gate_login": "${GATE_IDENTITY.login}"`);
    // ... the records are verified in place BEFORE any label write, then T2
    // completes with the ✅ reaction (V1.1: approval record first, then the
    // gate_transition record, then the label swap).
    expect(h.calls.order).toEqual(['addComment', 'addComment', 'addLabels', 'removeLabel']);
    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '+1' }]);
    expect(log.warnings).toEqual([]);
  });

  it('approving a non-plan comment is a logged no-op (membership unverifiable via the plan list)', async () => {
    const h = makeHarness({
      labels: [LABELS.review],
      comments: [planComment(123), plainComment(777, 'just a question about the repo')],
    });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 777' }), h.client, log);

    expect(writeCount(h)).toBe(0);
    expect(h.calls.addComment).toEqual([]);
    expect(log.warnings.some((m) => m.includes('comment-on-other-issue') && m.includes('777'))).toBe(true);
  });

  it('the marker of the referenced comment must be a PLAN marker (a tracker comment is rejected)', async () => {
    const h = makeHarness({
      labels: [LABELS.review],
      comments: [
        planComment(123),
        {
          id: 778,
          user: 'executor-bot',
          body: '## Execution Tracker\n\n**Status:** In Progress\n\n<!-- ai-workflow:execution-tracker:v1 -->',
        },
      ],
    });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 778' }), h.client, log);

    expect(writeCount(h)).toBe(0);
    expect(h.calls.addComment).toEqual([]);
    expect(log.warnings.some((m) => m.includes('778'))).toBe(true);
  });

  it('approving a missing comment (getComment 404 -> null) is a logged no-op', async () => {
    const h = makeHarness({ labels: [LABELS.review], comments: [planComment(123)] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 99999' }), h.client, log);

    expect(writeCount(h)).toBe(0);
    expect(h.calls.getComment).toEqual([{ commentId: 99999 }]);
    expect(h.calls.addComment).toEqual([]);
    expect(log.warnings.some((m) => m.includes('comment-not-found') && m.includes('99999'))).toBe(true);
  });

  it('approve in a wrong state (PLANNING) is the unchanged no-op and never consults the comment API', async () => {
    const h = makeHarness({ labels: [LABELS.planning] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 123' }), h.client, log);

    expect(writeCount(h)).toBe(0);
    expect(h.calls.listComments).toBe(0);
    expect(h.calls.getComment).toEqual([]);
    expect(log.warnings.some((m) => m.includes('requires REVIEW'))).toBe(true);
  });

  it('a non-trusted human "/approve 123" still gets exactly one 👎 and zero comment reads', async () => {
    const h = makeHarness({ labels: [LABELS.review] });

    await runGate(makeInput({ commentBody: '/approve 123', actor: 'external-user' }), h.client, makeLogger());

    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '-1' }]);
    expect(h.calls.addLabels).toEqual([]);
    expect(h.calls.removeLabel).toEqual([]);
    expect(h.calls.listComments).toBe(0);
    expect(h.calls.getComment).toEqual([]);
  });

  it('plan-marker comments are found regardless of their position in the store (id-chronological current plan)', async () => {
    const h = makeHarness({
      labels: [LABELS.review],
      comments: [
        plainComment(200, 'later chatter'),
        planComment(123),
        plainComment(50, 'early chatter'),
        epochRecordComment(45),
        approvalRecordComment({}, 46),
      ],
    });

    await runGate(makeInput({ commentBody: '/approve 123' }), h.client, makeLogger());

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
  });
});

/* --------------------------------- Schema 2: identity config (GF-H10) */

describe('Schema 2: identity configuration is validated first, fail closed (GF-H10)', () => {
  it('an Organization-owned repository without trusted-humans fails the whole run', async () => {
    const h = makeHarness({ labels: [LABELS.review], ownerType: 'Organization' });
    const log = makeLogger();

    await expect(runGate(makeInput(), h.client, log)).rejects.toThrow(
      'gate identity configuration rejected',
    );

    // The owner TYPE was verified against the API, not the event payload.
    expect(h.calls.getRepoIdentity).toBe(1);
    expect(h.calls.getIssue).toBe(0);
    expect(writeCount(h)).toBe(0);
    expect(h.calls.addComment).toEqual([]);
  });

  it('require-explicit-humans: false lets an Organization repository run (knowing risk)', async () => {
    const h = makeHarness({ labels: [], ownerType: 'Organization' });
    const log = makeLogger();

    await runGate(
      makeInput({
        commentBody: '/ai-plan',
        requireExplicitHumansInput: 'false',
        // V1.1 (Phase 9): an Organization owner is NEVER an Effective Trusted
        // Human by default — only an explicitly allowlisted human may command.
        actor: 'maintainer-1',
        trustedHumansInput: 'maintainer-1',
      }),
      h.client,
      log,
    );

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.planning] }]);
    expect(log.warnings.some((m) => m.includes('identity configuration rejected'))).toBe(false);
  });

  it('an Organization owner is NOT a Trusted Human by default (V1.1 shared resolver)', async () => {
    const h = makeHarness({ labels: [], ownerType: 'Organization' });
    const log = makeLogger();

    await runGate(
      makeInput({ commentBody: '/ai-plan', requireExplicitHumansInput: 'false' }),
      h.client,
      log,
    );

    expect(h.calls.addLabels).toEqual([]);
    expect(h.calls.removeLabel).toEqual([]);
    expect(h.calls.addComment).toEqual([]);
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '-1' }]);
  });

  it('an Organization repository with an explicit humans allowlist approves through a valid record', async () => {
    const h = makeHarness({
      labels: [LABELS.review],
      ownerType: 'Organization',
      comments: [
        DEFAULT_PLAN_COMMENT,
        epochRecordComment(),
        approvalRecordComment({ approved_by_login: 'maintainer-1' }),
      ],
    });

    await runGate(
      makeInput({ actor: 'maintainer-1', trustedHumansInput: 'maintainer-1' }),
      h.client,
      makeLogger(),
    );

    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
  });

  it('overlapping Human/Agent allowlists fail the run (the roles must never share a login)', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();

    await expect(
      runGate(
        makeInput({ trustedHumansInput: 'ci-bot', trustedAgentsInput: 'ci-bot' }),
        h.client,
        log,
      ),
    ).rejects.toThrow('gate identity configuration rejected');

    expect(writeCount(h)).toBe(0);
    expect(h.calls.getIssue).toBe(0);
  });
});

/* --------------------------------- Schema 2: fresh record publication */

describe('Schema 2: /approve publishes the approval record BEFORE any label write', () => {
  it('a FRESH /approve publishes the record, then completes T2 with ✅', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 123' }), h.client, log);

    // The record comment WAS created, bound to repo/issue/epoch/plan/command.
    expect(h.calls.addComment).toHaveLength(2); // approval record + T2 transition record (V1.1)
    const body = h.calls.addComment[0]?.body ?? '';
    expect(body).toContain('<!-- gateflow:approval:v2 -->');
    expect(body).toContain('"schema": 2');
    expect(body).toContain(`"plan_sha256": "${planSha256(PLAN_COMMENT_BODY)}"`);
    expect(body).toContain('"plan_comment_id": 123');
    expect(body).toContain(`"operation_id": "${approvalOperationId(123, 7, WORKFLOW_EPOCH, 123)}"`);
    // Records verified in place → the authorization is granted: the label
    // migration runs AFTER the records, then the ✅ reaction.
    expect(h.calls.addLabels).toEqual([{ labels: [LABELS.ready] }]);
    expect(h.calls.removeLabel).toEqual([{ label: LABELS.review }]);
    expect(h.calls.order).toEqual(['addComment', 'addComment', 'addLabels', 'removeLabel']);
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '+1' }]);
    expect(log.warnings).toEqual([]);
  });

  it('a record write failure (addComment rejects) grants nothing: no label migration, no reaction', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const failingAddComment = vi.fn(async () => {
      throw new Error('500 comment write failed');
    });
    h.client.addComment = failingAddComment;
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 123' }), h.client, log);

    expect(failingAddComment).toHaveBeenCalledTimes(1); // the attempt happened
    expect(h.calls.addLabels).toEqual([]); // no migration ...
    expect(h.calls.removeLabel).toEqual([]);
    expect(h.calls.addReaction).toEqual([]); // ... and no ✅
    expect(log.warnings.some((m) => m.includes('approval record publish failed') && m.includes('500'))).toBe(
      true,
    );
  });

  it('/approve without an epoch record on the issue fails closed (no record, no transition)', async () => {
    const h = makeHarness({ labels: [LABELS.review], seedEpoch: false });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 123' }), h.client, log);

    expect(h.calls.addComment).toEqual([]);
    expect(writeCount(h)).toBe(0);
    expect(log.warnings.some((m) => m.includes('no workflow_epoch record'))).toBe(true);
  });

  it('a tampered (unparsable) epoch record fails /approve closed', async () => {
    const h = makeHarness({
      labels: [LABELS.review],
      comments: [
        DEFAULT_PLAN_COMMENT,
        {
          id: 45,
          user: 'attacker',
          body: '<!-- gateflow:workflow:v2 -->\n\n```json\n{"kind": "workflow_epoch"}\n```\n',
        },
      ],
    });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 123' }), h.client, log);

    expect(h.calls.addComment).toEqual([]);
    expect(writeCount(h)).toBe(0);
    expect(log.warnings.some((m) => m.includes('unparsable workflow_epoch record'))).toBe(true);
  });

  it('/approve without a comment id cannot anchor the command: fail closed, no record', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/approve 123', commentId: undefined }), h.client, log);

    expect(h.calls.addComment).toEqual([]);
    expect(writeCount(h)).toBe(0);
    expect(log.warnings.some((m) => m.includes('no comment id'))).toBe(true);
  });
});

describe('Schema 2: /choose and /change publish feedback_accepted records', () => {
  it('a FRESH /choose publishes the feedback record and is accepted with ✅', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/choose 1 B' }), h.client, log);

    expect(h.calls.addComment).toHaveLength(1);
    const body = h.calls.addComment[0]?.body ?? '';
    expect(body).toContain('<!-- gateflow:feedback:v2 -->');
    expect(body).toContain('"schema": 2');
    expect(body).toContain('"kind": "feedback_accepted"');
    expect(body).toContain('"feedback_kind": "choose"');
    expect(body).toContain('"event_id": "fe9001"');
    expect(body).toContain(`"operation_id": "${feedbackOperationId(123, 7, WORKFLOW_EPOCH, 9001)}"`);
    // The record verified in place → the event is accepted: ✅ + forwarding.
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '+1' }]);
    expect(log.warnings).toEqual([]);
    expect(log.infos.some((m) => m.includes('question "1"') && m.includes('choice "B"'))).toBe(true);
  });

  it('a FRESH /change publishes its feedback record bound to the command comment', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/change please reconsider' }), h.client, log);

    expect(h.calls.addComment).toHaveLength(1);
    const body = h.calls.addComment[0]?.body ?? '';
    expect(body).toContain('"feedback_kind": "change"');
    expect(body).toContain('"schema": 2');
    expect(h.calls.addReaction).toEqual([{ commentId: 9001, content: '+1' }]);
    expect(log.warnings).toEqual([]);
  });

  it('duplicate delivery of an accepted event is idempotent (no second record, ✅ again)', async () => {
    const h = makeHarness({ labels: [LABELS.review] });
    const log = makeLogger();

    await runGate(makeInput({ commentBody: '/choose 1 B' }), h.client, log);
    await runGate(makeInput({ commentBody: '/choose 1 B' }), h.client, log);

    expect(h.calls.addComment).toHaveLength(1); // accepted record created once
    expect(h.calls.addReaction).toEqual([
      { commentId: 9001, content: '+1' },
      { commentId: 9001, content: '+1' },
    ]);
    expect(log.warnings).toEqual([]);
  });
});
