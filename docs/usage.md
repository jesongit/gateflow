# 使用手册（Usage）

> 本页先提供**协议速查表**（Gate 协议冻结在 [protocol.md](protocol.md)）；"安装"章节是 V1 六步流程**摘要**（逐步的详细接入指南见 [integration.md](integration.md)）；"日常使用"章节是 V1（Driver 自动派发）场景 A~J 的操作手册；文末附录保留 V0 手动调试模式。
> Driver 的运行与运维细节见 [driver.md](driver.md)；Agent 侧见 [agent-skills.md](agent-skills.md)。

## 1. 协议速查表

### 1.1 命令（Issue 评论，整条评论只写命令）

| 命令 | 示例 | 谁能用 | 何时 | 效果 |
| --- | --- | --- | --- | --- |
| `/ai-plan` | `/ai-plan` | Trusted Human（默认 repo owner） | 无 `ai:*` 标签的 Issue | 进入 `ai:planning`，Driver 派发 Consumer 规划 |
| `/approve` | `/approve <plan-comment-id>`（**V1：Plan 绑定审批**，细节见 [protocol.md](protocol.md)） | Trusted Human | `ai:review` | 批准指定 Plan，进入 `ai:ready`；Driver 校验批准后派发 Executor |
| `/choose` | `/choose 1 B` | Trusted Human | `ai:review` | 选择"问题 1 的选项 B"，Driver 投影反馈并自动触发新一轮 Consumer |
| `/change` | `/change 还需要考虑离线安装` | Trusted Human | `ai:review` | 要求修改，Driver 投影反馈并自动触发新一轮 Consumer（出 Plan vN+1） |
| `/cancel` | `/cancel` | Trusted Human | 任一 `ai:*` 状态 | 移除全部 `ai:*` 标签退出工作流（不关闭 Issue） |

解析规则要点：命令必须独占整条评论（trim 后全等 / 锚定匹配）；大小写敏感；非 Trusted Human 静默忽略（实现为 👎 reaction，见 protocol.md 文末实现备注）；Trusted Human 姿势错误不产生状态迁移。

### 1.2 状态标签

```text
ai:planning → ai:review → ai:ready → ai:working → ai:done
                                     ↕
                               ai:blocked
```

| 标签 | 含义 | 你要做什么 |
| --- | --- | --- |
| `ai:planning` | Consumer 正在分析 / 补设计 | 无需操作——Driver 自动派发；`manual` 激活模式下按提示打开 Agent 客户端即可 |
| `ai:review` | Plan 待审批 | 读 Plan → `/approve <plan-comment-id>`，或 `/change` / `/choose`（Driver 自动触发重新规划） |
| `ai:ready` | 已批准，待执行 | 无需操作——Driver 独立校验 Approval Proof 通过后自动派发 Executor |
| `ai:working` | 执行中 | 看 Execution Tracker 的实时进度（Driver 以 debounce 同步 Agent 的 PROGRESS） |
| `ai:blocked` | 执行被阻塞 | 看 blocked 的 reason（Tracker / result），人工解决后用 `gateflow driver retry <dispatch_id>` 重派（见 [driver.md](driver.md)） |
| `ai:done` | AI 完成，待你检查 | 检查 Report / PR / Tests → 手动 Close Issue |

### 1.3 Markers（一般无需手写，供机器识别）

| Marker | 位置 | 含义 | V1 发布者 |
| --- | --- | --- | --- |
| `<!-- ai-workflow` `schema/source/kind/maturity_hint` 块 | Issue body 末尾 | Work Item 元信息 | Driver（Producer submit 路径）或创建者 |
| `<!-- ai-workflow:append:v1 -->` | Comment | 追加的讨论（只新增不改历史） | —（V0 Producer；V1 标准流程不再使用） |
| `<!-- ai-workflow:plan:v1 -->` | Comment | Execution Plan（修订 = 新版本新评论） | Driver（身份 = `trusted-agents` 里的 Bot，如 `gateflow-agent[bot]`） |
| `<!-- ai-workflow:execution-tracker:v1 -->` | Comment | Execution Tracker（实时 Todo，允许编辑） | Driver |
| `<!-- ai-workflow:completion-report:v1 -->` | Comment | 最终完成报告 | Driver |

> Marker 只是结构标记，永远不能当权限证明；marker 触发迁移（T1/T3/T6）要求发布者 ∈ Trusted Human ∪ Trusted Agent。

### 1.4 成熟度（Consumer 依据）

`L0 Requirement`（只有想法）→ Consumer 全程规划；`L1 Direction`（有方向）→ 验证方向补全；`L2 Solution`（方案已定）→ 只补遗漏不重新选型；`L3 Execution Plan`（完整计划）→ Readiness Check 后直接进入待审批，禁止重新设计。

## 2. 安装（V1 六步·摘要）

> **逐步详细指南见 [integration.md](integration.md)**（Part 1 Gate 接入：三种可引用模式 + bootstrap；Part 2 Driver + Workspace 接入：配置、凭证、Skills、冒烟闭环）。Driver 运维细节见 [driver.md](driver.md)。

```bash
# 第 1 步：bootstrap Gate（在目标仓库的检出目录里运行；生成后手动 commit + push）
node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target --token "$GITHUB_TOKEN"
```

1. **bootstrap Gate**：创建 6 个 `ai:*` 标签 + 生成 `.github/workflows/ai-workflow.yml`（幂等、绝不覆盖已有文件）。前提：GateFlow 本体可被 `uses:` 引用（public / 私有 + Access 策略 / 内嵌，三选一）。
2. **安装本地 Driver**：`cd /path/to/gateflow && npm install && npm run build:cli` → 得到 `dist/cli.js`（`npm run build` 同时构建 Gate 与 Driver 两个产物）。
3. **配置凭证与 `gateflow.config.yml`**：`export GITHUB_TOKEN=…`（只存在于 Driver 进程环境）；在目标仓库根目录创建 `gateflow.config.yml`（示例见 [workspace-protocol.md](workspace-protocol.md) §10）。
4. **安装 Agent Skills**：`skills/agent`、`skills/consumer`、`skills/executor`、`skills/producer` 四个 Skill 装入你的 AI 客户端（安装方式见 [agent-skills.md](agent-skills.md) §1）。
5. **配置角色路由**：`gateflow.config.yml` 的 `routing:` 把 `consumer` / `executor` 指到具体 agent（role 与 provider 分离）。
6. **启动 Driver**：`gateflow driver start`（常驻；CI / 调试用 `gateflow driver once`）。

完成后即可进入 [§3 日常使用](#3-日常使用)。注意：V1 **不需要**给 Agent 配置 GitHub MCP 或任何 Token——这是与 V0 安装流程的最大区别。

## 3. 日常使用

### 3.0 V1 现实：Driver 自动派发（先读这段）

V1 中 **Label 变化会由 Driver 自动转化为 Agent 派发**，"对 AI 说'规划 / 执行 #123'"不再是标准流程。你的动作只有两类：

| 动作类型 | 你在哪里做 | 例子 |
| --- | --- | --- |
| **Gate 命令**（确定生效） | GitHub Issue 评论 | `/ai-plan`、`/approve <id>`、`/choose 1 B`、`/change xxx`、`/cancel` |
| **Driver 运维**（本地 CLI） | 目标仓库检出目录的终端 | `gateflow driver start` / `once` / `status` / `retry <dispatch_id>`（见 [driver.md](driver.md)） |

唯一需要"对 Agent 说话"的场景是 `manual` 激活模式（无自动唤醒能力时的一等公民模式）：Driver 把 inbox 准备好后通知你，你打开 ChatGPT / ZCode，Agent 自己读 `.gateflow/current.json` 开始工作——不需要也不应该告诉它去 GitHub 上找任务。

`/change`、`/choose` 被 Gate 接受（✅）后，Driver 会把反馈投影为 `FEEDBACK.md` 并**自动**派发新一轮 Consumer——同样不需要手动唤醒。

### 3.1 场景速查表（A~J）

| 场景 | 你做什么 | 谁响应 | 状态变化 |
| --- | --- | --- | --- |
| A 聊完发任务 | Producer 起草 → 手动建 Issue；或明确要求"发成任务"（写 `.gateflow/submit/`） | Producer（起草）+ Driver（建 Issue） | 无 → `ai:planning` |
| B 模糊想法 | `/ai-plan`（或 submit 建的 Issue 已带标）→ 等 Plan → `/approve <id>` | Driver → Consumer → Gate | `ai:planning` → `ai:review` →（`/approve`）→ `ai:ready` |
| C 方案聊得差不多 | 同 B | Consumer（L2，只补遗漏不重新选型） | 同 B |
| D 已有完整计划 | 同 B | Consumer（L3，只做 Readiness Check） | 同 B |
| E 别人提交 Bug | 值得处理 → Issue 里评论 `/ai-plan` | Gate → Driver → Consumer | 无 → `ai:planning` → `ai:review` |
| F Plan 要改 | 评论 `/change <要求>` | Gate（✅）→ Driver（投影 FEEDBACK.md）→ 新一轮 Consumer | 状态不变，自动出 Plan vN+1 |
| G Plan 有选择 | 评论 `/choose 1 B` | 同 F | 状态不变，自动出收敛后的 Plan vN+1 |
| H 批准后执行 | 评论 `/approve <plan-comment-id>` | Gate（T2）→ Driver（Approval Proof 校验）→ Executor | `ai:review` → `ai:ready` →（Tracker）→ `ai:working` |
| I 查看进度 | 打开 Issue 看 Tracker 勾选与 Status | （无人响应，GitHub 自身可见） | — |
| J 完成 | 检查 Report / PR / Tests → Close Issue | Executor 已结束，你来收尾 | `ai:working` → `ai:done`（终态，Issue 仍开） |

### 3.2 场景详解

#### 场景 A：你先和 AI 聊，再发布任务

- **你做**：和 AI（装了 Producer Skill 的客户端）正常讨论需求；讨论结束后说"把刚才讨论整理成任务描述"。
- **谁响应**：**Producer** 在对话内产出 Draft（Goal / Context / Confirmed Requirements / Open Questions …）给你确认。之后两条路：① 你**手动**在 GitHub 建 Issue（V1 默认）；② 你**明确要求**"发成任务 / 创建 Issue"，Producer 写本地提交请求 `.gateflow/submit/TASK.md` + `submit.json`，**Driver** 在下次发现时创建 Issue（正文 = TASK.md + schema 块，直接打 `ai:planning`，等价 T0），成功后把 `submit/` 改名为 `processed-<timestamp>/`。
- **状态**：无 → `ai:planning`。
- 提醒：Producer 只在你明确要求时写 `submit/`，绝不自行发布；它自己永远不碰 GitHub。

#### 场景 B：Issue 只有一个模糊想法

- **你做**：Issue 评论 `/ai-plan`（Producer submit 建的 Issue 已带 `ai:planning`，可跳过）。Driver 在下个轮询周期派发 Consumer；`manual` 激活时按提示打开客户端。Plan 评论出现后读一遍，满意就在 Issue 评论 `/approve <该 Plan 评论的 id>`。
- **谁响应**：**Driver** 发现 `ai:planning` → 构建 inbox（TASK.md）→ 派发 **Consumer**；Consumer 读真实仓库、识别 L0、把 Execution Plan 写进 `outbox/PLAN.md`；**Driver** 校验后以 Bot 身份发布带 plan marker 的 Plan 评论；**Gate** 检测 marker 迁移 T1。
- **状态**：`ai:planning` → `ai:review` →（你 `/approve <id>`）→ `ai:ready`。

#### 场景 C：你已经和 AI 把方案讨论得差不多

- **你做**：同场景 B。
- **谁响应**：**Consumer** 按 L2 处理：对照仓库验证方案、只补遗漏、生成执行计划，**不会**重新问"我们是否应该用 X？"这类已定的选型。
- **状态**：同场景 B。

#### 场景 D：已有完整开发计划

- **你做**：同场景 B。
- **谁响应**：**Consumer** 识别 L3，只做 Readiness Check（逐条核对计划引用的模块 / 接口在真实仓库是否成立）加必要小修正，直接整理成待审批执行计划；**禁止重新设计整套方案**。
- **状态**：同场景 B。

#### 场景 E：别人提交 Bug

- **你做**：外部 Issue 默认是普通 GitHub Issue，Agent 不会自动处理（它也看不到）。你觉得值得处理，就在该 Issue 评论 `/ai-plan`。
- **谁响应**：**Gate** 响应 `/ai-plan`（T0）；随后 **Driver** 发现新状态并派发 Consumer（同场景 B）。
- **状态**：无 → `ai:planning` → `ai:review`。

#### 场景 F：Plan 需要改

- **你做**：在 Issue 评论 `/change V1 暂时不要做自动更新，只保留手动更新`；Gate 会给该评论加 ✅。**之后不需要再做任何事**。
- **谁响应**：**Gate** 只校验命令并 ✅（不迁移状态）；**Driver** 发现未投影的反馈 → 写 `FEEDBACK.md` → 自动派发新一轮 Consumer（轮次 +1，新 dispatch_id）；Consumer 逐条消化反馈，产出完整的新版 PLAN.md；**Driver** 发布 Plan v2 新评论。
- **状态**：保持 `ai:review`；Plan v2 是**新评论**，旧 Plan 不编辑、不覆盖。

#### 场景 G：Plan 有多个选择

- **你做**：Plan 的 Open Decisions 会按"问题号 + 选项字母"列出（如 `1. 更新方式：A 自动 / B 手动（推荐）/ C 两者都做`）。你评论 `/choose 1 B`，然后等 Driver 自动触发新一轮（同场景 F）。
- **谁响应**：**Gate** 校验格式并 ✅；**Consumer** 把决定收敛进方案并发布新版 Plan；已决定的问题从 Open Decisions 移除或标记已决定。
- **状态**：保持 `ai:review`；自动出 Plan vN+1。

#### 场景 H：批准以后执行

- **你做**：在 Issue 评论 `/approve <plan-comment-id>`（整条评论只写这一句；`<plan-comment-id>` 是你要批准的那条 Plan 评论的 id）。然后等 Driver 自动派发。
- **谁响应**：**Gate** 执行 T2（`ai:review` → `ai:ready`）；**Driver** 在派发 Executor 前再次独立校验 Approval Proof：`ai:ready` + 有效 `/approve <id>`（作者 ∈ Trusted Humans）+ id 指向 Current Plan + Plan 批准后未被编辑——**手改的假 `ai:ready` 标签过不了这一关**；校验通过后构建 executor inbox（TASK.md + PLAN.md）并派发 **Executor**；Executor 写 `status=working` 后 **Driver** 创建/更新 Execution Tracker（tracker marker），**Gate** 迁 T3。
- **状态**：`ai:review` → `ai:ready` →（Tracker）→ `ai:working`。

#### 场景 I：查看实时进度

- **你做**：不用问 AI"做到哪了"，直接打开 Issue 看 Execution Tracker（Driver 以默认 60s debounce 把 Agent 的 PROGRESS 同步进同一条评论）：

```text
- [x] Manifest
- [x] Downloader
- [ ] Cache
- [ ] Integration
```

- **谁响应**：无人——进度就在 GitHub 上；执行受阻时 Issue 会出现 `ai:blocked`（Tracker Status=Blocked，Gate T4），blocked 原因看 Tracker / result 的 reason。
- **状态**：`ai:working` ↔ `ai:blocked`（由 Tracker 的 Status 机器值驱动，Agent 恢复工作后回到 `ai:working`，T5）。

#### 场景 J：完成

- **你做**：Executor 发布 Completion Report 后，检查代码 / PR / Tests / Report，确认无误后手动 Close Issue。
- **谁响应**：**Executor** 把 `REPORT.md` 写进 outbox，**Driver** 校验后发布带 completion-report marker 的报告，**Gate** 已迁 T6；最后一步（Close）永远是你。
- **状态**：`ai:working` → `ai:done`（终态，Issue 保持 Open，关闭即终态）。

### 3.3 命令速记

```text
和 AI 聊完发布：     Producer 起草 → 手动建 Issue；或明确要求“发成任务”（Producer 写 .gateflow/submit/，Driver 建 Issue）
已有 Issue 入流程：  /ai-plan（Owner 在 Issue 评论）
启动规划：           无需手动——Driver 发现 ai:planning 自动派发 Consumer（manual 激活：按提示打开客户端即可）
要求修改：           /change xxx（Driver 投影 FEEDBACK.md，自动重新规划）
选择方案：           /choose 1 B（同上）
批准：               /approve <plan-comment-id>（Trusted Human，Gate 判定；V1 绑定 Plan 版本）
取消：               /cancel（任一 ai:* 状态，退出工作流，不关闭 Issue）
启动执行：           无需手动——Approval Proof 校验通过后 Driver 自动派发 Executor
进度 / 完成：        看 Execution Tracker / Completion Report，最后手动 Close
Driver 运维：        gateflow driver start | once | status | retry <dispatch_id>（见 docs/driver.md）
```

三条安全底线（AI 永远做不到，也请你不要要求它做）：AI 不能批准 Plan（`/approve <id>` 只有 Trusted Human 有效且由 Gate 判定；`approve` 等词在 Agent 输出白名单之外）；AI 不能绕过 Gate 改状态（V1 中它连 GitHub 都访问不了）；AI 不能编辑已发布的 Plan / 评论历史（修订永远是新评论）。

## 附录：V0 手动调试模式（非标准架构）

V0 的标准流程是 **GitHub MCP 直连**：给 Agent 配置官方 GitHub MCP Server + PAT（最小 toolsets `repos` / `issues` / `pull_requests`），由人对 AI 说"规划 <repo>#<n>" / "执行 <repo>#<n>"手动唤醒 Skill，Agent 自己读 Issue、发布 Plan / Tracker / Report、更新进度。该模式下：

- AI 操作的 actor 就是 PAT 所属者（V0 快速自用模式下即 Owner本人），`trusted-agents` 无需设置；
- `/change` / `/choose` 之后需要人再手动唤醒 Consumer；Label 变化不会自动唤醒任何东西；
- 安装与配置细节见 V0 文档：[integration.md](integration.md) 附录"MCP 直连（旧模式）"与 [architecture.md](architecture.md)（历史）。

V1 中这套流程**不再是标准架构**，仅保留两类调试用途：

1. **孤立调试 Gate**：不启动 Driver，直接在 Issue 上发命令 / 手工构造 marker 评论，验证 Gate 的判定与迁移（注意：V1 协议下 `/approve` 需要 Plan 评论 id，且 Executor 派发还有 Driver 侧的 Approval Proof 校验）；
2. **不依赖 Driver 的最小闭环验证**：在无法运行本地 Driver 的环境里，用 MCP 直连完成一次人工规划 / 执行演练。

注意事项：V1 的四个 Skill 已**删除全部 GitHub 集成知识**（无 MCP、无 Token、只读写 `.gateflow/`）——要走 V0 直连调试，意味着绕过 V1 Skill 的协议约束，以普通对话方式让 AI 操作 GitHub；请确信你在调试而不是在"干活"，并把它的 actor 身份混同风险（见 [security.md](security.md) §2.2）记在心里。日常使用请回到标准架构：Driver + Workspace Protocol（[driver.md](driver.md)）。
