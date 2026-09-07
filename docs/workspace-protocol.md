# Workspace Protocol v2（冻结契约）

> 本文是 Workspace Protocol 的**冻结契约**（Schema 2，2026-09 Hardening）：目录结构、JSON Schema、dispatch_id 规则、角色输出白名单、文件生命周期与安全约束。决策依据见 [docs/plans/v1_hardening_decisions.md](plans/v1_hardening_decisions.md)。
> 实现以 `src/workspace/` 为准；机器 Schema 同步维护在 `protocol/workspace-schema-v2.json`。
> 原则：**状态和动作使用 JSON（严格 Schema），长内容使用 Markdown（不解析语义）。**
>
> **Schema 2 破坏性变化摘要**：所有机器文件 `schema: 2`；dispatch_id 绑定 workflow epoch；receipt 状态机 `dispatched → publishing → published → accepted`（+ `failed` / `obsolete`，单一 `synced` 已废除）；dispatch/context 绑定 `workflow_epoch`，context 携带 `input_snapshot_sha256`；Producer 提交携带稳定 `submission_id`；Driver 私有状态（receipts / locks / logs）移入 `.gateflow/driver/`。

## 1. 目录布局

目标仓库根目录下 `.gateflow/`（运行时目录，必须加入 `.gitignore`）：

```text
.gateflow/
├── current.json                  # 人工查看用指针（不是任务身份；Agent 只处理指派的 inbox/<id>/dispatch.json）
├── inbox/<dispatch_id>/
│   ├── dispatch.json             # 机器协议：任务描述（含 workflow_epoch；最后写入的就绪标记）
│   ├── context.json              # 机器协议：来源锚点（plan_comment_id / plan_sha256 / input_snapshot_sha256 / …）
│   ├── TASK.md                   # Issue 投影（标题 + 正文 + 目标）
│   ├── PLAN.md                   # 仅 executor：被批准的 Plan 原文（冻结规范化后的内容）
│   └── FEEDBACK.md               # 人类反馈投影（仅 Gate 已接受的事件，可有可无）
├── outbox/<dispatch_id>/
│   ├── status.json               # 运行状态（working/blocked/failed）
│   ├── result.json               # 终态结果（completed/plan_ready/blocked/question/failed）
│   ├── PROGRESS.md               # 人类可读进度（Driver 不解析语义）
│   ├── PLAN.md                   # 仅 consumer：产出的 Execution Plan
│   └── REPORT.md                 # 仅 executor：完成报告
├── submit/                       # Producer 本地提交（TASK.md + submit.json，schema 2 携带 submission_id）
└── driver/                       # Driver 私有状态（Agent 通信面之外，禁止触碰）
    ├── receipts/<dispatch_id>.json   # Driver 本地缓存（非正式状态，可重建）
    ├── locks/                        # executor.lock（同 Worktree 单 Executor）+ driver.lock（同机单 Driver）
    └── logs/driver.log
```

写权限（冻结）：

```text
.gateflow/current.json   Driver 写
.gateflow/inbox/**       Driver 写，Agent 只读（系统输入，不可修改）
.gateflow/outbox/**      Agent 写，Driver 读
.gateflow/receipts/**    Driver 写（本地缓存）
.gateflow/submit/**      Producer Agent 写（用户明确要求时）
.gateflow/logs/**        Driver 写
```

## 2. 机器文件 Schema（schema = 1）

所有 JSON 文件必须带 `"schema": 1`；版本不匹配 = 校验失败（no-op + 日志）。

### 2.1 dispatch.json

```json
{
  "schema": 1,
  "dispatch_id": "gf_r123_i42_consumer_01",
  "repository": "owner/name",
  "repository_id": 123,
  "issue_number": 42,
  "role": "consumer",
  "reason": "planning",
  "created_at": "2026-09-06T17:00:00Z",
  "plan_comment_id": null,
  "approval_comment_id": null,
  "input": { "task": "TASK.md", "plan": null, "feedback": "FEEDBACK.md" }
}
```

- `role`：`"consumer" | "executor"`。
- `reason`：consumer → `"planning" | "feedback_applied"`；executor → 恒为 `"approved_plan"`。
- `plan_comment_id` / `approval_comment_id`：仅 executor 且必有（number）。
- `input.*`：相对 `inbox/<dispatch_id>/` 的文件名；`null` 表示该文件不存在。`plan` 仅 executor 非空。
- `created_at`：ISO 8601 UTC（`Z` 结尾）。

### 2.2 context.json

```json
{
  "schema": 1,
  "dispatch_id": "gf_r123_i42_executor_p3472198451",
  "plan_comment_id": 3472198451,
  "plan_sha256": "<hex sha256 of PLAN.md content>",
  "feedback_count": 2
}
```

`plan_comment_id` / `plan_sha256` 仅 executor 必有；`feedback_count` = 投影进 FEEDBACK.md 的条目数（无 FEEDBACK.md 时为 0）。

### 2.3 status.json（运行中状态，可反复覆盖写）

```json
{
  "schema": 1,
  "dispatch_id": "…",
  "role": "executor",
  "state": "working",
  "phase": "implementation",
  "summary": "正在实现 Approval Record 校验",
  "updated_at": "2026-09-06T17:30:00Z"
}
```

- `state`：`"working" | "blocked" | "failed"`（终态用 result.json 表达；status 里的 failed 表示中途放弃）。
- `phase` / `summary`：可选字符串（≤ 500 字符），人类可读，Driver 不据此迁移状态。

### 2.4 result.json（终态，一个 dispatch 至多一个有效结果）

```json
{ "schema": 1, "dispatch_id": "…", "role": "consumer", "result": "plan_ready", "plan_file": "PLAN.md" }
```

```json
{ "schema": 1, "dispatch_id": "…", "role": "executor", "result": "completed", "report_file": "REPORT.md", "validation": "passed" }
```

```json
{ "schema": 1, "dispatch_id": "…", "role": "executor", "result": "blocked", "reason": "缺少第三方 API 凭证" }
```

字段约束：

- `plan_file`：consumer 且 `result=plan_ready` 时必填，值恒为 `"PLAN.md"`。
- `report_file`：executor 且 `result=completed` 时必填，值恒为 `"REPORT.md"`；`validation` 必填（`"passed" | "failed"`）。
- `reason`：`blocked | question | failed` 时必填非空字符串（≤ 1000 字符）。

### 2.5 current.json

```json
{ "schema": 1, "dispatch_id": "…", "role": "consumer", "issue_number": 42, "updated_at": "…" }
```

### 2.6 receipts/<dispatch_id>.json（Driver 本地缓存，可随时删除重建）

```json
{
  "dispatch_id": "…",
  "status": "dispatched",
  "attempts": 1,
  "tracker_comment_id": 123,
  "last_progress_sha256": "…",
  "last_feedback_comment_id": 456,
  "last_sync_at": "2026-09-06T17:31:00Z",
  "error": null
}
```

- `status`：`"dispatched" | "syncing" | "synced" | "failed"`。
- `last_feedback_comment_id`：已投影的最新人类反馈命令评论 id（用于增量发现）。
- Crash Recovery：receipts 丢失后，Driver 通过扫描 GitHub 评论（tracker marker + dispatch_id 字符串）与 outbox 现状重建。

## 3. dispatch_id 规则（冻结）

```text
gf_r<repository_id>_i<issue_number>_<role>_<revision>
```

- consumer：`revision` = 规划轮次，**从 01 起两位零填充**（≥100 时用十进制原值）。
  `轮次 = 1 + 本 Issue 上人类反馈命令（/change、/choose）总数`。
  （首轮无反馈 → 01；每个反馈命令使轮次 +1，因此反馈后的重新规划必然产生新 dispatch_id。）
- executor：`revision = p<plan_comment_id>`（绑定被批准的 Plan 评论）。
- 相同 dispatch_id 不重复派发（receipts 去重），除非显式 retry（`gateflow driver retry <dispatch_id>` 或 attempts < max_attempts 的自动重试）。

## 4. 角色输出白名单（冻结）

| role | status.json `state` | result.json `result` |
| --- | --- | --- |
| consumer | `working` / `blocked` / `failed` | `plan_ready` / `question` / `failed` |
| executor | `working` / `blocked` / `failed` | `completed` / `blocked` / `question` / `failed` |

**Human-only 动作永远不进入任何 Agent Schema**：`approve / ready / cancel / human-close`。校验器遇到这些值（无论大小写变体）必须判为非法并拒绝同步（对 GitHub no-op + 记日志）。

## 5. 校验规则（validation.ts，冻结）

Driver 处理 outbox 前必须全部通过，否则记录并跳过该文件（不 crash）：

1. JSON 可解析；`schema === 1`。
2. `dispatch_id` 与所在目录名（以及 dispatch.json）一致。
3. `role` 与 dispatch.json 的 role 一致。
4. `result` / `state` 在该 role 的白名单内（含 Human-only 词黑名单检查）。
5. 互斥字段约束（2.4）成立；`updated_at` 可解析。
6. 引用的内容文件存在且非空（PLAN.md / REPORT.md）。
7. 单文件 ≤ 512 KB（防 oversized）；目录名匹配 `^gf_r\d+_i\d+_(consumer|executor)_[0-9p][A-Za-z0-9_-]*$`。

## 6. 文件写入与监听（冻结）

- **原子写**：所有机器 JSON 一律 `temp 文件 → close → rename`（同目录内 rename，Windows 兼容：rename 前先删除已存在目标或使用 `rename` 覆盖语义的实现）。
- **Watcher**：监听 outbox 变化必须 debounce（默认 300ms 静默期）+ 文件大小/内容稳定性检查（连续两次 stat 尺寸一致才处理），避免读到半写入文件；`driver once` 模式不用 watcher，直接扫描。
- inbox 构建同样使用原子写；每次重新派发同一 dispatch 目录时整目录重建（先写临时目录再 rename，或逐文件原子写 + 最后写 dispatch.json 作为"就绪标记"）。

**就绪标记约定**：`dispatch.json` 是 inbox 的最后一个写入文件；Agent 只在 `current.json` 指向该 dispatch 且 `dispatch.json` 可解析时才开始工作。

## 7. Markdown 投影规则（冻结）

- **TASK.md**（Driver 从 Issue 构建）：`# <title>`、Issue 正文原样（含 Producer schema block 也原样保留，仅作上下文）、末尾 `## Goal` 固定措辞（consumer："分析任务并产出可执行的 Execution Plan（写入 outbox/PLAN.md），完成后写 result.json（result=plan_ready）"；executor："严格按照 PLAN.md 执行并通过真实验证，完成后写 REPORT.md 与 result.json（result=completed）"）。不暴露 GateFlow 内部状态。
- **FEEDBACK.md**：人类反馈命令的规范化投影，按时间升序编号：

```markdown
# Human Feedback

## 1 — 2026-09-06 17:10 (/change)
这里不要使用 SQLite。

## 2 — 2026-09-06 17:20 (/choose)
Q: q1 → A: B
```

- **PLAN.md（inbox）**：executor 专用，内容 = 被批准 Plan 评论的正文（去掉 plan marker 行）。
- **PROGRESS.md / REPORT.md**：Driver 仅作透传（Tracker / Completion Report 的正文），绝不解析语义。

## 8. 安全约束（冻结）

1. 路径解析必须拒绝 `..` 与绝对路径；`inbox/outbox/<id>` 目录名必须匹配 §5.7 的正则；解析出的真实路径必须仍在 `.gateflow/` 内（symlink escape 防护）。
2. Agent 修改 inbox 不产生任何效力：Driver 每次同步前不信任 inbox 现状，重派发时整目录重建；`plan_sha256` 使被篡改的 PLAN.md 可被发觉。
3. 未知 `dispatch_id`（inbox 无对应目录）的 outbox 输出一律拒绝。
4. `result.json` 一旦被 Driver 接受并同步（receipts.status=synced），同 dispatch 的后续 result 覆盖写不再被接受（幂等，防重放）。

## 9. Producer Submit 协议（.gateflow/submit/，冻结）

```text
.gateflow/submit/
├── TASK.md       # 任务描述（Markdown，人类/Agent 撰写）
└── submit.json   # {"schema":1,"title":"...","kind":"feature|bug|refactor|docs|chore","maturity_hint":"requirement|direction|solution|execution_plan","created_at":"..."}
```

- Driver 在 Discovery 时检查 `submit/`：校验 submit.json（title ≤ 256 字符非空、kind/maturity_hint 在枚举内）→ 通过 GitHub API 创建 Issue（正文 = TASK.md 内容 + Producer schema block，直接打 `ai:planning`，等价 T0 的 Producer CREATE 路径）→ 成功后把 `submit/` 整目录改名为 `submit/processed-<timestamp>/`（防重复提交）。
- 校验失败：写 `submit/error.json`（说明原因），不创建 Issue，等人工清理。

## 10. 驱动配置（gateflow.config.yml，目标仓库根目录）

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

- Role 与 Provider 分离：任意 role 可路由到任意 agent。
- `activation` 取值：`manual | chatgpt | zcode`；adapter probe 失败时回退 `activation.fallback`。
- GitHub 凭证只存在于 Driver 进程环境（`GITHUB_TOKEN`），永不写入 `.gateflow/` 与配置文件。
