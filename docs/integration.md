# 接入项目仓库详细指南（Integration）—— V1

> 本指南面向**第一次接触 GateFlow** 的人：只照本文档操作，就能把自己的项目仓库接入 GateFlow 并跑通第一个 Issue 闭环。全程**不需要配置远端服务器、不需要额外部署任何东西**。
>
> V1 接入分两部分：
>
> - **Part 1 · Gate 接入（GitHub 侧）**：让目标仓库的 workflow 能运行确定性 Gate——GateFlow 本体可被引用、bootstrap 初始化、Action 输入配置（第 1~5 章）；
> - **Part 2 · Driver + Workspace 接入（本地侧，V1 新增）**：构建本地 Driver、写 `gateflow.config.yml`、配置凭证与身份、安装四个 Agent Skills，并跑通一次完整冒烟闭环（第 6~10 章）。
>
> 命令与协议约定见 [protocol.md](protocol.md)；Workspace 协议见 [workspace-protocol.md](workspace-protocol.md)；Driver 运维见 [driver.md](driver.md)；日常操作见 [usage.md](usage.md) §3；发布维护见 [release.md](release.md)。
>
> 占位约定：GateFlow 本体写作 `jesongit/gateflow@v1`（请替换为你实际发布的 `owner/gateflow@v1`；未发布 V1 tag 前 bootstrap 的默认占位仍是 `@v0`，用 `--action-ref` 覆盖即可）；目标仓库写作 `owner/target`；本地检出的 GateFlow 仓库路径写作 `/path/to/gateflow`。

---

## 0. 这份指南解决什么

你的项目仓库（`owner/target`）要接入 GateFlow V1，本质上是让五样东西就位：

1. **Gate 本体可被引用**——目标仓库的 workflow 里有一句 `uses: jesongit/gateflow@v1`，这句引用必须能在 GitHub 上解析成功（第一步，三选一）；
2. **仓库里的接线**——6 个 `ai:*` 状态标签 + 一个监听 Issue 事件的 workflow 文件（第二步，脚本或手写）；
3. **Driver 身份登记**——workflow 的 `trusted-agents` 输入里登记 Driver 的 Bot 身份（如 `gateflow-agent[bot]`），Gate 才认可 Driver 发布的 Plan / Tracker / Report 评论（第三步）；
4. **本地接线**——构建 `gateflow` CLI、写 `gateflow.config.yml`、配 `GITHUB_TOKEN`、装四个 Agent Skills（第四步）；
5. **跑通一次闭环**——从 Issue 进入工作流到 DONE 走完一遍，确认 Gate / Driver / Agent 各就各位（第五步验收）。

全流程图：

```text
 ┌─ Part 1 · GitHub 侧 ─────────────────────────────────────────────────┐
 │ 第一步：发布 GateFlow 本体（模式 A / B / C 三选一，让 uses: 能解析）  │
 │ 第二步：bootstrap（创建 6 个 ai:* 标签 + 生成 workflow）+ commit/push │
 │ 第三步：配置 Action 输入（trusted-agents 登记 Driver Bot 身份）       │
 └──────────────────────────────┬───────────────────────────────────────┘
                                ▼
 ┌─ Part 2 · 本地侧（V1 新增）──────────────────────────────────────────┐
 │ 第四步：构建 gateflow CLI → 写 gateflow.config.yml → GITHUB_TOKEN    │
 │         → 安装 agent / consumer / executor / producer 四个 Skills    │
 │ 第五步：验收——Driver + Agent 冒烟闭环（once → inbox → outbox → once）│
 └──────────────────────────────────────────────────────────────────────┘
```

> V0 的"AI 配置 GitHub MCP"步骤在 V1 中**不再需要**：Agent 只读写本地 `.gateflow/`，GitHub 访问全部由 Driver 完成（历史做法见文末附录）。

---

## 1. 前置条件清单

| # | 项 | 要求 | 检查命令 / 入口 |
| --- | --- | --- | --- |
| 1 | GitHub 账号 | 对目标仓库 `owner/target` 拥有 **admin** 权限（建标签、改仓库 Settings、推 workflow 文件都需要） | 仓库页面 → Settings 可见即有 admin |
| 2 | 本机 Node.js | ≥ 20（bootstrap 零依赖；Driver CLI 同样运行在 Node 上，开发基线为 Node 24） | `node --version` |
| 3 | 本机 git | 任意较新版本 | `git --version` |
| 4 | GateFlow 本仓库 | 已 clone 到本地（下文写作 `/path/to/gateflow`），并能 `npm install && npm run build:cli` | `ls /path/to/gateflow/scripts/bootstrap.mjs` |
| 5 | 目标仓库 | 已 clone 到本地（下文写作目标仓库的检出目录），且对应 GitHub 上的 `owner/target` | `git -C <检出目录> remote -v` |
| 6 | bootstrap 用 PAT | 一个 Personal Access Token（见下方"如何创建 PAT"），用于 bootstrap 建标签、push workflow 文件 | — |
| 7 | Driver 用 `GITHUB_TOKEN` | Driver 进程专用的 GitHub token（可与 6 同一个，见第 8 章）；**只存在于 Driver 进程环境**，不给 Agent | — |
| 8 | AI 客户端 | 可安装 Skill 的客户端（ChatGPT / ZCode 等）；**V1 不再要求支持 MCP** | — |

### 如何创建 PAT（classic 与 fine-grained 二选一）

入口：GitHub 右上角头像 → **Settings** → 左栏最底部 **Developer settings** → **Personal access tokens**。

**方式一：classic PAT**（Tokens (classic) → **Generate new token (classic)**）：

| 勾选项 | 用途 |
| --- | --- |
| `repo` | bootstrap 调 API 建标签；push 到私有仓库；Driver 读 Issue / 评论、发布 Plan / Tracker / Report 评论、（submit 路径）创建 Issue |
| `workflow` | push 添加 / 更新 workflow 文件的提交（**没有它 push 会被拒**，见第 11 章 FAQ-5） |

**方式二：fine-grained PAT**（Fine-grained tokens → **Generate new token**）：

| Token 用途 | Repository access | Permissions |
| --- | --- | --- |
| bootstrap（建标签） | 仅选中 `owner/target` | **Issues: Read and write**（Metadata: Read 自动附带）；脚本只调用 GET /repos、列标签、建标签三个 API |
| push workflow 文件 | 仅选中 `owner/target` | **Contents: Read and write** + **Workflows: Read and write** |
| Driver `GITHUB_TOKEN` | 仅选中 `owner/target` | **Issues: Read and write**（读 Issue / 评论、发评论、建 Issue；Metadata 自动附带）。不要授予 Administration 等高权权限 |

> token 只在创建时可见，先复制好。下文示例以环境变量引用为主：`export GITHUB_TOKEN=ghp_xxx`（避免出现在 shell history 与文档里）。

---

## Part 1 · Gate 接入（GitHub 侧）

## 2. 第一步：让 GateFlow 本体可被引用

目标仓库的 workflow 里会有一句 `uses: jesongit/gateflow@v1`。GitHub 对这句话有一条硬规则：**它指向的仓库（含 `action.yml` 与已提交的 `dist/index.js`）必须在 GitHub 上可被你的目标仓库访问**。三种模式覆盖所有情形，先说结论：

| 模式 | gateflow 仓库可见性 | 额外要求 | 适用 |
| --- | --- | --- | --- |
| **A（推荐）** | **public** | 无 | 绝大多数场景。Action 代码本身不含任何密钥——Gate 运行时用的是**目标仓库自己的 `${{ github.token }}`**（由 workflow 的 `permissions:` 授权，见第 5 章），源码公开没有安全损失 |
| B | private | 在 gateflow 仓库打开 "Access" 共享策略：**Settings → Actions → General → Access** → 选 *"Accessible from repositories owned by '<你的用户名>' user"*（个人账号，要求两个仓库同属一个用户）或 *"Accessible from repositories in the '<组织名>' organization"*（组织账号，要求两个仓库同属一个组织） | 完全不想公开源码，且目标仓库与 gateflow 同属一个用户 / 一个组织。**默认值为 "Not accessible"，不打开就引用失败**。另一条硬限制（GitHub 官方原文 *"Access is allowed only from private repositories."*）：目标仓库也必须是**私有**的——公开的目标仓库永远引用不了私有的 action |
| C | 不上 GitHub 也行 | 把 `action.yml` + `dist/index.js` 复制进目标仓库 `.github/actions/gateflow/`，`uses:` 写本地路径 `./.github/actions/gateflow` | 完全不想公开、又没有组织、或属于目标与 gateflow 不同账号且不便开策略的场景。代价是 Gate 升级需要手工同步副本 |

> 依据：GitHub 官方文档 "Managing GitHub Actions settings for a repository" 的 *"Allowing access to components in a private repository"* 章节：*"Actions and reusable workflows in your private repositories can be shared with other private repositories owned by the same user or organization."*，默认 *"Workflows in other repositories cannot access this repository."*
>
> **不要**尝试用"fork 一份私有副本"来绕过：跨仓库私有引用的限制跟的是"仓库是否可被目标仓库访问"，fork 私有副本同样受上面规则约束（还是要开 Access 或转公开）。

### 2.A 模式 A：发布为 public 仓库（最短指引）

完整发布步骤（两个 dist 产物的同步检查、版本对齐、GitHub Release、`@v1` 浮动 tag 维护策略）见 [release.md](release.md) §1，这里只给最短可用路径：

```bash
cd /path/to/gateflow

# 0. 本地验证（release.md §1 Step 1，全绿才继续）
npm run typecheck && npm test && npm run build && npm run check:dist && git status   # dist/ 必须无变化

# 1. 在 GitHub 上建一个 public 仓库（名字建议 gateflow），然后：
git remote add origin https://github.com/<owner>/gateflow.git
git push -u origin main

# 2. 打版本 tag 与浮动 tag（与 package.json 的版本对齐）
git tag v1.0.0
git push origin v1.0.0
git tag -f v1 v1.0.0
git push -f origin v1
```

完成后 `uses: <owner>/gateflow@v1` 即可被任何仓库引用。此后每次 Gate 更新，按 [release.md](release.md) §1 Step 5 重新移动 `v1`。

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

   > 前提：`/path/to/gateflow` 里已执行过 `npm run build`（`dist/index.js` 是 esbuild 产物，GitHub JS Action 只认它，不认 `src/`）。`action.yml` 与 `dist/index.js` 两个文件都要复制、都要 commit。注意：内嵌的是 **Gate** 产物；Driver（`dist/cli.js`）始终在本地运行，不需要内嵌。

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
…（共 6 行，与 protocol.md §1 一致）
[dry-run] 步骤 3：workflow 文件：<当前目录>\.github\workflows\ai-workflow.yml
[create] 将在确认后从 templates/workflow.yml 生成（uses: <你传的 action-ref>）。
                                          ← V1 建议传 --action-ref <owner>/gateflow@v1
[dry-run] 步骤 4：打印 GitHub MCP 与 Skills 安装提示（只提示，不代劳）。
                                          ← 脚本收尾提示沿用 V0 文案；V1 中 MCP 提示已过时，
                                            忽略即可（正确步骤见本指南第 6~9 章）
```

> 若步骤 3 显示 *"该文件已存在：将警告并跳过，绝不覆盖"*，说明当前目录已有同名 workflow——脚本不会动它，确认这是否符合预期（要换引用请手工编辑，见第 11 章 FAQ-6）。

### 步骤 2.3 真跑（去掉 --dry-run）

```bash
node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target \
  --token "$GITHUB_TOKEN" --action-ref jesongit/gateflow@v1
# 模式 C 则改为： --action-ref ./.github/actions/gateflow
```

预期输出：

```text
== gateflow bootstrap ==
目标仓库：owner/target
Action 引用：jesongit/gateflow@v1

步骤 1/3：校验 token 与仓库…
[ok] 仓库可访问：owner/target
                                          ← 私有目标仓库会多一行 [ok] 私有仓库：…
                                          ← token 无写权限会出 [warn] …创建标签将失败

步骤 2/3：创建 ai:* 标签（已存在的同名标签跳过，绝不修改）…
[create] 标签已创建：ai:planning（#d4c5f9）
…（共 6 行；已存在的显示 [skip] 标签已存在，不做任何修改：…）

步骤 3/3：workflow 文件（已存在则警告跳过，绝不覆盖）…
[confirm] 将创建 <当前目录>\.github\workflows\ai-workflow.yml（uses: jesongit/gateflow@v1），是否继续？[Y/n]
                                          ← 交互确认：回车或 y 继续，n 取消（取消则不生成文件，标签已建不受影响）
[create] workflow 文件已生成：<当前目录>\.github\workflows\ai-workflow.yml

收尾提示（以下步骤需要你手动完成，本脚本不代劳）：…
```

两个行为细节：

- **非交互终端**（如管道、CI）：无法询问确认，脚本会打印 `[warn] 当前不是交互式终端，无法询问确认：跳过 workflow 文件生成` 并跳过生成——**标签仍会创建**。请在终端里重跑一次拿到 workflow 文件；
- 中途报错（如 401 / 404）时脚本打印 `[error] …` 与 `已中止：未完成的步骤可在修复问题后重新运行（本脚本幂等）`，退出码 1。修复后直接重跑即可。

### 步骤 2.4 检查生成的 workflow 文件

打开生成的 `.github/workflows/ai-workflow.yml`（内容与 [templates/workflow.yml](../templates/workflow.yml) 一致，仅 `uses:` 换成了你传的引用）。结构如下，逐段说明：

```yaml
name: AI Workflow Gate

# 监听事件（与 protocol.md §8 事件矩阵一致）：
#   issues  [opened, labeled, closed]  —— Issue 创建 / 打标 / 关闭
#   issue_comment [created, edited]    —— 主处理路径：命令（/approve 等）与 Marker（Plan / Tracker / Report）
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
        # V1：owner/gateflow@v1（必须按第 2 章发布 / 开策略后才解析成功）
        # 模式 C：./.github/actions/gateflow（本地路径，action 本体已复制进本仓库）
        uses: jesongit/gateflow@v1
        with:
          # 缺省 = workflow 自己的 ${{ github.token }}，无需配置 secret
          github-token: ${{ github.token }}
          # 额外可信的人类账号（逗号分隔，如 alice,bob）；留空 = 仅 repo owner
          trusted-humans: ''
          # V1 必填场景：Driver 的 Bot 身份（如 gateflow-agent[bot]），见第 5 章
          trusted-agents: ''
```

### 步骤 2.5 commit + push

```bash
git add .github/workflows/ai-workflow.yml
git commit -m "ci: adopt GateFlow AI workflow gate"
git push
```

> **push 被拒的常见原因**：含 workflow 文件的提交，用 HTTPS + PAT 推送时要求 PAT 具备 workflow 权限——classic PAT 勾选 **`workflow`** scope，fine-grained PAT 则需要 **Workflows: Read and write**（外加 Contents 读写）。否则报错形如 *"refusing to allow a Personal Access Token to create or update workflow … without workflow scope"*。SSH 方式推送不受此限制。排查详见第 11 章 FAQ-5。
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
| `--action-ref <ref>` | `jesongit/gateflow@v0` | workflow 中 `uses:` 的 Action 引用（不能含空白字符；V1 建议传 `@v1`，模式 C 传 `./.github/actions/gateflow`） |
| `--workflow-file <name>` | `ai-workflow.yml` | 生成的 workflow 文件名（不含路径的 `.yml` / `.yaml` 文件名） |
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

在目标仓库检出目录新建 `.github/workflows/ai-workflow.yml`，内容与 [templates/workflow.yml](../templates/workflow.yml) 完全一致（把 `uses:` 换成你第 2 章选定的引用，V1 建议 `@v1`；逐段说明见步骤 2.4）：

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
        uses: jesongit/gateflow@v1    # 模式 A/B：你的 owner/gateflow@v1；模式 C：./.github/actions/gateflow
        with:
          github-token: ${{ github.token }}
          trusted-humans: ''
          trusted-agents: ''          # V1：填 Driver 的 Bot 身份（第 5 章）
```

### 4.3 push 并验证

```bash
git add .github/workflows/ai-workflow.yml
git commit -m "ci: adopt GateFlow AI workflow gate"
git push
```

验证同步骤 2.6。push 的 workflow 权限提醒同步骤 2.5。

---

## 5. 第三步：配置 Action 输入

Action 共三个输入（定义见 [action.yml](../action.yml)，权限模型见 [protocol.md](protocol.md) §6）。生成的 workflow 里三项都已显式写出（默认值），**第一次接入至少要改 `trusted-agents`**（见下）；`github-token` 与 `trusted-humans` 可先保持默认，跑通验收后再按需调整：

### `github-token`：保持默认即可

模板写的是 `github-token: ${{ github.token }}`——这是 **GitHub Actions 自动注入的 workflow token**，随 workflow 运行自动生成与回收，配合上方的 `permissions: issues: write, contents: read` 正好够 Gate 读标签、写标签、加 reaction。**你不需要在仓库 Secrets 里配任何 PAT**。只有当你的仓库策略限制默认 token 权限时才需要换成 PAT secret，常规使用不要动。

### `trusted-humans`：除了你之外，还有谁能发命令

- **何时填**：仓库有协作者，且你希望他们也能执行 `/ai-plan`、`/approve`、`/choose`、`/change`、`/cancel` 时。
- **格式**：逗号分隔的 GitHub login，如 `trusted-humans: 'alice,bob'`。
- **默认行为**：留空 = 只有 **repo owner**（个人仓库即你）是 Trusted Human。
- **V1 注意**：这份名单同时被 Driver 使用——`gateflow.config.yml` 的 `trusted_humans` 字段应填同一批人（Driver 在派发 Executor 前独立校验 `/approve <id>` 评论的作者时用它），见第 7 章。

### `trusted-agents`：登记 Driver 的 Bot 身份（V1 必填场景）

**V1 语义**：Trusted Agent = **受控 GateFlow Driver 的 GitHub Identity**，而不是"AI 直接操作 GitHub 的身份"。Driver 以这个身份发布 Plan / Tracker / Completion 评论；Gate 只认可发布者 ∈ Trusted Human ∪ Trusted Agent 的 marker 评论（T1 / T3 / T6）——**不登记，Driver 发的 Plan 评论就只是普通文本，状态永远停在 `ai:planning`**。

- **它永远不能执行命令**：即使有人诱导 Bot 发 `/approve`，也等价于普通评论。命令权只在 Trusted Human 手里；
- **凭证不归 AI**：该身份的 token 只存在于 Driver 进程（`GITHUB_TOKEN`），Agent 接触不到。

配置步骤：

1. 准备一个专用 Bot 身份：独立 GitHub 账号，或 GitHub App（对应的 comment 作者形如 `gateflow-agent[bot]`）；
2. 为它生成 token，作为 Driver 进程的 `GITHUB_TOKEN`（第 8 章）；
3. workflow 里登记（与 token 所属账号一致）：

   ```yaml
   trusted-agents: 'gateflow-agent[bot]'
   ```

4. 效果：Driver 发布的 Plan / Tracker / Report 评论能触发状态迁移（T1 / T3 / T6）；`gateflow-agent[bot]` 评论 `/approve` **永远无效**。

| | Trusted Human（`trusted-humans`） | Trusted Agent（`trusted-agents`，V1 = Driver 身份） |
| --- | --- | --- |
| 能否**发命令**（`/approve` 等 5 个） | **能**（且只有它能） | **永远不能**——发了也不被解析，等价于普通评论 |
| 能否**发 Marker 推进状态**（触发 T1 / T3 / T6） | 能 | 能（这是它唯一的职权；V1 中即 Driver） |
| 典型身份 | 你、你的协作者 | `gateflow-agent[bot]` 等专用 Bot |

---

## Part 2 · Driver + Workspace 接入（本地侧，V1 新增）

## 6. 第四步（1/4）：构建本地 Driver

Driver 是本地确定性 CLI（`src/driver/`，产物 `dist/cli.js`，bin 名 `gateflow`）。在 GateFlow 本地检出里构建：

```bash
cd /path/to/gateflow
npm install
npm run build:cli        # esbuild 打包 src/cli.ts → dist/cli.js
```

- 运行方式二选一：`node /path/to/gateflow/dist/cli.js driver …`，或将 `gateflow` 链接到 PATH（`package.json` 已声明 `"bin": {"gateflow": "dist/cli.js"}`）；
- CLI 契约：`gateflow driver start|once|status|retry <dispatchId>`，全局 flags `--root <dir>`（缺省 = 当前目录）与 `--config <file>`（缺省 = `<root>/gateflow.config.yml`）；完整参考见 [driver.md](driver.md) §5；
- `npm run build` 会同时构建 Gate 与 Driver 两个产物，两者都必须提交在 GateFlow 仓库中（`npm run check:dist` 校验同步）。

## 7. 第四步（2/4）：写 `gateflow.config.yml`

在**目标仓库的检出根目录**创建 `gateflow.config.yml`。以下即 [workspace-protocol.md](workspace-protocol.md) §10 的冻结示例：

```yaml
version: 1
repository: owner/name            # 可省略：回退解析 git remote origin，再回退 GATEFLOW_REPOSITORY
driver:
  poll_interval_seconds: 30       # start 模式轮询间隔
  workspace_dir: .gateflow
  progress_sync_seconds: 60       # Tracker 编辑 debounce
  max_attempts: 3                 # 同一 dispatch 自动重试上限
trusted_humans: []                # 除 repo owner 外的 Trusted Humans（Driver 校验 Approval 用）
routing:
  consumer: chatgpt-main
  executor: zcode-main
agents:
  chatgpt-main: { activation: chatgpt }
  zcode-main:   { activation: zcode }
activation:
  fallback: manual
```

字段说明（完整参考见 [driver.md](driver.md) §3）：

- **Role 与 Provider 分离**：`routing` 把角色路由到 `agents` 里定义的任意 agent——`consumer: zcode-main` + `executor: chatgpt-main` 同样合法；
- `agents.<name>.activation` 取值 `manual | chatgpt | zcode`；adapter probe 失败时回退 `activation.fallback`；
- `trusted_humans` 与 workflow 的 `trusted-humans` 保持同一份名单（Driver 校验 `/approve <id>` 作者时使用）；
- 同时确认目标仓库的 `.gitignore` 已包含 `.gateflow/`（运行时目录，不入库）。

## 8. 第四步（3/4）：配置 `GITHUB_TOKEN`

```bash
export GITHUB_TOKEN=ghp_xxx        # Driver 专用 token（见第 1 章权限建议）
```

三条铁律：

1. **只存在于 Driver 进程环境**——不写入任何文件、不进 `gateflow.config.yml`、不进 `.gateflow/`、不给 AI 客户端；
2. **Agent 零凭证**：ChatGPT / ZCode 不需要（也不应该有）任何 GitHub token / MCP——这是 V1 与 V0 的本质区别；
3. **身份即登记**：`GITHUB_TOKEN` 所属的账号就是 Driver 发评论用的身份，必须与 workflow 的 `trusted-agents` 登记一致（第 5 章），否则 marker 不触发迁移。

## 9. 第四步（4/4）：安装四个 Agent Skills

把本仓库的四个 Skill 装入你的 AI 客户端（ChatGPT / ZCode 等；每个 Skill 是一个目录，目录名即 Skill 名）：

```bash
# 以客户端的项目级 skills 目录为例（按你所用客户端的约定放置；全局安装则复制到全局目录）
mkdir -p /path/to/your-client/skills
cp -r /path/to/gateflow/skills/agent    /path/to/your-client/skills/
cp -r /path/to/gateflow/skills/consumer /path/to/your-client/skills/
cp -r /path/to/gateflow/skills/executor /path/to/your-client/skills/
cp -r /path/to/gateflow/skills/producer /path/to/your-client/skills/
```

| Skill | 作用 |
| --- | --- |
| `skills/agent` | 通用基础：如何找到当前 Dispatch（`current.json` → inbox）、`.gateflow/` 读写纪律、汇报规则、注入防护 |
| `skills/consumer` | 规划角色：读 TASK.md / FEEDBACK.md 与真实仓库 → 产出 `outbox/PLAN.md`，`result=plan_ready` |
| `skills/executor` | 执行角色：严格按 inbox 的 PLAN.md 实现 + 真实验证 → `REPORT.md`，`result=completed` |
| `skills/producer` | 起草任务；用户明确要求时写 `.gateflow/submit/` 本地提交请求（Driver 负责 建 Issue） |

装完新开会话让客户端重新加载。**验证方式**：对 Agent 说"看看有没有 GateFlow 任务"——正确行为是读 `.gateflow/current.json`，没有就如实说没有；若它试图访问 GitHub 或要求配 token，说明装的是 V0 旧 Skill（V1 Skill 禁止一切 GitHub 访问，见 [agent-skills.md](agent-skills.md)）。

## 10. 第五步：验收——跑通第一个 Driver + Agent 闭环

冒烟测试逐条做，每步对照"你应该看到什么"。以下假定目标仓库 `owner/target`、Issue 编号 `#N`、检出目录 `/path/to/target-checkout`。**全程不需要 GitHub MCP**；闭环跑完建议关掉测试 Issue。

### 10.1 让测试 Issue 进入工作流（`ai:planning`）

- **操作**：在 GitHub 上手动新建一个测试 Issue（标题随意，如"GateFlow V1 冒烟测试"），评论一条命令（**整条评论只写这五个字符**）：

  ```text
  /ai-plan
  ```

- **你应该看到**：几秒后该命令评论出现 **✅ reaction**，Issue 标签变为 **`ai:planning`**；Actions 页出现一条绿色 run。

### 10.2 Driver 单轮执行：`once` → inbox 出现

- **操作**：在目标仓库检出目录（`GITHUB_TOKEN` 已导出、`gateflow.config.yml` 已就位）：

  ```bash
  gateflow driver once
  ```

- **你应该看到**：Driver 日志显示发现 `ai:planning` 并派发 Consumer；`.gateflow/inbox/gf_r<repo_id>_i<N>_consumer_01/` 目录出现，内含 `dispatch.json`、`TASK.md`（Issue 标题 + 正文 + `## Goal`），`current.json` 指向该 dispatch。Issue 标签**不变**（派发不迁移状态）。

### 10.3 Agent 规划：读 inbox → 写 outbox

- **操作**：打开装有 consumer Skill 的客户端（ChatGPT / ZCode），让它开始当前任务（`manual` 激活模式即"人打开客户端"这一步）。
- **你应该看到**：Agent 读 `current.json` → `dispatch.json` → `TASK.md` 与真实仓库，把 Execution Plan 写进 `.gateflow/outbox/gf_r…_consumer_01/PLAN.md`，最后写 `result.json`（`result=plan_ready`）。**Agent 全程不碰 GitHub**。

### 10.4 Driver 再跑一轮：Plan 评论出现（`ai:review`）

- **操作**：再次 `gateflow driver once`。

- **你应该看到**：Driver 校验 outbox（schema / role / dispatch_id / 白名单）通过后，以 Driver Bot 身份（如 `gateflow-agent[bot]`）发布一条以 `<!-- ai-workflow:plan:v1 -->` 开头的 **Plan 评论**；Actions 页出现新的绿色 run；Issue 标签自动变为 **`ai:review`**（Gate 检测 marker 触发 T1）。**记下这条 Plan 评论的 id**（评论 URL 末尾数字），下一步要用。

  > 若 Plan 评论已发布但标签**没有**变 `ai:review`：检查 workflow 的 `trusted-agents` 是否登记了 Driver Bot 身份（第 5 章）——未登记时 marker 不触发迁移（第 11 章 FAQ-9）。

### 10.5 批准（`ai:ready`）

- **操作**：在 Issue 下评论（整条评论只写这一句，`<plan-comment-id>` 换成 10.4 记下的 id）：

  ```text
  /approve <plan-comment-id>
  ```

- **你应该看到**：该评论获得 **✅ reaction**，标签变为 **`ai:ready`**（Gate T2）。

### 10.6 Driver 派发 Executor：Tracker 与执行（`ai:working`）

- **操作**：让 Executor 角色的 Agent 可用后，再次 `gateflow driver once`。

- **你应该看到**：Driver 在派发前独立校验 Approval Proof（`ai:ready` + 有效 `/approve <id>` + id 指向 Current Plan + Plan 未被编辑）→ 构建 `.gateflow/inbox/gf_r…_i<N>_executor_p<plan-comment-id>/`（TASK.md + PLAN.md）→ Agent 写 `status.json`（`state=working`）→ Driver 创建以 `<!-- ai-workflow:execution-tracker:v1 -->` 开头的 **Execution Tracker 评论**；标签变为 **`ai:working`**（Gate T3）。此后 Agent 更新 PROGRESS，Driver 以默认 60s debounce 编辑同一条 Tracker。

### 10.7 完成报告与收尾（`ai:done` → Close）

- **操作**：等 Executor 完成（可先给它一个极小任务，如"在 README 加一行测试段落"）。

- **你应该看到**：Agent 写 `REPORT.md` + `result.json`（`completed`）→ Driver 校验后发布以 `<!-- ai-workflow:completion-report:v1 -->` 开头的 **Completion Report 评论**；标签变为 **`ai:done`**（Gate T6）。**Issue 保持 Open**——你检查 Report / 变更无误后，**手动 Close 这个 Issue**。闭环完成。

### 10.8 常驻运行与可选负面用例

- 日常使用把每一步的 `once` 换成常驻的 `gateflow driver start`（默认每 30s 一轮），以上迁移全部自动发生；
- **负面用例**：用非 Trusted Human 账号评论 `/approve <id>` → 该评论得 **👎 reaction**、标签不迁移、Gate run 依然绿色（拒绝是正常业务结果）；
- 更多排障见第 11 章 FAQ 与 [driver.md](driver.md) §9。

---

## 11. 故障排查 FAQ

**FAQ-1 workflow 完全没触发（Actions 页没有 run）**
现象：评论了 `/ai-plan` / Driver 发了 Plan，Actions 页干干净净。
原因与解决（按概率排序）：① workflow 文件没推上去，或推到了非默认分支——`issues` / `issue_comment` 事件只认**默认分支**上的 workflow 定义；② 仓库 Settings → Actions 里 Actions 被禁用；③ YAML 语法错误导致 workflow 加载失败。逐一检查后重发一条评论验证。

**FAQ-2 Gate run 红叉**
现象：Actions 页 run 失败。
原因：Gate 对无效命令 / 错误状态一律 no-op 并**正常退出**（不会红叉），红叉一定是运行时故障而非业务拒绝。点开 run 看 log（首行应为 `gateflow <GATE_VERSION>`）：常见原因有 `uses:` 解析失败（见 FAQ-3）、API 限流或 token 权限不足、workflow YAML 非法。修复后可重跑该 run（Gate 幂等：迁移前会重读标签，不会二次迁移）。

**FAQ-3 `uses:` 解析失败 / "Can't find action" / 404 Resource not found**
原因：`uses: owner/gateflow@v1` 指向的仓库不存在、**还是 private 且未开 Access 共享策略**（默认 "Not accessible" 就是被禁）、或 `v1` tag 不存在。
解决：回到第 2 章三模式自查——模式 A 确认仓库 public 且 `v1` tag 已推；模式 B 确认 Access 已开且**目标仓库也是私有**；模式 C 确认 `.github/actions/gateflow/{action.yml,dist/index.js}` 已提交且与 workflow 同 commit。

**FAQ-4 bootstrap 报错（401 / 404 / 网络等）**
- `[error] token 无效或已过期（HTTP 401）`：token 抄错 / 已撤销，重新生成；
- `[error] 仓库不存在或 token 无权访问（HTTP 404）`：`--repo` 拼写错，或 fine-grained PAT 没勾选目标仓库；
- `[error] 创建标签失败：…（HTTP 403）`：token 缺 Issues 写权限；
- `[warn] 当前不是交互式终端…`：非交互环境跳过 workflow 生成（标签仍创建），在终端重跑一次；
- `[error] 缺少 GitHub token…` / `缺少目标仓库…`：参数没传或环境变量没设（**`--dry-run` 也要求**）。

**FAQ-5 push workflow 文件被拒**
现象：`git push` 报 `refusing to allow a Personal Access Token to create or update workflow … without workflow scope`。
解决：classic PAT 勾 **`workflow`** scope；fine-grained PAT 加 **Workflows: Read and write**（外加 Contents 读写）。改完 PAT 更新本地凭据；改用 SSH remote 则不受此限。

**FAQ-6 标签没建出来 / 建错了 / 想换 `uses:` 引用**
- `[skip] 标签已存在`：按设计跳过且绝不修改；颜色 / 描述可在 GitHub 界面手工改；
- 名称写错（漏 `ai:` 前缀等）：删掉重建，名称必须与 protocol.md §1 逐字一致；
- 已生成的 workflow 想换 `uses:` 引用（如 `@v0` → `@v1`）：直接编辑该文件的 `uses:` 行并 push（bootstrap 绝不覆盖已有文件）。

**FAQ-7 AI 说它改不了标签 / 你想让 AI 直接操作 GitHub**
这是**设计使然**，不是故障：V1 的 Agent 没有 GitHub 凭证、不参与状态迁移；标签只由 Gate 写，GitHub 访问只由 Driver 做。正确姿势：让 Agent 写好 outbox，Driver 负责同步，你发命令推动状态。若某次迁移没发生，看 Actions 页 run 与 Issue 评论（Gate 的拒绝是静默 no-op 或 👎）。

**FAQ-8 `gateflow driver once` 没有任何派发**
按顺序检查：① `GITHUB_TOKEN` 是否已导出且有效（`driver status` 离线可用，先看本地回执）；② `gateflow.config.yml` 的 `repository` / git remote 是否指向目标仓库；③ Issue 是否真的处于会触发派发的状态（`ai:planning`；或 `ai:ready` 且批准有效）；④ `--root` 是否指向目标仓库检出目录；⑤ receipts 里该 dispatch 是否已 `synced`（去重生效，重复派发需 `gateflow driver retry <dispatch_id>`）。详见 [driver.md](driver.md) §9。

**FAQ-9 Driver 发了 Plan / Tracker / Report 评论，但标签不变**
原因：Driver 的 Bot 身份没有登记进 workflow 的 `trusted-agents`（或登记的账号与 `GITHUB_TOKEN` 所属账号不一致）——Gate 把 marker 评论当普通文本，不触发 T1 / T3 / T6。解决：按第 5 章登记后重试（已发布的评论不会追溯触发，让 Driver 走完下一轮即可）。

**FAQ-10 `.gateflow/` 出现在 `git status` 里**
`.gateflow/` 是本地运行时目录（inbox / outbox / receipts / logs），**必须加入 `.gitignore`**。它不是正式状态——即使被误删，Driver 也能从 GitHub 重建；被误提交则应从索引移除并补 `.gitignore`。

---

## 12. 卸载 / 回退

- **停用 Gate**：删除（或重命名）目标仓库的 `.github/workflows/ai-workflow.yml` 并 push——Gate 即不再运行。这是唯一的"开关"；
- **停用 Driver**：终止 `gateflow driver start` 进程即可；`.gateflow/` 目录可整目录删除（全部可由 GitHub 重建），`gateflow.config.yml` 一并删除即完全移除本地接入；
- **标签**：6 个 `ai:*` 标签可以留着（普通 GitHub 标签，不影响其他 Issue），也可在 Labels 页删除；删除后再接入重跑 bootstrap 即可；
- **已完成的 Issue**：状态不受任何影响；仍带 `ai:*` 标签的未关闭 Issue 可由 Trusted Human 评论 `/cancel`（Gate 停用后改为手工删标签）；
- **AI 侧**：删除客户端 skills 目录下的 `agent / consumer / executor / producer` 四个目录即完全移除；
- **模式 C 的内嵌副本**：删除 `.github/actions/gateflow/` 目录一并提交。

---

## 附录：MCP 直连（旧模式，V1 不再需要）

V0 的接入要求给 AI 配置官方 GitHub MCP Server（远端 `https://api.githubcopilot.com/mcp/` + PAT + `X-MCP-Toolsets: repos,issues,pull_requests`），由人对 AI 说"规划 / 执行 #<n>"手动唤醒，Agent 直接读写 GitHub。**V1 中这套配置不再需要，也不再是标准架构**：

- V1 的 Agent 只读写本地 `.gateflow/`（inbox / outbox），GitHub 访问全部由 Driver 完成——给 Agent 配 MCP / PAT 不仅多余，还违反"Agent 零凭证"的 V1 安全模型（见 [security.md](security.md) §8.1）；
- V1 的四个 Skill 已删除全部 GitHub 集成知识；带着 MCP 配置跑 V1 Skill 不会让 Agent"恢复"GitHub 能力，只会制造干扰；
- 保留它的唯一场景是**孤立调试 Gate**（不启动 Driver，人工构造命令 / marker 验证 Gate 判定），且需自行承担 actor 身份混同与绕过 Workspace Protocol 的代价（[usage.md](usage.md) 附录）。新接入请一律走 Part 2 的 Driver + Workspace 流程。
