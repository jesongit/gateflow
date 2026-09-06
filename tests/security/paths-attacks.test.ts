/**
 * SECURITY — Area A: workspace path attacks (docs/workspace-protocol.md §8.5).
 *
 * The attacker is the local agent (or any process able to write files /
 * craft dispatch ids). Every attack asserts BOTH the rejection AND that no
 * GitHub write / no state change occurred, and that no file outside
 * `.gateflow/` is read or written.
 */
import { describe, expect, it } from 'vitest';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { inboxDispatchDir, outboxDispatchDir } from '../../src/workspace/paths';
import { listOutboxDispatchIds } from '../../src/workspace/outbox';
import { syncAll, syncDispatch } from '../../src/driver/sync';
import {
  CONSUMER_ID,
  EXECUTOR_ID,
  ISSUE,
  countedClient,
  seedInbox,
  trySymlinkDir,
  writeOutboxJson,
} from './helpers';
import {
  FakeDriverClient,
  makeDeps,
  makeWorkspace,
  testConfig,
  writeOutboxFile,
} from '../driver/helpers';

async function setup() {
  const client = countedClient(new FakeDriverClient());
  const fixture = await makeWorkspace();
  const deps = makeDeps(client, testConfig(), fixture);
  client.addIssue(ISSUE, { labels: ['ai:planning'] });
  return { client, fixture, deps, cleanup: fixture.cleanup };
}

describe('A. workspace path attacks (docs/workspace-protocol.md §8.5)', () => {
  it('rejects path traversal in dispatch id (resolution throws; sync rejects without any GitHub call)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      const hostileIds = [
        'gf_r1_i2_consumer_../../..',
        '..%2F..%2Fetc',
        'gf_r1_i2_consumer_01/../../../../../../etc/passwd',
        'x/../../../../../../etc/passwd',
        'gf_r1_i2_consumer_01\\..\\..\\..\\evil',
        '..',
        '.',
        '',
      ];
      for (const id of hostileIds) {
        expect(() => inboxDispatchDir(fixture.paths, id), `inboxDispatchDir(${id})`).toThrow();
        expect(() => outboxDispatchDir(fixture.paths, id), `outboxDispatchDir(${id})`).toThrow();
      }

      // Even a hostile direct caller of syncDispatch gets a rejection with
      // zero GitHub reads/writes: the id grammar dies before any API call.
      for (const id of ['gf_r1_i2_consumer_../../..', '..%2F..%2Fetc']) {
        const outcome = await syncDispatch(deps, client.repository, id);
        expect(outcome.action).toBe('rejected');
        expect(outcome.detail).toMatch(/unknown dispatch/i);
      }
      expect(client.writes).toBe(0);
      expect(client.reads).toBe(0);
      expect(client.commentCount(ISSUE)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('rejects absolute paths as dispatch id', () => {
    const paths = {
      root: '.gateflow',
      current: '.gateflow/current.json',
      inbox: '.gateflow/inbox',
      outbox: '.gateflow/outbox',
      receipts: '.gateflow/receipts',
      submit: '.gateflow/submit',
      logs: '.gateflow/logs',
    };
    const absoluteIds = ['C:\\evil', '/etc', '\\\\server\\share\\x', 'D:/evil', 'C:evil'];
    for (const id of absoluteIds) {
      expect(() => outboxDispatchDir(paths, id), `outboxDispatchDir(${id})`).toThrow();
      expect(() => inboxDispatchDir(paths, id), `inboxDispatchDir(${id})`).toThrow();
    }
    // A valid id always resolves strictly inside the workspace roots.
    const valid = 'gf_r123_i7_executor_p501';
    const outDir = outboxDispatchDir(paths, valid);
    const inDir = inboxDispatchDir(paths, valid);
    expect(
      nodePath.resolve(outDir).startsWith(nodePath.resolve(paths.outbox) + nodePath.sep),
    ).toBe(true);
    expect(
      nodePath.resolve(inDir).startsWith(nodePath.resolve(paths.inbox) + nodePath.sep),
    ).toBe(true);
  });

  it('filters junk outbox directory names before sync (grammar is the only door)', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'status.json', '{}');
      const junk = [
        'not-a-dispatch',
        '.hidden',
        'gf_r1_i2_consumer_',
        'gf_r1_i2_consumer_01x',
        'gf_r1_i2_consumer_%2e%2e',
        'GF_R1_I2_CONSUMER_01',
      ];
      for (const name of junk) {
        await mkdir(nodePath.join(fixture.paths.outbox, name), { recursive: true });
      }
      // A file with a perfectly valid dispatch name is not a dispatch dir.
      await writeFile(
        nodePath.join(fixture.paths.outbox, 'gf_r1_i2_consumer_77'),
        'not a directory',
        'utf8',
      );

      const ids = await listOutboxDispatchIds(fixture.paths);
      expect(ids).toEqual([CONSUMER_ID]);

      const outcomes = await syncAll(deps, client.repository);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.dispatchId).toBe(CONSUMER_ID);
      // status.json "{}" is invalid (missing keys) → rejected, no write.
      expect(outcomes[0]?.action).toBe('rejected');
      expect(client.writes).toBe(0);
      expect(client.commentCount(ISSUE)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('does not follow a symlinked outbox dispatch dir pointing outside .gateflow', async (ctx) => {
    const { client, fixture, deps, cleanup } = await setup();
    const escapeId = 'gf_r123_i7_consumer_01';
    const linkPath = nodePath.join(fixture.paths.outbox, escapeId);
    try {
      // The outside target lives in the project root but OUTSIDE .gateflow/
      // and is dressed up as a tempting, fully valid outbox payload.
      const outsideDir = nodePath.join(fixture.projectRoot, 'outside-canary');
      await mkdir(outsideDir, { recursive: true });
      const canaryPath = nodePath.join(outsideDir, 'canary.md');
      await writeFile(canaryPath, 'CANARY — must never be read or written', 'utf8');
      await writeFile(
        nodePath.join(outsideDir, 'result.json'),
        JSON.stringify({
          schema: 1,
          dispatch_id: escapeId,
          role: 'consumer',
          result: 'plan_ready',
          plan_file: 'PLAN.md',
        }),
        'utf8',
      );
      await writeFile(nodePath.join(outsideDir, 'PLAN.md'), '# EVIL PLAN', 'utf8');

      const created = await trySymlinkDir(outsideDir, linkPath);
      if (!created) {
        ctx.skip(true, 'symlink creation requires privileges on this platform');
        return;
      }

      const listed = await listOutboxDispatchIds(fixture.paths);
      const outcomes = await syncAll(deps, client.repository);

      if (listed.includes(escapeId)) {
        // If the platform reports the link as a directory, the sync must
        // still reject it: no inbox dispatch.json exists for this id.
        const outcome = outcomes.find((o) => o.dispatchId === escapeId);
        expect(outcome?.action).toBe('rejected');
        expect(outcome?.detail).toMatch(/unknown dispatch/i);
      } else {
        // Preferred behavior: the grammar+type filter never even lists it.
        expect(outcomes).toHaveLength(0);
      }
      // Invariant: nothing was ever published, and no file outside
      // .gateflow was read or written (canary untouched, no new files).
      expect(client.commentCount(ISSUE)).toBe(0);
      expect(client.writes).toBe(0);
      expect(await readFile(canaryPath, 'utf8')).toBe('CANARY — must never be read or written');
      const outsideFiles = (await readdir(outsideDir)).sort();
      expect(outsideFiles).toEqual(['PLAN.md', 'canary.md', 'result.json']);
    } finally {
      // Remove the link itself first so the recursive cleanup cannot descend
      // through it into the outside directory.
      await rm(linkPath, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('rejects oversized content files (> 512 KB) with no sync', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      // PLAN.md oversized → consumer plan_ready rejected.
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      await writeOutboxFile(fixture.paths, CONSUMER_ID, 'PLAN.md', 'x'.repeat(513 * 1024));
      await writeOutboxJson(fixture.paths, CONSUMER_ID, 'result.json', {
        schema: 1,
        dispatch_id: CONSUMER_ID,
        role: 'consumer',
        result: 'plan_ready',
        plan_file: 'PLAN.md',
      });
      const planOutcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(planOutcome.action).toBe('rejected');
      expect(planOutcome.detail).toMatch(/exceeds 524288/);

      // REPORT.md oversized → executor completed rejected.
      await seedInbox(fixture, EXECUTOR_ID, 'executor');
      await writeOutboxFile(fixture.paths, EXECUTOR_ID, 'REPORT.md', 'y'.repeat(513 * 1024));
      await writeOutboxJson(fixture.paths, EXECUTOR_ID, 'result.json', {
        schema: 1,
        dispatch_id: EXECUTOR_ID,
        role: 'executor',
        result: 'completed',
        report_file: 'REPORT.md',
        validation: 'passed',
      });
      const reportOutcome = await syncDispatch(deps, client.repository, EXECUTOR_ID);
      expect(reportOutcome.action).toBe('rejected');
      expect(reportOutcome.detail).toMatch(/exceeds 524288/);

      // status.json oversized → rejected before any status is consumed.
      await writeOutboxJson(fixture.paths, CONSUMER_ID, 'status.json', {
        schema: 1,
        dispatch_id: CONSUMER_ID,
        role: 'consumer',
        state: 'working',
        summary: 'x'.repeat(600 * 1024),
        updated_at: '2026-09-06T17:30:00Z',
      });
      const statusOutcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(statusOutcome.action).toBe('rejected');
      // Rejected by the machine-file size bound (docs §5.7) BEFORE any
      // JSON.parse / field validation runs.
      expect(statusOutcome.detail).toMatch(/exceeds the .*-byte limit/);

      expect(client.writes).toBe(0);
      expect(client.commentCount(ISSUE)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('never writes outside the workspace even when the agent plants an escape-shaped result', async () => {
    const { client, fixture, deps, cleanup } = await setup();
    try {
      await seedInbox(fixture, CONSUMER_ID, 'consumer');
      // The field caps make traversal via file *values* impossible: only
      // the constant "PLAN.md" is accepted, and it is resolved inside the
      // dispatch dir. Smuggle a traversal value anyway and observe rejection.
      await writeOutboxJson(fixture.paths, CONSUMER_ID, 'result.json', {
        schema: 1,
        dispatch_id: CONSUMER_ID,
        role: 'consumer',
        result: 'plan_ready',
        plan_file: '../../PLAN.md',
      });
      const outcome = await syncDispatch(deps, client.repository, CONSUMER_ID);
      expect(outcome.action).toBe('rejected');
      expect(outcome.detail).toMatch(/plan_file/);
      expect(client.writes).toBe(0);
      expect(client.commentCount(ISSUE)).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
