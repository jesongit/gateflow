# 使用手册（Usage）

> 本页先提供**协议速查表**（已冻结）；"安装"章节给出把工作流接入新项目的四步流程（bootstrap 脚本 → workflow 模板 → GitHub MCP → Skills）；"日常使用"章节是场景 A~J 的中文操作手册（每个场景：你做什么 → 谁响应 → 状态怎么变）。
> 完整协议见 [protocol.md](protocol.md)。

## 1. 协议速查表

### 1.1 命令（Issue 评论，整条评论只写命令）

| 命令 | 示例 | 谁能用 | 何时 | 效果 |
| --- | --- | --- | --- | --- |
| `/ai-plan` | `/ai-plan` | Trusted Human（默认 repo owner） | 无 `ai:*` 标签的 Issue | 进入 `ai:planning`，AI 开始规划 |
| `/approve` | `/approve` | Trusted Human | `ai:review` | 批准 Plan，进入 `ai:ready` |
| `/choose` | `/choose 1 B` | Trusted Human | `ai:review` | 选择"问题 1 的选项 B"，Consumer 出新版 Plan |
| `/change` | `/change 还需要考虑离线安装` | Trusted Human | `ai:review` | 要求修改，Consumer 只改受影响部分出 Plan vN+1 |
| `/cancel` | `/cancel` | Trusted Human | 任一 `ai:*` 状态 | 移除全部 `ai:*` 标签退出工作流（不关闭 Issue） |

解析规则要点：命令必须独占整条评论（trim 后全等 / 锚定匹配）；大小写敏感；非 Owner 静默忽略；Owner 姿势错误不产生状态迁移。

### 1.2 状态标签

```text
ai:planning → ai:review → ai:ready → ai:working → ai:done
                                     ↕
                               ai:blocked
```

| 标签 | 含义 | 你要做什么 |
| --- | --- | --- |
| `ai:planning` | Consumer 正在分析 / 补设计 | 等待 Plan，或手动对 AI 说"规划 #N"（V0 无自动唤醒） |
| `ai:review` | Plan 待审批 | 读 Plan → `/approve`，或 `/change` / `/choose` |
| `ai:ready` | 已批准，待执行 | 对 AI 说"执行 #N"（V0 手动触发） |
| `ai:working` | 执行中 | 看 Execution Tracker 的实时进度 |
| `ai:blocked` | 执行被阻塞 | 看 Tracker 的 Notes，必要时介入 |
| `ai:done` | AI 完成，待你检查 | 检查 Report / PR / Tests → 手动 Close Issue |

### 1.3 Markers（一般无需手写，供机器识别）

| Marker | 位置 | 含义 |
| --- | --- | --- |
| `<!-- ai-workflow` `schema/source/kind/maturity_hint` 块 | Issue body 末尾 | Producer 创建的 Work Item 元信息 |
| `<!-- ai-workflow:append:v1 -->` | Comment | Producer 追加的讨论（只新增不改历史） |
| `<!-- ai-workflow:plan:v1 -->` | Comment | Execution Plan（修订 = 新版本新评论） |
| `<!-- ai-workflow:execution-tracker:v1 -->` | Comment | Execution Tracker（实时 Todo，允许编辑） |
| `<!-- ai-workflow:completion-report:v1 -->` | Comment | 最终完成报告 |

> Marker 只是结构标记，永远不能当权限证明。

### 1.4 成熟度（Consumer 依据）

`L0 Requirement`（只有想法）→ Consumer 全程规划；`L1 Direction`（有方向）→ 验证方向补全；`L2 Solution`（方案已定）→ 只补遗漏不重新选型；`L3 Execution Plan`（完整计划）→ Readiness Check 后直接进入待审批，禁止重新设计。

## 2. 安装（接入新项目的四步流程）

> 一键入口是 [scripts/bootstrap.mjs](../scripts/bootstrap.mjs)：零新增依赖（Node ≥ 20 自带 fetch），**幂等，可重复执行**。
> 它只做三件事：创建缺失的 `ai:*` 标签、生成缺失的 workflow 文件、打印剩余手动步骤。
> **不覆盖保证**：已存在的同名 labels 一律跳过（颜色 / 描述一字不改）；`.github/workflows/` 下同名 workflow 文件已存在时警告并跳过（绝不覆盖）；已有 issue templates 与 PR workflow 完全不触碰。

### Step 1：运行 bootstrap

把本仓库（gateflow）与目标仓库都检出到本地，然后**在目标仓库的检出目录里**运行（workflow 文件会写入当前目录）：

```bash
# 最简形式：token 走 GITHUB_TOKEN 环境变量
node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target

# 显式传 token 与 Action 引用（Action 发布前 / fork 场景）
node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target \
  --token <token> --action-ref owner/gateflow@v0

# 先看看会做什么（只打印，不做任何修改、不访问网络）
node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target --dry-run
```

| 参数 | 缺省 | 说明 |
| --- | --- | --- |
| `--repo owner/name` | `GITHUB_REPOSITORY` 环境变量 | 目标仓库 |
| `--token <token>` | `GITHUB_TOKEN` 环境变量 | 需要目标仓库写权限（创建标签）；两者都没有时报错退出 |
| `--action-ref <ref>` | `jesongit/gateflow@v0` | workflow 中 `uses:` 的引用（Phase 9 发布时以实际 owner 为准，可参数覆盖） |
| `--workflow-file <name>` | `ai-workflow.yml` | 生成的 workflow 文件名 |
| `--dry-run` | 关 | 只打印将做什么 |
| `--help` | — | 打印用法 |

幂等性来源：标签创建前先拉取已有标签列表做同名比对（GitHub API 侧再加 422 兜底）；workflow 文件用 `existsSync` + 独占写入（`wx`）双保险，且生成前需要交互确认（非交互终端直接跳过，绝不默默写文件）。重复运行只会看到一串 `[skip]`。

### Step 2：workflow 文件（bootstrap 生成的内容）

生成物就是 [templates/workflow.yml](../templates/workflow.yml)，要点：

- **事件**：`issues [opened, labeled, closed]` + `issue_comment [created, edited]`——与协议第 8 节事件矩阵一致（不监听 `reopened`，V0 不处理）；
- **权限**：`issues: write`（Gate 写 `ai:*` 标签与 reaction）、`contents: read`；
- **串行保证**：`concurrency.group: ai-workflow-<issue_number>` + `cancel-in-progress: false`——同一 Issue 的所有 Gate run 排队执行（协议第 7 节）。Gate 在每次迁移前仍会通过 API 重读 labels 做最终校验，但串行化本身由这个并发组保证，**请不要删除**；
- **`uses:` 占位**：`jesongit/gateflow@v0`（Phase 9 发布时以实际 owner 为准；bootstrap `--action-ref` 可替换）；
- **显式输入**：`trusted-humans` / `trusted-agents` 默认为空 = 仅 repo owner 可执行命令、无 Trusted Agent（语义见模板内注释与 [protocol.md](protocol.md) 第 6 节；Owner PAT 直连 MCP 的快速自用模式下无需设置）。

提交并推送该文件后，Gate 即对目标仓库生效。

### Step 3：配置 GitHub MCP（手动）

在你的 AI Client（Codex / Claude Code / Cursor / VS Code 等）配置 GitHub 官方 MCP Server：

- 最小 toolsets：`repos` / `issues` / `pull_requests`——覆盖 Producer 创建 Issue、Consumer 读仓库 / 发 Plan、Executor 创建 PR 的需要；
- 只使用 Producer / Consumer（不执行）时，可进一步收紧到只读 + issues 写；
- 不要把全部 toolsets 打开给 AI；快速自用模式可直接用你的 PAT，长期建议给 AI 独立 Bot 身份（见 [protocol.md](protocol.md) 第 6 节）。
- 参考：<https://github.com/github/github-mcp-server>

### Step 4：安装三个 Skills（手动）

把 [skills/producer](../skills/producer/SKILL.md)、[skills/consumer](../skills/consumer/SKILL.md)、[skills/executor](../skills/executor/SKILL.md) 安装到你的 AI Client（全局安装或项目级引用均可）。

完成后即可进入 [§3 日常使用](#3-日常使用)：和 AI 聊完说一句"发成 Issue"，或在已有 Issue 上评论 `/ai-plan`，然后 `/approve` → "执行 #N"。

## 3. 日常使用

### 3.0 V0 现实：手动触发（先读这段）

Gate 只管权限与状态迁移，**Label 变化不会自动唤醒 AI**（V0 没有 Consumer Driver）。所以有两类动作：

| 动作类型 | 你在哪里做 | 例子 |
| --- | --- | --- |
| **Gate 命令**（确定生效） | GitHub Issue 评论 | `/ai-plan`、`/approve`、`/choose 1 B`、`/change xxx`、`/cancel` |
| **对 AI 说话**（手动唤醒 Skill） | 你的 AI Client（对话里） | "规划 gamer#123"、"执行 gamer#123" |

在 `ai:planning` / `ai:ready` 状态下，需要人手动说一句"规划 <repo>#<n>"或"执行 <repo>#<n>"AI 才动。这是 V0 的刻意取舍：先验证工作流本身好用，再解决自动唤醒。另外，`/change`、`/choose` 被 Gate 接受（✅）后**不迁移状态、也不唤醒 AI**——需要再对 AI 说一句"按 gamer#123 的 /change（/choose）意见更新 Plan"。

### 3.1 场景速查表（A~J）

| 场景 | 你做什么 | 谁响应 | 状态变化 |
| --- | --- | --- | --- |
| A 聊完发 Issue | "把刚才讨论整理成 gamer 的 Issue" → 确认 Draft | Producer（GitHub MCP） | 无 → `ai:planning` |
| B 模糊想法 | "规划 gamer#123" → 读 Plan → `/approve` | Consumer → Gate | `ai:planning` → `ai:review` →（`/approve`）→ `ai:ready` |
| C 方案聊得差不多 | 同 B（Producer 会给 `maturity_hint: solution`） | Consumer | 同 B，但 Consumer 只补遗漏不重新选型 |
| D 已有完整计划 | 同 B | Consumer（只做 Readiness Check） | 同 B |
| E 别人提交 Bug | 值得处理 → Issue 里评论 `/ai-plan` → "规划 gamer#123" | Gate → Consumer | 无 → `ai:planning` → `ai:review` |
| F Plan 要改 | 评论 `/change <要求>` → "按 /change 意见更新 gamer#123 的 Plan" | Gate（✅）→ Consumer | 状态不变，出 Plan vN+1 |
| G Plan 有选择 | 评论 `/choose 1 B` → 手动唤醒 Consumer | Gate（✅）→ Consumer | 状态不变，出收敛后的 Plan vN+1 |
| H 批准后执行 | 评论 `/approve` → "执行 gamer#123" | Gate → Executor | `ai:review` → `ai:ready` →（tracker）→ `ai:working` |
| I 查看进度 | 打开 Issue 看 Tracker 勾选与 Status | （无人响应，GitHub 自身可见） | — |
| J 完成 | 检查 Report / PR / Tests → Close Issue | Executor 已结束，你来收尾 | `ai:working` → `ai:done`（终态，Issue 仍开） |

### 3.2 场景详解

#### 场景 A：你先和 AI 聊，再发布 Issue

- **你做**：和 AI 正常讨论需求；讨论结束后说"把刚才讨论整理成 gamer 的 Issue"。
- **谁响应**：Producer——从对话提炼 Draft（目标仓库、标题、kind、maturity_hint、完整 body），给你确认；你确认后才通过 GitHub MCP 创建 Issue，并在 body 末尾写入 schema 块、给 Issue 打上 `ai:planning`。
- **状态**：无 → `ai:planning`。
- 提醒：Producer 只在你明确要求时发布，不会自己判断"聊得差不多了"替你发 Issue；写完即停，后续规划要你手动启动（见场景 B）。

#### 场景 B：Issue 只有一个模糊想法

- **你做**：对 AI 说"规划 gamer#123"（Issue 需已处于 `ai:planning`）；等 Plan 出来后读一遍，满意就在 Issue 评论 `/approve`。
- **谁响应**：Consumer——读 Issue 与真实仓库，识别 L0，自己完成"分析问题 → 设计方案 → 生成执行计划"，发布带 plan marker 的 Plan Comment；**Gate** 检测到 plan marker 后迁移状态。
- **状态**：`ai:planning` → `ai:review` →（你 `/approve`）→ `ai:ready`。

#### 场景 C：你已经和 AI 把方案讨论得差不多

- **你做**：同场景 B（"规划 gamer#123"）。
- **谁响应**：Consumer——Producer 的 `maturity_hint: solution` 使其按 L2 处理：对照仓库验证方案、只补遗漏、生成执行计划。**不会**重新问"我们是否应该用 HTTP？"这类已定的选型。
- **状态**：同场景 B。

#### 场景 D：Producer 已经提交完整开发计划

- **你做**：同场景 B。
- **谁响应**：Consumer——识别 L3，只做 Readiness Check（逐条核对计划引用的模块 / 接口在真实仓库是否成立）加必要小修正，直接整理成待审批执行计划；**禁止重新设计整套方案**。
- **状态**：同场景 B。

#### 场景 E：别人提交 Bug

- **你做**：外部 Issue 默认是普通 GitHub Issue，AI 不自动处理。你觉得值得处理，就在该 Issue 评论 `/ai-plan`；Gate 验证你是 repo owner 后打标。然后再对 AI 说"规划 gamer#123"。
- **谁响应**：**Gate** 响应 `/ai-plan`（T0）；随后 Consumer 接手规划（同场景 B）。
- **状态**：无 → `ai:planning` → `ai:review`。

#### 场景 F：Plan 需要改

- **你做**：在 Issue 评论 `/change V1 暂时不要做自动更新，只保留手动更新`；Gate 会给该评论加 ✅。然后（V0 不会自动唤醒）对 AI 说"按 gamer#123 的 /change 意见更新 Plan"。
- **谁响应**：**Gate** 只校验命令并 ✅（不迁移状态）；**Consumer** 读取修改意见，只改受影响的 Plan 部分，发布 Plan v2。
- **状态**：保持 `ai:review`；Plan v2 是**新评论**，旧 Plan 不编辑、不覆盖。

#### 场景 G：Plan 有多个选择

- **你做**：Plan 的 Open Decisions 会按"问题号 + 选项字母"列出（如 `1. 更新方式：A 自动 / B 手动（推荐）/ C 两者都做`）。你评论 `/choose 1 B`，然后手动唤醒 Consumer（同场景 F）。
- **谁响应**：**Gate** 校验格式并 ✅；**Consumer** 把决定收敛进方案并发布新版 Plan；已决定的问题从 Open Decisions 移除或标记已决定。
- **状态**：保持 `ai:review`；出 Plan vN+1。

#### 场景 H：批准以后执行

- **你做**：Issue 评论 `/approve`（只有 Trusted Human 有效，由 Gate 判定）；然后对 AI 说"执行 gamer#123"。
- **谁响应**：**Gate** 执行 T2 迁移；**Executor** 读 Approved Plan、创建 Execution Tracker、按任务执行（Executor 细节见其 Skill 与 Phase 6/7 计划）。
- **状态**：`ai:review` → `ai:ready` →（tracker marker，T3）→ `ai:working`。

#### 场景 I：查看实时进度

- **你做**：不用问 AI"做到哪了"，直接打开 Issue 看 Execution Tracker：

```text
- [x] Manifest
- [x] Downloader
- [ ] Cache
- [ ] Integration
```

- **谁响应**：无人——进度就在 GitHub 上；执行受阻时 Issue 会出现 `ai:blocked`，看 Tracker 的 Notes。
- **状态**：`ai:working` ↔ `ai:blocked`（由 Tracker 的 Status 机器值驱动）。

#### 场景 J：完成

- **你做**：Executor 发布 Completion Report 后，检查代码 / PR / Tests / Report，确认无误后手动 Close Issue。
- **谁响应**：**Executor** 已发布带 completion-report marker 的报告，**Gate** 已迁 T6；最后一步（Close）永远是你。
- **状态**：`ai:working` → `ai:done`（终态，Issue 保持 Open，关闭即终态）。

### 3.3 命令与触发词速记

```text
和 AI 聊完发布：     “把刚才讨论整理成 <repo> 的 Issue”（Producer）
追加到已有 Issue：   “把这段方案追加到 #123”（Producer）
已有 Issue 入流程：  /ai-plan（Owner 在 Issue 评论）
启动规划：           “规划 gamer#123”（对 AI 说；Issue 须 ai:planning）
要求修改：           /change xxx → 手动唤醒：“按 /change 意见更新 gamer#123 的 Plan”
选择方案：           /choose 1 B → 手动唤醒同上
批准：               /approve（Trusted Human，Gate 判定）
取消：               /cancel（任一 ai:* 状态，退出工作流，不关闭 Issue）
启动执行：           “执行 gamer#123”（对 AI 说；Issue 须 ai:ready）
进度 / 完成：        看 Execution Tracker / Completion Report，最后手动 Close
```

三条安全底线（AI 永远做不到，也请你不要要求它做）：AI 不能批准 Plan（`/approve` 只有 Trusted Human 有效且由 Gate 判定）；AI 不能绕过 Gate 改状态（`ai:*` 标签迁移只在 Gate）；AI 不能编辑已发布的 Plan / 评论历史（修订永远是新评论）。
