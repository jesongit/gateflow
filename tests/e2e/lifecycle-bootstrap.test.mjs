import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrapRepository, configureGateToken } from '../../scripts/e2e/lifecycle.mjs';

const ACTION_REF = 'jesongit/gateflow@06b5bf9123b9844a5dc6738003ed5f6717a08358';
const LABELS = ['ai:planning', 'ai:review', 'ai:ready', 'ai:working', 'ai:blocked', 'ai:done'];

async function makeContext(commit) {
  const targetDir = await mkdtemp(join(tmpdir(), 'gateflow-bootstrap-test-'));
  await writeFile(join(targetDir, 'README.md'), '# fixture\n', 'utf8');
  const calls = [];
  const context = {
    root: process.cwd(),
    githubToken: 'test-token',
    bootstrapEnv: {},
    options: { timeoutMs: 5_000 },
    workflowFile: 'ai-workflow.yml',
    log: vi.fn(),
    gh: { json: vi.fn(async () => LABELS.map((name) => ({ name }))) },
    runProcess: vi.fn(async (program, args, options) => {
      calls.push({ program, args, options });
      if (program === process.execPath && args[0].endsWith('scripts\\bootstrap.mjs')) {
        await mkdir(join(targetDir, '.github', 'workflows'), { recursive: true });
        await writeFile(
          join(targetDir, '.github', 'workflows', 'ai-workflow.yml'),
          `name: GateFlow\n\nuses: ${ACTION_REF}\n`,
          'utf8',
        );
        await writeFile(join(targetDir, 'gateflow.config.yml'), 'version: 1\n', 'utf8');
        await writeFile(join(targetDir, '.gitignore'), '# GateFlow V1 local runtime\n.gateflow/\n', 'utf8');
        return { stdout: '', stderr: '' };
      }
      if (program === 'git' && args[0] === 'status') return { stdout: ' M .github', stderr: '' };
      return { stdout: '', stderr: '' };
    }),
  };
  return { context, targetDir, calls, commit };
}

describe('release E2E bootstrap commit boundary', () => {
  it('commits and pushes the first Bootstrap by default', async () => {
    const fixture = await makeContext(true);
    try {
      const result = await bootstrapRepository(
        fixture.context,
        fixture.targetDir,
        'jesongit/gateflow',
        'new',
        ACTION_REF,
      );
      expect(result.actions.bootstrap.commit).toBe(true);
      const gitCalls = fixture.calls.filter((call) => call.program === 'git');
      expect(gitCalls[0].args[0]).toBe('status');
      expect(gitCalls[1].args[0]).toBe('add');
      expect(gitCalls[2].args).toContain('commit');
      expect(gitCalls[3].args[0]).toBe('push');
    } finally {
      await rm(fixture.targetDir, { recursive: true, force: true });
    }
  });

  it('can install reconnect files without changing history', async () => {
    const fixture = await makeContext(false);
    try {
      const result = await bootstrapRepository(
        fixture.context,
        fixture.targetDir,
        'jesongit/gateflow',
        'existing',
        ACTION_REF,
        { commit: false },
      );
      expect(result.actions.bootstrap.commit).toBe(false);
      expect(fixture.calls.filter((call) => call.program === 'git').map((call) => call.args[0])).toEqual(['status']);
    } finally {
      await rm(fixture.targetDir, { recursive: true, force: true });
    }
  });

  it('patches a restored workflow to the secret without writing the token', async () => {
    const targetDir = await mkdtemp(join(tmpdir(), 'gateflow-token-test-'));
    const token = 'test-token';
    try {
      await mkdir(join(targetDir, '.github', 'workflows'), { recursive: true });
      await writeFile(join(targetDir, '.github', 'workflows', 'ai-workflow.yml'),
        `uses: ${ACTION_REF}\nwith:\n  github-token: \${{ github.token }}\n`, 'utf8');
      await writeFile(join(targetDir, 'gateflow.config.yml'), 'version: 1\n', 'utf8');
      const context = {
        repository: { fullName: 'jesongit/gateflow' },
        paths: { clone: targetDir },
        githubToken: token,
        preflight: { login: 'jesongit' },
        bootstrapResult: { workflowFile: 'ai-workflow.yml' },
        driverEnv: {},
        options: { timeoutMs: 5_000 },
        log: vi.fn(),
        gh: { run: vi.fn(async () => ({ stdout: '', stderr: '' })) },
        runProcess: vi.fn(async () => ({ stdout: '', stderr: '' })),
      };
      await configureGateToken(context);
      const workflow = await readFile(join(targetDir, '.github', 'workflows', 'ai-workflow.yml'), 'utf8');
      const config = await readFile(join(targetDir, 'gateflow.config.yml'), 'utf8');
      expect(workflow).toContain('${{ secrets.GATEFLOW_GATE_TOKEN }}');
      expect(workflow).not.toContain(token);
      expect(config).toContain('jesongit');
      expect(config).not.toContain(token);
      expect(context.log).not.toHaveBeenCalledWith(expect.stringContaining(token));
      expect(context.gh.run).toHaveBeenCalledWith(
        ['secret', 'set', 'GATEFLOW_GATE_TOKEN', '--repo', 'jesongit/gateflow'],
        expect.objectContaining({ input: `${token}\n`, redactOutput: true }),
      );
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});
