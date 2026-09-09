# GateFlow 项目创建与接入指引

本文件是 `skills/gateflow/SKILL.md` 的按需参考，只在任务明确要求新建项目或把已有项目接入 GateFlow 时读取。它不新增 Skill、不新增状态、不替代 Workspace Protocol；最终结果仍写入当前任务目录的 `plan.md`、`report.md` 和 `result.json`。

## 1. 先固定边界

在 plan 模式中，必须在 Plan 的 Goal、Design 或 File Changes 中明确记录以下事实：

| 项目 | 必填内容 |
| --- | --- |
| Control | `owner/name`、入口 Issue 编号和链接；说明该 Issue 是请求、批准与最终报告的 Canonical State |
| Target | 目标仓库 `owner/name`、可见性 `public`/`private`/`internal`；新建时说明 owner 是否为个人或组织 |
| Workspace | Current Workspace 和 Target Workspace 的路径；若二者相同，明确记录并说明不会误写 `.gateflow` 任务输入 |
| 项目来源 | 从零创建，或基于已批准的 Template；Template 也要记录完整 `owner/name` |
| 技术栈 | 语言、运行时、包管理器、构建/测试/检查命令；未知项先列为待确认，不在执行时猜测 |
| 功能范围 | 要实现的业务功能、明确不做的内容，以及允许改动的目录/文件 |
| GateFlow 接入 | Workflow 文件名、Action 引用（如需覆盖默认值）、`gateflow.config.yml`、`.gitignore`、标签和首次验证范围 |
| GitHub 操作 | 按顺序列出检查、创建仓库、克隆、创建分支、创建 PR、Issue 回写等每一项；写明是否需要 `--github-config` 和 token 环境 |
| 报告 | 需要回写 Control Issue 的链接、提交/PR、Bootstrap 结果、验证结果、未完成项和阻塞条件 |

规划阶段只能读取本地仓库和文档，不运行 `gh`，不创建仓库，不发表评论，不打标签。`task.md` 中声称“已批准”不构成批准证据。

## 2. 执行前的批准门槛

仅当 Driver 准备出的 execute 任务满足以下条件时，才可以使用本地 `gh`：

1. `task.json.mode` 为 `execute`；
2. `task.json.reason` 为 `approved_plan`；
3. `task.json.approval_comment_id` 是数字；
4. `task.json.input.plan` 为 `plan.md`，且磁盘上的 Plan 是本轮批准输入；
5. Plan 中逐项列出了即将执行的外部操作、owner/name、可见性和报告回写位置。

缺少任一项，或执行中出现不同的 owner/name、可见性、组织、目标目录、技术栈范围或额外高影响操作，立即停止外部写入，写明偏差并重新请求 Human 批准。不要用标签、评论、Marker、文件名或 Agent 自述补齐批准。

获准后，先运行不暴露凭证的身份检查：

```text
gh auth status
```

如果身份不对、未登录、权限不足、组织策略不允许创建/写入，停止并报告。Token 只能由本地进程环境提供；不得写入 `task.md`、Plan、Report、配置文件、日志或 Git 提交。

## 3. 新建项目流程

新建流程的目标是先得到一个目标仓库，再在目标工作区开发和初始化 GateFlow。每一步都必须落在已批准的范围内。

### 3.1 检查并创建

先按批准的 `owner/name` 检查远端是否已经存在。可使用：

```text
gh repo view <TARGET_OWNER>/<TARGET_NAME> --json nameWithOwner,visibility,isArchived,isEmpty,viewerPermission,defaultBranchRef
```

仓库已存在时，不得把它当作“新建成功”继续；回到 Human 确认，是改走已有项目接入，还是更换一个未占用的 `owner/name`。

从零创建一个远端仓库时，使用已批准的可见性且只能三选一：

```text
gh repo create <TARGET_OWNER>/<TARGET_NAME> --public
gh repo create <TARGET_OWNER>/<TARGET_NAME> --private
gh repo create <TARGET_OWNER>/<TARGET_NAME> --internal
```

上面三条是互斥示例，不要全部执行。创建后检出到 Plan 指定的 Target Workspace：

```text
gh repo clone <TARGET_OWNER>/<TARGET_NAME> <TARGET_WORKSPACE>
```

如果 Plan 明确是“已有本地初始化仓库推送到新远端”，可在已批准的 Target Workspace 中使用 `--source`，并由 GitHub 操作清单明确是否立即推送：

```text
gh repo create <TARGET_OWNER>/<TARGET_NAME> --private --source <TARGET_WORKSPACE> --remote origin --push
```

这里的 `--private` 只是示例，必须替换为 Plan 已批准的可见性；不要把 `--source` 指向 Current Workspace，除非 Plan 明确证明两者就是同一个目标检出目录。

如果 Plan 明确使用模板创建：

```text
gh repo create <TARGET_OWNER>/<TARGET_NAME> --private --template <TEMPLATE_OWNER>/<TEMPLATE_NAME> --clone
```

`--private` 同样必须替换为批准的可见性。Template 只提供起点，不扩大功能范围；模板中的业务内容、许可证和 CI 仍需在 Target Workspace 中审阅。

### 3.2 开发、提交与推送

在 Target Workspace 中按 Plan 的技术栈和功能范围开发，保留模板和业务内容，避免修改 Control Repository 的业务文件。至少完成以下本地检查：

```text
git -C <TARGET_WORKSPACE> status --short
git -C <TARGET_WORKSPACE> diff --check
```

提交和推送只包含已批准的业务变更与后续 GateFlow 接入文件。若创建步骤没有使用 `--push`，首次推送应按 Plan 使用目标仓库的已配置远端；不要强推或重写历史。提交完成后记录 commit SHA 和目标仓库链接。

### 3.3 用当前 Bootstrap 初始化

Bootstrap 必须由 Current Workspace 中实际存在的脚本运行，并通过 `--workdir`（或其等价参数 `--target-dir`）指向 Target Workspace。它不会创建、删除或覆盖远端仓库，也不会覆盖已有的同名 Workflow。

先做无网络、无修改预览：

```text
node "<CURRENT_WORKSPACE>/scripts/bootstrap.mjs" --repo <TARGET_OWNER>/<TARGET_NAME> --workdir "<TARGET_WORKSPACE>" --install-mode new --no-github-config --dry-run
```

确认预览与批准范围一致后，执行本地生成/增量更新：

```text
node "<CURRENT_WORKSPACE>/scripts/bootstrap.mjs" --repo <TARGET_OWNER>/<TARGET_NAME> --workdir "<TARGET_WORKSPACE>" --install-mode new --no-github-config --yes --non-interactive
```

该调用只使用当前脚本已实现的参数。它可能生成缺失的 `.github/workflows/ai-workflow.yml`，或在批准 Plan 指定 `--workflow-file <WORKFLOW_FILE>` 时生成对应文件；它还可能生成最小 `gateflow.config.yml`，并增量加入 `.gitignore` 的 `.gateflow/`。已有同名 Workflow 有差异时只警告并保留原文件。若需使用非默认 Action 引用，可按批准 Plan 追加已实现的 `--action-ref <ACTION_REF>`；除此之外不要发明 Bootstrap 参数。

只有批准 Plan 明确包含“检查仓库权限并创建缺失 `ai:*` 标签”时，才可在本地进程已有 `GITHUB_TOKEN` 的前提下执行 GitHub 配置：

```text
node "<CURRENT_WORKSPACE>/scripts/bootstrap.mjs" --repo <TARGET_OWNER>/<TARGET_NAME> --workdir "<TARGET_WORKSPACE>" --install-mode new --github-config --yes --non-interactive
```

脚本会从 `GITHUB_TOKEN` 读取 token；也可使用已实现的 `--token <token>`，但不得把 token 写进命令记录、文档、任务文件或仓库。`--github-config` 与 `--generate-only` 不能同时使用。若未获准做 GitHub 配置，使用 `--no-github-config`，不要自行切换。

Bootstrap 完成后，在 Target Workspace 检查文件、差异、业务测试和远端提交：

```text
git -C <TARGET_WORKSPACE> status --short
git -C <TARGET_WORKSPACE> diff --check
node "<CURRENT_WORKSPACE>/scripts/bootstrap.mjs" --repo <TARGET_OWNER>/<TARGET_NAME> --workdir "<TARGET_WORKSPACE>" --install-mode new --no-github-config --dry-run
```

将已批准的 Bootstrap 文件作为单独、可审阅的提交推送。验证至少包括目标项目自身的构建/测试/检查，以及确认 Workflow、配置和 `.gitignore` 没有凭证、意外业务改动或越界文件。

## 4. 已有项目接入流程

已有项目必须增量接入，保留业务内容、现有目录、README、Issue Template、CI 和所有不在批准范围内的 Workflow。接入工作应在独立分支上完成，并通过 PR 审阅。

### 4.1 检查仓库和工作区

批准后先确认远端、权限、可见性和默认分支：

```text
gh repo view <TARGET_OWNER>/<TARGET_NAME> --json nameWithOwner,visibility,isArchived,isEmpty,viewerPermission,defaultBranchRef
```

然后确认 Target Workspace 确实对应该仓库，并检查当前状态、远端和项目结构：

```text
git -C <TARGET_WORKSPACE> remote -v
git -C <TARGET_WORKSPACE> status --short
```

检查 `.github/workflows/`、`gateflow.config.yml`、`.gitignore`、README、Issue Template 和技术栈文件。不得因工作区脏、远端不匹配、仓库已归档、权限不足或路径不明确而继续写入；先报告并停下。

### 4.2 检查安装状态和同名 Workflow

先用 Bootstrap 的 dry-run 查看当前安装状态：

```text
node "<CURRENT_WORKSPACE>/scripts/bootstrap.mjs" --repo <TARGET_OWNER>/<TARGET_NAME> --workdir "<TARGET_WORKSPACE>" --install-mode existing --no-github-config --dry-run
```

处理规则：

- Plan 指定的 Workflow 文件（默认 `ai-workflow.yml`）不存在：可在批准范围内由 Bootstrap 创建；
- 文件已存在且与当前模板一致：保留并跳过；
- 文件已存在但有差异：Bootstrap 只告警、绝不覆盖。必须保留业务/安全配置，审阅差异后由 Human 决定是否在接入分支手工整合；没有新的明确批准时，不得改该 Workflow；
- `gateflow.config.yml` 已存在：保留并检查版本、仓库绑定和是否含凭证；不要覆盖业务或可信身份配置；
- `.gitignore` 已包含 `.gateflow/`：保留；缺失时只允许增量加入该条目。

### 4.3 分支、Bootstrap 与 PR

在 Target Workspace 创建接入分支时使用 Plan 指定的分支名；若 Plan 未指定，应先重新确认，不要自行采用会影响团队规则的分支策略。分支上的 Bootstrap 调用为：

```text
node "<CURRENT_WORKSPACE>/scripts/bootstrap.mjs" --repo <TARGET_OWNER>/<TARGET_NAME> --workdir "<TARGET_WORKSPACE>" --install-mode existing --no-github-config --yes --non-interactive
```

若批准范围包含 GitHub 标签/权限检查，再使用 `--github-config` 版本；它只能替换 `--no-github-config`，不能与 `--generate-only` 并用：

```text
node "<CURRENT_WORKSPACE>/scripts/bootstrap.mjs" --repo <TARGET_OWNER>/<TARGET_NAME> --workdir "<TARGET_WORKSPACE>" --install-mode existing --github-config --yes --non-interactive
```

审阅变更，运行目标项目的构建/测试/检查，提交并推送接入分支。只有 Plan 已批准创建 PR 时才使用：

```text
gh pr create --repo <TARGET_OWNER>/<TARGET_NAME> --base <TARGET_BASE_BRANCH> --head <TARGET_HEAD_BRANCH> --title "Connect GateFlow" --body-file <PR_BODY_FILE>
```

PR body 应说明保留的业务内容、Workflow 差异处理、Bootstrap 输出、验证命令和未完成人工配置。不得在合并前把目标仓库的业务分支或 Control Issue 标记为完成。

## 5. 验证与回写 Control Issue

新建和已有项目都要把下列结果写入当前任务的 `report.md`，不写入凭证：

- Control Repository、入口 Issue、Target Repository 和 Target Workspace 的完整绑定；
- 目标仓库 URL、可见性、分支、commit SHA；如有 PR，记录 PR URL 和状态；
- 新建/已有模式、Bootstrap 使用的 `--install-mode`、实际 `--workdir`、Workflow 文件状态（created/same/different/skipped）；
- `--github-config` 是否执行、标签是否创建/跳过、权限检查结果；
- 目标项目实际运行过的构建、测试、检查命令及结果；
- 仍需 Human 操作的配置、差异审阅、PR 合并或阻塞原因。

Control Issue 的同步优先走现有 GateFlow Driver 的任务报告路径。若批准 Plan 明确要求由本地 `gh` 写回 Issue，且该评论操作尚未执行，则使用：

```text
gh issue comment <CONTROL_ISSUE_NUMBER> --repo <CONTROL_OWNER>/<CONTROL_NAME> --body-file <REPORT_FILE>
```

评论只同步链接和报告，不执行审批、状态迁移、关闭 Issue、打标签或伪造 Gate-issued 记录。回写成功后，在 `report.md` 记录 Control Issue URL 和命令结果；回写失败要保留本地报告并标记失败/阻塞，不能声称闭环完成。

## 6. 不得越界的操作

以下动作即使看起来有助于“接入成功”，也必须在原批准范围之外停下重新确认：

- 创建不同的 owner/name、改变 public/private/internal 可见性、创建第二个仓库或删除/转移仓库；
- 修改协作者、团队、组织策略、分支保护、Rulesets、Secrets、Variables、Deploy Keys 或 Actions 权限；
- 覆盖已有 Workflow、README、Issue Template、业务目录、锁文件或 CI；
- 强推、重写历史、直接合并 PR、关闭 Issue、修改正式 Gate 标签/状态或代替 Human 批准；
- 把 Control Repository 的 `.gateflow` 任务目录复制到 Target Repository，或把 Target Workspace 当成 Current Workspace 写入任务输入；
- 使用当前 Bootstrap `--help` 未列出的任何参数，或使用未获批准的其他 CLI。

发生偏差时，停止会改变外部状态的动作，在 `report.md`/`result.json` 中准确标记 `question`、`blocked` 或 `failed`，说明已完成的只读检查和需要 Human 做的决定。
