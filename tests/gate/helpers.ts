/**
 * Gate test fixtures (tests/security was folded here): a fake gate GitHub
 * client and helpers to drive runGate end-to-end with in-memory data.
 */
import type { GitHubClient, IssueRef } from '../../src/gate/github';
import type { GateComment } from '../../src/gate/approvals';
import { buildRecordBody, type GateRecord } from '../../src/protocol/records';
import { newWorkflowEpoch, type WorkflowEpoch } from '../../src/protocol/epoch';

export const OWNER = 'octo';
export const REPO = 'repo';
export const ISSUE = 7;

/** Issue with its comments, as stored inside the fake gate client. */
export type FakeIssue = {
  state: 'open' | 'closed';
  labels: string[];
  comments: GateComment[];
};

/**
 * In-memory GitHubClient with the same semantics the real gate client has:
 * getLabels/getIssue read the stored issue, addLabels/removeLabel mutate it,
 * comments are id-ascending and addComment/getComment/listComments operate
 * on the same list.
 */
export class FakeGateClient implements GitHubClient {
  readonly repoIdentity: { owner: string; ownerType: string };
  readonly issues = new Map<number, FakeIssue>();
  gateLogin = 'github-actions[bot]';
  private commentSeq = 1000;

  constructor(identity: { owner: string; ownerType: string } = { owner: OWNER, ownerType: 'User' }) {
    this.repoIdentity = identity;
  }

  addIssue(number: number, labels: string[] = [], state: 'open' | 'closed' = 'open'): FakeIssue {
    const issue: FakeIssue = { state, labels: [...labels], comments: [] };
    this.issues.set(number, issue);
    return issue;
  }

  pushComment(issueNumber: number, user: string, body: string): GateComment {
    const issue = this.issues.get(issueNumber);
    if (issue === undefined) throw new Error(`fake issue #${issueNumber} does not exist`);
    this.commentSeq += 1;
    const comment: GateComment = {
      id: this.commentSeq,
      user,
      body,
    };
    issue.comments.push(comment);
    return comment;
  }

  addGateRecord(issueNumber: number, record: GateRecord, user?: string): GateComment {
    return this.pushComment(issueNumber, user ?? this.gateLogin, buildRecordBody(record));
  }

  labelsOf(issueNumber: number): string[] {
    return [...(this.issues.get(issueNumber)?.labels ?? [])];
  }

  async getRepoIdentity(_ref: { owner: string; repo: string }) {
    return { owner: this.repoIdentity.owner, ownerType: this.repoIdentity.ownerType, id: 123 };
  }

  async getAuthenticatedUser() {
    return { id: 41898282, login: this.gateLogin };
  }

  async getIssue(ref: IssueRef) {
    const issue = this.issues.get(ref.issueNumber);
    if (issue === undefined) throw new Error(`fake issue #${ref.issueNumber} does not exist`);
    return { state: issue.state, labels: [...issue.labels] };
  }

  async getLabels(ref: IssueRef): Promise<string[]> {
    return this.labelsOf(ref.issueNumber);
  }

  async addLabels(ref: IssueRef, labels: string[]): Promise<void> {
    const issue = this.issues.get(ref.issueNumber);
    if (issue === undefined) throw new Error(`fake issue #${ref.issueNumber} does not exist`);
    for (const label of labels) {
      if (!issue.labels.includes(label)) issue.labels.push(label);
    }
  }

  async removeLabel(ref: IssueRef, label: string): Promise<void> {
    const issue = this.issues.get(ref.issueNumber);
    if (issue === undefined) throw new Error(`fake issue #${ref.issueNumber} does not exist`);
    issue.labels = issue.labels.filter((l) => l !== label);
  }

  async listComments(ref: IssueRef): Promise<GateComment[]> {
    return [...(this.issues.get(ref.issueNumber)?.comments ?? [])].sort((a, b) => a.id - b.id);
  }

  async getComment(ref: IssueRef, commentId: number): Promise<GateComment | null> {
    const found = (this.issues.get(ref.issueNumber)?.comments ?? []).find((c) => c.id === commentId);
    return found ?? null;
  }

  async addComment(ref: IssueRef, body: string): Promise<{ id: number }> {
    const comment = this.pushComment(ref.issueNumber, this.gateLogin, body);
    return { id: comment.id };
  }

  async addReaction(_ref: IssueRef, _commentId: number, _content: '+1' | '-1'): Promise<void> {
    /* observable via the reactions list */
    this.reactions.push({ issue: _ref.issueNumber, commentId: _commentId, content: _content });
  }

  async editComment(ref: IssueRef, commentId: number, body: string): Promise<void> {
    const comment = this.issues.get(ref.issueNumber)?.comments.find((c) => c.id === commentId);
    if (comment === undefined) throw new Error(`fake comment ${commentId} not found`);
    comment.body = body;
  }

  readonly reactions: Array<{ issue: number; commentId: number; content: '+1' | '-1' }> = [];

  /** Every comment the gate published, for record assertions. */
  gateComments(issueNumber: number): GateComment[] {
    return (this.issues.get(issueNumber)?.comments ?? []).filter((c) => c.user === this.gateLogin);
  }
}

export function testGateEpoch(n = 1): WorkflowEpoch {
  const suffix = n.toString(36).padStart(12, '0').slice(-12).replace(/[^0-9a-z]/g, '0');
  return `wf_${suffix}` as WorkflowEpoch;
}

export function gateEpochRecord(
  repositoryId: number,
  issueNumber: number,
  epoch: WorkflowEpoch,
): GateRecord {
  return {
    schema: 2,
    kind: 'workflow_epoch',
    repository_id: repositoryId,
    issue_number: issueNumber,
    workflow_epoch: epoch,
    created_at: '2026-09-06T11:00:00Z',
    issued_by: 'github-actions-bot',
    operation_id: `epoch:${repositoryId}:${issueNumber}:${epoch}`,
  } as unknown as GateRecord;
}

export function gateApprovalRecord(input: {
  repositoryId: number;
  issueNumber: number;
  epoch: WorkflowEpoch;
  planCommentId: number;
  planSha256: string;
  approvalCommandCommentId: number;
  approvedByLogin: string;
}): GateRecord {
  return {
    schema: 2,
    kind: 'approval',
    repository_id: input.repositoryId,
    issue_number: input.issueNumber,
    workflow_epoch: input.epoch,
    plan_comment_id: input.planCommentId,
    plan_sha256: input.planSha256,
    approval_command_comment_id: input.approvalCommandCommentId,
    approved_by_id: 1001,
    approved_by_login: input.approvedByLogin,
    gate_login: 'github-actions-bot',
    gate_user_id: 41898282,
    created_at: '2026-09-06T12:00:00Z',
    operation_id: `approval:${input.repositoryId}:${input.issueNumber}:${input.epoch}:p${input.planCommentId}`,
  } as unknown as GateRecord;
}

export { newWorkflowEpoch };
