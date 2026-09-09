import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reconnectExistingProject } from '../../scripts/e2e/scenarios/reconnect.mjs';

const ACTION_REF = 'jesongit/gateflow@240cf858c075162311acd9ba242584cff01a47e7';

describe('reconnect Gate token configuration', () => {
  it('configures the restored workflow after the explicit reconnect push', async () => {
    const targetDir = await mkdtemp(join(tmpdir(), 'gateflow-reconnect-test-'));
    const events = [];
    let snapshot = 0;
    try {
      await writeFile(join(targetDir, 'README.md'), '# fixture\n', 'utf8');
      await writeFile(join(targetDir, 'hello.txt'), 'hello gateflow\n', 'utf8');
      await mkdir(join(targetDir, '.github', 'workflows'), { recursive: true });

      const context = {
        root: process.cwd(),
        options: { timeoutMs: 5_000 },
        preflight: { head: '240cf858c075162311acd9ba242584cff01a47e7', login: 'jesongit' },
        runBootstrap: vi.fn(async ({ targetDir: dir }) => {
          events.push('bootstrap');
          await writeFile(
            join(dir, '.github', 'workflows', 'ai-workflow.yml'),
            `uses: ${ACTION_REF}\nwith:\n  github-token: \${{ github.token }}\n`,
            'utf8',
          );
          await writeFile(join(dir, 'gateflow.config.yml'), 'version: 1\n', 'utf8');
        }),
        configureGateToken: vi.fn(async () => {
          events.push('configure');
          const workflowPath = join(targetDir, '.github', 'workflows', 'ai-workflow.yml');
          const workflow = await readFile(workflowPath, 'utf8');
          expect(workflow).toContain('${{ github.token }}');
          await writeFile(workflowPath, workflow.replaceAll('${{ github.token }}', '${{ secrets.GATEFLOW_GATE_TOKEN }}'), 'utf8');
          return { status: 'passed', workflow: { expression: '${{ secrets.GATEFLOW_GATE_TOKEN }}' } };
        }),
        github: { listLabels: vi.fn(async () => [
          'ai:planning', 'ai:review', 'ai:ready', 'ai:working', 'ai:blocked', 'ai:done',
        ]) },
        runProcess: vi.fn(async (program, args) => {
          if (program !== 'git') return { stdout: '', stderr: '' };
          if (args[0] === 'status') {
            events.push('git:status');
            return { stdout: ' M .github', stderr: '' };
          }
          if (args[0] === 'rev-parse') {
            snapshot += 1;
            return { stdout: snapshot === 1 ? 'after-removal' : 'reconnect', stderr: '' };
          }
          if (args[0] === 'rev-list') return { stdout: '2', stderr: '' };
          if (args[0] === 'log') return { stdout: 'reconnect\nafter-removal', stderr: '' };
          if (args[0] === 'add') events.push('git:add');
          if (args.includes('commit')) events.push('git:commit');
          if (args[0] === 'push') events.push('git:push');
          return { stdout: '', stderr: '' };
        }),
      };
      const removed = {
        repository: 'jesongit/gateflow',
        targetDir,
        workflowRel: join('.github', 'workflows', 'ai-workflow.yml'),
        actionRef: ACTION_REF,
        businessFiles: { 'README.md': '# fixture\n', 'hello.txt': 'hello gateflow\n' },
        afterRemoval: { head: 'after-removal', count: 2, log: ['after-removal', 'base'] },
      };

      const result = await reconnectExistingProject(context, removed);
      expect(result.gateToken.status).toBe('passed');
      expect(events.indexOf('configure')).toBeGreaterThan(events.lastIndexOf('git:push'));
      const workflow = await readFile(join(targetDir, '.github', 'workflows', 'ai-workflow.yml'), 'utf8');
      expect(workflow).toContain('${{ secrets.GATEFLOW_GATE_TOKEN }}');
      expect(workflow).not.toContain('test-token');
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});
