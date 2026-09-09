# GateFlow V1 安全与可靠性收尾开发计划

> 项目：`jesongit/gateflow`  
> 计划日期：2026-09-07  
> 计划性质：基于已完成的 Workspace / Driver 重构进行 Hardening，不重新设计产品架构。  
> 适用范围：当前开发阶段，允许破坏性修改；不为尚未正式稳定的 V0/V1 协议保留复杂兼容层。  
> 仓库：https://github.com/jesongit/gateflow

## 1. 目标与结论

本轮目标不是继续增加 Agent 功能，而是让现有链路具备可验证的授权、可恢复的同步和明确的客户端运行边界。

```text
GitHub Canonical State
        │
        ├── Deterministic Gate
        │      └── Human Authorization / State Transition
        │
        └── GateFlow Driver
               ├── Discovery / Dispatch
               ├── Workspace Sync
               ├── Idempotency / Reconciliation
               └── Activation Adapter
                         │
                  .gateflow/ Workspace
                         │
                  ChatGPT / ZCode Agent
                         │
                  Skill + Local Files
```

继续保留：

- GitHub 是正式状态载体，不增加独立 Server 或业务数据库。
- Gate 不调用 LLM，Driver 不调用 LLM。
- Skill 教 Agent 如何规划、开发、验证和汇报，不承担 GitHub 协议操作。
- Agent 的 Plan、Progress、Report 是声明，不能直接授予审批权或修改正式状态。
- ChatGPT / ZCode 客户端差异只放在 Activation Adapter，不影响 Workspace Protocol。
- Manual Activation 是正式支持模式，不为了“全自动”依赖不稳定的客户端私有接口。

本轮需要补齐的核心链路：

```text
Human /approve <plan-id>
      ↓
Gate 验证并固化 Approval Record
      ↓
Driver 验证当前授权与任务版本
      ↓
创建精确 Dispatch
      ↓
Agent 修改代码、写 Outbox
      ↓
Driver 重新验证 + 幂等发布
      ↓
Gate 确认正式状态
```

### 1.1 本轮不做

不增加 Web UI、通用 Agent Registry、复杂任务队列、Redis、SQLite、远程 Control Plane、多 Agent 抢占调度，也不重写现有 GitHub/Workspace 协议的全部结构。只有当现有协议无法表达必要的安全事实时，才作最小破坏性升级。

---

## 2. 审查基线与问题清单

本计划依据 2026-09-07 对当前公开 `main` 的相关源码复核，以及上一轮静态审查结果制定。此前审查没有成功完成本地克隆和全量测试，因此以下内容是待实施和待验证事项，不应视为已经通过运行验证的结论。实施开始时必须记录真实 commit SHA，并重新确认文件内容；若某项已在新提交中修复，直接以对应验收测试关闭，不重复改造。

| ID | 优先级 | 问题 | 主要位置 | 目标 |
|---|---|---|---|---|
| GF-H01 | P0 | Action Runtime 仍为 Node20 | `action.yml`、`package.json`、`dist/` | Node24 + 真实 Action smoke test |
| GF-H02 | P0 | 审批记录未证明 Gate 当时接受了审批 | `src/gate/approvals.ts`、`src/driver/intent.ts` | Gate-issued Approval Record |
| GF-H03 | P0 | Plan Hash 在派发时计算，未在审批时固化 | Gate / Driver / Plan 相关模块 | 审批绑定精确 Plan 内容 |
| GF-H04 | P0 | 同步前缺少当前任务有效性校验 | `src/driver/sync.ts` | 旧 Dispatch 拒绝写入 |
| GF-H05 | P1 | GitHub 成功、本地 receipt 失败时可能重复创建 | `src/driver/submit.ts`、`src/driver/sync.ts` | Operation ID + Reconciliation |
| GF-H06 | P1 | 本地文件隔离不等于权限隔离 | CLI / Activation / Workspace | 凭证隔离、运行边界明确 |
| GF-H07 | P1 | 全局 `current.json` 可能指向另一任务 | `src/driver/dispatch.ts` | 精确 Dispatch Path + 工作区锁 |
| GF-H08 | P1 | 客户端启动成功不等于 Agent 已接收任务 | `src/activation/` | Capability / Ack / Manual fallback |
| GF-H09 | P1 | Consumer revision 基于历史命令数量 | `src/driver/intent.ts`、`src/github/issue-sync.ts` | Gate 接受事件 + workflow epoch |
| GF-H10 | P1 | Organization 默认 Human 规则不完整 | `src/gate/permissions.ts`、bootstrap | 明确 allowlist 与身份不重叠 |
| GF-H11 | P1 | 发布成功、Gate 接受、Workflow 完成语义混用 | Driver receipt / sync / Gate | 分层状态与确认恢复 |
| GF-H12 | P2 | 文档、Schema、Skill 与实现易发生漂移 | `docs/`、`protocol/`、`skills/`、tests | Contract Tests + 发布检查 |

### 2.1 实施前基线检查

```bash
git fetch origin
git checkout main
git pull --ff-only
git rev-parse HEAD
npm ci
npm run typecheck
npm test
npm run build
git diff --exit-code -- dist/
```

若现有脚本名称不同，以 `package.json` 为准。记录测试数量、失败项、当前 Action Runtime、当前协议版本及是否存在未提交的生成文件。不要在有未保存开发改动的工作区直接执行破坏性命令。

---

# Phase 0 — 固定协议与安全边界

**优先级：P0；先完成设计决策，再改授权和同步代码。**

## 0.1 冻结四个不同的状态概念

必须区分：

```text
Workflow State       GitHub 正式状态，由 Gate 管理
Dispatch State       Driver 对某个工作单元的派发/恢复状态
Agent Claim          Agent 在 Outbox 声明的进度或结果
Publication State    Driver 对 GitHub 写入的确认状态
```

明确：

```text
activated  != working
completed claim != report published
report published != Gate accepted
Gate accepted != code merged
```

不要再用单个 `synced` 同时表达这些含义。

## 0.2 冻结 Canonical Source

GitHub 保存正式 Workflow 和授权记录；本地 receipts、inbox、outbox、进程状态均为运行副本。Driver 的本地缓存丢失后必须能够通过 GitHub 与现存本地输出进行恢复或明确进入人工检查，不能猜测。

## 0.3 冻结信任模型

- Human：真实 GitHub User，负责 Human-only 命令。
- Gate：受控的授权和状态迁移执行身份。
- Driver：受控的 Agent-side GitHub 写入身份，只具备必要权限。
- Agent：不可信的任务内容处理者，默认不具有 GitHub 工作流写权限。
- Workspace 文件：通信协议，不自动构成 OS 沙箱。

必须明确：**只校验 GitHub 评论作者或 Marker，不足以证明某个独立 Gate 实例确实批准了某次操作。** 后续安全设计应依赖受保护的执行身份、最小权限、可验证记录及必要的运行隔离。

## 0.4 交付与验收

交付 `docs/plans/v1_hardening_decisions.md`（可由本计划拆分）及协议变更清单，确定 workflow epoch、Approval Record、Operation ID、Dispatch 状态语义。任何新增字段均须有定义、所有者和版本规则。

---

# Phase 1 — Node24、CI 与发布阻塞项

**优先级：P0；可与 Phase 0 并行。**

## 1.1 Runtime 升级

修改 `action.yml`：

```yaml
runs:
  using: node24
  main: dist/index.js
```

同步修改构建目标、开发/CI Node 版本及实际需要的 `engines` 约束。重新运行完整测试并构建提交 `dist/index.js`。不要只改 `action.yml` 而保留旧构建产物。

GitHub 官方公告目前将 Node20 从 Actions runner 移除的日期定为 **2026-09-23**，因此这是发布阻塞项而非普通优化。Node24 对部分旧 OS/架构有兼容性要求，若支持 self-hosted runner，应在文档中列明并实际验证。

## 1.2 CI

CI 至少覆盖：

```text
npm ci
Typecheck
Unit / Integration Tests
Protocol Contract Tests
Build
git diff --exit-code -- dist/
```

增加真实 GitHub-hosted runner 的 Action smoke test，验证 Node24、输入解析、合法事件、非法事件 no-op 和最小权限。测试中不得使用生产 PAT。

## 1.3 发布文件

确认 LICENSE、SECURITY.md、CONTRIBUTING.md、Release Checklist 是否存在，缺失的补齐。SECURITY.md 用于漏洞报告政策，不等同于架构安全说明。

## 验收

- [ ] `action.yml` 与构建目标均为 Node24。
- [ ] CI 全绿且能检测 dist 未同步。
- [ ] 真实 Action smoke test 成功。
- [ ] 发布文档没有旧 Runtime 的错误说明。

---

# Phase 2 — Gate-issued Approval Record 与精确 Plan 绑定

**优先级：P0；本轮最重要的安全改造。**

## 2.1 当前问题

现有 `src/gate/approvals.ts` 将 Human 的 `/approve <plan-id>` 评论本身作为持久审批记录；`src/driver/intent.ts` 根据历史审批评论、Plan ID 和时间戳决定是否派发。该方式无法证明 Gate 当时接受过该命令；Plan Hash 又是在 Driver 构建 Dispatch 时生成，无法证明当前内容等于批准时内容。

目标是区分：

```text
Human Approval Command  = 审批请求
Gate Approval Record    = 已接受的授权事实
```

## 2.2 新 Approval Record

Gate 在严格验证通过后创建受控、机器可读的记录。推荐字段：

```json
{
  "schema": 2,
  "kind": "approval",
  "repository_id": 123456,
  "issue_number": 42,
  "workflow_epoch": "wf_01...",
  "plan_comment_id": 3472198451,
  "plan_sha256": "<64 hex chars>",
  "approval_command_comment_id": 3472200012,
  "approved_by_id": 12345,
  "approved_by_login": "human-login",
  "gate_version": "1.x",
  "operation_id": "approval:<repo-id>:<issue>:<epoch>:<plan-id>"
}
```

记录由 Gate 生成，不能让 Agent 或 Driver 填写 `approved_by`、Plan Hash 或授权结论。`approved_at` 可以用于审计，但不能代替版本/Hash 校验。

### 记录载体选择

优先保持 GitHub-native，可使用 Gate 创建的协议 Comment；是否改用受保护的 GitHub App、独立授权存储或签名记录，须由实际身份/权限模型决定。**普通 Comment + Marker 并不自动具备防伪性。**

若使用 Comment：

- 校验记录由可信 Gate 身份发布；
- Gate 身份不得与 Agent-side Driver 混用；
- Agent 不得持有 Gate 凭证；
- 校验记录所属仓库、Issue、epoch 和 Plan；
- 记录被编辑、删除或出现冲突时 fail closed；
- 对于同一身份下无法阻止的篡改，文档不得宣称强不可篡改；必要时采用独立保护主体或签名并保护密钥。

不建议为了一个 Approval Proof 直接引入大型后台服务，但也不能为了“无服务器”而虚构权限保证。

## 2.3 Plan 内容固化

`/approve <plan-comment-id>` 时：

1. 重新获取 Issue 和指定 Plan；
2. 验证 Human、当前 REVIEW、Plan 所属 Issue、合法 Marker、可信发布者、当前 Plan 身份；
3. 使用冻结的 canonicalization 规则计算 SHA-256；
4. 写入包含 Plan ID + Hash + epoch 的 Approval Record；
5. 确认记录可读取且内容匹配；
6. 再推进 READY；
7. 后续 Driver/Executor 重新验证同一份记录。

Canonicalization 必须固定 UTF-8、换行及是否去除协议 Marker。不要在不同模块分别实现不同的 Hash 算法。可以采用“Hash 原始 Plan 正文的确定性字节”或规范化正文，但必须有测试向量。

Plan 被编辑、删除、替换或最新 Plan 改变后，旧 Approval 不再授权新的执行。不能仅靠 `updated_at <= approved_at` 判断内容未变。

## 2.4 Gate 的状态迁移与恢复

GitHub API 没有跨 Comment 和 Label 的事务。推荐先持久化授权事实，再推进 UI Label；若中途失败，下一次 Gate Reconciliation 根据有效记录恢复，不重复创建授权对象。

不要把“写了 Approval Comment”理解为立即可执行。Driver 必须同时验证当前状态、有效记录和当前 Plan 内容。对于记录写入成功而状态未推进的情况，必须定义可恢复规则和审计信息。

## 2.5 核心测试

- [ ] Human 合法批准当前 Plan 成功。
- [ ] Agent / Unknown Actor 的审批请求拒绝。
- [ ] 历史 `/approve` 当时被 Gate 拒绝，之后手工改 READY，仍不得执行。
- [ ] 仅有 fake ready，无有效 Approval Record，不得执行。
- [ ] 伪造 Approval Marker，不得执行。
- [ ] Plan 审批后被编辑，旧 Approval 失效。
- [ ] 同 ID Plan 内容改变，Hash 不匹配。
- [ ] 新 Plan 发布后旧 Approval 不授权新 Plan。
- [ ] Approval 创建成功、Label 更新失败，可恢复且不重复授权。
- [ ] Approval 被删除、编辑或出现冲突时 fail closed。

---

# Phase 3 — Workflow Epoch、Accepted Events 与旧 Dispatch 失效

**优先级：P0；与 Phase 2 共同构成安全闭环。**

## 3.1 增加 Workflow Epoch

Issue Number 不是完整工作流身份。同一 Issue 可能 Cancel 后重新开启、重新规划或重新执行，不能用旧 Plan ID、历史评论数量推断当前轮次。

建议：

```text
repository_id
+ issue_number
+ workflow_epoch
+ work_revision / accepted_event_id
```

`workflow_epoch` 在新的正式工作流轮次创建，由可信 Runtime 生成并持久化。它不是从时间戳、评论总数或 Label 推导的。恢复时必须能从 GitHub 正式记录获取。

## 3.2 Consumer Revision

当前以所有历史 `/change`、`/choose` 命令数量计算 Consumer Round 的方式应替换。

推荐：

```text
Gate 接受 Human Feedback
       ↓
Accepted Feedback Event
       ↓
创建下一 Consumer Work Revision
```

只统计本 epoch 内 Gate 已接受的事件，使用稳定 Event ID 或 Revision，不统计被拒绝、重复、旧轮次或普通文本评论。Driver 与 Gate 共享严格命令解析和已接受事件读取逻辑，不再维护另一套锚定正则。

## 3.3 Dispatch 身份

建议新 Dispatch ID 绑定：

```text
repo_id / issue / epoch / role / revision
```

Executor 额外绑定 Approval Record ID 与 Plan Hash。Dispatch ID 可以是上述字段的确定性编码或 Hash，不依赖随机时间戳。

例：

```json
{
  "schema": 2,
  "dispatch_id": "gf_...",
  "workflow_epoch": "wf_...",
  "role": "executor",
  "work_revision": "exec_01",
  "plan_comment_id": 3472198451,
  "approval_record_id": 3472200100,
  "plan_sha256": "..."
}
```

## 3.4 旧任务失效规则

下列事件必须使相关旧 Dispatch 失效或进入不可继续状态：

- Human Cancel / Issue 关闭；
- 新 epoch 开始；
- 新 Plan 取代旧 Plan；
- Approval 失效；
- 明确重新规划或重新执行；
- 当前任务与 Dispatch 绑定的 Revision 不一致。

对仍在运行的 Agent：

```text
Canonical Authorization Revoked
        ↓
Driver 标记 obsolete
        ↓
停止接受旧 Outbox 的状态相关写入
        ↓
尽可能通知/取消 Agent
```

**停止同步不等于 Agent 已停止修改本地代码。** 这一点必须同时在客户端和工作区隔离阶段处理。

## 验收

- [ ] 旧 epoch 的 Approval/Dispatch 不会被新一轮复用。
- [ ] 被拒绝的 `/change` 不产生新的 Consumer Revision。
- [ ] 重复 Webhook 不产生重复 Revision。
- [ ] Cancel 后旧 Report 不得推进 DONE。
- [ ] 旧 Agent 晚到输出只能被拒绝或隔离归档。

---

# Phase 4 — Outbox 同步前重新校验与正式确认

**优先级：P0/P1。**

## 4.1 统一 Preflight

在 `src/driver/sync.ts` 的所有状态相关 GitHub 写入前调用统一的 `validateDispatchForSync()`，而不是只验证本地 JSON 格式。

检查：

```text
Repository ID / Issue ID
Current workflow epoch
Current state
Dispatch role + revision
Current Plan ID / Hash（Executor）
Approval Record（Executor）
是否 cancelled / obsolete
当前发布动作是否允许
```

Consumer Plan、Executor Tracker、Blocked、Completion Report 应分别定义允许的状态/阶段，不能共用一个宽松条件。

### 重要一致性限制

GitHub 的“读取状态 → 发起写入”不是原子事务。Preflight 只能缩小竞态，不能保证两次请求之间状态绝对不变。因此应同时：

- 在 Gate 接受协议对象时再次校验 epoch、revision、Plan/Approval；
- 对需要强顺序的写入采用同一受控执行通道或共享协调机制；
- 不把 GitHub Actions concurrency group 误认为跨本地 Driver 的全局事务锁；
- 无法证明当前授权时 fail closed。

## 4.2 统一输出发布接口

建议：

```ts
publishAgentOutput(dispatch, output, operationId)
```

内部：

```text
Read / Validate Outbox
      ↓
Canonical Preflight
      ↓
Find / Reconcile Operation
      ↓
Publish GitHub Object
      ↓
Confirm Remote Object
      ↓
Persist Local Receipt
      ↓
Observe Gate Acceptance
```

如果 Publish 期间出现状态变化，Gate 必须仍能拒绝不属于当前 epoch 的对象。

## 4.3 修正完成链路

当前 Executor `result=completed` 的逻辑应从“直接发布 Report 并设 synced”升级为阶段化流程：

```text
Agent completed claim
       ↓
Driver 校验 output + 当前授权
       ↓
Report Published
       ↓
Gate validates Report / state / epoch
       ↓
DONE Confirmed
```

如果 Agent 在没有 Tracker 的情况下直接写 completed，Driver 应按冻结协议补齐合法 Tracker 或拒绝并要求修正，不能发布一个无法合法触发 DONE 的孤立 Report。

`validation="passed"` 只是 Agent 的声明。它不等于系统已经独立运行测试。V1 可以保留该字段，但不能把它当成可信 CI 证明；若需要强验证，另由确定性测试命令或 CI 产出可验证结果。

## 4.4 Receipt 状态建议

建议把单一 `synced` 拆分为：

```text
prepared
activation_pending
notified
running_claimed
publishing
published
accepted
blocked
obsolete
failed
```

不要求全部成为 GitHub Label。它们属于 Driver Runtime 状态，具体可以简化，但必须明确 `published` 和 `accepted` 的区别。终态只在真实确认后写入；失败保留可恢复上下文。

## 验收

- [ ] Cancel 后旧 Plan/Tracker/Report 不再被有效同步。
- [ ] 新 epoch 开始后旧 Dispatch 不会复活。
- [ ] Report 发布成功但 Gate 未接受，不显示 Workflow 已完成。
- [ ] Gate 暂时失败时 Driver 可以恢复确认。
- [ ] Agent completed 不被直接当成 DONE。

---

# Phase 5 — GitHub 写入幂等与 Crash Recovery

**优先级：P1；长期运行前必须完成。**

## 5.1 定义 Operation ID

为每个会产生 GitHub 副作用的动作定义稳定 ID：

```text
submit:<submission-id>
plan:<dispatch-id>
tracker:<dispatch-id>
report:<dispatch-id>
notice:<dispatch-id>:<notice-revision>
approval:<repo>:<issue>:<epoch>:<plan-id>
```

Operation ID 必须与内容/任务身份绑定，不能每次重试生成新的随机值。

## 5.2 Producer Submit

当前 `createIssue()` 成功后再写 receipt 的窗口必须补齐。

建议本地 `submit.json` 包含稳定 `submission_id`，创建 Issue 时写入机器可识别的 Source ID。重试时：

1. 读取本地 Operation；
2. 查询 GitHub 是否已有相同 Submission ID 的 Issue；
3. 存在则 adopt 远端 Issue ID；
4. 不存在且已确认可重试才创建；
5. API 超时/未知结果先 reconcile，不能直接再次 POST。

需要处理分页、权限错误及检索不确定性，不能只凭标题判断重复。

## 5.3 Plan / Tracker / Report

统一发布策略：

```text
Prepare Operation
      ↓
Search Existing Remote Object by Operation ID
      ├─ exists → validate + adopt
      └─ absent → publish
                       ↓
                 validate response
                       ↓
                 persist receipt
```

Plan、Report、普通 Notice 都要覆盖；不能只对 Tracker 做恢复。

如果远端存在相同 Operation ID 但内容 Hash 不一致，必须进入 Conflict，不可直接覆盖或再发一条。对于已经被 Human Review/Approve 的 Plan，更不能在重试时悄悄改变正文。

## 5.4 正确认识 Exactly-once

GitHub Issue/Comment API 不提供通用跨请求事务，也不保证按自定义 Operation ID 原子去重。因此不能承诺严格 exactly-once。

V1 合理目标是：

> **At-least-once retry + deterministic deduplication + remote reconciliation + fail-closed conflict handling。**

对于无法确定远端是否成功的请求，如果有重复风险，优先进入待确认状态，而不是盲目重试。需要强互斥时使用单受控写入者或外部协调机制，并在文档中明确限制。

## 5.5 故障注入

针对每个写入点测试：

```text
Before POST
After POST before response
After response before receipt
After receipt before next action
During tracker edit
During Gate acceptance
```

验证恢复后不会产生错误状态、重复授权或覆盖新版本。

## 验收

- [ ] Producer API 成功、receipt 丢失后能 adopt 旧 Issue。
- [ ] Plan/Report API 超时后先 reconcile。
- [ ] 同 Operation ID、相同内容不会重复发布。
- [ ] 同 Operation ID、不同内容进入 Conflict。
- [ ] Driver 重启不丢失已确认远端对象。

---

# Phase 6 — 本地凭证、文件边界与实际安全模式

**优先级：P0/P1；凭证继承修复应与 Phase 1 同步。**

## 6.1 修正安全声明

Workspace Protocol 负责通信隔离，不等于 OS 权限隔离。同一用户下拥有终端能力的 Agent 可能读取其可访问的文件、环境变量、Git 凭证和 Driver Runtime 文件。不能仅靠 Skill 中的“不要修改 inbox”作为安全边界。

正式区分：

### Personal Mode

- 适合个人开发和 dogfood；
- 可共享操作系统用户或 Git 工作区；
- 不保证对恶意/被注入的 Agent 的强权限隔离；
- 仍然必须防止误同步、旧任务和凭证意外传递。

### Secure Mode

只有在真实身份与运行隔离满足要求后才宣称：

- Human / Agent-side Driver / Gate 使用独立受控身份；
- Agent 无法取得 Gate/Driver 凭证；
- Agent 可写目录与 Driver 私有状态有操作系统级权限边界；
- 关键 GitHub 写入受到最小权限与受控执行路径保护。

## 6.2 凭证继承修复

检查 CLI 和全部 Activation Adapter 的 `spawn` 路径。不得默认把完整 `process.env` 原样传给 Agent 子进程。

建议：

```text
Driver Environment
    ├── GitHub Credential
    └── Other Runtime Secrets
              │
              ▼
       Explicit Safe Env Builder
              │
              ▼
       Agent Process Environment
       （不包含 Driver Secret）
```

使用允许列表、必要的 PATH/HOME/临时目录和客户端所需环境变量，避免把 GitHub Token、App Private Key、Webhook Secret 等传入。不要在日志、Prompt、Workspace、错误输出中打印凭证。

### 注意

环境变量清理只能减少意外泄露；如果 Agent 与 Driver 属于同一 OS 用户且能访问相同凭证文件/进程，仍不能构成强隔离。Secure Mode 应采用真正的独立用户、受限容器或等效权限边界，并验证实际文件访问权限。

## 6.3 Driver 私有状态

将以下内容移出 Agent 可写项目目录，或放入受保护的 Runtime 根目录：

```text
Credentials
Private Keys
Authorization Cache
Receipt / Operation Journal
Driver Configuration containing secrets
```

`.gateflow/inbox/outbox` 保留为 Agent 通信面。Agent 不得通过修改 receipt 或 context 文件改变正式授权；Driver 必须从自己的可信状态或 GitHub 重新验证关键字段。

## 6.4 文件系统防护

对所有来自 Dispatch/Outbox 的路径：

- 严格限制相对路径和允许文件名；
- 禁止 `..`、绝对路径和越界；
- 对 symlink / junction / reparse point 做明确防护；
- 打开文件时验证实际目标仍在允许根目录；
- 对文件大小和目录扫描数量设上限；
- 避免先检查后打开带来的明显 TOCTOU 问题；
- 写入采用临时文件 + 原子替换；
- 不跟随 Agent 提供的任意报告路径。

Windows 场景应额外测试 Junction、大小写、盘符和路径规范化。不要假设 POSIX 的 `O_NOFOLLOW` 在所有平台行为一致。

## 6.5 Organization 权限

个人仓库可默认真实 owner 为 Human；Organization 仓库必须显式配置 Trusted Human allowlist。禁止把 Organization login 当成普通 Human，也应禁止 Human 与 Trusted Agent/Gate 身份重叠。使用 GitHub API 可验证的 owner type，不靠名称猜测。

## 验收

- [ ] Agent 启动环境不包含 Driver GitHub Token。
- [ ] Driver 私有状态不再暴露在普通 Agent Outbox 中。
- [ ] Path traversal / symlink / Windows Junction 测试通过。
- [ ] Secure Mode 文档不再宣称“仅靠文件协议即可隔离权限”。
- [ ] Organization 空 Human allowlist 在安装/启动前报错。

---

# Phase 7 — 精确任务绑定、客户端适配与并发控制

**优先级：P1。**

## 7.1 去除全局 current 的正式任务身份作用

当前多个 Dispatch 可能连续覆盖 `.gateflow/current.json`，Agent 若稍后读取全局 current，可能处理错误任务。

正式启动 Prompt/通知必须包含精确路径：

```text
.gateflow/inbox/<dispatch-id>/dispatch.json
```

Agent 只能处理指定 Dispatch，所有输出写对应 outbox。`current.json` 可以保留为手动 UI 指针，但不得用它重新决定已经分配的任务身份。

## 7.2 Inbox 不得在旧任务运行时被静默重写

同一 Dispatch ID 的输入应绑定确定性内容 Hash。若需要新反馈或新任务版本，应创建新 Revision 或显式可版本化的反馈事件，不允许无提示覆盖正在执行的任务快照。

建议记录：

```text
Dispatch ID
Input Snapshot Hash
Workflow Epoch
Plan/Approval Binding
Workspace Path
Agent Activation Handle（如有）
```

## 7.3 工作区并发策略

V1 默认每个 Git Worktree 同时只允许一个活动 Executor。Consumer 可在满足只读/不修改代码约束时并行，但要防止与 Executor 对同一工作区产生冲突。

默认策略：

```text
One Workspace → One Active Executor
```

发现冲突时排队/提示，不抢占。未来确实需要多个 Executor 再引入独立 Git Worktree，不做复杂 Agent Registry。

同一 Project 的多个 Driver 进程也要检测重复启动；本地锁仅能约束同机实例，不能作为跨机器全局互斥。多设备共用同一仓库时，应明确只允许一个受控写入者，或另行设计共享协调机制。

## 7.4 Activation 语义

区分：

```text
Prepared
Notification Sent
Client Process Started
Task Accepted / Session Created
Agent Working Claim
```

`spawn()` 成功不等于 Agent 已接收任务。若客户端提供稳定 Task/Session API，可保存 Handle 并接收 Ack；没有则只报告 `notified`，不能伪造 `started`。

ChatGPT/ZCode Adapter 必须 capability-based：

- 有官方、稳定、可验证的外部启动能力时使用；
- 不存在时采用 Manual Activation；
- 不依赖私有接口、窗口坐标和脆弱 UI 自动点击；
- 不将客户端定时 Prompt 用作任务发现机制；
- Cancel 支持 best effort，无法取消时明确返回 Unsupported/Unknown。

## 7.5 取消后的本地代码风险

即使 Driver 拒绝旧 Outbox，Agent 仍可能继续改工作区或 Push。Personal Mode 需通过 Skill/通知要求停止，并提供冲突检查；若要保证旧 Agent 不能继续影响主工作区，应在受限进程/独立 Worktree/独立 Git 凭证中执行，并在授权撤销时收回相应访问。不要把 `cancel()` no-op 描述成已终止任务。

## 验收

- [ ] 两个 Issue 连续派发不会读错 Dispatch。
- [ ] 旧任务不会因 current 改变而切到别的 Issue。
- [ ] 同一 Worktree 不会自动启动两个 Executor。
- [ ] Activation 失败不推进 WORKING。
- [ ] 客户端无自动接口时完整 Manual 闭环可用。
- [ ] Cancel 后旧 Session 输出被拒绝，取消能力状态准确呈现。

---

# Phase 8 — Protocol、Skill、测试与文档一致性

**优先级：P1/P2；最终 Release 阶段完成。**

## 8.1 协议版本策略

此次涉及 Approval Record、epoch、Dispatch/Receipt 语义的变更，应作为一次明确的破坏性协议升级处理。建议：

```text
GitHub Protocol Schema 2（或当前下一正式版本）
Workspace Protocol Schema 2（若字段/语义不兼容）
```

实际版本号以当前仓库已发布版本为准，不机械重复旧计划的版本号。保持 GitHub Protocol 与 Workspace Protocol 独立演进。

## 8.2 单一协议定义

集中定义：

```text
Labels / States / Transitions
Commands / Accepted Events
Markers / Approval Record
Dispatch / Context / Result / Receipt
Operation ID / Epoch / Revision
```

Gate、Driver、Schema、测试、Skill 不应分别维护不一致的字符串或正则。对外协议字段必须有 JSON Schema/类型定义和测试向量。

## 8.3 Skill 更新

保持三个层次：

```text
Workspace Protocol
        ↓
gateflow-agent Skill（读写规则、汇报方式）
        ↓
Consumer / Executor / Producer Role Skill
```

Skill 不应重新引入 GitHub MCP、Marker 拼接或 Label 迁移。补充：

- 精确 Dispatch Path；
- 不修改 inbox / Driver 私有状态；
- 不因旧会话上下文跳过新输入；
- 任务失效时停止并报告；
- Progress/Report 只描述真实进展；
- 不将 Agent Claim 误认为系统验收；
- 不要求每个 Shell 命令都写进度。

## 8.4 测试分层

建议：

```text
tests/
├── gate/
├── driver/
├── workspace/
├── activation/
├── protocol/
├── integration/
└── security/
```

重点测试矩阵：

| 场景 | 预期 |
|---|---|
| 历史被拒绝 approve + fake ready | 不派发 |
| Plan 审批后编辑 | 拒绝执行 |
| 新 epoch + 旧 Approval | 拒绝 |
| Cancel + 旧 Report 晚到 | 拒绝 |
| GitHub POST 成功后超时 | Reconcile，不盲目重复 |
| Receipt 丢失 | Adopt 远端对象 |
| 同 Operation ID 不同内容 | Conflict |
| 两个 Dispatch 覆盖 current | Agent 仍绑定精确 ID |
| Agent 伪造 approve 输出 | Schema 拒绝 |
| Agent 修改 inbox / receipt | 不改变正式授权 |
| 无客户端自动启动 API | Manual fallback |
| Gate 接受前 Driver 重启 | 可恢复确认 |
| Organization 未配置 Human | 启动/安装失败 |
| Node24 Action | 真实 runner 通过 |

## 8.5 E2E

使用独立测试仓库和测试身份，不使用真实生产任务。至少验证：

```text
Issue → Consumer → Plan → Human Approve
→ Executor → Progress → Blocked/Resume → Report → DONE
```

分别验证 ChatGPT、ZCode 及混合 Consumer/Executor。对于当前没有稳定自动启动接口的客户端，Manual E2E 是有效验收；不能把未验证的自动唤醒写成已完成。

额外进行故障 E2E：Driver 重启、重复事件、API 超时、取消后旧输出、Plan 更新、同一工作区两个任务。

## 8.6 文档与发布

更新：

```text
README.md
docs/architecture-v1.md
docs/protocol.md
docs/workspace-protocol.md
docs/driver.md
docs/agent-skills.md
docs/security.md
docs/integration.md
docs/release.md
```

将旧 V0 历史文档归档，不让旧“AI 直接 GitHub MCP”流程继续作为正式 Quick Start。明确 Personal/Secure、安全限制、Manual-first、故障恢复、协议升级方式。

---

# 9. 推荐执行顺序与任务拆分

## 9.1 实施顺序

```text
Phase 0  架构/协议决策与当前 SHA 基线
   │
   ├── Phase 1  Node24 / CI / 凭证继承紧急修复
   │
   ▼
Phase 2  Gate-issued Approval Record
   ▼
Phase 3  Workflow Epoch / Accepted Events / Dispatch 失效
   ▼
Phase 4  Sync Preflight / Gate Acceptance 确认
   ▼
Phase 5  Operation ID / Reconciliation / Crash Recovery
   ▼
Phase 6  本地安全边界 / Organization 权限
   ▼
Phase 7  精确 Dispatch / 工作区并发 / Activation
   ▼
Phase 8  Protocol / Skills / Tests / E2E / Release
```

Phase 2～4 应作为一个完整安全里程碑验收，不能只完成 Approval Record 后就宣布安全闭环。Phase 5～7 可在接口冻结后部分并行，但最终必须跑统一 E2E。

## 9.2 可直接拆给开发 Agent 的任务

| Task | 名称 | 主要交付 | 依赖 |
|---|---|---|---|
| H01 | Runtime / CI 修复 | Node24、dist、smoke test | Phase 0 |
| H02 | Approval Schema | 记录格式、Hash、验证器 | Phase 0 |
| H03 | Gate Approval Issuance | 接受审批、持久记录、恢复 | H02 |
| H04 | Workflow Epoch | epoch、revision、accepted events | H02 |
| H05 | Dispatch Identity | 新 ID、输入绑定、旧任务失效 | H04 |
| H06 | Sync Authorization Preflight | 统一同步前校验 | H03、H05 |
| H07 | Gate Publication Acceptance | Tracker/Report 二次验证与确认 | H06 |
| H08 | Operation ID / Reconcile | Submit/Plan/Tracker/Report 幂等 | H05 |
| H09 | Crash Recovery | receipt、远端 adopt、未知结果处理 | H08 |
| H10 | Credential Isolation | 子进程环境、私有状态迁移 | Phase 0 |
| H11 | Workspace FS Hardening | Path、symlink、大小限制、原子写 | H05 |
| H12 | Identity / Org Permissions | Human allowlist、身份不重叠 | H03 |
| H13 | Exact Dispatch Activation | 不依赖 current 的任务绑定 | H05 |
| H14 | Workspace Concurrency | 单 Executor/Worktree 锁与冲突 | H13 |
| H15 | Client Capability / Cancel | ChatGPT/ZCode/Manual 语义 | H13 |
| H16 | Protocol / Skill Sync | Schema、文档、Skill 更新 | H03～H15 |
| H17 | Security Regression Suite | 授权、旧任务、伪造、竞态 | H03～H15 |
| H18 | Real E2E / Release | 混合客户端、故障注入、发布 | H16、H17 |

任务应可独立领取、开发、提交、验证；不要将所有内容交给一个巨大 Task。涉及同一协议的任务先冻结接口再并行，最后安排一次集成验收。

---

# 10. MVP 收尾与正式发布门槛

## 10.1 第一里程碑：安全可用

必须完成：

```text
Node24
Gate-issued Approval
Plan Hash Binding
Workflow Epoch
Sync Preflight
Old Dispatch Invalidation
Credential Inheritance Fix
```

达到此里程碑后可以继续个人 dogfood，但若文件/进程权限仍共享，应明确标注 Personal Mode，不宣称 Secure Mode。

## 10.2 第二里程碑：长期运行可靠性

必须完成：

```text
Operation ID
Remote Reconciliation
Crash Recovery
Published / Accepted 区分
Exact Dispatch Binding
Single Active Executor Per Worktree
```

达到后再开启长期常驻 Driver，并通过至少一次真实异常恢复测试。

## 10.3 正式 Release Definition of Done

### Runtime

- [ ] Node24 Action 与 dist 正确。
- [ ] CI / Protocol Contract / Security Tests 全绿。
- [ ] 真实 GitHub Action smoke test 通过。

### Authorization

- [ ] Gate 接受审批时固化 Plan ID + Hash + epoch。
- [ ] Fake Ready / 历史被拒绝命令无法获得执行权。
- [ ] Approval 篡改/删除/冲突 fail closed。
- [ ] Human / Agent / Gate 身份边界明确。

### Dispatch / Sync

- [ ] 所有状态相关写入有当前任务 Preflight。
- [ ] 旧 epoch、旧 Plan、Cancel 后的输出不能有效同步。
- [ ] Report Published 与 DONE Confirmed 分离。
- [ ] Operation ID 覆盖 Submit/Plan/Tracker/Report。
- [ ] API 未知结果先 reconcile，不盲目重试。

### Workspace / Client

- [ ] 精确 Dispatch Path，不依赖全局 current。
- [ ] 一个 Worktree 不会自动运行两个 Executor。
- [ ] Driver Secret 不传入 Agent 进程环境。
- [ ] Workspace Path/Symlink/文件大小防护通过。
- [ ] Manual Activation 完整可用。
- [ ] ChatGPT/ZCode 自动能力只按真实验证结果声明。

### E2E / Docs

- [ ] 完整 Plan → Approve → Execute → Report 闭环。
- [ ] Cancel、重启、API 超时、重复事件故障场景通过。
- [ ] Personal 与 Secure Mode 的真实安全保证写清楚。
- [ ] 旧协议与旧 Skill 文档不再误导新用户。

---

# 11. 最终建议

GateFlow 现在最值得做的不是继续增加调度能力，而是把现有两条链路做扎实：

```text
授权链：
Human → Gate → Approved Plan Proof → Driver → Executor

交付链：
Agent Claim → Driver Validation → GitHub Publication
→ Gate Acceptance → Canonical State
```

本轮最重要的四个改动是：

1. **审批必须由 Gate 固化，而不是靠历史 `/approve` 评论反推。**
2. **每次同步必须绑定当前 epoch、Plan 和授权，旧任务不能复活。**
3. **GitHub 写入必须使用稳定 Operation ID 和远端 Reconciliation，不依赖本地 receipt 恰好成功。**
4. **Workspace 是通信隔离；真正的凭证和权限隔离必须由运行环境保证。**

完成这些以后，现有 GitHub-native + Local Driver + Workspace Protocol + Agent Skill 的架构就足够支撑长期 dogfood。后续再根据真实使用需求考虑自动唤醒增强、多 Worktree 或远程 Driver，而不是现在继续扩大系统复杂度。

---

## 12. 参考与核对范围

项目源码（实施时以锁定的 commit SHA 为准）：

- https://github.com/jesongit/gateflow
- https://raw.githubusercontent.com/jesongit/gateflow/main/action.yml
- https://raw.githubusercontent.com/jesongit/gateflow/main/src/gate/approvals.ts
- https://raw.githubusercontent.com/jesongit/gateflow/main/src/driver/intent.ts
- https://raw.githubusercontent.com/jesongit/gateflow/main/src/driver/dispatch.ts
- https://raw.githubusercontent.com/jesongit/gateflow/main/src/driver/sync.ts
- https://raw.githubusercontent.com/jesongit/gateflow/main/src/driver/submit.ts
- https://raw.githubusercontent.com/jesongit/gateflow/main/src/activation/chatgpt.ts
- https://raw.githubusercontent.com/jesongit/gateflow/main/src/activation/zcode.ts
- https://raw.githubusercontent.com/jesongit/gateflow/main/package.json

GitHub 官方资料：

- Node20 Action deprecation（2026-08-25 更新移除日期）：https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
- Actions Metadata Syntax：https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax

本计划是开发方案，不表示代码已经修改、测试已经执行或客户端自动接口已经验证。
