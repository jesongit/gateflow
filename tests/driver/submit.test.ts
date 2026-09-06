/**
 * Producer submit → Issue wiring tests (src/driver/submit.ts + its runOnce
 * integration, docs/workspace-protocol.md §9): FakeDriverClient harness with
 * a LOCAL subclass that records createIssue calls — tests/driver/helpers.ts
 * is shared and intentionally left untouched.
 */
import { describe, expect, it, vi } from 'vitest';

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { parseIssueSchemaBlock } from '../../src/gate/markers';
import type { IssueRef } from '../../src/github/client';
import { runOnce } from '../../src/driver/driver';
import { processSubmit } from '../../src/driver/submit';
import { resolveWorkspace } from '../../src/workspace/paths';
import type { WorkspacePaths } from '../../src/workspace/paths';
import { FakeDriverClient, makeDeps, makeWorkspace, testConfig } from './helpers';

/**
 * FakeDriverClient reusing the base class createIssue recording, plus an
 * outage switch. Created issues immediately enter the fake's canonical state
 * (as on real GitHub), so the same cycle's discovery can dispatch work for
 * them.
 */
class SubmitFakeClient extends FakeDriverClient {
  /** When true the next createIssue throws once (API outage simulation). */
  failNextCreate = false;

  async createIssue(
    ref: IssueRef,
    input: { title: string; body: string; labels: string[] },
  ): Promise<{ number: number }> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('simulated GitHub outage');
    }
    return super.createIssue(ref, input);
  }
}

async function setup(): Promise<{
  client: SubmitFakeClient;
  deps: ReturnType<typeof makeDeps>;
  paths: WorkspacePaths;
  cleanup: () => Promise<void>;
}> {
  const client = new SubmitFakeClient();
  const fixture = await makeWorkspace();
  const deps = makeDeps(client, testConfig(), fixture);
  return { client, deps, paths: resolveWorkspace(fixture.projectRoot), cleanup: fixture.cleanup };
}

const REPO_INFO = { owner: 'octo', repo: 'repo', id: 123 };

const VALID_SUBMIT_JSON = JSON.stringify({
  schema: 1,
  title: 'Add export button',
  kind: 'feature',
  maturity_hint: 'direction',
  created_at: '2026-09-06T09:00:00Z',
});

/** Write a submit request (creating submit/ when missing). */
async function writeSubmit(paths: WorkspacePaths, submitJson: string, task?: string): Promise<void> {
  await mkdir(paths.submit, { recursive: true });
  await writeFile(nodePath.join(paths.submit, 'TASK.md'), task ?? '# Task\n\nBuild the export button.\n', 'utf8');
  await writeFile(nodePath.join(paths.submit, 'submit.json'), submitJson, 'utf8');
}

/** Mute the manual activation banner (it writes to process.stdout). */
function muteActivation(): { restore: () => void } {
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((() => true) as typeof process.stdout.write);
  return { restore: () => spy.mockRestore() };
}

describe('processSubmit (docs/workspace-protocol.md §9)', () => {
  it('ready submission → issue created with TASK.md + schema block, then never re-submitted', async () => {
    const { client, deps, paths, cleanup } = await setup();
    try {
      await writeSubmit(paths, VALID_SUBMIT_JSON);

      const outcome = await processSubmit(deps, REPO_INFO);
      expect(outcome.action).toBe('created');
      expect(outcome.issueNumber).toBe(501);
      expect(client.createdIssues).toHaveLength(1);

      const created = client.createdIssues[0]!;
      expect(created.title).toBe('Add export button');
      expect(created.labels).toEqual(['ai:planning']);
      // Body = TASK.md content verbatim first…
      expect(created.body.startsWith('# Task\n\nBuild the export button.\n')).toBe(true);
      // …then the schema block in the EXACT format the gate parses…
      expect(created.body).toContain(
        '<!-- ai-workflow\nschema: 1\nsource: producer\nkind: feature\nmaturity_hint: direction\n-->',
      );
      // …and the provenance note last.
      expect(
        created.body.trimEnd().endsWith('> Submitted via GateFlow local submit (.gateflow/submit).'),
      ).toBe(true);
      // Cross-check against the gate's own parser.
      expect(parseIssueSchemaBlock(created.body)).toEqual({
        status: 'valid',
        metadata: { schema: 1, source: 'producer', kind: 'feature', maturityHint: 'direction' },
      });

      // submit/ renamed aside (never re-submitted), no error.json.
      const entries = await readdir(paths.submit);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.startsWith('processed-')).toBe(true);

      // Next inspection finds nothing: no duplicate issue.
      const second = await processSubmit(deps, REPO_INFO);
      expect(second.action).toBe('empty');
      expect(client.createdIssues).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('invalid submission → error.json written, NO issue, recoverable after a fix', async () => {
    const { client, deps, paths, cleanup } = await setup();
    try {
      const bad = JSON.stringify({
        schema: 1,
        title: 'Broken',
        kind: 'featurerequest', // not in the frozen enum
        maturity_hint: 'direction',
        created_at: '2026-09-06T09:00:00Z',
      });
      await writeSubmit(paths, bad);

      const outcome = await processSubmit(deps, REPO_INFO);
      expect(outcome.action).toBe('invalid');
      expect(client.createdIssues).toHaveLength(0);

      const error = JSON.parse(await readFile(nodePath.join(paths.submit, 'error.json'), 'utf8')) as {
        error: string;
      };
      expect(error.error).toContain('kind');
      // The request stays in place awaiting human cleanup (not processed).
      await expect(readFile(nodePath.join(paths.submit, 'submit.json'), 'utf8')).resolves.toBe(bad);

      // Human fixes the kind → next cycle creates the issue.
      await writeFile(nodePath.join(paths.submit, 'submit.json'), VALID_SUBMIT_JSON, 'utf8');
      const second = await processSubmit(deps, REPO_INFO);
      expect(second.action).toBe('created');
      expect(client.createdIssues).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('empty submit directory → no-op, zero API calls, no error.json', async () => {
    const { client, deps, paths, cleanup } = await setup();
    try {
      const outcome = await processSubmit(deps, REPO_INFO);
      expect(outcome.action).toBe('empty');
      expect(outcome.issueNumber).toBeUndefined();
      expect(client.createdIssues).toHaveLength(0);
      expect(await readdir(paths.submit)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('createIssue API failure → outcome error, NOT marked processed, retried next cycle', async () => {
    const { client, deps, paths, cleanup } = await setup();
    try {
      await writeSubmit(paths, VALID_SUBMIT_JSON);
      client.failNextCreate = true;

      const failed = await processSubmit(deps, REPO_INFO);
      expect(failed.action).toBe('error');
      expect(failed.detail).toContain('simulated GitHub outage');
      expect(client.createdIssues).toHaveLength(0);
      // The request is still pending (never lost, never half-processed).
      expect(await readdir(paths.submit)).toEqual(expect.arrayContaining(['TASK.md', 'submit.json']));
      expect(deps.log.lines.some((l) => l.startsWith('error:') && l.includes('simulated GitHub outage'))).toBe(
        true,
      );

      const retried = await processSubmit(deps, REPO_INFO);
      expect(retried.action).toBe('created');
      expect(retried.issueNumber).toBe(501);
      expect(client.createdIssues).toHaveLength(1);
      const entries = await readdir(paths.submit);
      expect(entries[0]).toMatch(/^processed-/);
    } finally {
      await cleanup();
    }
  });
});

describe('runOnce submit integration (submit BEFORE intents)', () => {
  it('creates the issue and dispatches it in the SAME cycle, next to existing work', async () => {
    const { client, deps, paths, cleanup } = await setup();
    const activation = muteActivation();
    try {
      await writeSubmit(paths, VALID_SUBMIT_JSON);
      // Existing work in the same cycle (issue 7 < created issue 501, so
      // discovery visits it first — ascending issue numbers).
      client.addIssue(7, { labels: ['ai:planning'] });

      const result = await runOnce(deps);
      expect(result.submit?.action).toBe('created');
      expect(result.submit?.issueNumber).toBe(501);
      // The issue CREATED by this cycle's submit step is already discovered:
      // proof that submit ran before processIntents.
      expect(result.dispatched).toEqual([
        { dispatched: true, dispatchId: 'gf_r123_i7_consumer_01', reason: 'new' },
        { dispatched: true, dispatchId: 'gf_r123_i501_consumer_01', reason: 'new' },
      ]);
      expect([...(await readdir(paths.inbox))].sort()).toEqual([
        'gf_r123_i501_consumer_01',
        'gf_r123_i7_consumer_01',
      ]);

      // Second cycle: the submission stays processed (no new issue), only
      // dedup no-ops remain.
      const second = await runOnce(deps);
      expect(second.submit).toBeUndefined();
      expect(client.createdIssues).toHaveLength(1);
      expect(second.dispatched.every((o) => !o.dispatched)).toBe(true);
    } finally {
      activation.restore();
      await cleanup();
    }
  });
});
