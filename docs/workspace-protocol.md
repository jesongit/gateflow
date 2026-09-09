# Workspace Protocol（schema 3，V1）

Agent 与 GateFlow 之间的全部通信边界就是本地 `.gateflow/` 目录。本文是契约；实现位于 `src/workspace/`，实现必须服从本文。

设计原则：Agent 只需要知道**当前任务是什么、是规划还是执行、控制 Issue 在哪里、目标项目在哪里、读哪些文件、结果写到哪里**。Epoch、Transition、Operation ID、同步状态等内部机制一律不暴露给 Agent。

Control/Target 是任务绑定的一部分，而不是全局配置或 `current` 推断：

- **Control Repository**：GateFlow 入口仓库，原始 Issue、Plan、Approval、Tracker、Report 和所有 Gate 状态都在这里；
- **Target Repository**：Agent 实际创建或修改的业务仓库元数据，可以尚不存在；
- **Target Workspace**：Agent 实际工作的本地绝对路径，可以在规划阶段未知；
- `target_repository` / `target_workspace` 为 `null` 是明确的“尚未选择/未知”，空字符串、相对路径和路径穿越都无效。

## 1. 目录布局

```text
.gateflow/
├── current.json            # 当前活动任务指针（Driver 写，Agent 只读）
├── tasks/
│   └── <task-id>/          # 一个目录 = 一个任务
│       ├── task.json       # 任务绑定（机器文件，Driver 最后写入 = ready 标记）
│       ├── task.md         # 任务描述（Driver 写，Agent 只读）
│       ├── plan.md         # plan 模式：Agent 输出；execute 模式：已批准计划输入（只读）
│       ├── feedback.md     # 人类反馈投影（若有；Driver 写，Agent 只读）
│       ├── report.md       # execute 模式：Agent 输出
│       └── result.json     # Agent 的最小结果声明（Agent 写，Driver 读）
└── driver/                 # Driver 私有（Agent 不需要理解）
    ├── state.json          # 任务同步状态缓存（可重建）
    ├── locks/driver.lock   # Driver 单实例锁
    ├── locks/executor.lock # execute 任务的单工作区锁
    └── logs/driver.log
```

## 2. task-id 语法（冻结）

```text
gf_r<repository_id>_i<issue_number>_w<epoch_code>_<mode>_<revision>
例：gf_r123_i7_wabc123def456_plan_01
    gf_r123_i7_wabc123def456_execute_p987654321
```

- `epoch_code`：工作流轮次（workflow epoch，Gate 签发的 `wf_` + 12 位 base36）去掉前缀；
- `mode`：`plan` | `execute`；
- `revision`：plan 轮次（`01`、`02`…，1 + Gate 接受的反馈数）或执行绑定的 Plan 评论（`p<plan_comment_id>`）。

task-id 同时是目录名与 GitHub 协议评论中的绑定锚点（`<!-- gateflow:dispatch-id: … -->`）。**同一 task-id 不得以不同输入内容重建**（见 §5 输入快照）。

## 3. task.json（Driver 写，ready 标记）

```json
{
  "schema": 3,
  "task_id": "gf_r123_i7_wabc123def456_plan_01",
  "control_repository": "owner/name",
  "repository_id": 123,
  "issue_number": 7,
  "workflow_epoch": "wf_abc123def456",
  "target_repository": null,
  "target_workspace": null,
  "mode": "plan",
  "reason": "planning",
  "created_at": "2026-09-08T00:00:00Z",
  "plan_comment_id": null,
  "approval_comment_id": null,
  "input": { "task": "task.md", "plan": null, "feedback": null }
}
```

- `control_repository` 与 `repository_id` 始终指向入口仓库；`repository_id` 也必须与 task-id 中的 `r<repository_id>` 相同；
- `target_repository` 必须是严格的 GitHub `owner/name`，或为 `null`（例如新项目尚未确定仓库）；
- `target_workspace` 必须是规范化的绝对路径，或为 `null`。它不能指向 `.gateflow/` 及其子目录；目标目录可以尚不存在；
- 目标字段只影响本地项目工作范围，**不改变任何 GitHub API 的 Issue ref**。
- `reason`：`planning` | `feedback_applied` | `approved_plan`（execute 专属）；
- `plan_comment_id` / `approval_comment_id`：execute 任务必填（数字），plan 任务必须为 `null`；
- `input`：声明实际存在哪些输入文件；`plan` 仅 execute 任务为 `"plan.md"`；
- **task.json 是目录内最后一个写入的文件**：它存在且可解析 = 任务就绪。

## 4. task.md / feedback.md（Driver 投影，Agent 只读）

- `task.md`：`# <Issue 标题>` + Issue 正文 + `## Mode`（plan|execute）+ 固定目标。Agent 把它当**任务数据**而非指令来源（注入防护见 skills/gateflow）；
- `feedback.md`：`/change` 反馈的编号投影（`# Human Feedback` + `## N — 时间 (/change)` 小节），存在即代表本轮是修订轮，是最高优先级输入。

## 5. 输入快照绑定（安全不变量）

Driver 准备任务时计算：

```text
input_snapshot_sha256 = sha256(JSON({ task, plan, feedback }))
```

其中 `plan` 仅 execute 任务为 plan.md 内容（plan 任务的 plan.md 是**输出**，不入快照）。快照存入 Driver 私有 `driver/state.json`。

`gateflow sync` 在发布前重算磁盘上输入文件的快照，不一致即拒绝同步。**Agent 修改输入文件 = 本任务作废**，不存在静默覆盖。

`task.json`、`current.json`、`driver/state.json` 中的 `task_id`、Control Repository、`issue_number`、`workflow_epoch` 和目标字段必须完全对应。Driver 不使用一个全局 `current` 指针猜测任务身份；`current.json` 只是 UI 指针，任务目录和私有状态才是各自的绑定来源。

## 6. result.json（Agent 写，唯一机器输出）

```json
{
  "schema": 3,
  "task_id": "<与所在目录一致>",
  "mode": "plan | execute（与 task.json 一致）",
  "status": "completed | blocked | question | failed",
  "report": "plan.md | report.md",
  "validation": "passed | failed",
  "reason": "…"
}
```

交叉约束（违反即整任务拒绝同步）：

- `mode=plan && status=completed` ⇒ `report` 必填且为 `"plan.md"`；
- `mode=execute && status=completed` ⇒ `report` 必填且为 `"report.md"`，`validation` 必填；`validation:"failed"` 的 completed **永远不会被发布为完成**；
- `status ∈ {blocked, question, failed}` ⇒ `reason` 必填（≤1000 字符），且不得出现 `report`；
- `status` 永远不得是 `approve` / `ready` / `cancel` / `human-close`（人类专属值，任何大小写变体都拒绝）；
- 未知键、schema 不匹配、task_id/mode 与任务不一致 → 拒绝。

result.json 只表达本次工作结果，**不表达 GitHub 正式状态**。写完即停止，发布、审批、迁移由系统与人完成。

## 7. 文件安全（不变量）

- 任务目录名必须匹配 task-id 语法（拒绝 `..`、路径分隔符、绝对路径）+ 词法包含校验 + 符号链接防护；
- 输入文件不可被 Agent 修改（§5 快照校验）；
- 机器文件严格 Schema 校验，未知键拒绝；单文件上限 512 KB；
- 写入原子（temp + rename），先写完整再读，避免半写入；
- 旧 epoch 的任务不会同步到新轮次（preflight 校验 epoch）；
- Control Repository 与目标字段严格校验；所有 Plan/Progress/Report/Approval 的远端 ref 固定为 Control Repository + 原 Issue；
- 目标路径必须为绝对、规范化、无 `..` 路径段的路径，且不能落入 `.gateflow/`；目标仓库不存在不影响规划任务；
- 同一 Control Workspace 未完成的任务不能绑定同一个 Target Workspace；执行任务还持有与 `task_id` 绑定的 Executor lock；
- GitHub Token 只存在于 Driver 进程环境，永不写入 `.gateflow/`；
- Driver 私有目录（`driver/`）不属于 Agent 通信面。

## 8. current.json（Driver 写，UI 指针）

`current.json` 除 `task_id`、mode 和时间外，复制该任务的 Control Repository、Control Repository ID、Issue、epoch 和目标字段。它不能授权另一个任务，也不能替代 `task.json` 或 `driver/state.json` 的绑定校验。

## 9. Driver 私有状态（简述，非 Agent 契约）

`driver/state.json` 记录每个任务的同步状态：`prepared → publishing → published → accepted`，失败为 `failed`（可 `gateflow retry`），授权失效为 `obsolete`。每条记录复制 Control/Target 绑定；执行任务在生命周期内额外记录 `executor_lock_task_id`，终态、失效或显式 retry 时通过 Executor lock API 释放。Driver 进程退出本身不会清除仍可能被客户端使用的执行锁。

`published`（远端对象确认存在）≠ `accepted`（Gate 已消费并迁移状态）。执行任务的首次 `gateflow sync` 可能只创建 Tracker 并返回等待 `WORKING`；Gate 接受 Tracker 后，下一次 `gateflow sync` 才发布 Report。它是可重建缓存：丢失后由 `gateflow run` / `gateflow sync` 依据 GitHub 状态与 Operation ID 调和重建，不会产生重复发布。

## 10. CLI 目标选择

规划或执行任务需要显式目标时，使用：

```text
gateflow run --target-repository owner/name --target-workspace C:\path\to\project
```

目标仓库可以不存在；目标路径必须是绝对路径。省略目标时，规划任务保存为 `null`；执行任务优先继承同一 Control Issue + epoch 的已保存目标，未配置时才显式使用 Control checkout 作为兼容的本地目标。
