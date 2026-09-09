# 日常使用手册（V1）

本文覆盖从个人入口仓库开始的首次配置、最小验证、日常任务闭环，以及通过入口 Issue 创建或接入项目。协议速查见 [protocol.md](protocol.md)，Driver 细节见 [driver.md](driver.md)，Gate 接入说明见 [integration.md](integration.md)。

## 1. Use this template：创建个人入口仓库

打开 [Use this template](https://github.com/jesongit/gateflow/generate)，创建一个属于自己的 GitHub 仓库，例如 `you/my-gateflow`。Fork 也可以使用，但不要求；这个仓库的作用是保留个人入口 Issue，不是要求所有业务代码都放在其中。

GateFlow 中的三个位置含义如下：

* **Control Repository**：入口仓库。入口 Issue 是本次任务的 Canonical State，Plan、Human Approval、Tracker、Report 都应回到该 Issue。
* **Target Repository**：实际创建或修改的业务仓库，例如 `you/new-project` 或 `you/existing-project`。
* **Target Workspace**：Target Repository 在本地的检出目录，Agent 在批准范围内于此准备文件、开发和验证。

普通单仓库任务中，Control 与 Target 可以相同。项目创建/接入任务中可以不同，例如 `you/my-gateflow#12` 是 Control，`you/new-project` 是 Target；Target 改变不会把报告改发到 Target 的 Issue。当前 `gateflow run/sync` 的仓库解析仍只选择一个 Control Repository：`control_repository` → `repository` → `GATEFLOW_REPOSITORY` → git remote `origin`。不要手工添加未实现的跨仓库命令或配置字段。

## 2. 首次配置个人入口

### 2.1 准备本地 Driver

要求 Node.js **≥ 24**。在个人入口仓库（或专门保存 GateFlow 源码的检出目录）执行：

```bash
gh auth login
gh auth status
gh repo clone you/my-gateflow
cd my-gateflow
npm ci
npm run build
npm link                 # 可选：让 `gateflow` 成为本机命令
node --version           # 应为 v24 或更高
```

如果不想执行 `npm link`，可直接调用 `node /path/to/my-gateflow/dist/cli.js ...`。`npm run build` 会生成 Driver 的 `dist/cli.js`；它不会自动安装全局命令。

`gh auth status` 只确认当前本地 CLI 使用的账号。`gh` 的权限来自该账号已有的 GitHub 授权，不会因为使用了 GateFlow 而扩大。目标仓库没有写权限、组织禁止创建仓库或需要额外授权时，应停止并报告，不要绕过限制。

### 2.2 生成并确认 Gate Workflow

在个人入口仓库的本地检出目录运行 Bootstrap。`--workdir` 与 `--target-dir` 等价；下面使用 `--target-dir`：

```bash
# 只查看计划：不访问网络、不修改文件
node scripts/bootstrap.mjs \
  --repo you/my-gateflow \
  --target-dir . \
  --install-mode existing \
  --dry-run
```

确认计划后，二选一：

```bash
# 只生成本地文件，不检查 GitHub、不创建标签
node scripts/bootstrap.mjs \
  --repo you/my-gateflow \
  --target-dir . \
  --install-mode existing \
  --generate-only \
  --yes
```

```bash
# 生成本地文件，并检查仓库权限、创建缺失的 6 个 ai:* 标签
export GITHUB_TOKEN="$(gh auth token)"
node scripts/bootstrap.mjs \
  --repo you/my-gateflow \
  --target-dir . \
  --install-mode existing \
  --github-config \
  --yes
unset GITHUB_TOKEN
```

PowerShell 等价写法：

```powershell
$env:GITHUB_TOKEN = gh auth token
node scripts/bootstrap.mjs --repo you/my-gateflow --target-dir . --install-mode existing --github-config --yes
$env:GITHUB_TOKEN = $null
```

`--github-config` 才会访问 GitHub；它需要 `--token <token>` 或 `GITHUB_TOKEN`。`--generate-only` 与 `--github-config` 不能同时使用。非交互环境下要明确批准本地写入，请使用 `--yes`；只有 `--non-interactive` 而没有 `--yes` 时，未获批准的写入会跳过。`--no-github-config` 可显式保持默认的本地模式。完整参数以 `node scripts/bootstrap.mjs --help` 为准。

Bootstrap 的本地结果通常是：

* `.github/workflows/ai-workflow.yml`；
* 不含凭证的最小 `gateflow.config.yml`；
* 增量加入 `.gitignore` 的 `.gateflow/`。

检查 `.github/workflows/ai-workflow.yml` 后再提交。Personal Mode 默认可保持：

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

当前 Gate 会通过 GitHub API 的 `GET /user` 取得签发身份，并把该身份写入 Gate-issued 授权记录；因此生产 Workflow 必须把 `github-token` 指向用户 PAT 的 Actions Secret，而不是默认的 `github.token`。在启用 Workflow 的仓库中配置一次 Secret（建议使用只授权目标仓库、Issues Read and write、Metadata read-only 的 fine-grained PAT）：

```bash
# 当前 gh 登录身份必须就是 GATEFLOW_GATE_TOKEN 所属的 GitHub User。
gh auth token | gh secret set GATEFLOW_GATE_TOKEN --repo you/my-gateflow
```

也可以在 GitHub 仓库的 Settings → Secrets and variables → Actions 中手工创建同名 Secret。Bootstrap 不会读取、打印或写入 Secret 值；仓库文件中只保留 `${{ secrets.GATEFLOW_GATE_TOKEN }}` 引用。

同时把同一个 PAT 所属用户的登录名加入 Driver 配置（只写登录名，不写 token）：

```bash
gh api user --jq .login
```

```yaml
version: 1
repository: you/my-gateflow
gate_logins:
  - your-github-login
```

这里的 `gate_logins` 是 Gate-issued 记录的发布者白名单，不是 `trusted-agents`；不要把该用户放进 `trusted-agents`。`trusted-humans: ''` 仍依赖个人仓库的 User-type owner 默认可信；Organization 仓库必须按批准范围填写显式 `trusted-humans`（或者明确承担将 `require-explicit-humans` 设为 `false` 的风险）。

确认后提交入口仓库的本地变更：

```bash
git status --short
git add .github/workflows/ai-workflow.yml gateflow.config.yml .gitignore
git commit -m "chore: enable GateFlow workflow"
git push
```

在 GitHub Settings → Actions → General 确认 Actions 没有被禁用，并在 Actions 页面确认 `AI Workflow Gate` 能运行。若现有 Workflow 与模板有差异，Bootstrap 会提示并保留原文件，绝不静默覆盖；请人工审阅后决定是否提交修改。

### 2.3 安装当前唯一 Skill

将入口仓库中的 `skills/gateflow` 安装到 ChatGPT、ZCode 或其他 AI 客户端。它是当前唯一的 GateFlow Skill，提供 `plan` 与 `execute` 两种模式。AI 默认只读写本地 `.gateflow/` 任务目录；不要把 GitHub token 写进任务文件、配置文件或 Issue。

## 3. Personal Mode 的 `gh` 权限边界

Personal Mode 可以复用用户已经登录的本地 `gh` 身份，但边界必须按“用户授权下的本地执行”理解：

* `gh repo create`、`gh repo view`、clone、commit、push、PR 等操作使用当前用户的 GitHub 权限；如果本地 AI 客户端被允许运行这些命令，它继承的也是同一权限，不是一个独立的 Agent 低权限身份。
* Gate Workflow 使用 Actions Secret `${{ secrets.GATEFLOW_GATE_TOKEN }}` 以固定用户身份读写 Issue 状态所需的标签和评论；本地 `GITHUB_TOKEN` 供 Bootstrap 的 GitHub 配置和 Driver 的 `run/sync` 使用。两者用途不同，凭证值都不应写入仓库或 `.gateflow/`。
* Human Approval 仍由 Gate 校验 `/approve <plan-comment-id>`、当前 Plan 和 Gate-issued 记录；`gh` 登录本身不会替代审批，也不会让 AI 自述获得授权。
* 在 Personal Mode 中，本地工作区隔离是协议边界，不是 OS 级的 Human/Agent 强隔离。创建仓库、修改可见性、修改权限、改 Secrets、改重要 Workflow、删除内容或向默认分支推送，都必须在 Plan 中写明并经用户批准。

因此，只有在批准的范围内才让本地 AI 客户端运行 `gh` 或 Bootstrap。命令失败、权限不足或目标超出范围时，保留现状并重新请求用户决定。

## 4. 最小验证任务

先验证个人入口仓库本身，再处理真实项目。创建一个无破坏性的小任务，例如：

```bash
gh issue create --repo you/my-gateflow \
  --title "GateFlow smoke test" \
  --body "请新增 SMOKE.md，写入一行说明，并在报告中列出验证命令；不要修改 CI、权限或 Secrets。"
gh issue comment --repo you/my-gateflow 12 --body "/ai-plan"  # 将 12 换成新 Issue 编号
```

等待 Actions 完成后，确认 Issue 有 `ai:planning` 和 Gate 记录，然后在配置了 `repository: you/my-gateflow` 的本地 Driver 根目录执行：

```bash
export GITHUB_TOKEN="$(gh auth token)"
gateflow run       # 准备任务目录并打印提示词
gateflow status    # 离线查看本地状态
# 将 gateflow run 打印的提示词粘贴到已安装的 gateflow Skill（plan 模式）
gateflow sync      # 发布 Plan；应进入 ai:review
```

在 GitHub Issue 中检查 Plan 后评论 `/approve <plan-comment-id>`，等待 Gate 将状态迁移为 `ai:ready`，再继续：

```bash
gateflow run       # 准备 execute 任务
# 将新提示词粘贴到 gateflow Skill（execute 模式）
    gateflow sync      # 首轮发布 Tracker；等待 Gate 接受 ai:working
    gateflow sync      # 下一轮发布 Report；Gate 随后接受并迁到 ai:done
unset GITHUB_TOKEN
```

最后人工检查 `SMOKE.md`、验证结果和 Actions 日志，再关闭 Issue。再次执行 `gateflow sync` 应通过远端调和而不重复发布。任务异常时可用 `gateflow status` 查看本地状态；确认要重新准备时使用 `gateflow retry <task-id>`。

## 5. 标准任务闭环

```text
创建 Issue
  → /ai-plan
  → gateflow run
  → AI（plan 模式）写 plan.md + result.json
  → gateflow sync（Plan）
  → /approve <plan-comment-id> 或 /change <反馈>
  → gateflow run
  → AI（execute 模式）开发、验证并写 report.md + result.json
  → gateflow sync（先创建 Tracker，等待 Gate 接受 WORKING）
  → 再次 gateflow sync（发布 Report，Gate 接受后进入 DONE）
  → 人工检查并关闭 Issue
```

常用命令：

| 命令 | 作用 | 需要 Token |
| --- | --- | --- |
| `gateflow run [--issue <n>] [--target-repository <owner/name>] [--target-workspace <absolute-path>] [--root <dir>] [--config <file>]` | 发现并准备当前任务，打印 AI 提示词；目标参数写入当前任务绑定 | 是 |
| `gateflow sync [--root <dir>] [--config <file>]` | 校验并发布任务结果，可安全重试 | 是 |
| `gateflow status [--root <dir>] [--config <file>]` | 查看本地任务与同步状态 | 否 |
| `gateflow retry <task-id> [--root <dir>]` | 清除任务状态，下次 `run` 重新准备 | 否 |

仓库解析顺序为 `gateflow.config.yml` 的 `control_repository` → `repository` → `GATEFLOW_REPOSITORY` → git remote `origin`。配置可缺省；最小配置示例：

```yaml
version: 1
repository: you/my-gateflow
# 替换为 GATEFLOW_GATE_TOKEN 所属用户的 gh api user --jq .login 输出：
gate_logins:
  - your-github-login
# 也可写成：control_repository: you/my-gateflow
```

## 6. 用入口 Issue 请求创建或接入项目

这两类需求都先在 Control Repository 创建 Issue，先规划、再批准、再执行。计划至少写清 Target Repository、可见性、技术栈、初始范围、是否允许创建/推送/PR、不得触碰的文件，以及验证方式。

### 6.1 请求新建项目

入口 Issue 示例：

```text
标题：创建一个可独立接入 GateFlow 的记账项目

请创建新仓库 you/ledger-app，设为 private。
技术栈：Erlang 后端 + React 前端。
范围：先完成最小的本地记账页面和一个健康检查；不要配置 Secrets，不要修改组织权限。
请在项目创建后用同一套 Bootstrap 接入 GateFlow，并验证新仓库可以创建 Issue、运行 AI Workflow。
允许的 GitHub 操作：创建该仓库、对该仓库提交和推送初始化代码、创建接入所需 PR。
完成后把 Target Repository 地址、Bootstrap 结果、验证命令和遗留事项回报到本入口 Issue。
```

批准后的执行顺序应是：检查名称是否已占用 → 在批准范围内使用 `gh repo create you/ledger-app --private`（或等价的、明确的命令）→ 准备 Target Workspace → 开发和验证 → 提交/推送 → 对新仓库运行 Bootstrap：

```bash
node /path/to/my-gateflow/scripts/bootstrap.mjs \
  --repo you/ledger-app \
  --target-dir /path/to/ledger-app \
  --install-mode new \
  --github-config \
  --yes
```

`--install-mode new` 表示“新项目创建后初始化”；Bootstrap 本身不会创建仓库。新仓库准备好后，后续业务任务应在 Target Repository 自己的 Issue 中管理；入口 Issue 只保留创建任务与结果链接。

### 6.2 请求接入已有项目

入口 Issue 示例：

```text
标题：把 you/existing-project 接入 GateFlow

请把已有仓库 you/existing-project 增量接入 GateFlow。
保留现有业务代码、目录、CI、README、Issue Template 和不相关的 Workflow。
允许新增或修改：GateFlow 所需的 ai:* 标签、一个经检查的 AI Workflow、最小 gateflow.config.yml 和 .gitignore 中的 .gateflow/。
请先检查当前账号权限和已有同名 Workflow；有差异时不要覆盖，改为报告差异并提交接入 PR。
完成后验证新仓库可以创建测试 Issue 并运行 `/ai-plan` → `gateflow run` → Plan → Approval 的最小闭环。
```

批准后的执行顺序应是：检查/克隆 Target Repository → 在 Target Workspace 运行 dry-run → 检查差异 → 按批准方案运行 Bootstrap：

```bash
node /path/to/my-gateflow/scripts/bootstrap.mjs \
  --repo you/existing-project \
  --target-dir /path/to/existing-project \
  --install-mode existing \
  --dry-run

node /path/to/my-gateflow/scripts/bootstrap.mjs \
  --repo you/existing-project \
  --target-dir /path/to/existing-project \
  --install-mode existing \
  --github-config \
  --yes
```

已有同名标签会跳过且不修改属性；已有 Workflow 一致则跳过，有差异则警告并保留原文件。检查通过后可按 Plan 提交分支/PR，由用户合并或明确批准推送。Bootstrap 不修改业务源码、已有 CI、Issue Template 或其他 Workflow。

### 6.3 反馈与恢复

* `REVIEW` 阶段需要调整计划时，在入口 Issue 评论 `/change <反馈>`，再执行 `gateflow run` 和 `gateflow sync`，批准新 Plan 后再执行。
* `gateflow sync` 报输入快照不一致时，不要直接覆盖任务目录；先保存需要的产出，再按提示用 `gateflow retry <task-id>` 重新准备。
* `gateflow sync` 报 preflight 或身份错误时，先查看 Gate Actions 日志和 Issue 记录。不要通过手工添加 `ai:*` 标签、伪造 Marker 或把 AI 自述当作授权来绕过。
* `gateflow retry <task-id>` 只清除本地 Driver 状态；它不会删除 GitHub Issue、评论或仓库。

## 7. 环境变量与边界速查

| 变量 | 用途 |
| --- | --- |
| `GITHUB_TOKEN` | Bootstrap 的 `--github-config`、Driver 的 `run/sync`；仅存在于进程环境 |
| `GATEFLOW_REPOSITORY` | Driver 找不到配置和 remote 时的 `owner/name` 兜底 |

`GATEFLOW_GATE_TOKEN` 不是本地环境变量，而是启用 Gate Workflow 的 GitHub Actions repository secret；它的值不应出现在配置文件、Issue、日志或任务目录中。

Gate 继续独占正式标签状态迁移和 Gate-issued 授权记录；Driver 负责准备、校验并发布协议评论；AI 负责计划、开发、验证和报告。不要在文档、Issue 或工作区中写入 token，也不要把本地 `gh` 的用户授权误解成强 Human/Agent 隔离。
