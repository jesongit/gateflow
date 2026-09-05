#!/usr/bin/env node
/**
 * github-ai-workflow bootstrap (Phase 8).
 *
 * Idempotent setup helper for adopting the workflow in a target repository.
 * Run it from the checkout of the TARGET repository (the workflow file is
 * written into the current working directory). Safe to re-run at any time:
 *
 *   1. verify the token can access the repo (GET /repos/{owner}/{repo});
 *   2. create the six ai:* labels (names / colors / descriptions frozen in
 *      docs/protocol.md). Existing labels with the same name are skipped and
 *      NEVER modified (color / description stay untouched);
 *   3. generate .github/workflows/<workflow-file> from templates/workflow.yml
 *      (replacing the action-ref placeholder) — only when the file does not
 *      exist and only after interactive confirmation. An existing file is
 *      warned about and NEVER overwritten; existing issue templates and PR
 *      workflows are never touched;
 *   4. print the remaining manual steps (GitHub MCP toolsets, Skills install)
 *      — hints only, the script never does them for you.
 *
 * Zero dependencies: uses the fetch built into Node >= 20.
 *
 * Usage examples:
 *   node scripts/bootstrap.mjs --repo owner/target --token $GITHUB_TOKEN
 *   node scripts/bootstrap.mjs --repo owner/target --action-ref owner/github-ai-workflow@main
 *   node scripts/bootstrap.mjs --repo owner/target --dry-run
 *
 * `--repo` defaults to $GITHUB_REPOSITORY, `--token` to $GITHUB_TOKEN.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

/** Placeholder reference written in templates/workflow.yml (Phase 9 ships the real owner). */
const DEFAULT_ACTION_REF = 'jesongit/github-ai-workflow@v0';
const DEFAULT_WORKFLOW_FILE = 'ai-workflow.yml';
const GITHUB_API_BASE = 'https://api.github.com';

/**
 * The six workflow labels, frozen in docs/protocol.md section 1. Colors and
 * descriptions must stay in sync with that document (colors are suggestions
 * there, but the bootstrap applies them verbatim on creation only).
 */
const LABELS = [
  { name: 'ai:planning', color: 'd4c5f9', description: 'Work Item 已进入 Workflow，Consumer 正在分析 / 补全设计' },
  { name: 'ai:review', color: 'fef2c0', description: 'Execution Plan 已发布，等待 Trusted Human 审批' },
  { name: 'ai:ready', color: 'c2e0c6', description: 'Plan 已批准，等待 Executor 接手' },
  { name: 'ai:working', color: '1d76db', description: 'Executor 正在按 Approved Plan 执行' },
  { name: 'ai:blocked', color: 'd93f0b', description: '执行被阻塞（WORKING 的子状态）' },
  { name: 'ai:done', color: '0e8a16', description: 'AI 工作已完成，等待 Owner 最终检查（不等于 Issue 已关闭）' },
];

const USAGE = `github-ai-workflow bootstrap —— 为目标仓库初始化 AI Workflow（幂等，可重复执行）

用法：
  node scripts/bootstrap.mjs --repo owner/name [选项]

参数：
  --repo owner/name       目标仓库（缺省读 GITHUB_REPOSITORY 环境变量）
  --token <token>         GitHub token，需要对目标仓库的写权限（缺省读 GITHUB_TOKEN）
  --action-ref <ref>      workflow 中 uses: 的 Action 引用（默认 ${DEFAULT_ACTION_REF}）
  --workflow-file <name>  生成的 workflow 文件名（默认 ${DEFAULT_WORKFLOW_FILE}）
  --dry-run               只打印将做什么，不做任何修改、不访问网络
  --help                  显示本帮助

行为（在目标仓库的检出目录内运行；workflow 文件写入当前工作目录）：
  1. 校验 token 与仓库可访问（GET /repos/{owner}/{repo}）；
  2. 创建 6 个 ai:* 标签——已存在的同名标签跳过，绝不修改其颜色 / 描述；
  3. .github/workflows/<file> 不存在时，经确认后从 templates/workflow.yml 生成；
     已存在则警告并跳过，绝不覆盖（也不触碰已有 issue templates 与 PR workflow）；
  4. 打印剩余手动步骤（GitHub MCP toolsets、Skills 安装）——只提示，不代劳。
`;

/** Error with a user-facing message: printed as `[error] ...` without a stack. */
class BootstrapError extends Error {}

function parseArgs(argv) {
  const opts = {
    repo: null,
    token: null,
    actionRef: DEFAULT_ACTION_REF,
    workflowFile: DEFAULT_WORKFLOW_FILE,
    dryRun: false,
    help: false,
  };
  const value = (flag, index) => {
    if (index >= argv.length) {
      throw new BootstrapError(`参数 ${flag} 缺少值（用法见 --help）`);
    }
    return argv[index];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--repo':
        opts.repo = value(flag, (i += 1));
        break;
      case '--token':
        opts.token = value(flag, (i += 1));
        break;
      case '--action-ref':
        opts.actionRef = value(flag, (i += 1));
        break;
      case '--workflow-file':
        opts.workflowFile = value(flag, (i += 1));
        break;
      default:
        throw new BootstrapError(`未知参数：${flag}（用法见 --help）`);
    }
  }
  return opts;
}

function validateOptions(opts) {
  if (opts.repo === null && process.env.GITHUB_REPOSITORY) {
    opts.repo = process.env.GITHUB_REPOSITORY;
  }
  if (opts.token === null && process.env.GITHUB_TOKEN) {
    opts.token = process.env.GITHUB_TOKEN;
  }
  if (!opts.repo) {
    throw new BootstrapError('缺少目标仓库：请用 --repo owner/name 传入，或设置 GITHUB_REPOSITORY 环境变量（用法见 --help）');
  }
  if (!/^\S+\/\S+$/.test(opts.repo)) {
    throw new BootstrapError(`--repo 格式应为 owner/name，收到："${opts.repo}"`);
  }
  if (!opts.token) {
    throw new BootstrapError('缺少 GitHub token：请用 --token 传入，或设置 GITHUB_TOKEN 环境变量（需要对目标仓库的写权限）');
  }
  if (/\s/.test(opts.actionRef)) {
    throw new BootstrapError(`--action-ref 不能包含空白字符："${opts.actionRef}"`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(yml|yaml)$/.test(opts.workflowFile)) {
    throw new BootstrapError(`--workflow-file 应为不含路径的 .yml / .yaml 文件名，收到："${opts.workflowFile}"`);
  }
}

/** Resolves templates/workflow.yml: next to this script first, cwd fallback second. */
function templatePath() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(scriptDir, '..', 'templates', 'workflow.yml'),
    join(process.cwd(), 'templates', 'workflow.yml'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new BootstrapError(`找不到 templates/workflow.yml（已尝试：${candidates.join(' , ')}）`);
  }
  return found;
}

function workflowTargetPath(workflowFile) {
  return join(process.cwd(), '.github', 'workflows', workflowFile);
}

async function confirm(question) {
  if (!process.stdin.isTTY) {
    console.log('[warn] 当前不是交互式终端，无法询问确认：跳过 workflow 文件生成（请在终端中重新运行）。');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function githubApi(token, path, init = {}) {
  let res;
  try {
    res = await fetch(`${GITHUB_API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new BootstrapError(`无法访问 GitHub API（${err instanceof Error ? err.message : String(err)}），请检查网络连接`);
  }
  return res;
}

/** Step 1: verify the token can see the repo. Returns the repo payload. */
async function verifyRepo(token, repo) {
  const res = await githubApi(token, `/repos/${repo}`);
  if (res.status === 401) {
    throw new BootstrapError('token 无效或已过期（HTTP 401）：请检查 --token / GITHUB_TOKEN');
  }
  if (res.status === 404) {
    throw new BootstrapError(`仓库不存在或 token 无权访问：${repo}（HTTP 404）`);
  }
  if (!res.ok) {
    throw new BootstrapError(`校验仓库失败：${repo}（HTTP ${res.status} ${res.statusText}）`);
  }
  const data = await res.json();
  console.log(`[ok] 仓库可访问：${data.full_name ?? repo}`);
  if (data.private === true) {
    console.log('[ok] 私有仓库：token 需要具备该仓库的写权限。');
  }
  if (data.permissions && data.permissions.push === false) {
    console.log('[warn] 当前 token 对该仓库没有写权限（push=false），创建标签将失败。');
  }
  return data;
}

/** Fetches all existing label names of the repo (paginated). */
async function listAllLabelNames(token, repo) {
  const names = [];
  let page = 1;
  for (;;) {
    const res = await githubApi(token, `/repos/${repo}/labels?per_page=100&page=${page}`);
    if (!res.ok) {
      throw new BootstrapError(`读取已有标签失败（HTTP ${res.status} ${res.statusText}）`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const label of batch) {
      if (typeof label?.name === 'string') names.push(label.name);
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return names;
}

/**
 * Step 2: create the six ai:* labels. Same-name labels are skipped untouched
 * (existing color / description are never modified). A 422 race is treated
 * as "someone else created it first" = skip.
 */
async function ensureLabels(token, repo) {
  const existing = new Set(await listAllLabelNames(token, repo));
  for (const label of LABELS) {
    if (existing.has(label.name)) {
      console.log(`[skip] 标签已存在，不做任何修改：${label.name}`);
      continue;
    }
    const res = await githubApi(token, `/repos/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({ name: label.name, color: label.color, description: label.description }),
    });
    if (res.status === 422) {
      console.log(`[warn] 标签已被并发创建，跳过：${label.name}`);
      continue;
    }
    if (!res.ok) {
      throw new BootstrapError(`创建标签失败：${label.name}（HTTP ${res.status} ${res.statusText}）`);
    }
    console.log(`[create] 标签已创建：${label.name}（#${label.color}）`);
  }
}

/**
 * Step 3: generate the workflow file if (and only if) it does not exist yet.
 * The write uses flag 'wx' as a second line of defence against overwriting.
 */
async function ensureWorkflow(opts, target) {
  if (existsSync(target)) {
    console.log(`[warn] workflow 文件已存在，警告并跳过（绝不覆盖）：${target}`);
    return;
  }
  const template = readFileSync(templatePath(), 'utf8');
  const content = template.split(DEFAULT_ACTION_REF).join(opts.actionRef);
  const ok = await confirm(`[confirm] 将创建 ${target}（uses: ${opts.actionRef}），是否继续？[Y/n] `);
  if (!ok) {
    console.log('[skip] 已取消：未创建 workflow 文件（标签不受影响）。');
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
  console.log(`[create] workflow 文件已生成：${target}`);
}

/** Step 4: manual follow-ups. Hints only — never performed by the script. */
function printNextSteps() {
  console.log('');
  console.log('收尾提示（以下步骤需要你手动完成，本脚本不代劳）：');
  console.log('  1. 在你的 AI Client（Codex / Claude Code / Cursor / VS Code 等）配置 GitHub 官方 MCP Server，');
  console.log('     最小 toolsets：repos / issues / pull_requests（只做规划时可进一步收紧写权限）。');
  console.log('     参考：https://github.com/github/github-mcp-server');
  console.log('  2. 把 skills/producer、skills/consumer、skills/executor 三个 Skill 安装到你的 AI Client（全局或项目级）。');
  console.log('');
  console.log('提交并推送生成的 .github/workflows/<file> 后，按 docs/usage.md §3 开始使用：/ai-plan → /approve → 执行。');
}

/** Dry-run: print the plan without touching the network or the filesystem. */
function printDryRunPlan(opts, target) {
  console.log('[dry-run] 以下是将要执行的操作（本次不做任何修改、不访问网络）：');
  console.log('');
  console.log(`[dry-run] 目标仓库：${opts.repo}`);
  console.log(`[dry-run] 步骤 1：校验 token 与仓库可访问（GET /repos/${opts.repo}）`);
  console.log('[dry-run] 步骤 2：创建以下 6 个 ai:* 标签（同名已存在的标签将跳过，绝不修改其颜色 / 描述）：');
  for (const label of LABELS) {
    console.log(`[create] 将创建标签：${label.name}（#${label.color}，描述：${label.description}）`);
  }
  console.log(`[dry-run] 步骤 3：workflow 文件：${target}`);
  if (existsSync(target)) {
    console.log('[warn] 该文件已存在：将警告并跳过，绝不覆盖。');
  } else {
    console.log(`[create] 将在确认后从 templates/workflow.yml 生成（uses: ${opts.actionRef}）。`);
  }
  console.log('[dry-run] 步骤 4：打印 GitHub MCP 与 Skills 安装提示（只提示，不代劳）。');
  console.log('');
  printNextSteps();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  validateOptions(opts);

  const target = workflowTargetPath(opts.workflowFile);
  if (opts.dryRun) {
    printDryRunPlan(opts, target);
    return;
  }

  console.log('== github-ai-workflow bootstrap ==');
  console.log(`目标仓库：${opts.repo}`);
  console.log(`Action 引用：${opts.actionRef}`);
  console.log('');
  console.log('步骤 1/3：校验 token 与仓库…');
  await verifyRepo(opts.token, opts.repo);
  console.log('');
  console.log('步骤 2/3：创建 ai:* 标签（已存在的同名标签跳过，绝不修改）…');
  await ensureLabels(opts.token, opts.repo);
  console.log('');
  console.log('步骤 3/3：workflow 文件（已存在则警告跳过，绝不覆盖）…');
  await ensureWorkflow(opts, target);
  printNextSteps();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[error] ${message}`);
  console.error('已中止：未完成的步骤可在修复问题后重新运行（本脚本幂等）。');
  process.exitCode = 1;
});
