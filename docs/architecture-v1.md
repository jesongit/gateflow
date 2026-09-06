# GateFlow V1 架构（冻结）

> 本文是 V1 重构的架构冻结文档。组件边界、职责与禁令以本文为准。
> 通信协议细节见 [docs/workspace-protocol.md](workspace-protocol.md)；V0 Gate 协议见 [docs/protocol.md](protocol.md)。

## 1. V1 定位

> **GitHub-native Human-Gated Agent Runtime。GitHub 保存正式状态；Gate 控制授权和状态迁移；Driver 负责任务发现、派发和同步；Agent 只通过本地 Workspace Protocol 接收任务、汇报进度和提交结果。**

职责一句话：

```text
Gate 管"能不能做"，Driver 管"什么时候做"，Adapter 管"怎么叫醒"，Skill 管"Agent 怎么干活"。
```

## 2. 组件与职责边界（冻结）

| 组件 | 职责 | 明确不做 |
| --- | --- | --- |
| **GitHub** | 唯一正式状态载体（Issue / Comment / Label / PR / Timeline） | 不引入独立数据库 |
| **Gate**（GitHub Action，确定性） | Actor Identity / Human Commands / State Validation / Plan & Approval Validation / Marker Validation / State Transition / Approval Proof | 不启动 Agent、不调 LLM、不轮询、不碰本地 Workspace、不解析 AI 自然语言 |
| **Driver**（本地，确定性） | Discovery / Dispatch / Inbox 构建 / Outbox 监听与校验 / GitHub 同步 / Dedup / Retry / Crash Recovery / Feedback 回流 | **不调用 LLM**；不自己决定状态迁移（只发布协议对象，迁移由 Gate 完成） |
| **Workspace Protocol**（`.gateflow/`） | Agent 通信边界：inbox（Driver 写，Agent 只读）/ outbox（Agent 写，Driver 读）/ receipts / logs | 不是正式状态（GitHub 才是） |
| **Activation Adapter** | 只负责"Dispatch 准备好后如何唤醒客户端"（probe / notify / cancel） | 不负责通信（通信 = Workspace Adapter/Protocol）；不做脆弱 GUI 自动化 |
| **Skill** | 教 Agent 怎么规划、开发、验证、汇报 | 不含 GitHub MCP / Label / Marker / Comment / Token 等系统集成知识 |
| **Agent** | 理解、规划、编码、验证、汇报 | 不直接访问 GitHub（无 GitHub MCP / PAT）；不改 Workflow State |

## 3. 数据流（冻结）

### 3.1 Planning

```text
Issue(ai:planning)
→ Driver Discovery
→ Consumer Dispatch（inbox: TASK.md + FEEDBACK.md?）
→ Activation Adapter 唤醒客户端
→ Agent 读 inbox，写 outbox（PLAN.md + result=plan_ready）
→ Driver 校验 Schema → 发布 Plan Comment（带 plan marker，身份 = Driver bot）
→ Gate 检测 marker → T1: PLANNING → REVIEW
```

### 3.2 Change / Feedback

```text
Human /change | /choose（REVIEW 中）
→ Gate 校验（V0 行为不变，不迁移）
→ Driver Discovery 发现未投影的 Feedback
→ 写 FEEDBACK.md → 新 Consumer Dispatch（work_revision 递增）
→ Agent 产出新 PLAN.md → Driver 发布新 Plan Comment → REVIEW 中更新
```

### 3.3 Approval

```text
Human /approve <plan-comment-id>
→ Gate 校验：Trusted Human + REVIEW + Comment 属于本 Issue + 是有效 Plan + 是 Current Plan
→ T2: REVIEW → READY
→ Executor Dispatch 前由 Driver 再次独立校验 Approval Record：
   ai:ready + 有效 /approve <id> 评论（作者 ∈ Trusted Humans）+ id 指向 Current Plan + Plan 未在批准后被编辑
→ 通过才派发 Executor；Fake ai:ready（手改标签）无法通过校验
```

### 3.4 Execution

```text
Driver 派发 Executor（inbox: TASK.md + PLAN.md + FEEDBACK.md?）
→ Agent 写 outbox：status=working → Driver 创建/更新 Execution Tracker（带 tracker marker）
→ Gate T3: READY → WORKING
→ PROGRESS 更新：Driver 以 debounce（默认 60s）编辑同一条 Tracker Comment
→ status=blocked → Driver 编辑 Tracker Status=Blocked → Gate T4: WORKING → BLOCKED
→ 恢复 working → Status=In Progress → Gate T5: BLOCKED → WORKING
→ REPORT.md + result=completed → Driver 校验 → 发布 Completion Report（completion marker）
→ Gate T6: WORKING → DONE
```

注意：`result=completed` 只是 Agent Claim；DONE 只由 Gate 完成。Activation 失败时 Issue 保持 READY（Agent 未写 status=working 之前不产生 Tracker，不触发 T3）。

## 4. 身份模型（V1 语义）

- **Trusted Human**：与 V0 相同（repo owner + `trusted-humans` 输入）。唯一命令发布者。
- **Trusted Agent（V1 重定义）**：**受控 GateFlow Driver 的 GitHub Identity**（如 `gateflow-agent[bot]`），通过 `trusted-agents` 输入注册。它只用于让 Gate 认可 Driver 发布的 marker 评论（T1/T3/T6）。**AI 本身永远不持有该凭证**——凭证在 Driver（本地进程）里，AI 只写本地文件。

## 5. 目录结构（冻结）

```text
src/
├── index.ts               # Gate Action 入口（不变）
├── cli.ts                 # gateflow driver CLI（start / once / status / retry）
├── gate/                  # V0 Gate（原 src/*.ts 平移 + V1 审批增强）
│   ├── gate.ts  commands.ts  states.ts  permissions.ts
│   ├── markers.ts  tracker.ts  github.ts  protocol.ts  approvals.ts
├── driver/                # V1 Local Driver
│   ├── driver.ts          # 编排循环（once / start 共用）
│   ├── discovery.ts       # GitHub Canonical State → DispatchIntent
│   ├── intent.ts          # DispatchIntent 类型与推导
│   ├── dispatch.ts        # Intent → inbox 构建 → 派发记录
│   ├── routing.ts         # role → agent → activation adapter
│   ├── sync.ts            # outbox → GitHub（plan/tracker/completion）
│   ├── dedup.ts           # dispatch_id 去重（receipts）
│   ├── retry.ts           # 重试与上限
│   └── config.ts          # gateflow.config.yml 加载与校验
├── workspace/             # Workspace Protocol 运行时
│   ├── protocol.ts        # 常量 + 类型（schema v1）
│   ├── schemas.ts         # JSON Schema 定义（与 protocol/workspace-schema-v1.json 同步）
│   ├── paths.ts           # .gateflow 路径解析 + 安全校验（traversal/symlink 防护）
│   ├── inbox.ts           # inbox 构建与读取（原子写）
│   ├── outbox.ts          # outbox 读取（原子写辅助）
│   ├── watcher.ts         # outbox 文件监听（debounce + 稳定性检查）
│   ├── validation.ts      # 机器文件校验（schema/role/dispatch_id/白名单）
│   └── submit.ts          # Producer submit 协议（.gateflow/submit/）
├── activation/            # Activation Adapters
│   ├── types.ts           # ActivationAdapter 接口
│   ├── manual.ts          # ManualActivationAdapter（一等公民）
│   ├── chatgpt.ts         # ChatGPTActivationAdapter（capability-based）
│   └── zcode.ts           # ZCodeActivationAdapter（capability-based）
└── github/                # Driver 侧 GitHub 访问层（独立于 gate/github.ts）
    ├── client.ts          # Octokit 封装 + DriverGitHubClient 接口
    ├── issue-sync.ts      # Issue/评论读、Plan/Tracker/Report 评论发布
    └── comments.ts        # 评论模板（marker 拼装只在 Driver 侧发生）
protocol/
├── workspace-schema-v1.json
├── github-schema-v2.json
└── README.md
skills/
├── agent/SKILL.md         # 通用 gateflow-agent（Workspace Protocol 用法）
├── consumer/SKILL.md      # 重写：无 GitHub 依赖
├── executor/SKILL.md      # 重写：无 GitHub 依赖
└── producer/SKILL.md      # 重写：.gateflow/submit 本地提交
tests/
├── gate/  workspace/  driver/  github/  activation/  integration/  security/
```

## 6. 状态迁移权（冻结，唯一）

状态迁移的执行者只有 Gate（GitHub Action）。其余角色只能发布"协议对象"：

```text
Agent Output → Driver（校验）→ GitHub Protocol Object（marker 评论 / Tracker 编辑）
→ Gate（Actions）→ State Transition
```

Driver 从 GitHub Canonical State 可完整重建 DispatchIntent，因此未来 Event-driven 与 Polling 共用同一语义。

## 7. 本轮明确不做

独立 Web Server / SQLite / Redis / 消息队列 / Agent Registry / 复杂 Scheduler / Dashboard / Lease / 多 Agent 抢占 / Remote Control Plane。角色路由只需 `role → agent` 配置。
