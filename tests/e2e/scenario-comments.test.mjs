import { describe, expect, it, vi } from 'vitest';

import {
  issueComments as workflowIssueComments,
  issueView as workflowIssueView,
} from '../../scripts/e2e/scenarios/workflow.mjs';
import {
  approvalRecordCommentId,
  issueComments as securityIssueComments,
  readIssueView as securityIssueView,
} from '../../scripts/e2e/scenarios/security.mjs';

function fakeContext() {
  const calls = [];
  const context = {
    root: 'C:\\e2e',
    gh: {
      json: vi.fn(async (args) => {
        calls.push(args);
        if (args[0] === 'issue') {
          return { number: 1, title: 'task', body: 'body', state: 'OPEN', labels: [{ name: 'ai:review' }] };
        }
        return [[{ id: 1234567890, body: '<!-- gateflow:plan -->', user: { login: 'jesongit' } }]];
      }),
    },
  };
  return { context, calls };
}

describe('release E2E issue comment readers', () => {
  it('binds Driver execute tasks to the Gate approval record comment', () => {
    expect(approvalRecordCommentId({ command: { id: 11 }, comment: { id: 12 } })).toBe(12);
    expect(() => approvalRecordCommentId({ command: { id: 11 } })).toThrow('no numeric comment id');
  });

  it('uses REST numeric database IDs in workflow and security readers', async () => {
    const { context, calls } = fakeContext();
    const workflowIssue = await workflowIssueView(context, 'jesongit/gateflow', 1);
    expect(workflowIssue.comments[0].id).toBe(1234567890);
    expect(calls[0]).toEqual([
      'issue', 'view', '1', '--repo', 'jesongit/gateflow', '--json', 'number,title,body,state,labels',
    ]);
    expect(calls[1]).toEqual([
      'api', 'repos/jesongit/gateflow/issues/1/comments', '--paginate', '--slurp',
    ]);

    const securityIssue = await securityIssueView(context, 'jesongit/gateflow', 1);
    expect(securityIssue.comments[0].id).toBe(1234567890);
    await expect(securityIssueComments(context, 'jesongit/gateflow', 1)).resolves.toEqual([
      { id: 1234567890, body: '<!-- gateflow:plan -->', user: 'jesongit' },
    ]);
    expect(workflowIssueComments).toBe(securityIssueComments);
  });

  it('fails closed when a REST comment has no numeric database ID', async () => {
    const context = {
      root: 'C:\\e2e',
      gh: { json: vi.fn(async () => [[{ id: 'IC_kwDO node id', body: '/approve 1' }]]) },
    };
    await expect(workflowIssueComments(context, 'jesongit/gateflow', 1)).rejects.toThrow(
      'no numeric database id',
    );
  });
});
