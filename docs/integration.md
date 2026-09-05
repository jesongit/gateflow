# 接入项目仓库详细指南（Integration）

> 本指南面向**第一次接触 GateFlow** 的人：只照本文档操作，就能把自己的项目仓库接入 GateFlow 并跑通第一个 Issue 闭环。全程**不需要配置远端服务器、不需要额外部署任何东西**（本指南也完全不涉及把目标仓库推送到哪里之外的远端——只要求目标仓库已有一个 GitHub 上的存在形态）。
>
> 命令与协议约定见 [protocol.md](protocol.md)；日常操作（接入完成之后）见 [usage.md](usage.md) §3；发布维护见 [release.md](release.md)。
>
> 占位约定：GateFlow 本体写作 `jesongit/gateflow@v0`（请替换为你实际发布的 `owner/gateflow@v0`）；目标仓库写作 `owner/target`；本地检出的 GateFlow 仓库路径写作 `/path/to/gateflow`。

---

## 0. 这份指南解决什么

你的项目仓库（`owner/target`）要接入 GateFlow，本质上是让四样东西就位：

1. **Gate 本体可被引用**——目标仓库的 workflow 里有一句 `uses: jesongit/gateflow@v0`，这句引用必须能在 GitHub 上解析成功（第一步，三选一）；
2. **仓库里的接线**——6 个 `ai:*` 状态标签 + 一个监听 Issue 事件的 workflow 文件（第二步，脚本或手写）；
3. **AI 侧的接线**——你的 AI 客户端能读写 GitHub（GitHub MCP），并装有 producer / consumer / executor 三个 Skill（第三、四步）；
4. **跑通一次闭环**——从 Issue 进入工作流到 Close 走完一遍，确认 Gate 与 AI 各就各位（第五步验收）。

全流程图：

```text
 ┌─ 第一步：发布 GateFlow 本体（模式 A / B / C 三选一，让 uses: 能解析） ─┐
 │                                                                      │
 │   模式 A（推荐）：发布为 public 仓库                                  │
 │   模式 B：私有仓库 + 打开 "Access" 共享策略（同账号 / 同组织）        │
 │   模式 C：内嵌——把 action 复制进目标仓库，uses: 本地路径             │
 └──────────────────────────────┬───────────────────────────────────────┘
                                ▼
 ┌─ 第二步：目标仓库接入 ────────────────────────────────────────────────┐
 │   bootstrap 脚本：创建 6 个 ai:* 标签 + 生成 .github/workflows/…yml  │
 │   （或按第 4 章手工完成同样两件事）                                   │
 │   然后 commit + push 生成的 workflow 文件（注意 PAT 的 workflow 权限）│
 └──────────────────────────────┬───────────────────────────────────────┘
                                ▼
 ┌─ 第三步：配置 Action 输入 ────────────────────────────────────────────┐
 │   github-token（保持默认即可）/ trusted-humans / trusted-agents      │
 └──────────────────────────────┬───────────────────────────────────────┘
                                ▼
 ┌─ 第四步：接入 AI 侧 ──────────────────────────────────────────────────┐
 │   GitHub MCP（toolsets: repos / issues / pull_requests）             │
 │   + 安装 producer / consumer / executor 三个 Skill                   │
 └──────────────────────────────┬───────────────────────────────────────┘
                                ▼
 ┌─ 第五步：验收——跑通第一个 Issue 闭环 ────────────────────────────────┐
 │   /ai-plan → 规划 → /approve → 执行 → Completion Report → Close      │
 └──────────────────────────────────────────────────────────────────────┘
```

---

## 1. 前置条件清单

| # | 项 | 要求 | 检查命令 / 入口 |
| --- | --- | --- | --- |
| 1 | GitHub 账号 | 对目标仓库 `owner/target` 拥有 **admin** 权限（建标签、改仓库 Settings、推 workflow 文件都需要） | 仓库页面 → Settings 可见即有 admin |
| 2 | 本机 Node.js | ≥ 20（bootstrap 零依赖，使用内置 fetch） | `node --version` |
| 3 | 本机 git | 任意较新版本 | `git --version` |
| 4 | GateFlow 本仓库 | 已 clone 到本地（下文写作 `/path/to/gateflow`） | `ls /path/to/gateflow/scripts/bootstrap.mjs` |
| 5 | 目标仓库 | 已 clone 到本地（下文写作目标仓库的检出目录），且对应 GitHub 上的 `owner/target` | `git -C <检出目录> remote -v` |
| 6 | GitHub PAT | 一个 Personal Access Token（创建路径见下方"如何创建 PAT"），用于 bootstrap 建标签、push workflow 文件、以及（快速自用模式）GitHub MCP | — |
| 7 | AI 客户端 | 支持 MCP 的客户端（Claude Code / Codex / Cursor / VS Code 等）；本指南以 Claude Code 为例给出具体配置 | — |

### 如何创建 PAT（classic 与 fine-grained 二选一）

入口：GitHub 右上角头像 → **Settings** → 左栏最底部 **Developer settings** → **Personal access tokens**。

**选型建议**：只想快速跑通 → classic（勾 scope 即可，一个 token 覆盖建标签 + push + MCP 三件事）；追求最小权限 → fine-grained（按用途拆多个 token）。

**方式一：classic PAT**（Tokens (classic) → **Generate new token (classic)**）：

| 勾选项 | 用途 |
| --- | --- |
| `repo` | bootstrap 调 API 建标签；push 到私有仓库；GitHub MCP 读写 Issue / 仓库 |
| `workflow` | push 添加 / 更新 workflow 文件的提交（**没有它 push 会被拒**，见第 8 章 FAQ-5） |

**方式二：fine-grained PAT**（Fine-grained tokens → **Generate new token**）：

| Token 用途 | Repository access | Permissions |
| --- | --- | --- |
| bootstrap（建标签） | 仅选中 `owner/target` | **Issues: Read and write**（Metadata: Read 自动附带）；另需 **Administration 无、Contents 无**——脚本只调用 GET /repos、列标签、建标签三个 API，全部落在 Metadata + Issues 上 |
| push workflow 文件 | 仅选中 `owner/target` | **Contents: Read and write** + **Workflows: Read and write**（workflows 权限只有 write 一档；没有它 push workflow 文件同样被拒） |
| GitHub MCP（Owner 身份使用） | 仅选中 `owner/target` | **Issues: Read and write** + **Contents: Read** + **Pull requests: Read and write**（Executor 建 PR 需要） |

> token 只在创建时可见，先复制好。下文示例以环境变量引用为主：`export GITHUB_TOKEN=ghp_xxx`（避免出现在 shell history 与文档里）。

---

## 2. 第一步：让 GateFlow 本体可被引用

目标仓库的 workflow 里会有一句 `uses: jesongit/gateflow@v0`。GitHub 对这句话有一条硬规则：**它指向的仓库（含 `action.yml` 与已提交的 `dist/index.js`）必须在 GitHub 上可被你的目标仓库访问**。三种模式覆盖所有情形，先说结论：

| 模式 | gateflow 仓库可见性 | 额外要求 | 适用 |
| --- | --- | --- | --- |
| **A（推荐）** | **public** | 无 | 绝大多数场景。Action 代码本身不含任何密钥——Gate 运行时用的是**目标仓库自己的 `${{ github.token }}`**（由 workflow 的 `permissions:` 授权，见第 5 章），源码公开没有安全损失 |
| B | private | 在 gateflow 仓库打开 "Access" 共享策略：**Settings → Actions → General → Access** → 选 *"Accessible from repositories owned by '<你的用户名>' user"*（个人账号，要求两个仓库同属一个用户）或 *"Accessible from repositories in the '<组织名>' organization"*（组织账号，要求两个仓库同属一个组织） | 完全不想公开源码，且目标仓库与 gateflow 同属一个用户 / 一个组织。**默认值为 "Not accessible"，不打开就引用失败**。另一条硬限制（GitHub 官方原文 *"Access is allowed only from private repositories."*）：目标仓库也必须是**私有**的——公开的目标仓库永远引用不了私有的 action |
| C | 不上 GitHub 也行 | 把 `action.yml` + `dist/index.js` 复制进目标仓库 `.github/actions/gateflow/`，`uses:` 写本地路径 `./.github/actions/gateflow` | 完全不想公开、又没有组织、或属于目标与 gateflow 不同账号且不便开策略的场景。代价是 Gate 升级需要手工同步副本 |

> 依据：GitHub 官方文档 "Managing GitHub Actions settings for a repository" 的 *"Allowing access to components in a private repository"* 章节：*"Actions and reusable workflows in your private repositories can be shared with other private repositories owned by the same user or organization."*，默认 *"Workflows in other repositories cannot access this repository."*
>
> **不要**尝试用"fork 一份私有副本"来绕过：跨仓库私有引用的限制跟的是"仓库是否可被目标仓库访问"，fork 私有副本同样受上面规则约束（还是要开 Access 或转公开）。

### 2.A 模式 A：发布为 public 仓库（最短指引）

完整发布步骤（产物同步检查、版本对齐、GitHub Release、`@v0` 浮动 tag 维护策略）见 [release.md](release.md) §1，这里只给最短可用路径：

```bash
cd /path/to/gateflow

# 0. 本地验证（release.md §1 Step 1，全绿才继续）
npm run typecheck && npm test && npm run build && git status   # dist/index.js 必须无变化

# 1. 在 GitHub 上建一个 public 仓库（名字建议 gateflow），然后：
git remote add origin https://github.com/<owner>/gateflow.git
git push -u origin main

# 2. 打版本 tag 与浮动 tag（与 package.json 的 0.1.0 对齐）
git tag v0.1.0
git push origin v0.1.0
git tag -f v0 v0.1.0
git push -f origin v0
```

完成后 `uses: <owner>/gateflow@v0` 即可被任何仓库引用。此后每次 Gate 更新，按 [release.md](release.md) §1 Step 5 重新移动 `v0`。

### 2.B 模式 B：私有仓库 + Access 共享策略

1. 同 2.A 步骤 0~2，但第 1 步建仓时选 **Private**；
2. 打开 gateflow 仓库 → **Settings** → 左栏 **Actions → General** → 拉到底部 **Access** 区块；
3. 选择 *"Accessible from repositories owned by '<你的用户名>' user"*（个人账号）或 *"Accessible from repositories in the '<组织名>' organization"*（组织账号）→ **Save**；
4. 确认目标仓库也是**私有**仓库（见上表硬限制）。

适用边界：两个仓库必须同属一个用户（或同属一个组织）；目标仓库转 public 后此模式失效（改用模式 A 或 C）。

### 2.C 模式 C：内嵌进目标仓库（无需 gateflow 上 GitHub）

原理：GitHub Actions 支持引用**同一仓库内的本地 action**（`uses: ./.github/actions/gateflow`）。bootstrap 脚本原生支持这种写法——`--action-ref` 可以传相对路径（脚本只要求该值不含空白字符，字符串替换后生成 `uses: ./.github/actions/gateflow`，这是合法的本地 action 引用）：

1. **复制 Action 本体**（bootstrap 不会替你复制，这两步是手动的）：

   ```bash
   # 在目标仓库的检出目录里
   mkdir -p .github/actions/gateflow
   cp /path/to/gateflow/action.yml .github/actions/gateflow/
   cp /path/to/gateflow/dist/index.js .github/actions/gateflow/
   ```

   > 前提：`/path/to/gateflow` 里已执行过 `npm run build`（`dist/index.js` 是 esbuild 产物，GitHub JS Action 只认它，不认 `src/`）。`action.yml` 与 `dist/index.js` 两个文件都要复制、都要 commit。

2. **bootstrap 时覆盖 `--action-ref` 为本地路径**（详见第 3 章）：

   ```bash
   node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target \
     --token "$GITHUB_TOKEN" --action-ref ./.github/actions/gateflow
   ```

3. **一并提交**：`.github/actions/gateflow/`（action 本体）与 `.github/workflows/ai-workflow.yml`（workflow）同一个 commit 推上去——workflow 引用的本地 action 必须与 workflow 在同一 commit 中存在。

升级方式：Gate 更新后重新执行步骤 1 的 `cp`（从更新后的 gateflow 检出复制新 `dist/index.js`）再提交。没有浮动 tag 机制，升级完全靠手工同步——这是本模式的代价。

---

## 3. 第二步：bootstrap 自动接入（推荐路径）

[scripts/bootstrap.mjs](../scripts/bootstrap.mjs) 是零依赖（Node ≥ 20 内置 fetch）、**幂等**（可重复执行，重复运行只会看到一串 `[skip]`）的初始化脚本。它做三件事：校验 token 与仓库 → 创建缺失的 6 个 `ai:*` 标签（同名已存在的**跳过且绝不修改**其颜色 / 描述）→ 经确认后生成缺失的 workflow 文件（已存在则**警告跳过，绝不覆盖**，也不触碰已有 issue templates 与其他 workflow）。

### 步骤 2.1 进入目标仓库的检出目录

```bash
cd /path/to/target-checkout
```

**为什么必须在这里运行**：bootstrap 把 workflow 文件写入**当前工作目录**下的 `.github/workflows/<file>`（不会推送到 GitHub，也不会写到别处）。它只与 GitHub API 交互（建标签），落盘动作只发生在你当前所在的目录。若在错误目录运行，workflow 文件会生成到错误的地方——此时删掉生成物重新在正确目录运行即可（脚本幂等，标签不受影响）。

### 步骤 2.2 先 dry-run 预览

```bash
node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target \
  --token "$GITHUB_TOKEN" --dry-run
```

> 注意：**`--dry-run` 也需要 `--token`**（或已设置 `GITHUB_TOKEN` 环境变量）——脚本入口统一做参数校验。dry-run 本身**不访问网络、不修改任何东西**，token 只需存在、不校验有效性（占位值也能跑通 dry-run）。如未传 repo / token，会得到 `[error] 缺少目标仓库…` / `[error] 缺少 GitHub token…` 并以退出码 1 结束。

典型输出（每行含义见注释）：

```text
[dry-run] 以下是将要执行的操作（本次不做任何修改、不访问网络）：
[dry-run] 目标仓库：owner/target
                                          ← 本次操作的目标仓库（--repo 传入）
[dry-run] 步骤 1：校验 token 与仓库可访问（GET /repos/owner/target）
                                          ← 真跑时先调 GET /repos 校验 token 与仓库
[dry-run] 步骤 2：创建以下 6 个 ai:* 标签（同名已存在的标签将跳过，绝不修改其颜色 / 描述）：
[create] 将创建标签：ai:planning（#d4c5f9，描述：…）
[create] 将创建标签：ai:review（#fef2c0，描述：…）
[create] 将创建标签：ai:ready（#c2e0c6，描述：…）
[create] 将创建标签：ai:working（#1d76db，描述：…）
[create] 将创建标签：ai:blocked（#d93f0b，描述：…）
[create] 将创建标签：ai:done（#0e8a16，描述：…）
                                          ← 6 个标签的名称 / 颜色 / 描述，与 protocol.md §1 一致
[dry-run] 步骤 3：workflow 文件：<当前目录>\.github\workflows\ai-workflow.yml
[create] 将在确认后从 templates/workflow.yml 生成（uses: jesongit/gateflow@v0）。
                                          ← 待生成的文件路径（在当前目录下）与将写入的 uses 引用
                                            （--action-ref 传了别的值时这里会显示那个值）
[dry-run] 步骤 4：打印 GitHub MCP 与 Skills 安装提示（只提示，不代劳）。

收尾提示（以下步骤需要你手动完成，本脚本不代劳）：
  1. 在你的 AI Client（Codex / Claude Code / Cursor / VS Code 等）配置 GitHub 官方 MCP Server，…
  2. 把 skills/producer、skills/consumer、skills/executor 三个 Skill 安装到你的 AI Client（全局或项目级）。

提交并推送生成的 .github/workflows/<file> 后，按 docs/usage.md §3 开始使用：/ai-plan → /approve → 执行。
```

> 若步骤 3 显示 *"该文件已存在：将警告并跳过，绝不覆盖"*，说明当前目录已有同名 workflow——脚本不会动它，确认这是否符合预期（要换引用请手工编辑，见第 8 章 FAQ-6）。

### 步骤 2.3 真跑（去掉 --dry-run）

```bash
node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target --token "$GITHUB_TOKEN"
# 模式 C 则加上： --action-ref ./.github/actions/gateflow
```

预期输出：

```text
== gateflow bootstrap ==
目标仓库：owner/target
Action 引用：jesongit/gateflow@v0

步骤 1/3：校验 token 与仓库…
[ok] 仓库可访问：owner/target
                                          ← 私有目标仓库会多一行 [ok] 私有仓库：…
                                          ← token 无写权限会出 [warn] …创建标签将失败

步骤 2/3：创建 ai:* 标签（已存在的同名标签跳过，绝不修改）…
[create] 标签已创建：ai:planning（#d4c5f9）
…（共 6 行；已存在的显示 [skip] 标签已存在，不做任何修改：…）

步骤 3/3：workflow 文件（已存在则警告跳过，绝不覆盖）…
[confirm] 将创建 <当前目录>\.github\workflows\ai-workflow.yml（uses: jesongit/gateflow@v0），是否继续？[Y/n]
                                          ← 交互确认：回车或 y 继续，n 取消（取消则不生成文件，标签已建不受影响）
[create] workflow 文件已生成：<当前目录>\.github\workflows\ai-workflow.yml

收尾提示（以下步骤需要你手动完成，本脚本不代劳）：…
```

两个行为细节：

- **非交互终端**（如管道、CI）：无法询问确认，脚本会打印 `[warn] 当前不是交互式终端，无法询问确认：跳过 workflow 文件生成` 并跳过生成——**标签仍会创建**。请在终端里重跑一次拿到 workflow 文件；
- 中途报错（如 401 / 404）时脚本打印 `[error] …` 与 `已中止：未完成的步骤可在修复问题后重新运行（本脚本幂等）`，退出码 1。修复后直接重跑即可。

### 步骤 2.4 检查生成的 workflow 文件

打开生成的 `.github/workflows/ai-workflow.yml`（内容与 [templates/workflow.yml](../templates/workflow.yml) 一致，仅 `uses:` 换成了你传的引用）。全文如下，逐段说明：

```yaml
name: AI Workflow Gate

# 监听事件（与 protocol.md §8 事件矩阵一致）：
#   issues  [opened, labeled, closed]  —— Issue 创建 / 打标 / 关闭（不给新 Issue 自动打标，只做一致性检查与静默收尾）
#   issue_comment [created, edited]    —— 主处理路径：命令（/approve 等）与 Marker（Plan / Tracker / Report）
# 注意：不监听 reopened（V0 不处理，残留标签用 /cancel 清除）。
on:
  issues:
    types: [opened, labeled, closed]
  issue_comment:
    types: [created, edited]

# workflow 自身权限：issues: write 让 Gate 能写 ai:* 标签与 reaction；
# contents: read 供 Action 运行时读取仓库元信息。
# 这个 github.token 是 GitHub 自动生成、随 workflow 生灭的，你不需要配任何 secret。
permissions:
  issues: write
  contents: read

jobs:
  gate:
    runs-on: ubuntu-latest
    # 串行保证（protocol.md §7）：同一 Issue 的所有 Gate run 排队执行、不取消。
    # 这一行请勿删除——Gate 自身幂等，但串行化由它保证。
    concurrency:
      group: ai-workflow-${{ github.event.issue.number }}
      cancel-in-progress: false

    steps:
      - name: AI Workflow Gate
        # 模式 A / B：owner/gateflow@v0（必须按第 2 章发布 / 开策略后才解析成功）
        # 模式 C：./.github/actions/gateflow（本地路径，action 本体已复制进本仓库）
        uses: jesongit/gateflow@v0
        with:
          # 缺省 = workflow 自己的 ${{ github.token }}，无需配置 secret
          github-token: ${{ github.token }}
          # 额外可信的人类账号（逗号分隔，如 alice,bob）；留空 = 仅 repo owner
          trusted-humans: ''
          # 额外可信的 AI 独立身份（逗号分隔）；留空 = 无（Owner PAT 直连 MCP 时无需设置）
          trusted-agents: ''
```

### 步骤 2.5 commit + push

```bash
git add .github/workflows/ai-workflow.yml
git commit -m "ci: adopt GateFlow AI workflow gate"
git push
```

> **push 被拒的常见原因**：含 workflow 文件的提交，用 HTTPS + PAT 推送时要求 PAT 具备 workflow 权限——classic PAT 勾选 **`workflow`** scope（官方定义：*"Grants the ability to add and update GitHub Actions workflow files"*），fine-grained PAT 则需要 **Workflows: Read and write**（外加 Contents 读写）。否则报错形如 *"refusing to allow a Personal Access Token to create or update workflow … without workflow scope"*。SSH 方式推送不受此限制（SSH 密钥与 PAT scope 无关）。排查详见第 8 章 FAQ-5。
>
> 模式 C 还要 `git add .github/actions/gateflow/` 一起提交（见 2.C 步骤 3）。

### 步骤 2.6 验证

| 位置 | 应该看到 |
| --- | --- |
| GitHub 仓库 → **Actions** 页 | 左栏出现 **"AI Workflow Gate"** workflow。此时可能还没有 run（它只在 Issue / 评论事件上触发；建一个测试 Issue 就会看到第一条 run） |
| GitHub 仓库 → **Issues** → Labels（或 *Labels* 页） | 6 个 `ai:*` 标签：`ai:planning` `ai:review` `ai:ready` `ai:working` `ai:blocked` `ai:done`，颜色与描述同 protocol.md §1 |
| GitHub 仓库 → **Settings → Actions → General** | Actions 处于允许运行状态（默认即是；若组织策略禁用了 Actions 需先放开） |

### bootstrap 参数总表（与 `--help` 输出逐项一致）

| 参数 | 缺省 | 说明 |
| --- | --- | --- |
| `--repo owner/name` | `GITHUB_REPOSITORY` 环境变量 | 目标仓库；两者都没有时报错退出 |
| `--token <token>` | `GITHUB_TOKEN` 环境变量 | GitHub token，需要对目标仓库的写权限（创建标签）；**`--dry-run` 也要求它存在**（入口统一校验，但 dry-run 不访问网络、不校验有效性） |
| `--action-ref <ref>` | `jesongit/gateflow@v0` | workflow 中 `uses:` 的 Action 引用（不能含空白字符；模式 C 传 `./.github/actions/gateflow`） |
| `--workflow-file <name>` | `ai-workflow.yml` | 生成的 workflow 文件名（不含路径的 `.yml` / `.yaml` 文件名，改了它 push 时注意同名文件对应关系） |
| `--dry-run` | 关 | 只打印将做什么，不做任何修改、不访问网络 |
| `--help` / `-h` | — | 显示帮助 |

---

## 4. 第二步（替代）：手动接入

不想跑脚本也可以，同样的两件事手工做：建 6 个标签 + 建 1 个 workflow 文件。

### 4.1 在 GitHub 界面创建 6 个标签

仓库页面 → **Issues** → 右侧 **Labels** → **New label**，逐个创建：

| 名称 | 颜色（hex） | 描述 |
| --- | --- | --- |
| `ai:planning` | `d4c5f9` | Work Item 已进入 Workflow，Consumer 正在分析 / 补全设计 |
| `ai:review` | `fef2c0` | Execution Plan 已发布，等待 Trusted Human 审批 |
| `ai:ready` | `c2e0c6` | Plan 已批准，等待 Executor 接手 |
| `ai:working` | `1d76db` | Executor 正在按 Approved Plan 执行 |
| `ai:blocked` | `d93f0b` | 执行被阻塞（WORKING 的子状态） |
| `ai:done` | `0e8a16` | AI 工作已完成，等待 Owner 最终检查（不等于 Issue 已关闭） |

> 名称必须逐字一致（含 `ai:` 前缀与冒号）。颜色 / 描述是 bootstrap 使用的建议值，不是协议语义的一部分；但**名称错了 Gate 就找不到状态标签**。

### 4.2 手动创建 workflow 文件

在目标仓库检出目录新建 `.github/workflows/ai-workflow.yml`，内容与 [templates/workflow.yml](../templates/workflow.yml) 完全一致（把 `uses:` 换成你第 2 章选定的引用）：

```yaml
name: AI Workflow Gate

on:
  issues:
    types: [opened, labeled, closed]
  issue_comment:
    types: [created, edited]

permissions:
  issues: write
  contents: read

jobs:
  gate:
    runs-on: ubuntu-latest
    # 同一 Issue 的所有 Gate run 必须串行（协议第 7 节）：共享并发组 + 排队不取消。请勿删除。
    concurrency:
      group: ai-workflow-${{ github.event.issue.number }}
      cancel-in-progress: false

    steps:
      - name: AI Workflow Gate
        uses: jesongit/gateflow@v0    # 模式 A/B：你的 owner/gateflow@v0；模式 C：./.github/actions/gateflow
        with:
          github-token: ${{ github.token }}
          trusted-humans: ''
          trusted-agents: ''
```

（各字段语义见步骤 2.4 的逐段说明。）

### 4.3 push 并验证

```bash
git add .github/workflows/ai-workflow.yml
git commit -m "ci: adopt GateFlow AI workflow gate"
git push
```

验证同步骤 2.6（Actions 页出现 "AI Workflow Gate"、Labels 页出现 6 个 `ai:*` 标签）。push 的 workflow 权限提醒同步骤 2.5。

---

## 5. 第三步：配置 Action 输入

Action 共三个输入（定义见 [action.yml](../action.yml)，权限模型见 [protocol.md](protocol.md) §6）。生成的 workflow 里三项都已显式写出（默认值），**第一次接入可以什么都不改**，先跑通验收，再按需回来加：

### `github-token`：保持默认即可

模板写的是 `github-token: ${{ github.token }}`——这是 **GitHub Actions 自动注入的 workflow token**，随 workflow 运行自动生成与回收，配合上方的 `permissions: issues: write, contents: read` 正好够 Gate 读标签、写标签、加 reaction。**你不需要在仓库 Secrets 里配任何 PAT**（很多人以为要配 `GITHUB_TOKEN` secret——不需要）。只有当你的仓库策略限制默认 token 权限时才需要换成 PAT secret，常规使用不要动。

### `trusted-humans`：除了你之外，还有谁能发命令

- **何时填**：仓库有协作者，且你希望他们也能执行 `/ai-plan`、`/approve`、`/choose`、`/change`、`/cancel` 时。
- **格式**：逗号分隔的 GitHub login，如 `trusted-humans: 'alice,bob'`。
- **默认行为**：留空 = 只有 **repo owner**（个人仓库即你）是 Trusted Human。
- 示例——让协作者 alice、bob 也拥有审批权：

  ```yaml
  trusted-humans: 'alice,bob'
  ```

  之后 alice 评论 `/approve` 也会被 Gate 接受（✅ 并迁移 `ai:review → ai:ready`）；非 Trusted Human 的命令一律被拒（👎，见第 7 章验收第 7 步）。

### `trusted-agents`：给 AI 独立身份登记（与 trusted-humans 本质不同）

两者**语义不同且在协议中永不合并**：

| | Trusted Human（`trusted-humans`） | Trusted Agent（`trusted-agents`） |
| --- | --- | --- |
| 能否**发命令**（`/approve` 等 5 个） | **能**（且只有它能） | **永远不能**——发了也不被解析，等价于普通评论 |
| 能否**发 Marker 推进状态**（Plan / Tracker / Report 触发 T1 / T3 / T6） | 能 | 能（这是它唯一的职权） |
| 典型身份 | 你、你的协作者 | 独立 Bot 账号 / GitHub App |

- **何时填**：V0 快速自用模式（你自己的 PAT 直连 GitHub MCP）下，AI 发的 Issue / 评论的 actor 就是你本人，天然满足 Trusted Human ∪ Trusted Agent，**无需设置**。当你给 AI 换成独立 Bot 身份（独立的 GitHub 账号 + 它自己的 PAT）时才需要登记。
- 示例——给 AI 一个独立身份 `gateflow-bot`：

  1. 创建 / 使用一个独立 GitHub 账号（或 bot 账号），为它生成 PAT，配到 GitHub MCP（见第 6 章）；
  2. workflow 里登记：

     ```yaml
     trusted-agents: 'gateflow-bot'
     ```

  3. 效果：`gateflow-bot` 发布的 Plan / Tracker / Report 评论能触发状态迁移（T1 / T3 / T6）；但它评论 `/approve` **永远无效**——即使有人诱导它（Prompt Injection），它也无法批准任何 Plan。命令权仍然只在 Trusted Human 手里。

---

## 6. 第四步：接入 AI 侧

### 6.1 配置 GitHub MCP

AI（Producer / Consumer / Executor）通过 [GitHub 官方 MCP Server](https://github.com/github/github-mcp-server) 读写 GitHub。推荐接**远端 server**（无需本地 Docker / Node 进程）：URL 为 `https://api.githubcopilot.com/mcp/`，用 PAT 走 `Authorization: Bearer` 头认证，用 `X-MCP-Toolsets` 头收敛 toolsets。

**Claude Code 方式一：命令行添加（user / local scope）**

```bash
claude mcp add --transport http github https://api.githubcopilot.com/mcp/ \
  --header "Authorization: Bearer <你的PAT>"
```

**Claude Code 方式二：项目级 `.mcp.json`（可提交给团队共用，PAT 用环境变量展开，不要把明文 token 提交进仓库）**

在目标仓库根目录建 `.mcp.json`：

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_MCP_PAT}",
        "X-MCP-Toolsets": "repos,issues,pull_requests"
      }
    }
  }
}
```

`${GITHUB_MCP_PAT}` 在你的 shell 里 `export GITHUB_MCP_PAT=github_pat_xxx`（Claude Code 支持 `${VAR}` 与 `${VAR:-default}` 展开语法）。项目级 server 首次使用时 Claude Code 会请求批准。

**其他客户端（Codex / Cursor / VS Code 等）通用写法**：任何支持 streamable HTTP MCP 的客户端，填同样的 URL + 两个 header 即可（JSON 字段名按各自客户端约定，`X-MCP-Toolsets` 与 `Authorization` 的值不变）。

**toolsets 最小化原则**：只开 `repos` / `issues` / `pull_requests` 三个——覆盖 Producer 建 Issue、Consumer 读仓库发 Plan、Executor 读代码建 PR 的全部需要。不要把全部 toolsets 打开给 AI（远端 server 未指定 toolsets 时会启用一组默认 toolsets，所以**显式带上这个 header**；也可以用 `X-MCP-Readonly: "true"` 做整体只读限幅，或对单一 toolset 用 `.../mcp/x/issues` 这类 URL path 写法——多 toolset 组合请用 header）。

**PAT 与 MCP 权限的关系**：MCP server 用你给的 PAT 代表"你"调 GitHub API，PAT 权限就是 AI 的实际上限：

- classic PAT：勾 `repo`（读写私有仓库的 Issue / 内容 / PR）；只读使用可进一步收敛；
- fine-grained PAT：目标仓库 + **Issues: Read and write** + **Contents: Read** + **Pull requests: Read and write**；
- 只装 Producer / Consumer（不让 Executor 执行）时，可以不给 pull_requests 写权限；
- 更换 PAT 时注意：MCP 连接的 actor 就是 AI 的 actor。V0 快速自用模式下它就是你（Trusted Human），所以**不要把有 admin 权限的 token 随手交给 AI**——给它能干活的最小权限即可。

配置完在 Claude Code 里跑 `/mcp` 应看到 `github ✔ Connected`。

### 6.2 安装三个 Skills

把本仓库的 [skills/producer/SKILL.md](../skills/producer/SKILL.md)、[skills/consumer/SKILL.md](../skills/consumer/SKILL.md)、[skills/executor/SKILL.md](../skills/executor/SKILL.md) 装进 Claude Code。

**安装方式**：每个 Skill 是一个目录（目录名即 Skill 名），内含 `SKILL.md`。

```text
# 方式一：全局（个人）安装——对你所有项目生效
~/.claude/skills/
├── producer/SKILL.md
├── consumer/SKILL.md
└── executor/SKILL.md

# 方式二：项目级安装——只对当前项目生效（可提交进仓库，随仓库分发给协作者）
<目标仓库>/.claude/skills/
├── producer/SKILL.md
├── consumer/SKILL.md
└── executor/SKILL.md
```

复制命令（以项目级为例，在目标仓库检出目录里执行）：

```bash
mkdir -p .claude/skills
cp -r /path/to/gateflow/skills/producer .claude/skills/
cp -r /path/to/gateflow/skills/consumer .claude/skills/
cp -r /path/to/gateflow/skills/executor .claude/skills/
```

> 注意复制的是**目录**（`cp -r …/producer .claude/skills/`），保证路径形如 `.claude/skills/producer/SKILL.md`。全局与项目级同名冲突时按 客户端优先级规则 解析；一般二选一即可。

**装完如何验证**：新开一个 Claude Code 会话（让它重新加载 Skills），对 AI 说：

```text
发个测试 Issue 到 owner/target：标题"GateFlow 接入冒烟测试"，内容随便写，用完我会关掉。
```

Producer 的正确行为是：提炼出一份 Draft（目标仓库、标题、正文），**先给你确认**——它应该在写入前向你展示 Draft 并等你说"确认"。你确认后它通过 GitHub MCP 创建 Issue，并给 Issue 打上 `ai:planning` 标签。看到这条 Issue 且标签正确，说明 MCP 与 Producer 都通了。（它若不打 `ai:planning` 或不打草稿直接发，说明 Skill 没装对——检查目录布局。）

---

## 7. 第五步：验收——跑通第一个 Issue 闭环

冒烟测试逐条做，每步对照"你应该看到什么"。以下假定目标仓库 `owner/target`、Issue 编号 `#N` 以实际为准。**全程不 push 任何代码到目标仓库之外的地方**；闭环跑完建议关掉测试 Issue。

### 7.1 让测试 Issue 进入工作流（`ai:planning`）

- **操作**：在 GitHub 上手动新建一个测试 Issue（标题随意，如"GateFlow 冒烟测试"），然后在 Issue 下评论一条命令（**整条评论只写这五个字符**）：

  ```text
  /ai-plan
  ```

  （或者：直接用 6.2 验证时 Producer 建的那条 Issue——它创建时已带 `ai:planning`，可跳过本步。）

- **你应该看到**：几秒后该命令评论出现 **✅ reaction**，Issue 标签变为 **`ai:planning`**；Actions 页出现一条绿色 run（事件 `issue_comment.created`）。若无标签且无 run → 第 8 章 FAQ-1。

### 7.2 让 Consumer 规划（`ai:review`）

- **操作**：在 Claude Code 里说：`规划 owner/target#N`。

- **你应该看到**：Consumer 读取 Issue 与仓库后，发布一条以 `<!-- ai-workflow:plan:v1 -->` 开头的 **Plan 评论**（Execution Plan：Objective / Design / Tasks / Acceptance Criteria …）；随后 Actions 页出现新的绿色 run；Issue 标签自动变为 **`ai:review`**（Gate 检测到 plan marker 触发 T1）。注意：标签迁移发生在你发完消息之后由 Gate 完成，偶尔有数秒延迟属正常。

### 7.3 批准 Plan（`ai:ready`）

- **操作**：在 Issue 下评论（整条评论只写这八个字符）：

  ```text
  /approve
  ```

- **你应该看到**：该评论获得 **✅ reaction**，标签变为 **`ai:ready`**（Gate T2），Actions 页有对应绿色 run。

### 7.4 让 Executor 执行（`ai:working`）

- **操作**：对 AI 说：`执行 owner/target#N`。

- **你应该看到**：Executor 读取 Approved Plan，在 Issue 发布一条以 `<!-- ai-workflow:execution-tracker:v1 -->` 开头的 **Execution Tracker 评论**（TodoList + `**Status:** In Progress`），随后持续**编辑**这条评论（勾选 Todo、更新 Current / Notes）；标签变为 **`ai:working`**（Gate T3）。此后看进度不需要问 AI——打开 Issue 看 Tracker 勾选即可。

### 7.5（可选）试 /change 与 Blocked 流程

- **`/change`**：评论 `/change 计划里不要引入新依赖` → 该评论出现 ✅、**标签保持 `ai:review`**（`/change` 不迁移状态）；再对 AI 说"按 owner/target#N 的 /change 意见更新 Plan"→ Consumer 发布 Plan v2 **新评论**（旧 Plan 不编辑）。（在 7.3 之前做这一步。）
- **Blocked**：执行期间让 Executor 遇阻（或直接让它把 Tracker 的 `**Status:**` 改为 `Blocked`）→ 标签 `ai:working → ai:blocked`（Gate T4，仅在 Tracker 评论的 edited 事件上触发）；处理后改回 `In Progress` → `ai:blocked → ai:working`（T5）。

### 7.6 Completion Report 与收尾（`ai:done` → Close）

- **操作**：等 Executor 完成（可先给它一个极小任务，比如"在 README 加一行测试段落"）。
- **你应该看到**：Executor 发布以 `<!-- ai-workflow:completion-report:v1 -->` 开头的 **Completion Report 评论**（Result / Completed / Key Changes / References / Validation / Deviations …）；标签变为 **`ai:done`**（Gate T6）。**Issue 保持 Open**——`ai:done` 的含义是"AI 完成，等你检查"，不是关闭。你检查 Report / 变更内容无误后，**手动 Close 这个 Issue**（关闭永远是人的职权）。闭环完成。

### 7.7 负面用例：无权限账号发命令必须无效

- **操作**：用另一个无 Trusted Human 身份的账号（协作者、小号、或请朋友），在同一个 Issue（需再建一个新测试 Issue 走到 `ai:review`）评论 `/approve`。
- **你应该看到**：该评论获得 **👎 reaction**（含义："invalid owner command"），**标签不迁移**，Actions 页对应的 Gate run 依然绿色（拒绝是正常业务结果，不是错误）。这就是"审批权只在 Trusted Human 手里"的确定性保证——即使 AI 被诱导也不可能出现例外，因为判定根本不经 AI。

---

## 8. 故障排查 FAQ

**FAQ-1 workflow 完全没触发（Actions 页没有 run）**
现象：评论了 `/ai-plan` / 发了 Plan，Actions 页干干净净。
原因与解决（按概率排序）：① workflow 文件没推上去，或推到了非默认分支——`issues` / `issue_comment` 事件只认**默认分支**上的 workflow 定义，确认 `origin/<默认分支>` 上存在 `.github/workflows/ai-workflow.yml`；② 仓库 Settings → Actions 里 Actions 被禁用（组织策略常见）；③ YAML 语法错误导致 workflow 加载失败（Actions 页会显示警告横幅）。逐一检查后重发一条评论验证。

**FAQ-2 Gate run 红叉**
现象：Actions 页 run 失败。
原因：Gate 对无效命令 / 错误状态一律 no-op 并**正常退出**（不会红叉），红叉一定是运行时故障而非业务拒绝。点开 run 看 log（首行应为 `gateflow <GATE_VERSION>`，没有这行说明 Action 根本没启动）：常见原因有 `uses:` 解析失败（见 FAQ-3）、API 限流或 token 权限不足（换 `github-token` 为有 Issues 写权限的 PAT 可定位）、workflow YAML 非法。修复后可重跑该 run（Gate 幂等：迁移前会重读标签，不会二次迁移）。

**FAQ-3 `uses:` 解析失败 / "Can't find action" / 404 Resource not found**
现象：run 启动即失败，log 显示找不到 action。
原因：`uses: owner/gateflow@v0` 指向的仓库不存在、**还是 private 且未开 Access 共享策略**（默认 "Not accessible" 就是被禁）、或 tag 不存在。
解决：回到**第一步**三模式自查——模式 A 确认仓库是 public 且 `v0` tag 已推（`git ls-remote --tags origin v0`）；模式 B 确认 gateflow 仓库 Settings → Actions → General → Access 已选同用户 / 同组织可访问，且**目标仓库也是私有**（公开目标仓库引用私有 action 永远不行）；模式 C 确认 `.github/actions/gateflow/{action.yml,dist/index.js}` 已提交且与 workflow 同 commit。完全没有组织、又不想公开 → 模式 C。

**FAQ-4 bootstrap 报错（401 / 404 / 网络等）**
- `[error] token 无效或已过期（HTTP 401）`：token 抄错 / 已撤销 / 用了错误的 token 类型。重新生成。
- `[error] 仓库不存在或 token 无权访问（HTTP 404）`：`--repo` 拼写错，或 fine-grained PAT 的 Repository access **没勾选目标仓库**（fine-grained 对未授权仓库一律 404）。
- `[error] 创建标签失败：…（HTTP 403）`：token 缺 Issues 写权限——classic 缺 `repo` scope；fine-grained 缺 **Issues: Read and write**。
- `[warn] 当前 token 对该仓库没有写权限（push=false）…`：token 能读不能写，建标签会失败，换 token。
- 422 相关无需处理：脚本把"标签已被并发创建"的 422 视为跳过（`[warn] 标签已被并发创建，跳过`），不是错误。
- `[error] 缺少 GitHub token…` / `缺少目标仓库…`：参数没传或环境变量没设（**`--dry-run` 也要求**，见步骤 2.2）。

**FAQ-5 push workflow 文件被拒**
现象：`git push` 报 `refusing to allow a Personal Access Token to create or update workflow … without workflow scope`（或 fine-grained PAT 类似拒绝）。
原因：HTTPS + PAT 推送含 workflow 文件的提交，需要专门的 workflow 权限。
解决：classic PAT 勾 **`workflow`** scope；fine-grained PAT 加 **Workflows: Read and write**（外加 Contents 读写）。改完 PAT 记得更新本地凭据（Windows 凭据管理器 / `git credential`）。改用 SSH remote 则不受此限。

**FAQ-6 标签没建出来 / 建错了**
- 脚本输出 `[skip] 标签已存在`：仓库里本来就有同名标签，脚本按设计**跳过且绝不修改**。若已有标签名称对但颜色 / 描述不合意，可在 GitHub 界面手工改，脚本永远不会碰它。
- 名称写错（如漏了 `ai:` 前缀）：删掉错误标签重建；**名称必须与 protocol.md §1 逐字一致**，否则 Gate 找不到状态标签。
- dry-run 不建标签——它只打印计划。

**FAQ-7 AI 说它改不了标签 / 你也想让 AI 直接改标签**
这是**设计使然**，不是故障：`ai:*` 标签的迁移只归 Gate（protocol.md §6.3——AI 不能绕过 Gate 修改正式工作流状态，手工增删标签属协议违规）。正确姿势：AI 通过发布 Plan / Tracker / Report（marker）或你发命令来推动状态，标签由 Gate 写。若某次迁移没发生，先看 Actions 页 run 与 Issue 评论（Gate 的拒绝是静默 no-op 或 👎，不在 AI 的报错里）。

---

## 9. 卸载 / 回退

- **停用**：删除（或重命名）目标仓库的 `.github/workflows/ai-workflow.yml` 并 push——Gate 即不再运行，任何 Issue 事件都不会再触发它。这是唯一的"开关"。
- **标签**：6 个 `ai:*` 标签可以留着（它们只是普通 GitHub 标签，不影响不参与工作流的 Issue），也可以在 Labels 页删除。删除后若再接入，重跑 bootstrap 或按第 4 章重建即可。
- **已完成的 Issue**：状态不受任何影响。已关闭的 Issue 就是终态；仍带 `ai:*` 标签的未关闭 Issue 会保留残留标签，想让它们回到"普通 Issue"可手工移除标签，或由 Trusted Human 评论 `/cancel`（停用 workflow 后 `/cancel` 不再有效，直接手工删标签）。
- **AI 侧**：删除 `.claude/skills/{producer,consumer,executor}`（项目级）或 `~/.claude/skills/` 下对应目录，以及 `.mcp.json` 里的 `github` server 配置即完全移除。
- **模式 C 的内嵌副本**：删除 `.github/actions/gateflow/` 目录一并提交。
