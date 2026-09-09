/**
 * Shared fixtures for driver tests: a disposable workspace, an in-memory
 * DriverGitHubClient fake (no real GitHub API is ever touched) and a config
 * builder (V1 simplified config).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import type {
  CommentDetail,
  DriverGitHubClient,
  IssueDetail,
  IssueRef,
  RepositoryInfo,
} from '../../src/github/client';
import type { DriverConfig } from '../../src/driver/config';
import type { DriverDeps, DriverLogger } from '../../src/driver/driver';
import { resolveWorkspace, ensureWorkspace } from '../../src/workspace/paths';
import type { WorkspacePaths } from '../../src/workspace/paths';
import { buildRecordBody, RECORD_SCHEMA_VERSION, type GateRecord } from '../../src/protocol/records';
import { newWorkflowEpoch, type WorkflowEpoch } from '../../src/protocol/epoch';

export const CREATED_AT = '2026-09-06T10:00:00Z';
export const UPDATED_AT = '2026-09-06T11:00:00Z';

/** A disposable workspace with all directories created. */
export interface WorkspaceFixture {
  projectRoot: string;
  paths: WorkspacePaths;
  cleanup: () => Promise<void>;
}

/** Temp workspace under os.tmpdir. */
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

/** A deterministic valid epoch for tests (suffix varies by index). */
export function testEpoch(n = 1): WorkflowEpoch {
  const suffix = n.toString(36).padStart(12, '0').slice(-12).replace(/[^0-9a-z]/g, '0');
  return `wf_${suffix}` as WorkflowEpoch;
}

/**
 * In-memory DriverGitHubClient: Map<issueNumber, issue+comments>, ascending
 * comment ids, addIssueComment appends, updateIssueComment mutates in place.
 */
export class FakeDriverClient implements DriverGitHubClient {
  readonly repository: RepositoryInfo;
  readonly issues = new Map<number, FakeIssue>();
  /** Login the fake uses for Driver-published comments. */
  botUser = 'gateflow-driver[bot]';
  /** Login the fake uses for Gate-issued record comments. */
  gateUser = 'github-actions[bot]';
  private commentSeq = 1000;

  constructor(repository: Partial<RepositoryInfo> = {}) {
    this.repository = { id: 123, owner: 'octo', name: 'repo', ownerType: 'User', ...repository };
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

  /**
   * Append a Gate-issued record comment: authored by the fake's gate
   * identity and carrying a valid record body.
   */
  addGateRecord(issueNumber: number, record: GateRecord, overrides: Partial<CommentDetail> = {}): CommentDetail {
    return this.addComment(issueNumber, this.gateUser, buildRecordBody(record), overrides);
  }

  commentCount(issueNumber: number): number {
    return this.issues.get(issueNumber)?.comments.length ?? 0;
  }

  async getRepository(): Promise<RepositoryInfo> {
    return this.repository;
  }

  async listIssues(ref: { owner: string; repo: string }): Promise<IssueDetail[]> {
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
}

/** DriverConfig with V1 defaults and surgical overrides for tests. */
export function testConfig(
  overrides: {
    repository?: string;
    trustedHumans?: string[];
    gateLogins?: string[];
    requireExplicitHumans?: boolean;
    maxAttempts?: number;
  } = {},
): DriverConfig {
  return {
    version: 1,
    ...(overrides.repository !== undefined ? { repository: overrides.repository } : {}),
    driver: {
      workspaceDir: '.gateflow',
      maxAttempts: overrides.maxAttempts ?? 3,
    },
    trustedHumans: overrides.trustedHumans ?? [],
    gateLogins: overrides.gateLogins ?? ['github-actions[bot]'],
    requireExplicitHumans: overrides.requireExplicitHumans ?? true,
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

/** Write a file inside a task directory (creating the directory). */
export async function writeTaskFile(
  paths: WorkspacePaths,
  taskId: string,
  name: string,
  content: string,
): Promise<void> {
  const dir = nodePath.join(paths.tasks, taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(nodePath.join(dir, name), content, 'utf8');
}

/** Standard fixture constants for issue 7 in repo octo/repo (id 123). */
export const ISSUE = 7;
export const OWNER = 'octo';
export const REPO = 'repo';

/** The record payload must agree with the comment's authenticated Gate author. */
export const GATE_JSON_LOGIN = 'github-actions[bot]';

/** Inject `schema: 2` so the produced body round-trips through parseRecord. */
function withSchema(record: Record<string, unknown>): GateRecord {
  return { schema: RECORD_SCHEMA_VERSION, ...record } as unknown as GateRecord;
}

/** A parser-valid workflow_epoch record (schema 2). */
export function epochRecord(
  repositoryId: number,
  issueNumber: number,
  epoch: WorkflowEpoch,
): GateRecord {
  return withSchema({
    kind: 'workflow_epoch',
    repository_id: repositoryId,
    issue_number: issueNumber,
    workflow_epoch: epoch,
    created_at: '2026-09-06T11:00:00Z',
    issued_by: GATE_JSON_LOGIN,
    operation_id: `epoch:${repositoryId}:${issueNumber}:${epoch}`,
  });
}

/** Inputs for approvalRecord (all Operation-ID bindings derived here). */
export interface ApprovalRecordInput {
  repositoryId: number;
  issueNumber: number;
  epoch: WorkflowEpoch;
  planCommentId: number;
  planSha256: string;
  /** /approve command comment the record points at (defaults to a fixture id). */
  approvalCommandCommentId?: number;
  approvedByLogin?: string;
}

/** A parser-valid approval record (schema 2, Gate-issued). */
export function approvalRecord(input: ApprovalRecordInput): GateRecord {
  return withSchema({
    kind: 'approval',
    repository_id: input.repositoryId,
    issue_number: input.issueNumber,
    workflow_epoch: input.epoch,
    plan_comment_id: input.planCommentId,
    plan_sha256: input.planSha256,
    approval_command_comment_id: input.approvalCommandCommentId ?? 900001,
    approved_by_id: 1001,
    approved_by_login: input.approvedByLogin ?? OWNER,
    gate_login: GATE_JSON_LOGIN,
    gate_user_id: 41898282,
    created_at: '2026-09-06T12:00:00Z',
    operation_id:
      `approval:${input.repositoryId}:${input.issueNumber}:${input.epoch}:p${input.planCommentId}`,
  });
}

/** Inputs for feedbackRecord. */
export interface FeedbackRecordInput {
  repositoryId: number;
  issueNumber: number;
  epoch: WorkflowEpoch;
  feedbackCommentId: number;
  kind: 'change';
}

/** A parser-valid feedback_accepted record (schema 2, Gate-issued). */
export function feedbackRecord(input: FeedbackRecordInput): GateRecord {
  const id = input.feedbackCommentId;
  return withSchema({
    kind: 'feedback_accepted',
    repository_id: input.repositoryId,
    issue_number: input.issueNumber,
    workflow_epoch: input.epoch,
    event_id: `fe${id}`,
    feedback_comment_id: id,
    feedback_kind: input.kind,
    gate_login: GATE_JSON_LOGIN,
    gate_user_id: 41898282,
    created_at: '2026-09-06T12:30:00Z',
    operation_id: `feedback:${input.repositoryId}:${input.issueNumber}:${input.epoch}:${id}`,
  });
}

/**
 * Convenience fixture: ensure the issue carries a parser-valid epoch record
 * (the usual first fixture call for an in-workflow issue).
 */
export function addEpochRecord(
  client: FakeDriverClient,
  issueNumber: number,
  epoch: WorkflowEpoch = testEpoch(issueNumber),
): WorkflowEpoch {
  client.addGateRecord(issueNumber, epochRecord(client.repository.id, issueNumber, epoch));
  return epoch;
}

/** Build a valid plan-marker comment body. */
export function planCommentBody(planMarkdown: string, taskId: string): string {
  return `<!-- ai-workflow:plan:v1 -->\n\n<!-- gateflow:dispatch-id: ${taskId} -->\n\n${planMarkdown.trim()}\n`;
}
