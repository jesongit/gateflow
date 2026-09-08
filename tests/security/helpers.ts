/**
 * Local fixtures for the SECURITY (adversarial) suite.
 *
 * Driver-side fakes are imported read-only from tests/driver/helpers.ts.
 * The gate fake (commentStore + full write tracking) is rebuilt here because
 * tests/gate/gate.test.ts keeps its harness file-local. Every fake records
 * ALL writes so each attack can assert "rejection AND no side effect".
 */
import { mkdir, symlink } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { CommentDetail, IssueDetail } from '../../src/github/client';
import type { WorkspacePaths } from '../../src/workspace/paths';
import type { GateComment } from '../../src/gate/approvals';
import type { AuthenticatedUser, GitHubClient, ReactionContent, RepoIdentity } from '../../src/gate/github';
import type { GateInput, GateLogger } from '../../src/gate/gate';
import type { FakeDriverClient, WorkspaceFixture } from '../driver/helpers';
import type { Discovery } from '../../src/driver/discovery';
import { LABELS } from '../../src/gate/protocol';
import { atomicWriteJson } from '../../src/workspace/inbox';
import { deriveIntents } from '../../src/driver/intent';
import { acceptedFeedbackEvents, readIssueRecords } from '../../src/github/issue-sync';
import { epochCode } from '../../src/protocol/epoch';
import { ISSUE, testEpoch, writeOutboxFile } from '../driver/helpers';

export { ISSUE, OWNER, REPO } from '../driver/helpers';
export type { WorkspaceFixture };

/** The deterministic test epoch for issue 7 and the dispatch ids built on it. */
export const EPOCH = testEpoch(ISSUE);

/** Standard dispatch ids for issue 7 in repo octo/repo (id 123) — schema 2. */
export const CONSUMER_ID = `gf_r123_i${ISSUE}_w${epochCode(EPOCH)!}_consumer_01`;
export const EXECUTOR_ID = `gf_r123_i${ISSUE}_w${epochCode(EPOCH)!}_executor_p501`;

/** Seed a valid inbox dispatch.json + context.json (the Driver's own layout). */
export async function seedInbox(
  fixture: WorkspaceFixture,
  dispatchId: string,
  role: 'consumer' | 'executor',
): Promise<void> {
  const dispatch = {
    schema: 2,
    dispatch_id: dispatchId,
    repository: 'octo/repo',
    repository_id: 123,
    issue_number: ISSUE,
    workflow_epoch: EPOCH,
    role,
    reason: role === 'executor' ? 'approved_plan' : 'planning',
    created_at: '2026-09-06T17:00:00Z',
    plan_comment_id: role === 'executor' ? 501 : null,
    approval_comment_id: role === 'executor' ? 601 : null,
    input:
      role === 'executor'
        ? { task: 'TASK.md', plan: 'PLAN.md', feedback: null }
        : { task: 'TASK.md', plan: null, feedback: null },
  } as const;
  const context = {
    schema: 2,
    dispatch_id: dispatchId,
    workflow_epoch: EPOCH,
    ...(role === 'executor' ? { plan_comment_id: 501, plan_sha256: 'a'.repeat(64) } : {}),
    feedback_count: 0,
    input_snapshot_sha256: 'b'.repeat(64),
  } as const;
  await atomicWriteJson(nodePath.join(fixture.paths.inbox, dispatchId, 'dispatch.json'), dispatch);
  await atomicWriteJson(nodePath.join(fixture.paths.inbox, dispatchId, 'context.json'), context);
}

/** Write a JSON outbox file (the attacker's channel). */
export async function writeOutboxJson(
  paths: WorkspacePaths,
  dispatchId: string,
  name: string,
  value: unknown,
): Promise<void> {
  await writeOutboxFile(paths, dispatchId, name, JSON.stringify(value, null, 2));
}

/** Write a raw (possibly malformed) outbox file: the attacker's raw channel. */
export async function writeOutboxRaw(
  paths: WorkspacePaths,
  dispatchId: string,
  name: string,
  content: string,
): Promise<void> {
  await writeOutboxFile(paths, dispatchId, name, content);
}

/** FakeDriverClient instrumented with read/write counters. */
export type CountedDriverClient = FakeDriverClient & { reads: number; writes: number };

/**
 * Wrap a FakeDriverClient so tests can assert "zero GitHub writes / reads".
 * Mutates only the instance (never the class) — the underlying fake behavior
 * is preserved via bound originals.
 */
export function countedClient(client: FakeDriverClient): CountedDriverClient {
  const tracked: CountedDriverClient = client as CountedDriverClient;
  tracked.reads = 0;
  tracked.writes = 0;
  const addIssueComment = client.addIssueComment.bind(client);
  const updateIssueComment = client.updateIssueComment.bind(client);
  const listComments = client.listComments.bind(client);
  const getIssue = client.getIssue.bind(client);
  client.addIssueComment = async (ref, body) => {
    tracked.writes += 1;
    return addIssueComment(ref, body);
  };
  client.updateIssueComment = async (ref, commentId, body) => {
    tracked.writes += 1;
    return updateIssueComment(ref, commentId, body);
  };
  client.listComments = async (ref) => {
    tracked.reads += 1;
    return listComments(ref);
  };
  client.getIssue = async (ref) => {
    tracked.reads += 1;
    return getIssue(ref);
  };
  return tracked;
}

/* ------------------------------------------------------------- gate fakes */

/** The Gate identity served by the harness (LOGIN-regex-safe). */
export const GATE_IDENTITY: AuthenticatedUser = { id: 41898282, login: 'gate-bot' };

/** Default API-verified repository identity (GF-H10). */
export const DEFAULT_REPO_IDENTITY: RepoIdentity = {
  owner: 'owner-user',
  ownerType: 'User',
  id: 123,
};

/** Every call the gate could ever make, fully recorded. */
export interface GateCallStats {
  order: string[];
  getIssue: number;
  getLabels: number;
  getComment: Array<{ commentId: number }>;
  listComments: number;
  addLabels: Array<{ labels: string[] }>;
  removeLabel: Array<{ label: string }>;
  addReaction: Array<{ commentId: number; content: string }>;
  editComment: Array<{ commentId: number; body: string }>;
  addComment: Array<{ body: string }>;
  getAuthenticatedUser: number;
  getRepoIdentity: number;
}

export interface GateHarness {
  client: GitHubClient;
  calls: GateCallStats;
  issueState: string;
  /** Labels returned by getIssue (the stale event-era snapshot). */
  issueLabels: string[];
  /** Labels returned by getLabels (the fresh re-read the gate must use). */
  labelStore: string[];
  commentStore: GateComment[];
  repoIdentity: RepoIdentity;
  gateIdentity: AuthenticatedUser;
  setLabelStore(labels: string[]): void;
  setComments(comments: GateComment[]): void;
}

export function makeGateHarness(
  options: {
    labels?: string[];
    state?: string;
    comments?: GateComment[];
    ownerType?: string;
  } = {},
): GateHarness {
  const calls: GateCallStats = {
    order: [],
    getIssue: 0,
    getLabels: 0,
    getComment: [],
    listComments: 0,
    addLabels: [],
    removeLabel: [],
    addReaction: [],
    editComment: [],
    addComment: [],
    getAuthenticatedUser: 0,
    getRepoIdentity: 0,
  };
  const h: GateHarness = {
    calls,
    issueState: options.state ?? 'open',
    issueLabels: [...(options.labels ?? [LABELS.review])],
    labelStore: [...(options.labels ?? [LABELS.review])],
    commentStore: [...(options.comments ?? [])],
    repoIdentity: { ...DEFAULT_REPO_IDENTITY, ownerType: options.ownerType ?? 'User' },
    gateIdentity: { ...GATE_IDENTITY },
    setLabelStore(labels: string[]) {
      h.labelStore = [...labels];
    },
    setComments(comments: GateComment[]) {
      h.commentStore = [...comments];
    },
    client: {
      async getIssue() {
        calls.getIssue += 1;
        return { state: h.issueState, labels: [...h.issueLabels] };
      },
      async getLabels() {
        calls.getLabels += 1;
        return [...h.labelStore];
      },
      async addLabels(_ref, labels) {
        calls.order.push('addLabels');
        calls.addLabels.push({ labels: [...labels] });
        h.labelStore = [...new Set([...h.labelStore, ...labels])];
      },
      async removeLabel(_ref, label) {
        calls.order.push('removeLabel');
        calls.removeLabel.push({ label });
        h.labelStore = h.labelStore.filter((l) => l !== label);
      },
      async addReaction(_ref, commentId, content: ReactionContent) {
        calls.addReaction.push({ commentId, content });
      },
      async editComment(_ref, commentId, body) {
        calls.editComment.push({ commentId, body });
      },
      async getComment(_ref, commentId) {
        calls.getComment.push({ commentId });
        const found = h.commentStore.find((c) => c.id === commentId);
        return found === undefined ? null : { ...found };
      },
      async listComments() {
        calls.listComments += 1;
        return [...h.commentStore].sort((a, b) => a.id - b.id);
      },
      async addComment(_ref, body) {
        calls.order.push('addComment');
        calls.addComment.push({ body });
        // Faithful GitHub simulation: the comment exists afterwards, authored
        // by the Gate identity.
        h.commentStore.push({ id: 10000 + calls.addComment.length, user: GATE_IDENTITY.login, body });
        return { id: 10000 + calls.addComment.length };
      },
      async getAuthenticatedUser() {
        calls.getAuthenticatedUser += 1;
        return { ...h.gateIdentity };
      },
      async getRepoIdentity(query) {
        calls.getRepoIdentity += 1;
        return { ...h.repoIdentity, owner: query.owner };
      },
    },
  };
  return h;
}

/** Every write operation the gate could ever perform. */
export function gateWriteCount(h: GateHarness): number {
  return (
    h.calls.addLabels.length +
    h.calls.removeLabel.length +
    h.calls.addReaction.length +
    h.calls.editComment.length
  );
}

export function makeGateInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    eventName: 'issue_comment',
    eventAction: 'created',
    actor: 'owner-user',
    actorId: 1001,
    repositoryId: 123,
    repoOwner: 'owner-user',
    repo: 'demo',
    issueNumber: 7,
    commentId: 9001,
    commentBody: '/approve 123',
    trustedHumansInput: '',
    trustedAgentsInput: '',
    ...overrides,
  };
}

export function gateLogger(): GateLogger & { infos: string[]; warnings: string[] } {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    infos,
    warnings,
    info: (message) => infos.push(message),
    warning: (message) => warnings.push(message),
  };
}

/* ----------------------------------------------- canonical state builders */

export function issue(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    number: ISSUE,
    title: 'Add dark mode',
    body: 'Please add dark mode.',
    state: 'open',
    labels: ['ai:planning'],
    updatedAt: '2026-09-06T10:00:00Z',
    ...overrides,
  };
}

export function comment(
  id: number,
  user: string,
  body: string,
  overrides: Partial<CommentDetail> = {},
): CommentDetail {
  return {
    id,
    user,
    body,
    createdAt: '2026-09-06T11:00:00Z',
    updatedAt: '2026-09-06T11:00:00Z',
    ...overrides,
  };
}

/* -------------------------------------------------------- symlink probing */

/**
 * Best-effort directory symlink/junction creation. Returns null when the
 * platform refuses (privileges required), so tests can skip gracefully.
 * Junctions are tried first on Windows: they need no elevated shell.
 */
export async function trySymlinkDir(target: string, linkPath: string): Promise<boolean> {
  await mkdir(nodePath.dirname(linkPath), { recursive: true });
  const types: Array<'dir' | 'junction'> =
    process.platform === 'win32' ? ['junction', 'dir'] : ['dir'];
  for (const type of types) {
    try {
      await symlink(target, linkPath, type);
      return true;
    } catch {
      // Fall through and try the next link type.
    }
  }
  return false;
}

/* --------------------------------------------------- discovery (decoupled) */

/**
 * Build a `Discovery` for one issue WITHOUT routing through the
 * `DriverGitHubClient`-typed helper: the security suite derives intents and
 * accepted feedback from plain data with the same pure functions discovery.ts
 * uses, so the tests stay decoupled from the (evolving) client interface.
 * `gateLogins` defaults to the standard Gate allowlist.
 */
export function buildDiscovery(
  issueDetail: IssueDetail,
  comments: CommentDetail[],
  trustedHumans: ReadonlySet<string>,
  repoOwner: string,
  options: {
    gateLogins?: ReadonlySet<string>;
    bootstrapIssuers?: ReadonlySet<string>;
    repositoryId?: number;
  } = {},
): Discovery {
  const gateLogins = options.gateLogins ?? new Set(['github-actions[bot]']);
  const records = readIssueRecords(comments, gateLogins);
  return {
    issue: issueDetail,
    comments,
    records,
    intents: deriveIntents(issueDetail, comments, {
      repositoryId: options.repositoryId ?? 123,
      repoOwner,
      trustedHumans,
      gateLogins,
      bootstrapIssuers: options.bootstrapIssuers ?? new Set<string>(),
    }),
    feedback: acceptedFeedbackEvents(records, comments, trustedHumans, repoOwner),
  };
}
