# Workspace Protocol（schema 3，V1）

Agent 与 GateFlow 之间的全部通信边界就是本地 `.gateflow/` 目录。本文是契约；实现位于 `src/workspace/`，实现必须服从本文。

设计原则：Agent 只需要知道**当前任务是什么、是规划还是执行、读哪些文件、结果写到哪里**。Epoch、Transition、Operation ID、同步状态等内部机制一律不暴露给 Agent。

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
    ├── locks/driver.lock   # 单实例锁
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
  "repository": "owner/name",
  "repository_id": 123,
  "issue_number": 7,
  "workflow_epoch": "wf_abc123def456",
  "mode": "plan",
  "reason": "planning",
  "created_at": "2026-09-08T00:00:00Z",
  "plan_comment_id": null,
  "approval_comment_id": null,
  "input": { "task": "task.md", "plan": null, "feedback": null }
}
```

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
- GitHub Token 只存在于 Driver 进程环境，永不写入 `.gateflow/`；
- Driver 私有目录（`driver/`）不属于 Agent 通信面。

## 8. Driver 私有状态（简述，非 Agent 契约）

`driver/state.json` 记录每个任务的同步状态：`prepared → publishing → published → accepted`，失败为 `failed`（可 `gateflow retry`），授权失效为 `obsolete`。`published`（远端对象确认存在）≠ `accepted`（Gate 已消费并迁移状态）。它是可重建缓存：丢失后由 `gateflow run` / `gateflow sync` 依据 GitHub 状态与 Operation ID 调和重建，不会产生重复发布。
