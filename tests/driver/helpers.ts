/**
 * Shared fixtures for driver tests: a disposable workspace, an in-memory
 * DriverGitHubClient fake (no real GitHub API is ever touched) and a config
 * builder matching docs/workspace-protocol.md §10 defaults.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import type {
  CommentDetail,
  DriverGitHubClient,
  DriverReactionContent,
  IssueDetail,
  IssueRef,
  RepositoryInfo,
} from '../../src/github/client';
import type { DriverConfig } from '../../src/driver/config';
import type { DriverDeps, DriverLogger } from '../../src/driver/driver';
import { resolveWorkspace, ensureWorkspace } from '../../src/workspace/paths';
import type { WorkspacePaths } from '../../src/workspace/paths';

export { CREATED_AT, UPDATED_AT } from '../workspace/helpers';

/** A disposable workspace with all directories created. */
export interface WorkspaceFixture {
  projectRoot: string;
  paths: WorkspacePaths;
  cleanup: () => Promise<void>;
}

/** Temp workspace under os.tmpdir (mirrors tests/workspace/helpers.ts). */
export async function makeWorkspace(): Promise<WorkspaceFixture> {
  const projectRoot = await mkdtemp(nodePath.join(tmpdir(), 'gateflow-driver-'));
  const paths = resolveWorkspace(projectRoot);
  await ensureWorkspace(paths);
  return {
    projectRoot,
    paths,
    cleanup: async () => {
      await rm(projectRoot, { recursive: true, force: true });
    },
  };
}

/** Issue with its comments, as stored inside the fake client. */
export type FakeIssue = IssueDetail & { comments: CommentDetail[] };

/**
 * In-memory DriverGitHubClient: Map<issueNumber, issue+comments>, ascending
 * comment ids, addIssueComment appends, updateIssueComment mutates in place.
 */
export class FakeDriverClient implements DriverGitHubClient {
  readonly repository: RepositoryInfo;
  readonly issues = new Map<number, FakeIssue>();
  /** Login the fake uses for Driver-published comments. */
  botUser = 'gateflow-driver[bot]';
  private commentSeq = 1000;

  constructor(repository: Partial<RepositoryInfo> = {}) {
    this.repository = { id: 123, owner: 'octo', name: 'repo', ...repository };
  }

  /** Register an issue; returns the stored record for further mutation. */
  addIssue(number: number, overrides: Partial<IssueDetail> = {}): FakeIssue {
    const issue: FakeIssue = {
      number,
      title: `Issue ${number}`,
      body: 'Do the thing.',
      state: 'open',
      labels: [],
      updatedAt: '2026-09-06T10:00:00Z',
      comments: [],
      ...overrides,
    };
    this.issues.set(number, issue);
    return issue;
  }

  /** Append a comment with an auto-incrementing id (ascending order). */
  addComment(
    issueNumber: number,
    user: string,
    body: string,
    overrides: Partial<CommentDetail> = {},
  ): CommentDetail {
    const issue = this.issues.get(issueNumber);
    if (issue === undefined) throw new Error(`fake issue #${issueNumber} does not exist`);
    this.commentSeq += 1;
    const comment: CommentDetail = {
      id: this.commentSeq,
      user,
      body,
      createdAt: '2026-09-06T11:00:00Z',
      updatedAt: '2026-09-06T11:00:00Z',
      ...overrides,
    };
    issue.comments.push(comment);
    return comment;
  }

  commentCount(issueNumber: number): number {
    return this.issues.get(issueNumber)?.comments.length ?? 0;
  }

  trackerBodies(issueNumber: number, dispatchId: string): string[] {
    return (this.issues.get(issueNumber)?.comments ?? [])
      .filter((c) => c.body.includes(dispatchId))
      .map((c) => c.body);
  }

  async getRepository(): Promise<RepositoryInfo> {
    return this.repository;
  }

  async listOpenIssues(_ref: { owner: string; repo: string }): Promise<IssueDetail[]> {
    return [...this.issues.values()]
      .filter((issue) => issue.state === 'open')
      .sort((a, b) => a.number - b.number)
      .map(({ comments: _comments, ...issue }) => issue);
  }

  async getIssue(ref: IssueRef): Promise<IssueDetail | null> {
    const issue = this.issues.get(ref.issueNumber);
    if (issue === undefined) return null;
    const { comments: _comments, ...rest } = issue;
    return rest;
  }

  async listComments(ref: IssueRef): Promise<CommentDetail[]> {
    return [...(this.issues.get(ref.issueNumber)?.comments ?? [])].sort((a, b) => a.id - b.id);
  }

  async addIssueComment(ref: IssueRef, body: string): Promise<{ id: number }> {
    const comment = this.addComment(ref.issueNumber, this.botUser, body);
    return { id: comment.id };
  }

  async updateIssueComment(ref: IssueRef, commentId: number, body: string): Promise<void> {
    const comment = this.issues.get(ref.issueNumber)?.comments.find((c) => c.id === commentId);
    if (comment === undefined) throw new Error(`fake comment ${commentId} not found`);
    comment.body = body;
  }

  async addReaction(_ref: IssueRef, _commentId: number, _content: DriverReactionContent): Promise<void> {
    /* no-op */
  }
}

/** DriverConfig with §10 defaults and surgical overrides for tests. */
export function testConfig(
  overrides: {
    repository?: string;
    trustedHumans?: string[];
    routing?: { consumer?: string; executor?: string };
    progressSyncSeconds?: number;
    maxAttempts?: number;
    pollIntervalSeconds?: number;
  } = {},
): DriverConfig {
  return {
    version: 1,
    ...(overrides.repository !== undefined ? { repository: overrides.repository } : {}),
    driver: {
      pollIntervalSeconds: overrides.pollIntervalSeconds ?? 30,
      workspaceDir: '.gateflow',
      progressSyncSeconds: overrides.progressSyncSeconds ?? 60,
      maxAttempts: overrides.maxAttempts ?? 3,
    },
    trustedHumans: overrides.trustedHumans ?? [],
    routing: overrides.routing ?? {},
    agents: {},
    activation: { fallback: 'manual' },
  };
}

/** Log sink collecting lines instead of printing. */
export function collectingLog(): DriverLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (msg) => lines.push(`info: ${msg}`),
    warning: (msg) => lines.push(`warn: ${msg}`),
    error: (msg) => lines.push(`error: ${msg}`),
  };
}

/** Build DriverDeps over a fixture + fake client with an injectable clock. */
export function makeDeps(
  client: FakeDriverClient,
  config: DriverConfig,
  fixture: WorkspaceFixture,
  now?: () => Date,
): DriverDeps & { log: ReturnType<typeof collectingLog> } {
  const log = collectingLog();
  return { client, config, projectRoot: fixture.projectRoot, log, ...(now ? { now } : {}) };
}

/** Write an outbox file for a dispatch (creating the directory). */
export async function writeOutboxFile(
  paths: WorkspacePaths,
  dispatchId: string,
  name: string,
  content: string,
): Promise<void> {
  const dir = nodePath.join(paths.outbox, dispatchId);
  await mkdir(dir, { recursive: true });
  await writeFile(nodePath.join(dir, name), content, 'utf8');
}

/** Standard fixture constants for issue 7 in repo octo/repo (id 123). */
export const ISSUE = 7;
export const OWNER = 'octo';
export const REPO = 'repo';
