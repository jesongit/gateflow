# 项目仓库接入指南

本文说明如何把 GateFlow 接入一个 Target Repository。它既适用于已经存在的项目，也适用于刚用 `gh` 创建的新项目；两者共用同一个 Bootstrap。个人入口仓库的创建、`gh` 登录和完整任务闭环见 [usage.md](usage.md)。

## 1. 先区分 Control 与 Target

* **Control Repository** 是保存入口 Issue 的个人仓库。创建项目或接入项目的 Plan、Approval、Tracker、Report 都回到入口 Issue。
* **Target Repository** 是真正被创建或修改的业务仓库。
* **Target Workspace** 是 Target Repository 的本地检出目录，Bootstrap 的 `--target-dir` / `--workdir` 指向这里。

普通单仓库任务中，Control 与 Target 可以相同；跨仓库项目任务中，入口 Issue 仍在 Control，代码和 Workflow 在 Target。当前 Driver 的 `control_repository`/`repository` 仍只解析一个 `owner/name`，执行某个 Control Issue 时，应让配置和 `--root` 指向 Control 仓库的本地工作区；Target 只能作为任务的 `--target-repository` / `--target-workspace` 元数据，不会改变评论回写的 Control Issue。

## 2. 前提与权限

准备 Node.js **≥ 24**、目标仓库的本地检出，以及已登录并有相应权限的 `gh`：

```bash
node --version                 # v24 或更高
gh auth login
gh auth status
gh repo view owner/target
```

如果是新项目，先在已批准的范围内创建仓库，再检出：

```bash
gh repo create owner/new-project --private
gh repo clone owner/new-project /path/to/new-project
```

`gh` 不会自动取得额外权限；上述操作使用当前用户的授权。组织策略、仓库可见性、创建仓库、推送默认分支、修改权限和 Secrets 等都必须纳入 Plan 并经用户批准。

## 3. 运行 Bootstrap

先在 Target Workspace 做无副作用检查：

```bash
node /path/to/my-gateflow/scripts/bootstrap.mjs \
  --repo owner/target \
  --target-dir /path/to/target \
  --install-mode existing \
  --dry-run
```

`--workdir <dir>` 与 `--target-dir <dir>` 等价。`--dry-run` 只打印计划，不访问网络、不修改文件。

检查计划后，按场景执行：

```bash
# 已有项目：增量接入
export GITHUB_TOKEN="$(gh auth token)"
node /path/to/my-gateflow/scripts/bootstrap.mjs \
  --repo owner/existing-project \
  --workdir /path/to/existing-project \
  --install-mode existing \
  --github-config \
  --yes

# 新项目：仓库已由 gh 创建后初始化
node /path/to/my-gateflow/scripts/bootstrap.mjs \
  --repo owner/new-project \
  --workdir /path/to/new-project \
  --install-mode new \
  --github-config \
  --yes
unset GITHUB_TOKEN
```

PowerShell 可使用：

```powershell
$env:GITHUB_TOKEN = gh auth token
node C:\path\to\my-gateflow\scripts/bootstrap.mjs --repo owner/target --target-dir C:\path\to\target --install-mode existing --github-config --yes
$env:GITHUB_TOKEN = $null
```

Bootstrap 的实际选项为：

| 选项 | 作用 |
| --- | --- |
| `--repo owner/name` | 目标仓库；也可从 `GITHUB_REPOSITORY` 读取 |
| `--token <token>` | GitHub 配置用 token；也可从 `GITHUB_TOKEN` 读取 |
| `--workdir <dir>` / `--target-dir <dir>` | 目标仓库检出目录，默认当前目录 |
| `--install-mode existing 或 new` | 已有项目或新项目创建后的初始化模式 |
| `--action-ref <ref>` | Workflow 的 Action 引用，默认 `jesongit/gateflow@v1` |
| `--workflow-file <name>` | Workflow 文件名，默认 `ai-workflow.yml` |
| `--github-config` | 检查仓库和写权限，并创建缺失的 6 个 `ai:*` 标签 |
| `--no-github-config` | 显式跳过 GitHub 配置；默认也是跳过 |
| `--generate-only` | 只生成本地文件，不访问网络；不能与 `--github-config` 同用 |
| `--non-interactive` | 不询问确认；没有 `--yes` 时跳过未明确批准的本地写入 |
| `--yes` / `-y` | 批准本次本地文件生成或增量更新 |
| `--dry-run` | 只打印计划，不访问网络、不修改文件 |
| `--help` | 显示 Bootstrap 帮助 |

需要离线生成时，用 `--generate-only --yes`；需要完整 GitHub 配置时，显式用 `--github-config` 并提供 token。脚本不会创建、删除或覆盖仓库，也不会覆盖有差异的已有 Workflow。

## 4. 检查生成结果并启用 Workflow

Bootstrap 会按需生成或检查 `.github/workflows/ai-workflow.yml`、不含凭证的最小 `gateflow.config.yml`、`.gitignore` 中的 `.gateflow/`，以及（仅 `--github-config`）缺少的 6 个 `ai:*` 标签。

Bootstrap 不会替目标仓库创建或写入 Secret。生成 Workflow 后，必须在启用 Gate 的目标仓库配置 `GATEFLOW_GATE_TOKEN`：当前 Gate 会调用 GitHub API 的 `GET /user` 获取 Gate-issued 记录的签发身份，所以这里应使用 GitHub User 的 PAT，而不是 Actions 默认的 `github.token`。建议使用只授权目标仓库、Issues Read and write、Metadata read-only 的 fine-grained PAT。可以通过 stdin 设置，避免把凭证写进命令参数：

```bash
# 当前 gh 登录身份必须就是 GATEFLOW_GATE_TOKEN 所属的 GitHub User。
gh auth token | gh secret set GATEFLOW_GATE_TOKEN --repo owner/target
```

也可以在 GitHub Settings → Secrets and variables → Actions 中手工创建该 Secret。仓库中只应出现 `${{ secrets.GATEFLOW_GATE_TOKEN }}` 引用，绝不能出现 Secret 值。

提交前人工检查 Workflow：

```yaml
permissions:
  issues: write
  contents: read

with:
  github-token: ${{ secrets.GATEFLOW_GATE_TOKEN }}
  trusted-humans: ''
  trusted-agents: ''
  require-explicit-humans: 'true'
```

把同一个 PAT 所属用户的登录名加入 Driver 使用的 `gateflow.config.yml`：

```yaml
version: 1
repository: owner/target
gate_logins:
  - your-github-login # 用 gh api user --jq .login 获取；这里只写登录名
```

`gate_logins` 是 Gate-issued 记录的发布者白名单，不是 `trusted-agents`；不要把该用户登录名放入 `trusted-agents`。默认 Action 引用是 `jesongit/gateflow@v1`；若需锁定到具体版本、改用自己的发布仓库或其他 ref，使用 `--action-ref`，并先确认 Target 能访问该 Action。个人仓库的 User-type owner 默认是 Trusted Human，因此通常不需要填写 `trusted-humans`。Organization 仓库必须配置显式 `trusted-humans`，否则默认 fail closed。

确认 GitHub Settings → Actions → General 中 Actions 未被禁用，然后提交：

```bash
git status --short
git add .github/workflows/ai-workflow.yml gateflow.config.yml .gitignore
git commit -m "chore: enable GateFlow workflow"
git push
```

若已有 Workflow 与模板完全一致，Bootstrap 会跳过；有差异时会警告并保留原文件。请人工审阅差异后再决定是否修改，不能让 Bootstrap 静默覆盖。

## 5. 在 Target 中准备 Driver 与 Skill

在保存 GateFlow 源码的本地检出目录执行一次：

```bash
npm ci
npm run build
npm link                         # 可选：安装本机 `gateflow` 命令
```

然后在 Control Workspace 中放置最小配置（也可以省略，让 Driver 从 git remote `origin` 解析）：

```yaml
version: 1
repository: owner/target
gate_logins:
  - your-github-login # GATEFLOW_GATE_TOKEN 所属用户的登录名
# 或使用显式名称：control_repository: owner/target
```

将同一检出目录的 `skills/gateflow` 安装到 AI 客户端。当前只有这一个 Skill，使用 `plan` 模式生成计划、使用 `execute` 模式开发并生成报告。AI 默认只读写 `.gateflow/`；本地 `GITHUB_TOKEN` 只放在 Driver 进程环境中，不写入配置或任务文件。

## 6. Target 冒烟验证

在 Target Repository 创建一个无破坏性测试 Issue：

```bash
gh issue create --repo owner/target \
  --title "GateFlow smoke test" \
  --body "新增 SMOKE.md 并在报告列出验证命令；不要修改 CI、权限或 Secrets。"
gh issue comment --repo owner/target 12 --body "/ai-plan"  # 将 12 换成新 Issue 编号
```

等待 Gate Action 完成并确认 `ai:planning`，再在 Control Workspace 执行：

```bash
export GITHUB_TOKEN="$(gh auth token)"
gateflow run --root /path/to/target --config /path/to/target/gateflow.config.yml
# 把提示词粘贴给 gateflow Skill（plan 模式）
gateflow sync --root /path/to/target --config /path/to/target/gateflow.config.yml
```

检查 Plan 评论后，在 Issue 中评论 `/approve <plan-comment-id>`，等待 `ai:ready`，然后执行：

```bash
gateflow run --root /path/to/target --config /path/to/target/gateflow.config.yml
# 把新提示词粘贴给 gateflow Skill（execute 模式）
gateflow sync --root /path/to/target --config /path/to/target/gateflow.config.yml  # 首轮确认/发布 Tracker
# 等待 Gate 接受 ai:working 后再执行一次，才会发布 Report
gateflow sync --root /path/to/target --config /path/to/target/gateflow.config.yml
unset GITHUB_TOKEN
```

预期结果是 Plan 评论、Tracker/Report 评论和 `ai:done`；人工检查后再关闭 Issue。重复 `gateflow sync` 应通过远端调和而不重复发布。Driver 的运行环境、配置和恢复语义见 [driver.md](driver.md)，日常场景见 [usage.md](usage.md)。
