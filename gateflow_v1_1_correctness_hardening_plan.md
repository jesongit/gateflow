# GateFlow V1.1 Correctness Hardening 收尾开发计划

> 项目：`jesongit/gateflow`  
> 仓库：https://github.com/jesongit/gateflow  
> 计划版本：V1.1 Hardening  
> 日期：2026-09-07  
> 适用阶段：GateFlow V1 核心架构已经落地，本轮不再增加新架构层，不引入 Server / DB / Queue / Agent Registry，只处理正确性、安全闭环、恢复语义和真实运行验证。

---

# 1. 本轮目标

GateFlow V1 当前架构已经基本稳定：

```text
GitHub
  ↕
Gate
  ↕
Driver
  ↕
Workspace Protocol
  ↕
Activation Adapter
  ↕
Agent + Skill
```

本轮不再讨论：

```text
是否需要 Driver
是否应该用 Workspace Protocol
Skill 是否应该隔离 GitHub
是否需要 ChatGPT / ZCode Adapter
```

这些方向已经确定。

V1.1 只解决：

1. Gate 对所有 Agent-side 状态迁移执行完整 Dispatch 授权校验；
2. Workflow Epoch 来源与新轮次恢复严格化；
3. Driver Receipt 的 accepted 绑定具体 GitHub 对象；
4. Executor Lock 不再依赖固定时间自动失效；
5. Driver/Gate 协议解析统一；
6. Action smoke test 改成真实事件测试；
7. ChatGPT / ZCode E2E 补齐。

最终目标：

> 任何 GitHub 状态迁移，都必须能追溯到当前 Epoch、当前 Dispatch、当前 Plan、当前 Approval 和具体被 Gate 接受的源对象。

---

# 2. V1.1 完成后的安全链

```text
Human
  │
  │ /approve <plan-id>
  ▼
Gate
  │
  ├─ validate Human
  ├─ validate REVIEW
  ├─ validate Current Epoch
  ├─ validate Current Plan
  ├─ calculate Plan Hash
  └─ issue Approval Record
         │
         ▼
       READY
         │
         ▼
Driver Preflight
         │
  ├─ Current Epoch
  ├─ Current Plan
  ├─ Plan Hash
  ├─ Approval Record
  └─ Dispatch validity
         │
         ▼
Executor Dispatch
         │
         ▼
Agent
         │
         ▼
Tracker / Report Output
         │
         ▼
Driver
         │
         ▼
GitHub Protocol Object
         │
         ▼
Gate
         │
  ├─ validate source actor
  ├─ validate Epoch
  ├─ validate Dispatch
  ├─ validate Plan / Approval
  ├─ validate source object
  └─ issue Transition Record
         │
         ▼
      WORKING / DONE
```

原则：

```text
Driver Preflight != Gate Authorization
```

Driver 可以提前阻止错误同步，但 Gate 必须再次独立验证。

---

# 3. 优先级

| 优先级 | 项目 | 目标 |
|---|---|---|
| P0 | Gate Dispatch Authorization | 所有状态迁移验证当前执行链 |
| P0 | Epoch Record Trust | Epoch 不可被普通 Comment 伪造 |
| P1 | T0 Epoch Recovery | 新轮次创建失败不能沿用旧 Epoch |
| P1 | Transition Record | Driver 精确知道 Gate 接受了哪条对象 |
| P1 | Receipt Acceptance | accepted 绑定 source_comment_id |
| P1 | Executor Lock | 防止旧客户端仍工作时自动抢占 |
| P1 | Shared Protocol Parser | Gate / Driver 不再各自解析命令 |
| P1 | Real Action Test | 验证真正 issue_comment 事件 |
| P1 | Real Client E2E | ChatGPT / ZCode 完整验证 |

---

# 4. Phase 1 — Gate Authorization Context

> 优先级：P0

当前 Driver 已经有较完整 Preflight：

```text
Epoch
Plan
Plan Hash
Approval
Dispatch
```

但 Gate 对 Tracker / Report 等 Marker 的迁移不能只依赖：

```text
Trusted Agent
+
Marker
+
Current Label
```

必须把新的授权模型真正移入 Gate。

## 4.1 新增统一 Authorization Context

建议增加：

```text
src/gate/authorization.ts
```

概念：

```ts
interface WorkflowAuthorizationContext {
  repositoryId: number;
  issueNumber: number;
  epoch: string;
  planCommentId?: number;
  planSha256?: string;
  approvalRecordCommentId?: number;
  dispatchId?: string;
  role?: "consumer" | "executor";
}
```

提供：

```text
resolveAuthorizationContext()
validateConsumerSource()
validateExecutorSource()
```

## 4.2 T1：Plan → REVIEW

Plan Comment 必须验证：

```text
publisher = Trusted Driver / Agent Identity
epoch = Current Epoch
dispatch.role = consumer
dispatch.issue = current issue
dispatch 对应当前 planning revision
source comment 不是旧轮次对象
```

## 4.3 T3：Tracker → WORKING

必须验证：

```text
Current Epoch
+
Current Plan
+
Valid Approval Record
+
Tracker.dispatch_id
+
dispatch.role == executor
+
dispatch.plan_comment_id == current plan
+
dispatch.epoch == current epoch
```

## 4.4 T4/T5：Blocked / Resume

Tracker Edit 必须绑定：

```text
同一个 Tracker Comment
同一个 dispatch_id
同一个 epoch
同一个 executor chain
```

禁止旧 Tracker 编辑影响新轮次。

## 4.5 T6：Completion → DONE

Report 必须验证：

```text
Current Epoch
Current Executor Dispatch
Current Plan
Valid Approval
Report.dispatch_id
Report.tracker_comment_id
Report.publisher
```

建议同时验证：

```text
Tracker 当前状态 == WORKING
```

## 4.6 Shared Validation

不要让 Driver 和 Gate 各自实现一套。

建议抽出：

```text
src/protocol/workflow-chain.ts
```

负责：

```text
Current Epoch resolution
Current Plan resolution
Approval validation
Dispatch binding
Plan hash comparison
```

Driver 和 Gate 共用。

## Phase 1 验收

```text
[ ] 旧 Plan Tracker 无法触发 WORKING
[ ] 旧 Epoch Tracker 无法触发 WORKING
[ ] Fake Tracker Marker 无法触发 WORKING
[ ] 无 Approval READY 无法触发 WORKING
[ ] 旧 Report 无法触发 DONE
[ ] Report dispatch_id 不匹配无法触发 DONE
[ ] Tracker 被旧 Agent 编辑不会影响新 Executor
[ ] 合法链完整迁移成功
```

---

# 5. Phase 2 — Epoch Record Trust Hardening

> 优先级：P0

Current Epoch 不能等于“最后一条长得像 Epoch Record 的 Comment”。

## 5.1 Epoch Record 可信来源

推荐：

```text
所有 Epoch 都只由 Gate 发布
```

Producer / Driver 只触发确定性事件，由 Gate 创建 Epoch。

若必须允许 Driver bootstrap，则只允许明确的 Bootstrap Driver Identity，并区分 bootstrap 与 normal epoch。

## 5.2 Epoch Record 字段

建议：

```yaml
schema: 2
kind: workflow_epoch
repository_id: 123
issue_number: 42
epoch: ep_xxx
operation_id: epoch:...
created_by: gate
created_at: ...
```

## 5.3 校验

```text
publisher identity
repository_id
issue_number
schema
operation_id
epoch format
duplicate/conflict
```

## 5.4 冲突

同一 operation_id 出现不同 epoch：

```text
fail closed
+
记录 protocol conflict
```

不能简单取最新。

## Phase 2 验收

```text
[ ] 普通用户伪造 Epoch 无效
[ ] Trusted Agent 伪造 Epoch 无效
[ ] wrong repository_id 无效
[ ] wrong issue_number 无效
[ ] duplicate same operation 可 adopt
[ ] conflicting epoch fail closed
```

---

# 6. Phase 3 — T0 / New Epoch Recovery

> 优先级：P1

新轮次启动必须可恢复。

推荐顺序：

```text
Human /ai-plan
→ Gate
→ deterministic epoch operation_id
→ create/adopt Epoch Record
→ 确认成功
→ PLANNING
```

不要先改 Label 再建 Epoch。

## 6.1 Operation ID

例如：

```text
epoch:<repository_id>:<issue_number>:<command_comment_id>
```

同一次 `/ai-plan` 重试必须得到同一个 ID。

## 6.2 Timeout Recovery

```text
search operation_id
├─ found → adopt
└─ none → retry create
```

## 6.3 禁止旧 Epoch fallback

新轮次 Epoch 未建立：

```text
fail
```

不能沿用 last known epoch。

## Phase 3 验收

```text
[ ] 首次 /ai-plan 创建 Epoch
[ ] 重复 event 不创建第二个 Epoch
[ ] API timeout 后可 adopt
[ ] 第二轮 /ai-plan 不沿用第一轮 Epoch
[ ] Epoch 创建失败不会进入 PLANNING
```

---

# 7. Phase 4 — Gate Transition Record

> 优先级：P1

Driver 需要知道 Gate 接受了哪一个具体源对象。

建议为关键迁移增加 Transition Record。

示例：

```html
<!-- gateflow:transition:v1
schema: 1
epoch: ep_xxx
dispatch_id: gf_xxx
source_comment_id: 123456
transition: WORKING_TO_DONE
from: ai:working
to: ai:done
gate_version: 1.1.0
-->
```

至少覆盖：

```text
T1 Plan Accepted
T2 Approval Accepted
T3 Tracker Accepted
T4 Blocked
T5 Resume
T6 Completion Accepted
```

要求：

```text
[ ] 每次 transition 有唯一 source_comment_id
[ ] 有 epoch
[ ] 有 dispatch 时记录 dispatch_id
[ ] 重复 event 不创建重复 Record
```

---

# 8. Phase 5 — Receipt Acceptance 精确化

> 优先级：P1

`accepted` 必须严格表示：

> Gate 已经接受 Driver 发布的具体 GitHub 对象。

建议：

```json
{
  "dispatch_id": "...",
  "operation_id": "...",
  "status": "published",
  "source_comment_id": 900,
  "transition_record_comment_id": null,
  "published_at": "...",
  "accepted_at": null
}
```

Gate 接受后：

```json
{
  "status": "accepted",
  "source_comment_id": 900,
  "transition_record_comment_id": 901
}
```

禁止：

```text
Issue == ai:done
→ receipt accepted
```

必须匹配：

```text
TransitionRecord.source_comment_id == receipt.source_comment_id
epoch 一致
dispatch_id 一致
transition 一致
```

如果当前 epoch 或 dispatch 已变化：

```text
receipt → obsolete
```

## Phase 5 验收

```text
[ ] DONE 但 source_comment 不匹配 → 不 accepted
[ ] old Report → obsolete
[ ] correct Transition Record → accepted
[ ] Driver restart 后可 reconcile
```

---

# 9. Phase 6 — Operation ID / Idempotent Publish

> 优先级：P1

GitHub API 没有跨请求事务，所以不宣称 absolute exactly-once。

目标：

> **Idempotent publishing with remote reconciliation**

所有远端创建统一 Operation ID：

```text
Issue Submit
Epoch Record
Plan Comment
Tracker Comment
Completion Report
Approval Record
Transition Record
```

标准流程：

```text
prepare operation_id
→ search remote
├─ exact match → adopt
├─ conflict → fail closed
└─ none → create
           ↓
        timeout?
           ↓
        search again
```

同一逻辑操作重试不允许随机生成新 ID。

## Phase 6 验收

模拟：

```text
request success
→ client timeout
→ Driver restart
```

确保不重复创建 Issue / Plan / Report。

---

# 10. Phase 7 — Executor Lock 重构

> 优先级：P1

桌面 Agent 中：

```text
Driver 进程结束
!=
Agent 已停止
```

所以 Executor Lock 不能仅因超过固定时间自动 stale。

建议：

```json
{
  "dispatch_id": "...",
  "epoch": "...",
  "workspace": "...",
  "owner_driver_pid": 1234,
  "created_at": "...",
  "heartbeat_at": "...",
  "state": "active"
}
```

Driver Runtime Lock 可使用 PID + heartbeat。

Executor Workspace Lock 不允许仅依据 Driver PID 或固定时间释放。

如果旧 Executor 状态未知：

```text
workspace_conflict
```

要求人工确认旧客户端已停止后再释放。

未来真正并行时再做：

```text
one dispatch → one git worktree
```

但不纳入 V1.1。

## Phase 7 验收

```text
[ ] Driver crash 不自动释放 Executor Workspace
[ ] 固定时间不会自动抢占
[ ] old dispatch obsolete + explicit release 才能重用
[ ] 未确认旧客户端停止时 fail safe
```

---

# 11. Phase 8 — Shared Command / Protocol Parser

> 优先级：P1

Gate 和 Driver 不应各自维护：

```text
/approve
/change
/choose
/cancel
```

正则与语义。

建议：

```text
src/protocol/
├── commands.ts
├── records.ts
├── markers.ts
├── workflow-chain.ts
└── schemas.ts
```

Driver 只消费 Gate Accepted Feedback。

Consumer revision 改为基于：

```text
Accepted Feedback Sequence
```

而不是符合格式的 Comment 数量。

## Phase 8 验收

```text
[ ] Gate/Driver 共用 command parser
[ ] rejected /change 不增加 revision
[ ] duplicate feedback 不重复派发
[ ] old epoch feedback 不影响 current consumer
```

---

# 12. Phase 9 — Identity Consistency

> 优先级：P1/P2

统一身份解析。

Personal repo：

```text
repo owner + configured trusted humans
```

Organization：

```text
configured trusted humans only
```

Effective Agent Set：

```text
configured trusted driver / bot identities
```

Secure Mode：

```text
Effective Humans ∩ Effective Agents == empty
```

Gate / Driver / Bootstrap 共用同一个 Identity Resolver。

## Phase 9 验收

```text
[ ] Personal repo owner 默认 Human
[ ] Org owner 不被当 Human
[ ] Secure Mode Human/Agent 重叠配置失败
[ ] Gate/Driver Identity 结果一致
```

---

# 13. Phase 10 — Action Event Test 重构

> 优先级：P1

普通 CI workflow 中创建 Issue/Comment 后再 `uses: ./`，不会自动变成对应 `issue_comment` 事件。

因此测试拆成两层。

## 13.1 Event Fixture Integration

增加：

```text
tests/events/
```

Fixture：

```text
issue_comment_created.json
issue_comment_edited.json
issues_opened.json
```

核心 handler 允许测试时注入：

```text
eventName
eventPayload
```

## 13.2 Action Runtime Smoke

CI 中 `uses: ./` 仅验证：

```text
Node24 Runtime
Bundle
Inputs
Action metadata
```

不要称 Gate E2E。

---

# 14. Phase 11 — Real GitHub E2E

> 优先级：P1

建立专用测试仓库。

完整链：

```text
Issue
→ /ai-plan
→ Epoch
→ Consumer Dispatch
→ Plan
→ REVIEW
→ /approve <plan-id>
→ Approval
→ READY
→ Executor Dispatch
→ Tracker
→ WORKING
→ Report
→ DONE
```

Security E2E：

```text
Agent /approve
Fake Epoch
Fake ready
Old Plan Approval
Edited Plan
Old Tracker
Old Report
Duplicate Report
Cancel + delayed Agent Output
```

Recovery E2E：

```text
Driver restart
Action redelivery
API timeout
Receipt 丢失
本地 receipts 删除
```

---

# 15. Phase 12 — ChatGPT / ZCode Client E2E

> 优先级：P1

先验证 Manual Activation：

```text
Driver 创建 Dispatch
→ 通知
→ 用户打开 ChatGPT/ZCode
→ Agent 读取精确 dispatch path
→ 工作
→ outbox
→ Driver Sync
```

至少测试：

```text
Consumer ChatGPT → Executor ZCode
Consumer ZCode → Executor ChatGPT
```

证明：

```text
Role != Provider
```

如果没有稳定自动 Task API：

```text
Manual Activation
```

仍算正式通过。

---

# 16. Phase 13 — 文档收尾

统一：

```text
README.md
docs/architecture.md
docs/protocol.md
docs/workspace-protocol.md
docs/security.md
docs/driver.md
docs/integration.md
```

明确三种安全语义：

### Personal Mode

```text
Workspace communication isolation
No OS security isolation
Human/Agent identity may overlap
```

### Secure Identity Mode

```text
Human / Driver GitHub identity separated
```

### Hardened Runtime（未来）

```text
OS/container isolation
credential isolation
worktree isolation
```

同时明确：

```text
Cancel
=
停止接受旧 Dispatch 输出
```

不等于保证终止外部桌面 Agent。

---

# 17. 推荐任务拆分

1. Shared Workflow Authorization
2. Gate Tracker Authorization
3. Gate Report Authorization
4. Epoch Record Trust
5. T0 Epoch Recovery
6. Transition Record
7. Receipt Acceptance
8. Operation ID Unification
9. Executor Lock
10. Shared Command Parser
11. Feedback Sequence
12. Identity Resolver
13. Action Fixture Tests
14. GitHub E2E
15. ChatGPT/ZCode E2E
16. Documentation Finalization

---

# 18. 推荐执行顺序

```text
Task 01
  ↓
Task 02 / 03
  ↓
Task 04 / 05
  ↓
Task 06 / 07
  ↓
Task 08
  ↓
Task 09
  ↓
Task 10 / 11 / 12
  ↓
Task 13
  ↓
Task 14
  ↓
Task 15
  ↓
Task 16
```

期间不要增加：

```text
Remote Driver
Agent Registry
Queue
Dashboard
Parallel Worktree Scheduler
```

---

# 19. V1.1 Definition of Done

## Gate Authorization

```text
[ ] Plan / Tracker / Report 都绑定 Current Epoch
[ ] Tracker / Report 绑定正确 Dispatch
[ ] Executor Chain 匹配 Current Plan + Approval
[ ] 旧轮次 Comment 不可推进状态
```

## Epoch

```text
[ ] Epoch 只接受可信来源
[ ] repository_id / issue_number 校验
[ ] Epoch 创建可恢复
[ ] 新轮次绝不沿用旧 Epoch
```

## Transition

```text
[ ] Gate 对关键迁移创建 Transition Record
[ ] source_comment_id 可追踪
[ ] dispatch_id / epoch 可追踪
```

## Driver

```text
[ ] accepted 绑定具体 Transition
[ ] stale output → obsolete
[ ] API timeout 可 reconcile
[ ] Driver restart 不重复发布
```

## Lock

```text
[ ] 不因固定时间自动抢占 Executor
[ ] 未确认旧客户端停止时 fail safe
```

## Protocol

```text
[ ] Gate / Driver 共用 parser
[ ] Feedback revision 来自 accepted event
[ ] Identity resolver 统一
```

## Tests

```text
[ ] Node24 Action runtime test
[ ] Event fixture integration tests
[ ] Real GitHub E2E
[ ] Security E2E
[ ] Recovery E2E
[ ] ChatGPT Client E2E
[ ] ZCode Client E2E
[ ] Mixed Provider E2E
```

---

# 20. 最终发布标准

完成 V1.1 后，GateFlow 才建议进入：

```text
长期 dogfood
+
无人值守 Driver
```

发布前必须证明以下异常全部 fail-safe：

```text
Fake Ready
Fake Epoch
Old Plan
Old Approval
Edited Plan
Old Tracker
Old Report
Agent delayed output after cancel
Duplicate GitHub delivery
GitHub API timeout
Driver restart
Receipt loss
Desktop Agent still running
```

核心规则：

```text
只要系统无法确定当前执行链仍然有效
→ 不迁移
→ 不同步
→ 不抢占
→ fail closed
```

---

# 21. 本轮之后停止架构扩张

如果本计划全部完成，当前架构已经足够稳定：

```text
GitHub
+
Deterministic Gate
+
Local Driver
+
Workspace Protocol
+
Activation Adapter
+
Agent Skills
```

下一步应该进入真实使用，而不是继续抽象。

只有实际出现：

```text
多个 Executor 并行
多机器
远程 Worker
Agent 抢任务
工作队列
中央调度
```

再考虑：

```text
Worktree Scheduler
Agent Registry
Lease
Remote Control Plane
```

---

# 22. 总结

V1.1 的核心不是增加功能，而是让已有设计真正闭环。

V1 已经做到：

```text
Agent 不直接管理 GitHub Workflow
Driver 不调用 AI
Gate 独立控制 Human Approval
```

V1.1 要补齐最后一步：

> **Gate 不只验证“谁发了一个合法格式对象”，而要验证“这个对象是否属于当前被授权的执行链”。**

完成以后，每次状态变化都应该能确定性回答：

```text
这是哪个 Epoch？
哪个 Plan？
谁批准的？
批准时 Plan Hash 是什么？
哪个 Dispatch？
哪个 Agent Output？
哪个 GitHub Comment？
Gate 接受的是哪一条？
```

如果这些问题都能回答，GateFlow V1 的核心协议就可以真正冻结。
