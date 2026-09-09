import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The bootstrap is intentionally a directly executable .mjs script. Its
// exported runner makes filesystem/network behavior injectable for unit tests.
// @ts-expect-error bootstrap.mjs is checked by Node/Vitest, not tsc.
import { LABELS, parseArgs, runBootstrap } from '../scripts/bootstrap.mjs';

const TEMPLATE = [
  'name: AI Workflow Gate',
  'permissions:',
  '  issues: write',
  'uses: jesongit/gateflow@v0',
  'with:',
  '  github-token: ${{ secrets.GATEFLOW_GATE_TOKEN }}',
  "trusted-humans: ''",
  "trusted-agents: ''",
  '',
].join('\n');

const roots: string[] = [];

async function makeTarget() {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'gateflow-bootstrap-'));
  roots.push(root);
  await writeFile(nodePath.join(root, 'templates-placeholder'), 'not used', 'utf8');
  const template = nodePath.join(root, 'workflow-template.yml');
  await writeFile(template, TEMPLATE, 'utf8');
  return { root, template };
}

function testDeps(root: string, template: string) {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    deps: {
      cwd: root,
      templatePath: () => template,
      log: (message: unknown) => logs.push(String(message)),
      error: (message: unknown) => errors.push(String(message)),
    },
    logs,
    errors,
  };
}

function response(status: number, body: unknown, statusText = '') {
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bootstrap CLI options', () => {
  it('parses the target directory, installation mode, non-interactive controls, and GitHub boundary', () => {
    const opts = parseArgs([
      '--repo', 'octo/project',
      '--token', 'secret',
      '--workdir', 'target',
      '--install-mode', 'new',
      '--github-config',
      '--non-interactive',
      '--yes',
    ]);

    expect(opts).toMatchObject({
      repo: 'octo/project',
      token: 'secret',
      workdir: 'target',
      installMode: 'new',
      installModeExplicit: true,
      githubConfig: true,
      nonInteractive: true,
      yes: true,
    });
  });

  it('allows dry-run and generate-only without a token, but rejects their unsafe combination', async () => {
    const { root, template } = await makeTarget();
    const dryRun = testDeps(root, template);
    await expect(runBootstrap(['--repo', 'octo/project', '--dry-run'], dryRun.deps)).resolves.toMatchObject({ dryRun: true });

    const generateOnly = testDeps(root, template);
    await expect(
      runBootstrap(['--repo', 'octo/project', '--generate-only'], generateOnly.deps),
    ).resolves.toMatchObject({ workflowStatus: 'created', gitignoreStatus: 'updated' });

    await expect(
      runBootstrap(['--repo', 'octo/project', '--generate-only', '--github-config'], testDeps(root, template).deps),
    ).rejects.toThrow('--generate-only 与 --github-config 不能同时使用');
  });
});

describe('local bootstrap idempotency and boundaries', () => {
  it('ships a production template that references the Gate secret, not github.token', async () => {
    const template = await readFile(nodePath.resolve(process.cwd(), 'templates', 'workflow.yml'), 'utf8');
    expect(template).toContain('github-token: ${{ secrets.GATEFLOW_GATE_TOKEN }}');
    expect(template).not.toContain('github-token: ${{ github.token }}');
  });

  it('uses the supplied workdir and creates the workflow, minimal config, and incremental runtime ignore', async () => {
    const { root, template } = await makeTarget();
    const fetch = vi.fn();
    const captured = testDeps(root, template);
    const result = await runBootstrap(
      ['--repo', 'octo/project', '--workdir', root, '--generate-only'],
      { ...captured.deps, fetch },
    );

    expect(result.target).toBe(nodePath.join(root, '.github', 'workflows', 'ai-workflow.yml'));
    expect(await readFile(result.target, 'utf8')).toContain('uses: jesongit/gateflow@v0');
    expect(await readFile(nodePath.join(root, 'gateflow.config.yml'), 'utf8')).toBe(
      'version: 1\nrepository: octo/project\n# Gate records are signed by the user behind GATEFLOW_GATE_TOKEN.\n# gate_logins:\n#   - your-github-login\n',
    );
    const workflow = await readFile(result.target, 'utf8');
    expect(workflow).toContain('github-token: ${{ secrets.GATEFLOW_GATE_TOKEN }}');
    expect(workflow).not.toContain('github-token: ${{ github.token }}');
    expect(workflow).not.toContain('test-token');
    expect(await readFile(nodePath.join(root, 'gateflow.config.yml'), 'utf8')).not.toContain('test-token');
    expect(await readFile(nodePath.join(root, '.gitignore'), 'utf8')).toBe(
      '# GateFlow V1 local runtime\n.gateflow/\n',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(captured.logs.join('\n')).toContain('GitHub 配置');
    expect(captured.logs.join('\n')).toContain('GATEFLOW_GATE_TOKEN');
    expect(captured.logs.join('\n')).toContain('gate_logins');

    const rerun = await runBootstrap(
      ['--repo', 'octo/project', '--workdir', root, '--generate-only'],
      { ...testDeps(root, template).deps, fetch },
    );
    expect(rerun).toMatchObject({ workflowStatus: 'same', configStatus: 'present', gitignoreStatus: 'present' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not overwrite an identical or different existing workflow', async () => {
    const { root, template } = await makeTarget();
    const workflow = nodePath.join(root, '.github', 'workflows', 'ai-workflow.yml');
    await mkdir(nodePath.dirname(workflow), { recursive: true });
    await writeFile(workflow, TEMPLATE, 'utf8');
    await writeFile(nodePath.join(root, '.gitignore'), '.gateflow/\n', 'utf8');

    const same = testDeps(root, template);
    await expect(runBootstrap(['--repo', 'octo/project', '--generate-only'], same.deps)).resolves.toMatchObject({
      workflowStatus: 'same',
    });
    expect(same.logs.join('\n')).toContain('与当前模板一致');

    const custom = `${TEMPLATE}\n# repository-specific change\n`;
    await writeFile(workflow, custom, 'utf8');
    const different = testDeps(root, template);
    await expect(runBootstrap(['--repo', 'octo/project', '--generate-only'], different.deps)).resolves.toMatchObject({
      workflowStatus: 'different',
    });
    expect(await readFile(workflow, 'utf8')).toBe(custom);
    expect(different.logs.join('\n')).toContain('存在差异，绝不覆盖');
  });

  it('skips local writes in non-interactive mode without explicit approval', async () => {
    const { root, template } = await makeTarget();
    const captured = testDeps(root, template);
    const result = await runBootstrap(
      ['--repo', 'octo/project', '--non-interactive'],
      captured.deps,
    );

    expect(result.workflowStatus).toBe('skipped');
    expect(result.configStatus).toBe('skipped');
    expect(result.gitignoreStatus).toBe('skipped');
    await expect(readFile(nodePath.join(root, '.github', 'workflows', 'ai-workflow.yml'), 'utf8')).rejects.toThrow();
    await expect(readFile(nodePath.join(root, '.gitignore'), 'utf8')).rejects.toThrow();
    await expect(readFile(nodePath.join(root, 'gateflow.config.yml'), 'utf8')).rejects.toThrow();
  });

  it('warns about the legacy workflow token without overwriting an existing workflow', async () => {
    const { root, template } = await makeTarget();
    const workflow = nodePath.join(root, '.github', 'workflows', 'ai-workflow.yml');
    await mkdir(nodePath.dirname(workflow), { recursive: true });
    await writeFile(workflow, TEMPLATE.replace('${{ secrets.GATEFLOW_GATE_TOKEN }}', '${{ github.token }}'), 'utf8');

    const captured = testDeps(root, template);
    const result = await runBootstrap(['--repo', 'octo/project', '--generate-only'], captured.deps);

    expect(result.workflowStatus).toBe('different');
    expect(await readFile(workflow, 'utf8')).toContain('${{ github.token }}');
    expect(captured.logs.join('\n')).toContain('github-token: ${{ secrets.GATEFLOW_GATE_TOKEN }}');
    expect(captured.logs.join('\n')).toContain('绝不覆盖');
  });
});

describe('GitHub configuration boundary', () => {
  it('creates only missing labels when GitHub configuration is explicitly enabled', async () => {
    const { root, template } = await makeTarget();
    const captured = testDeps(root, template);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return response(200, { full_name: 'octo/project', permissions: { push: true }, owner: { type: 'User' } });
      }
      if (calls.length === 2) return response(200, []);
      return response(201, {});
    });

    await runBootstrap(
      ['--repo', 'octo/project', '--token', 'secret', '--github-config', '--yes'],
      { ...captured.deps, fetch },
    );

    expect(fetch).toHaveBeenCalledTimes(8);
    const posts = calls.filter(({ init }) => init?.method === 'POST');
    expect(posts).toHaveLength(LABELS.length);
    expect(JSON.parse(String(posts[0]?.init?.body))).toMatchObject({ name: 'ai:planning' });
  });

  it('checks permission before labels and skips every existing ai:* label without updating attributes', async () => {
    const { root, template } = await makeTarget();
    await writeFile(nodePath.join(root, '.gitignore'), '.gitignore-entry\n.gateflow/\n', 'utf8');
    const captured = testDeps(root, template);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return response(200, { full_name: 'octo/project', permissions: { push: true }, owner: { type: 'User' } });
      }
      return response(200, LABELS.map((label: { name: string; color: string; description: string }) => ({
        ...label,
        color: '000000',
        description: 'custom',
      })));
    });

    const result = await runBootstrap(
      ['--repo', 'octo/project', '--token', 'secret', '--github-config', '--generate-only'],
      { ...captured.deps, fetch },
    ).catch((error: unknown) => error);

    // The two flags are intentionally rejected before network or file writes.
    expect(result).toBeInstanceOf(Error);
    expect(fetch).not.toHaveBeenCalled();

    const normal = testDeps(root, template);
    const normalFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return response(200, { full_name: 'octo/project', permissions: { push: true }, owner: { type: 'User' } });
      }
      return response(200, LABELS.map((label: { name: string; color: string; description: string }) => ({
        ...label,
        color: '000000',
        description: 'custom',
      })));
    });
    await runBootstrap(
      ['--repo', 'octo/project', '--token', 'secret', '--github-config', '--yes'],
      { ...normal.deps, fetch: normalFetch },
    );
    expect(normalFetch).toHaveBeenCalledTimes(2);
    expect(normalFetch.mock.calls.slice(1).every(([, init]) => init?.method !== 'POST')).toBe(true);
    expect(normal.logs.join('\n')).toContain('标签已存在，不做任何修改');
  });

  it('fails closed on a repository without push permission before attempting labels', async () => {
    const { root, template } = await makeTarget();
    const captured = testDeps(root, template);
    const fetch = vi.fn(async () => response(200, {
      full_name: 'octo/project',
      permissions: { push: false },
      owner: { type: 'User' },
    }));

    await expect(
      runBootstrap(['--repo', 'octo/project', '--token', 'secret', '--github-config'], {
        ...captured.deps,
        fetch,
      }),
    ).rejects.toThrow('没有写权限');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
