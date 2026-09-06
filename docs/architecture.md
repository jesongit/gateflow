# 架构（Architecture）

> ⚠️ **V0 架构文档（历史）— V1 架构见 [docs/architecture-v1.md](architecture-v1.md)。**
>
> V1 相对本文（V0）的核心变化：
>
> 1. 新增本地确定性 **Driver**（`gateflow` CLI）：任务发现、inbox 派发、outbox 校验与 GitHub 同步；V0 的"人手动对 AI 说'规划 / 执行 #123'"不再是标准流程；
> 2. 新增 **Workspace Protocol**（`.gateflow/`：inbox / outbox / receipts）：Agent 不再配置 GitHub MCP / PAT，只读写本地工作区；
> 3. **Trusted Agent 重定义**为受控 Driver 的 GitHub Identity（如 `gateflow-agent[bot]`），登记在 `trusted-agents` 输入；
> 4. `/approve` 变为 `/approve <plan-comment-id>`（Plan 绑定审批），Executor 派发前 Driver 独立校验 Approval Proof；
> 5. Gate 的职责与 V0 协议（Labels / 状态机 / 命令 / Marker）保持不变——本文描述的 Gate 部分仍然有效。
>
> 以下正文保留 V0 原貌，仅供追溯，不作为 V1 的实现依据。

> 版本：V0（Phase 0 冻结骨架）
> 权威协议见 [protocol.md](protocol.md)；安全模型见 [security.md](security.md)。

## 1. 一句话定位

GateFlow 是一套"用 GitHub 原生对象（Issue / Comment / Label / PR）作为唯一正式状态存储，用确定性 GitHub Action 做权限与状态迁移，用 Markdown Skill 驱动 AI 做规划与执行"的轻量工作流。

没有 Go Server、SQLite、React、Docker、消息队列、Agent Registry、Dashboard（V0 明确不做，见第 6 节）。

## 2. 四部分架构

```text
AI Conversation
      │
      ▼
 Producer Skill            Chat → GitHub Work Item（CREATE Issue / APPEND Comment）
      │
      ▼
 GitHub Issue              Issue + Label + Comment = 唯一正式状态
      │
      ▼
 TypeScript Gate           GitHub JS Action，事件驱动，确定性判定与迁移
      │
      ▼
 Consumer / Executor Skills
      │
      ▼
 Plan → Todo → Code → Report
```

技术栈：TypeScript(strict) + `@actions/core` + `@actions/github`，esbuild 打包为 `dist/index.js`，以 JavaScript Action 形式运行在 GitHub Actions 中，无常驻进程，只在事件发生时运行。

Gate 订阅的事件：

```text
issues:            opened / labeled / closed
issue_comment:     created / edited
```

## 3. 组件职责

### 3.1 Deterministic Gate（本仓库的 Action，唯一正式程序）

| 职责 | 说明 |
| --- | --- |
| 身份验证 | 判定 actor 是否 Trusted Human / Trusted Agent（见第 4 节） |
| 命令解析 | 对 5 个 Comment 命令做严格解析（trim 后全等 / 锚定匹配，禁止子串匹配） |
| 状态检查 | 迁移前从 GitHub API 重读 labels，校验前提状态 |
| Marker 检查 | 识别 issue body schema 块与 4 种 comment marker（结构信号，非权限） |
| Label 状态迁移 | 按冻结状态机原子替换 ai:* 标签 |
| 操作反馈 | 成功 ✅；Owner 无效命令 👎（Phase 2 实装）；非 Owner 静默忽略 |
| 并发保护 | 同一 Issue 的 run 串行（concurrency group），迁移前重读状态 |

Gate 内部模块划分（Phase 1 起实现）：`commands.ts`（严格解析）、`states.ts`（状态机）、`permissions.ts`（身份判定）、`markers.ts`（Marker 识别）、`github.ts`（API 封装）、`gate.ts`（事件 → 权限 → 状态 → 校验 → 迁移）。协议常量统一定义在 `src/protocol.ts`，与 `docs/protocol.md` 一一对应。

### 3.2 Producer Skill（Phase 3）

职责：`AI Conversation → GitHub Work Item`。

- 只在用户明确要求时发布，不自行判断"讨论已成熟"。
- CREATE：创建新 Issue，body 末尾写入 `ai-workflow` schema 块（schema / source / kind / maturity_hint），**创建时直接通过 GitHub MCP 打上 `ai:planning`**。
- APPEND：向已有 Issue 追加带 `ai-workflow:append:v1` marker 的评论，只新增、不修改历史。

### 3.3 Consumer Skill（Phase 4/5）

职责：`Work Item → Repository Analysis → Maturity 判断 → 补设计 → Execution Plan`。

- 接手 `ai:planning` 状态的 Issue，读取 Issue body、Append 评论、README、AGENTS.md、相关源码与测试。
- 判断 Effective Maturity（L0~L3），只补缺失内容，不做重复设计。
- 发布带 `ai-workflow:plan:v1` marker 的 Plan Comment；Gate 据此将状态迁到 `ai:review`。
- 处理 `/choose`、`/change` 的语义（Gate 只做身份校验、格式解析与 ✅ 反馈，不迁移状态）；修订 = 发布 Plan vN+1 新评论，不覆盖旧版。

### 3.4 Executor Skill（Phase 6/7）

职责：`Approved Plan → TodoList → Development → Validation → Completion Report`。

- 只处理 `ai:ready` 状态的 Issue。
- 创建带 `ai-workflow:execution-tracker:v1` marker 的 Execution Tracker（允许持续编辑），Gate 据此迁到 `ai:working`；Tracker 的 `**Status:**` 机器值（In Progress / Blocked / Completed）由 Gate 确定性解析，驱动 `WORKING ↔ BLOCKED`。
- 完成后发布带 `ai-workflow:completion-report:v1` marker 的最终报告，Gate 迁到 `ai:done`；Issue 保持 Open，由 Owner 检查后手动关闭。

## 4. 身份模型

- **Trusted Human**：V0 默认 = repo owner login；可通过 Action 输入 `trusted-humans`（逗号分隔）扩展。唯一能执行 `/ai-plan`、`/approve`、`/choose`、`/change`、`/cancel` 的角色，也是唯一最终 Close Issue 的角色。
- **Trusted Agent**：独立 Action 输入 `trusted-agents`（逗号分隔），V0 默认空；用于未来 AI 以独立 Bot / GitHub App 身份操作时的登记。**两个概念在代码与协议中绝不合并**：Trusted Agent 永远不能执行任何命令。
- 快速自用模式下 AI 经 Owner 的 PAT 走 GitHub MCP，其操作 actor 即 Owner；这是 V0 的现实而非概念合并（详见 [security.md](security.md)）。

## 5. 端到端数据流

```text
你和 AI 讨论
    ↓ “把这个发成 Issue”
Producer CREATE：Issue + schema 块 + ai:planning        [PLANNING]
    ↓
Consumer 读 Repo，判断 Maturity，只补缺失设计
    ↓ 发布 Plan Comment（plan marker）
Gate: PLANNING → REVIEW                                 [REVIEW]
    ↓ （可选循环：/change、/choose → Consumer 发布 Plan vN+1）
你 /approve（Trusted Human，Gate 校验）
    ↓
Gate: REVIEW → READY                                    [READY]
    ↓ “执行 #123”
Executor 读 Approved Plan，创建 Execution Tracker（tracker marker）
Gate: READY → WORKING                                   [WORKING]
    ↓ 持续更新 Tracker（[x] 进度、Status: Blocked → In Progress）
Validation 通过，发布 Completion Report（report marker）
    ↓
Gate: WORKING → DONE                                    [DONE，终态，Issue 保持 Open]
    ↓
Owner 检查 Report / PR / Tests → Close Issue（关闭即终态）
```

全程中所有授权点（`/approve`、`/cancel`）都由 Gate 确定性完成；AI 只产出内容（Plan / Tracker / Code / Report），从不审批。

## 6. V0 明确不做的清单

```text
Go Server / SQLite / React / Docker 服务 / 独立数据库 / 独立 Dashboard
Agent Registry / Task Scheduler / Lease / 消息队列
复杂 RBAC / 复杂 Workflow Engine
Child Issues 自动化（Parent/Child 拆分）
Consumer Driver / 自动唤醒（V0 由人手动对 AI 说“规划/执行 #123”）
Bot 独立身份 / GitHub App（代码保留 Trusted Agent 概念，默认空）
Reaction 审批、Stale 检测、Cross-repo Dashboard
```

只有当 GitHub 原生能力被真实使用证明不够时（多 Agent 抢任务、需要精确 Lease、跨几十个 Repo 等），才考虑引入独立 Control Plane（见计划文档第二十九节）。

## 7. 状态存储位置（V0 全量）

```text
GitHub Issue     正式工作项 + ai:* 状态标签 + schema 块
GitHub Comment   Plan / Execution Tracker / Completion Report / Append / 命令
GitHub Label     工作流状态机（6 个 ai:* 标签）
GitHub PR        代码变更载体
GitHub Timeline  一切操作的审计轨迹（天然由 GitHub 记录）
```
