#!/usr/bin/env node
/**
 * gateflow bootstrap.
 *
 * One small, repeatable installer for both kinds of target checkout:
 *   - an existing project being connected to GateFlow; and
 *   - a project that was just created and now needs its local GateFlow files.
 *
 * The script deliberately has two explicit boundaries:
 *   - `--github-config` is required before it talks to GitHub or creates
 *     labels; and
 *   - local file creation is confirmed unless `--yes` or `--generate-only`
 *     was explicitly supplied.
 *
 * It never creates, deletes, or overwrites a repository or an existing
 * workflow. It uses Node's built-in fetch and has no dependency on a global
 * GateFlow CLI.
 */

import {
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  statSync as defaultStatSync,
  writeFileSync as defaultWriteFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

/** Placeholder reference written in templates/workflow.yml. */
export const DEFAULT_ACTION_REF = 'jesongit/gateflow@v0';
export const DEFAULT_WORKFLOW_FILE = 'ai-workflow.yml';
export const DEFAULT_INSTALL_MODE = 'existing';
export const GITHUB_API_BASE = 'https://api.github.com';
const CONFIG_FILE = 'gateflow.config.yml';
const GITIGNORE_ENTRY = '.gateflow/';

function minimumConfig(repo) {
  return `version: 1\nrepository: ${repo}\n`;
}

/**
 * The six workflow labels, frozen in docs/protocol.md section 1. Existing
 * same-name labels are intentionally never read-modify-written.
 */
export const LABELS = [
  { name: 'ai:planning', color: 'd4c5f9', description: 'Work Item 已进入 Workflow，GateFlow 正在准备规划' },
  { name: 'ai:review', color: 'fef2c0', description: 'Execution Plan 已发布，等待 Trusted Human 审批' },
  { name: 'ai:ready', color: 'c2e0c6', description: 'Plan 已批准，等待 Driver 接手执行' },
  { name: 'ai:working', color: '1d76db', description: 'Driver 已派发任务，Agent 正在执行' },
  { name: 'ai:blocked', color: 'd93f0b', description: '执行被阻塞（WORKING 的子状态）' },
  { name: 'ai:done', color: '0e8a16', description: 'AI 工作已完成，等待 Owner 最终检查（不等于 Issue 已关闭）' },
];

const USAGE = `gateflow bootstrap —— 为目标仓库初始化 AI Workflow（幂等，可重复执行）

用法：
  node scripts/bootstrap.mjs --repo owner/name [选项]

参数：
  --repo owner/name          目标仓库（缺省读 GITHUB_REPOSITORY 环境变量）
  --token <token>            GitHub token（缺省读 GITHUB_TOKEN；仅 --github-config 需要）
  --workdir <dir>            目标仓库检出目录（默认当前目录）
  --target-dir <dir>         --workdir 的等价写法
  --install-mode <mode>      安装模式：existing（已有项目）或 new（新项目创建后）
  --action-ref <ref>         workflow 中 uses: 的 Action 引用（默认 ${DEFAULT_ACTION_REF}）
  --workflow-file <name>     生成的 workflow 文件名（默认 ${DEFAULT_WORKFLOW_FILE}）
  --github-config            执行 GitHub 仓库检查和缺失标签创建（默认不执行）
  --no-github-config         明确跳过 GitHub 配置
  --generate-only             仅生成本地文件；不访问网络、不执行 GitHub 配置
  --non-interactive           不询问确认；未显式批准的本地写入将跳过
  --yes, -y                   明确批准本次本地文件生成/增量更新
  --dry-run                   只打印计划；不访问网络、不修改文件
  --help                      显示本帮助

行为：
  1. 检查目标工作目录、本地 GateFlow 安装状态和必要配置；
  2. 需要时将 .github/workflows/<file> 与模板渲染结果比较；已有文件只提示差异，绝不覆盖；
  3. 生成不含凭证的最小 gateflow.config.yml，并增量加入 .gitignore 的 .gateflow/；不修改业务源码、已有 CI、Issue Template 或其它 workflow；
  4. 只有显式传 --github-config 才检查 GitHub 权限并创建缺失的 6 个 ai:* 标签；同名标签始终跳过；
  5. 打印 Trusted Human、Driver 和唯一 GateFlow Skill 的后续配置提示，不替用户安装或写入凭证。
`;

/** Error with a user-facing message: printed as `[error] ...` without a stack. */
export class BootstrapError extends Error {}

function defaultLog(...args) {
  console.log(...args);
}

function defaultError(...args) {
  console.error(...args);
}

/** Small injectable boundary used by tests and by callers embedding the script. */
function makeIo(deps = {}) {
  return {
    existsSync: deps.existsSync ?? defaultExistsSync,
    mkdirSync: deps.mkdirSync ?? defaultMkdirSync,
    readFileSync: deps.readFileSync ?? defaultReadFileSync,
    statSync: deps.statSync ?? defaultStatSync,
    writeFileSync: deps.writeFileSync ?? defaultWriteFileSync,
    fetch: deps.fetch ?? globalThis.fetch,
    confirm: deps.confirm ?? defaultConfirm,
    log: deps.log ?? defaultLog,
    error: deps.error ?? defaultError,
    env: deps.env ?? process.env,
    cwd: deps.cwd ?? process.cwd(),
    templatePath: deps.templatePath,
  };
}

/** Parse CLI flags without performing I/O. */
export function parseArgs(argv) {
  const opts = {
    repo: null,
    token: null,
    workdir: null,
    installMode: DEFAULT_INSTALL_MODE,
    installModeExplicit: false,
    actionRef: DEFAULT_ACTION_REF,
    workflowFile: DEFAULT_WORKFLOW_FILE,
    githubConfig: false,
    generateOnly: false,
    nonInteractive: false,
    yes: false,
    dryRun: false,
    help: false,
  };

  const value = (flag, index) => {
    if (index >= argv.length || argv[index].startsWith('--')) {
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
      case '--generate-only':
        opts.generateOnly = true;
        break;
      case '--github-config':
        opts.githubConfig = true;
        break;
      case '--no-github-config':
      case '--skip-github-config':
        opts.githubConfig = false;
        break;
      case '--non-interactive':
        opts.nonInteractive = true;
        break;
      case '--yes':
      case '-y':
        opts.yes = true;
        break;
      case '--repo':
        opts.repo = value(flag, (i += 1));
        break;
      case '--token':
        opts.token = value(flag, (i += 1));
        break;
      case '--workdir':
      case '--target-dir':
        opts.workdir = value(flag, (i += 1));
        break;
      case '--install-mode':
        opts.installMode = value(flag, (i += 1));
        opts.installModeExplicit = true;
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

function isDirectory(path, io) {
  try {
    return io.statSync(path).isDirectory();
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return false;
    throw new BootstrapError(`无法检查目标工作目录 ${path}：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Validate and resolve options. Dry-run and generate-only intentionally do not need a token. */
export function validateOptions(opts, env = process.env, io = makeIo({ env })) {
  if (opts.repo === null && env.GITHUB_REPOSITORY) {
    opts.repo = env.GITHUB_REPOSITORY;
  }
  if (opts.token === null && env.GITHUB_TOKEN) {
    opts.token = env.GITHUB_TOKEN;
  }
  if (!opts.repo) {
    throw new BootstrapError('缺少目标仓库：请用 --repo owner/name 传入，或设置 GITHUB_REPOSITORY 环境变量（用法见 --help）');
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) {
    throw new BootstrapError(`--repo 格式应为 owner/name，收到："${opts.repo}"`);
  }
  if (opts.githubConfig && opts.generateOnly) {
    throw new BootstrapError('--generate-only 与 --github-config 不能同时使用：请明确选择仅生成文件或执行 GitHub 配置');
  }
  if (opts.githubConfig && !opts.dryRun && !opts.token) {
    throw new BootstrapError('缺少 GitHub token：执行 --github-config 请用 --token 传入，或设置 GITHUB_TOKEN');
  }
  if (typeof opts.actionRef !== 'string' || opts.actionRef.length === 0 || /\s/.test(opts.actionRef)) {
    throw new BootstrapError(`--action-ref 不能包含空白字符且不能为空："${opts.actionRef}"`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(yml|yaml)$/.test(opts.workflowFile)) {
    throw new BootstrapError(`--workflow-file 应为不含路径的 .yml / .yaml 文件名，收到："${opts.workflowFile}"`);
  }
  if (!['existing', 'new'].includes(opts.installMode)) {
    throw new BootstrapError(`--install-mode 只能是 existing 或 new，收到："${opts.installMode}"`);
  }

  const workdir = resolve(io.cwd, opts.workdir ?? io.cwd);
  if (workdir === resolve(workdir, '..')) {
    throw new BootstrapError(`目标工作目录不能是文件系统根目录：${workdir}`);
  }
  if (!isDirectory(workdir, io)) {
    throw new BootstrapError(`目标工作目录不存在或不是目录：${workdir}（请先检出或创建目标仓库）`);
  }
  opts.workdir = workdir;
  return opts;
}

/** Resolves templates/workflow.yml beside this script first, then beside the target checkout. */
function templatePath(io, workdir) {
  if (typeof io.templatePath === 'function') return io.templatePath(workdir);
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(scriptDir, '..', 'templates', 'workflow.yml'),
    join(workdir, 'templates', 'workflow.yml'),
  ];
  const found = candidates.find((candidate) => io.existsSync(candidate));
  if (!found) {
    throw new BootstrapError(`找不到 templates/workflow.yml（已尝试：${candidates.join(' , ')}）`);
  }
  return found;
}

function workflowTargetPath(workdir, workflowFile) {
  return join(workdir, '.github', 'workflows', workflowFile);
}

function readText(path, io, description = path) {
  try {
    return io.readFileSync(path, 'utf8');
  } catch (err) {
    throw new BootstrapError(`无法读取${description}：${path}（${err instanceof Error ? err.message : String(err)}）`);
  }
}

function renderedWorkflow(opts, io) {
  const sourcePath = templatePath(io, opts.workdir);
  const source = readText(sourcePath, io, 'workflow 模板');
  return {
    sourcePath,
    content: source.split(DEFAULT_ACTION_REF).join(opts.actionRef),
  };
}

function workflowState(target, expected, io) {
  if (!io.existsSync(target)) {
    return { status: 'missing', current: null };
  }
  const current = readText(target, io, '已有 workflow 文件');
  return {
    status: current === expected ? 'same' : 'different',
    current,
  };
}

function hasGitignoreEntry(content) {
  return content.split(/\r?\n/).some((line) => {
    const normalized = line.trim();
    return normalized === GITIGNORE_ENTRY || normalized === '.gateflow';
  });
}

function gitignoreState(workdir, io) {
  const path = join(workdir, '.gitignore');
  if (!io.existsSync(path)) {
    return {
      path,
      status: 'missing',
      current: null,
      next: `# GateFlow V1 local runtime\n${GITIGNORE_ENTRY}\n`,
    };
  }
  const current = readText(path, io, '.gitignore');
  if (hasGitignoreEntry(current)) {
    return { path, status: 'present', current, next: current };
  }
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current.length === 0 ? '' : current.endsWith('\n') ? newline : `${newline}${newline}`;
  return {
    path,
    status: 'needs-update',
    current,
    next: `${current}${separator}# GateFlow V1 local runtime${newline}${GITIGNORE_ENTRY}${newline}`,
  };
}

function configState(workdir, repo, io) {
  const path = join(workdir, CONFIG_FILE);
  if (!io.existsSync(path)) {
    io.log(`[info] 未找到 ${CONFIG_FILE}：将按确认生成最小配置；Organization 仓库仍需人工配置 trusted_humans。`);
    return { path, status: 'missing', trustedHumansConfigured: false, next: minimumConfig(repo) };
  }

  const content = readText(path, io, 'GateFlow 配置');
  const errors = [];
  if (!/^\s*version\s*:\s*1\s*(?:#.*)?$/m.test(content)) {
    errors.push('version 必须为 1');
  }
  const repositoryLine = /^\s*repository\s*:\s*([^\s#]+)\s*(?:#.*)?$/m.exec(content);
  if (repositoryLine && repositoryLine[1].replace(/^['"]|['"]$/g, '') !== repo) {
    errors.push(`repository 应为 ${repo}`);
  }
  if (/\b(?:GITHUB_TOKEN|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/.test(content)) {
    errors.push('配置文件不应包含 GitHub 凭证');
  }
  if (errors.length > 0) {
    throw new BootstrapError(`${CONFIG_FILE} 检查失败：${errors.join('；')}。请人工修正后重新运行。`);
  }

  const lines = content.split(/\r?\n/);
  const trustedHumansIndex = lines.findIndex((line) => /^\s*trusted_humans\s*:/.test(line));
  const trustedHumansLine = trustedHumansIndex >= 0
    ? /^\s*trusted_humans\s*:\s*(.*)$/.exec(lines[trustedHumansIndex])
    : null;
  const inlineHumans = trustedHumansLine !== null
    && !/^\s*(?:\[\s*\]|['"]{2})?\s*(?:#.*)?$/.test(trustedHumansLine[1]);
  let listHumans = false;
  if (trustedHumansIndex >= 0 && !inlineHumans) {
    for (const line of lines.slice(trustedHumansIndex + 1)) {
      if (/^\S/.test(line) && !/^\s*(?:#|$)/.test(line)) break;
      if (/^\s+-\s*\S+/.test(line)) {
        listHumans = true;
        break;
      }
    }
  }
  const trustedHumansConfigured = inlineHumans || listHumans;
  io.log(`[ok] 已发现并检查 ${CONFIG_FILE}：version 1${trustedHumansConfigured ? '，已配置 trusted_humans' : '，trusted_humans 仍需按身份模型确认'}`);
  return { path, status: 'present', trustedHumansConfigured, content };
}

function inspectWorkflowInputs(target, current, io, repoInfo) {
  if (current === null) return;
  const missing = [];
  if (!/^\s*permissions\s*:/m.test(current) || !/^\s+issues\s*:\s*write\s*$/m.test(current)) {
    missing.push('permissions.issues: write');
  }
  if (!/^\s*trusted-humans\s*:/m.test(current)) missing.push('trusted-humans');
  if (!/^\s*trusted-agents\s*:/m.test(current)) missing.push('trusted-agents');
  if (missing.length > 0) {
    io.log(`[warn] 已有 workflow ${target} 缺少或无法确认必要配置：${missing.join('、')}；文件保持不变，请人工审阅。`);
  }
  const trustedHumansLine = /^\s*trusted-humans\s*:\s*(.*)$/m.exec(current);
  const trustedHumansConfigured = trustedHumansLine !== null
    && !/^\s*(?:\[\s*\]|['"]{2})?\s*(?:#.*)?$/.test(trustedHumansLine[1]);
  if (repoInfo?.owner?.type === 'Organization' && !trustedHumansConfigured) {
    io.log('[warn] Organization 仓库的 trusted-humans 未确认有值；请按批准范围配置可信人类，Driver 也需要显式身份配置。');
  }
}

async function defaultConfirm(question) {
  if (!process.stdin.isTTY) {
    console.log('[warn] 当前不是交互式终端，未获得本地文件写入确认：跳过该文件（可用 --yes 或 --generate-only 明确批准）。');
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

async function approveLocalWrite(opts, io, question) {
  if (opts.generateOnly || opts.yes) return true;
  if (opts.nonInteractive) {
    io.log('[warn] 非交互模式未提供 --yes：跳过未获明确批准的本地写入。');
    return false;
  }
  return io.confirm(question);
}

async function ensureWorkflow(opts, state, expected, target, io) {
  if (state.status === 'same') {
    io.log(`[ok] workflow 文件已存在且与当前模板一致，跳过：${target}`);
    return 'same';
  }
  if (state.status === 'different') {
    io.log(`[warn] workflow 文件与当前模板渲染结果存在差异，绝不覆盖：${target}`);
    io.log('[warn] 现有 workflow 已保留；如需升级，请人工审阅差异并自行提交。');
    return 'different';
  }

  const ok = await approveLocalWrite(
    opts,
    io,
    `[confirm] 将在 ${target} 创建 workflow（uses: ${opts.actionRef}），是否继续？[Y/n] `,
  );
  if (!ok) {
    io.log(`[skip] 未创建 workflow 文件（未获得确认）：${target}`);
    return 'skipped';
  }
  try {
    io.mkdirSync(dirname(target), { recursive: true });
    io.writeFileSync(target, expected, { encoding: 'utf8', flag: 'wx' });
    io.log(`[create] workflow 文件已生成：${target}`);
    return 'created';
  } catch (err) {
    if (err?.code === 'EEXIST') {
      io.log(`[warn] workflow 文件在检查后已出现，跳过且绝不覆盖：${target}`);
      return 'race-skipped';
    }
    throw new BootstrapError(`生成 workflow 文件失败：${target}（${err instanceof Error ? err.message : String(err)}）`);
  }
}

async function ensureGitignore(opts, state, io) {
  if (state.status === 'present') {
    io.log(`[ok] .gitignore 已包含 ${GITIGNORE_ENTRY}，跳过：${state.path}`);
    return 'present';
  }
  const action = state.status === 'missing' ? '创建 .gitignore 并加入' : '向 .gitignore 增量加入';
  const ok = await approveLocalWrite(opts, io, `[confirm] 将${action} ${GITIGNORE_ENTRY}：${state.path}，是否继续？[Y/n] `);
  if (!ok) {
    io.log(`[skip] 未更新 .gitignore（未获得确认）：${state.path}`);
    return 'skipped';
  }
  try {
    if (state.status === 'missing') {
      io.writeFileSync(state.path, state.next, { encoding: 'utf8', flag: 'wx' });
      io.log(`[create] 已生成 .gitignore 并忽略 GateFlow 本地运行目录：${state.path}`);
    } else {
      io.writeFileSync(state.path, state.next, { encoding: 'utf8', flag: 'w' });
      io.log(`[update] 已增量更新 .gitignore：${state.path}`);
    }
    return 'updated';
  } catch (err) {
    if (err?.code === 'EEXIST') {
      io.log(`[warn] .gitignore 在检查后已出现，跳过且不覆盖：${state.path}`);
      return 'race-skipped';
    }
    throw new BootstrapError(`更新 .gitignore 失败：${state.path}（${err instanceof Error ? err.message : String(err)}）`);
  }
}

async function ensureConfig(opts, state, io) {
  if (state.status === 'present') {
    io.log(`[ok] 已有 ${CONFIG_FILE} 通过必要检查，跳过且不覆盖：${state.path}`);
    return 'present';
  }
  const ok = await approveLocalWrite(
    opts,
    io,
    `[confirm] 将创建不含凭证的最小 ${CONFIG_FILE}：${state.path}，是否继续？[Y/n] `,
  );
  if (!ok) {
    io.log(`[skip] 未创建 ${CONFIG_FILE}（未获得确认）：${state.path}`);
    return 'skipped';
  }
  try {
    io.writeFileSync(state.path, state.next, { encoding: 'utf8', flag: 'wx' });
    io.log(`[create] 已生成最小 ${CONFIG_FILE}：${state.path}`);
    return 'created';
  } catch (err) {
    if (err?.code === 'EEXIST') {
      io.log(`[warn] ${CONFIG_FILE} 在检查后已出现，跳过且绝不覆盖：${state.path}`);
      return 'race-skipped';
    }
    throw new BootstrapError(`生成 ${CONFIG_FILE} 失败：${state.path}（${err instanceof Error ? err.message : String(err)}）`);
  }
}

async function githubApi(token, path, init = {}, io) {
  if (typeof io.fetch !== 'function') {
    throw new BootstrapError('当前 Node 环境没有可用的 fetch，无法执行 GitHub 配置');
  }
  let res;
  try {
    res = await io.fetch(`${GITHUB_API_BASE}${path}`, {
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

/** Check repository access and write permission before any label mutation. */
async function verifyRepo(token, repo, io) {
  const res = await githubApi(token, `/repos/${repo}`, {}, io);
  if (res.status === 401) {
    throw new BootstrapError('token 无效或已过期（HTTP 401）：请检查 --token / GITHUB_TOKEN');
  }
  if (res.status === 404) {
    throw new BootstrapError(`仓库不存在或 token 无权访问：${repo}（HTTP 404）`);
  }
  if (!res.ok) {
    throw new BootstrapError(`校验仓库失败：${repo}（HTTP ${res.status} ${res.statusText ?? ''}`.trimEnd() + ')');
  }
  const data = await res.json();
  io.log(`[ok] 仓库可访问：${data.full_name ?? repo}`);
  if (data.archived === true || data.disabled === true) {
    throw new BootstrapError(`目标仓库不可写：${repo} 已归档或被禁用，已停止 GitHub 配置`);
  }
  if (data.permissions?.push === false) {
    throw new BootstrapError(`当前 token 对目标仓库没有写权限（push=false）：${repo}；已在创建标签前停止`);
  }
  if (data.permissions?.push === true) {
    io.log('[ok] 已确认当前 token 具备仓库写权限。');
  } else {
    io.log('[warn] GitHub 未在仓库响应中返回 push 权限字段；后续写入仍会逐项失败即停。');
  }
  return data;
}

/** Fetch all existing label names. Existing attributes are deliberately ignored. */
async function listAllLabelNames(token, repo, io) {
  const names = [];
  let page = 1;
  for (;;) {
    const res = await githubApi(token, `/repos/${repo}/labels?per_page=100&page=${page}`, {}, io);
    if (!res.ok) {
      throw new BootstrapError(`读取已有标签失败（HTTP ${res.status} ${res.statusText ?? ''}`.trimEnd() + ')');
    }
    const batch = await res.json();
    if (!Array.isArray(batch)) {
      throw new BootstrapError('读取已有标签失败：GitHub 返回了非数组响应，已停止以避免误判并重复创建');
    }
    if (batch.length === 0) break;
    for (const label of batch) {
      if (typeof label?.name === 'string') names.push(label.name);
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return names;
}

/** Create only missing labels. A concurrent 422 remains a safe skip. */
async function ensureLabels(token, repo, io) {
  const existing = new Set(await listAllLabelNames(token, repo, io));
  for (const label of LABELS) {
    if (existing.has(label.name)) {
      io.log(`[skip] 标签已存在，不做任何修改：${label.name}`);
      continue;
    }
    const res = await githubApi(token, `/repos/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({ name: label.name, color: label.color, description: label.description }),
    }, io);
    if (res.status === 422) {
      io.log(`[warn] 标签已被并发创建，跳过：${label.name}`);
      continue;
    }
    if (!res.ok) {
      throw new BootstrapError(`创建标签失败：${label.name}（HTTP ${res.status} ${res.statusText ?? ''}`.trimEnd() + ')');
    }
    io.log(`[create] 标签已创建：${label.name}（#${label.color}）`);
  }
  return existing;
}

function printDryRunPlan(opts, target, workflow, workflowInfo, gitignoreInfo, configInfo, io) {
  io.log('[dry-run] 以下是将要执行的操作（本次不做任何修改、不访问网络）：');
  io.log('');
  io.log(`[dry-run] 安装模式：${opts.installMode}；目标工作目录：${opts.workdir}`);
  io.log(`[dry-run] 目标仓库：${opts.repo}`);
  if (opts.githubConfig) {
    io.log('[dry-run] GitHub 配置：校验仓库和权限，并创建缺失的 6 个 ai:* 标签');
  } else {
    io.log('[dry-run] GitHub 配置：跳过（需显式传 --github-config 才执行）');
  }
  io.log(`[dry-run] workflow 模板：${workflow.sourcePath}（uses: ${opts.actionRef}）`);
  if (workflowInfo.status === 'same') {
    io.log(`[ok] workflow 已存在且一致：${target}`);
  } else if (workflowInfo.status === 'different') {
    io.log(`[warn] workflow 已存在但有差异：将保留且绝不覆盖：${target}`);
  } else {
    io.log(`[create] 将生成 workflow：${target}`);
  }
  if (gitignoreInfo.status === 'present') {
    io.log(`[ok] .gitignore 已包含 ${GITIGNORE_ENTRY}：${gitignoreInfo.path}`);
  } else {
    io.log(`[update] 将增量更新 .gitignore 以忽略 ${GITIGNORE_ENTRY}：${gitignoreInfo.path}`);
  }
  if (configInfo.status === 'present') {
    io.log(`[ok] ${CONFIG_FILE} 已存在且通过必要检查：${configInfo.path}`);
  } else {
    io.log(`[create] 将生成不含凭证的最小 ${CONFIG_FILE}：${configInfo.path}`);
  }
  io.log('[dry-run] 不会创建仓库、修改已有 workflow、写入凭证或安装客户端 Skill。');
  printNextSteps(opts, io);
}

function printNextSteps(opts, io) {
  io.log('');
  io.log('后续提示（以下步骤需要你按批准范围手动完成，本脚本不代劳）：');
  io.log('  1. 在 AI Client 中配置 GitHub 官方 MCP Server；凭证只交给 Driver 进程，不写入工作区。');
  io.log('  2. 在 AI Client 中安装唯一的 GateFlow Skill：skills/gateflow（plan / execute 两种模式）。');
  io.log('  3. 确认 workflow 中的 Trusted Human / Trusted Agent 配置，并在 Organization 仓库配置 Driver 的 gate 身份。');
  io.log(`  4. 提交并推送 ${opts.workflowFile}、${CONFIG_FILE} 与 .gitignore 的本地变更，然后从 Issue 上评论 /ai-plan 开始。`);
}

/**
 * Run bootstrap with an injectable I/O boundary. The returned status is
 * useful to tests and to a future caller without introducing another CLI.
 */
export async function runBootstrap(argv, deps = {}) {
  const io = makeIo(deps);
  const opts = parseArgs(argv);
  if (opts.help) {
    io.log(USAGE);
    return { help: true, options: opts };
  }
  validateOptions(opts, io.env, io);

  const target = workflowTargetPath(opts.workdir, opts.workflowFile);
  const workflow = renderedWorkflow(opts, io);
  const workflowInfo = workflowState(target, workflow.content, io);
  const gitignoreInfo = gitignoreState(opts.workdir, io);
  const configInfo = configState(opts.workdir, opts.repo, io);

  if (opts.dryRun) {
    printDryRunPlan(opts, target, workflow, workflowInfo, gitignoreInfo, configInfo, io);
    return { dryRun: true, options: opts, target, workflowInfo, gitignoreInfo, configInfo };
  }

  io.log('== gateflow bootstrap ==');
  io.log(`目标仓库：${opts.repo}`);
  io.log(`安装模式：${opts.installMode === 'new' ? 'new（新项目创建后初始化）' : 'existing（已有项目增量接入）'}`);
  io.log(`目标工作目录：${opts.workdir}`);
  io.log(`Action 引用：${opts.actionRef}`);
  io.log('');

  let repoInfo = null;
  if (opts.githubConfig) {
    io.log('步骤 1/2：检查 GitHub 仓库和写权限…');
    repoInfo = await verifyRepo(opts.token, opts.repo, io);
    if (repoInfo.owner?.type === 'Organization' && !configInfo.trustedHumansConfigured) {
      io.log('[warn] Organization 仓库尚未确认 gateflow.config.yml 中的 trusted_humans；GateFlow 将保持 fail closed。');
    }
    io.log('');
    io.log('步骤 2/2：创建缺失的 ai:* 标签（同名标签跳过且绝不修改）…');
    await ensureLabels(opts.token, opts.repo, io);
  } else {
    io.log('GitHub 配置：跳过（默认不执行；如已获批准请显式传 --github-config）。');
  }

  io.log('');
  io.log('本地文件：检查并按确认生成/增量更新…');
  const workflowStatus = await ensureWorkflow(opts, workflowInfo, workflow.content, target, io);
  const configStatus = await ensureConfig(opts, configInfo, io);
  const gitignoreStatus = await ensureGitignore(opts, gitignoreInfo, io);
  inspectWorkflowInputs(target, workflowInfo.current, io, repoInfo);
  printNextSteps(opts, io);
  return {
    options: opts,
    target,
    workflowStatus,
    configStatus,
    gitignoreStatus,
    workflowInfo,
    gitignoreInfo,
    configInfo,
    repoInfo,
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  try {
    await runBootstrap(argv, deps);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = deps.error ?? defaultError;
    error(`[error] ${message}`);
    error('已中止：未完成的步骤可在修复问题后重新运行（本脚本幂等）。');
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
