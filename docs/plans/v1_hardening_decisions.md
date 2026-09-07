# GateFlow V1 Hardening 冻结决策（v1_hardening_decisions）

> 本文档是 `gateflow_v1_hardening_plan.md` Phase 0 的交付物：冻结本轮 Hardening
> 涉及的全部协议与安全设计决策。实现以本文档为准；实现与文档不一致时，以
> 测试 + 本文档同时更新为准，不允许静默漂移。
>
> 基线 commit：`3b4c11e`（2026-09-07）。本轮为**破坏性协议升级**：GitHub
> Protocol Schema 1 → **2**，Workspace Protocol Schema 1 → **2**。不为旧
> schema 保留兼容读取。

## 1. 四层状态（冻结）

| 层 | 载体 | 所有者 |
|---|---|---|
| Workflow State | GitHub `ai:*` labels | Gate（独占写） |
| Dispatch State | Driver receipt（`.gateflow/driver/receipts/`） | Driver |
| Agent Claim | `.gateflow/outbox/<id>/status.json` / `result.json` | Agent（声明，非授权） |
| Publication State | receipt 的 `published`/`accepted` + 远端对象 comment id | Driver 观察、Gate 确认 |

Receipt 状态机（schema 2，替代单一 `synced`）：

```text
dispatched → publishing → published → accepted
                ↘ failed            ↘ obsolete（epoch 失效/取消/issue 关闭）
```

不变式（永久冻结）：

```text
activated        != working
completed claim  != report published
report published != Gate accepted
Gate accepted    != code merged
```

- `published`：Driver 已把协议对象写到 GitHub 并确认远端存在（含 comment id）。
- `accepted`：Gate 已消费该对象并完成状态迁移（label 进入 review/done 等），
  由 Driver 在后续 cycle 观察 canonical 状态后写入。
- 回放保护：receipt 处于 `published`/`accepted` 后，同 dispatch 的后续
  result.json 覆写被拒绝（`skipped`）。
- `synced` 一词从协议中移除。

## 2. Canonical Source（冻结）

- GitHub（issue body / comments / labels）是唯一正式状态。
- `.gateflow/inbox|outbox|submit` 是通信面；`.gateflow/driver/`（receipts、
  locks、logs）是 Driver 私有运行副本，随时可从 GitHub 重建。
- 本地缓存丢失后的恢复路径：重新读取 GitHub → 按 Operation ID adopt 远端
  对象；远端是否存在无法证明时 fail closed（receipt `failed`，等待人工），
  不猜测、不盲目重发。

## 3. 信任模型（冻结）

| 身份 | 角色 | 凭证 |
|---|---|---|
| Human | 真实 GitHub User，Human-only 命令 | 个人账号 |
| Gate | 授权与状态迁移执行身份（Action token 的 authenticated user） | `gate-login` 可校验 |
| Driver | Agent-side 写入身份，只具备最小权限（评论/受限建 Issue） | 独立 fine-grained PAT |
| Agent | 不可信内容处理者，无 GitHub 凭证 | 无 |

- Gate 身份在运行时通过 `GET /user` 取得并写入每条 Gate 记录
  （`gate_login` + `gate_user_id`）。
- Driver 侧配置 `gate_logins`（默认 `['github-actions[bot]']`）：只有该
  allowlist 身份发布的 approval / feedback-accepted 记录可信。
- **记录类别的发布权限**：
  - `workflow_epoch` 记录：Gate **或** Driver（Driver 为 Producer submit
    自建的 issue 引导 epoch；作者记为 `issued_by`）。
  - `approval` 记录：仅 Gate。
  - `feedback_accepted` 记录：仅 Gate。
- **明确的限制**：Comment 承载的记录由受保护身份 + 最小权限 + fail-closed
  冲突检测共同保证可审计性，但**不是强不可篡改存储**。同仓库 admin 权限的
  篡改只能被检测（内容/引用不一致 → 拒绝），不能被阻止。文档不得宣称更强
  保证；需要强保证时升级为 GitHub App / 独立保护主体 / 签名记录。

## 4. Gate-issued Record（GitHub Protocol Schema 2）

记录是 Gate（或 Driver 引导 epoch）发布的协议 Comment，格式冻结：

```text
<!-- gateflow:<kind>:v2 -->

```json
<record JSON>
```
```

解析规则：marker 行必须独占一行（复用 detectCommentMarker 的行语义；
record marker 不在 workflow marker 集合内，永远不会触发状态迁移）；JSON
取 marker 行之后的第一个 fenced block；字段严格校验（未知键拒绝）。

### 4.1 workflow_epoch

```json
{
  "schema": 2,
  "kind": "workflow_epoch",
  "repository_id": 123456,
  "issue_number": 42,
  "workflow_epoch": "wf_<12 位 base36 随机>",
  "created_at": "<ISO 8601>",
  "issued_by": "<gate|driver login>",
  "operation_id": "epoch:<repo_id>:<issue>:<epoch>"
}
```

- epoch 由可信 Runtime（Gate / Driver 引导）用 CSPRNG 生成；**不从时间戳、
  评论数、label 推导**。
- 当前 epoch = issue 上 comment id 最大的 epoch 记录。新轮次（/ai-plan 在
  workflow 外重新进入）生成新 epoch；旧 epoch 的一切 Approval / Dispatch
  随之作废。
- Driver 接受的 epoch 记录作者：`gate_logins` ∪ {Driver 自身身份}。

### 4.2 approval

```json
{
  "schema": 2,
  "kind": "approval",
  "repository_id": 123456,
  "issue_number": 42,
  "workflow_epoch": "wf_...",
  "plan_comment_id": 3472198451,
  "plan_sha256": "<64 hex>",
  "approval_command_comment_id": 3472200012,
  "approved_by_id": 12345,
  "approved_by_login": "human-login",
  "gate_login": "github-actions[bot]",
  "gate_user_id": 41898282,
  "created_at": "<ISO 8601>",
  "operation_id": "approval:<repo_id>:<issue>:<epoch>:p<plan_comment_id>"
}
```

- 仅 Gate 发布。Gate 在 `/approve <plan-comment-id>` 全部校验通过后：
  1. 用冻结 canonicalization 计算 Plan hash（见 §6）；
  2. 发布 approval 记录；
  3. 校验远端记录内容匹配（创建响应或回读）；
  4. 才执行 T2 label 迁移（先加 `ai:ready` 再删 `ai:review`）。
  记录写入失败 → 不迁移、不反应；记录成功而 label 失败 → 下个事件由
  Driver 依据有效记录独立验证（Gate 侧 label 幂等重放由保留的 ✅ 反应与
  记录存在性共同判定），不重复创建授权对象。
- Driver 验证（独立于 Gate，每次 dispatch/sync 前重做）：
  - 记录作者 ∈ `gate_logins`；
  - `repository_id` / `issue_number` 与当前 issue 匹配；
  - `workflow_epoch` == 当前 epoch；
  - `plan_comment_id` == 当前 Plan comment id；
  - `plan_sha256` == 按当前 Plan comment body 重算的 hash；
  - `approval_command_comment_id` 指向仍存在的、由可信 Human 发出的
    `/approve <plan_comment_id>` 评论，且作者与 `approved_by_login` 一致；
  - 同 (epoch, plan) 存在多条**内容不一致**的有效记录 → fail closed；
    仅重复发布（同 operation_id 同内容）→ 取 comment id 最大者。

### 4.3 feedback_accepted

```json
{
  "schema": 2,
  "kind": "feedback_accepted",
  "repository_id": 123456,
  "issue_number": 42,
  "workflow_epoch": "wf_...",
  "event_id": "fe<feedback_comment_id>",
  "feedback_comment_id": 3472200050,
  "feedback_kind": "choose | change",
  "gate_login": "github-actions[bot]",
  "gate_user_id": 41898282,
  "created_at": "<ISO 8601>",
  "operation_id": "feedback:<repo_id>:<issue>:<epoch>:<feedback_comment_id>"
}
```

- Gate 接受 `/choose` / `/change`（格式 + REVIEW 前置 + 身份）后发布；被
  拒绝的命令永不产生记录。发布前按 `operation_id` 查重（幂等）。
- 事件 `event_id` 稳定，`feedback_comment_id` 是唯一事实来源。

## 5. Consumer Revision 与 Dispatch 身份（Workspace Schema 2）

- **Consumer revision = 1 + 本 epoch 内有效 feedback_accepted 事件数**
  （事件引用的原始评论仍须存在且为可信 Human 的合法命令；被拒、重复、
  旧 epoch、普通文本一律不计）。零填充两位。Driver 与 Gate 共享
  `src/protocol/records.ts` 的解析，不再维护第二套锚定正则。
- **Dispatch ID v2 语法**（目录名安全，base36 小写）：

```text
gf_r<repository_id>_i<issue>_w<epoch_code>_<role>_<revision>
epoch_code = workflow_epoch 去掉 "wf_" 前缀
revision   = consumer: 零填充轮次 | executor: p<plan_comment_id>
```

- Executor dispatch.json / receipt 额外绑定：`workflow_epoch`、
  `plan_comment_id`、`approval_comment_id`（= approval 记录 comment id）、
  `plan_sha256`。不依赖随机时间戳。
- **旧任务失效**：issue 关闭 / label 丢失（cancel）/ 新 epoch / Plan 变更 /
  Approval 失效 / revision 不一致 → 同步前 Preflight 拒绝，receipt 置
  `obsolete`。停止同步 ≠ Agent 停止写代码；该残余风险由 Skill 约定 +
  Personal/Secure Mode 边界声明处理（§8）。

## 6. Plan Hash Canonicalization（冻结，唯一实现）

`plan_sha256 = SHA-256(UTF-8(canonicalPlanContent(planCommentBody)))`：

1. 按 `/\r?\n/` 拆行（同时归一化 CRLF/CR）；
2. 丢弃（trim 后）匹配 workflow marker 行、`gateflow:dispatch-id` 注释行
   或 `gateflow:<kind>:v2` 记录 marker 行的行；
3. `'\n'` 连接后 trim。

唯一实现在 `src/protocol/plan.ts`，Gate 与 Driver 均从它导入；测试向量
固化在 `tests/protocol/plan.test.ts`。Plan 审批后被编辑/删除/替换 → hash
不匹配 → 旧 Approval 失效（不允许仅凭 `updated_at <= approved_at` 判断）。

## 7. Operation ID 与恢复（冻结）

```text
epoch:<repo_id>:<issue>:<epoch>
approval:<repo_id>:<issue>:<epoch>:p<plan_comment_id>
feedback:<repo_id>:<issue>:<epoch>:<feedback_comment_id>
submit:<submission_id>
plan:<dispatch_id>   tracker:<dispatch_id>   report:<dispatch_id>
notice:<dispatch_id>:<notice_key>          notice_key = sha256(body)[0:16]
```

- Operation ID 与内容/任务身份绑定，重试永不重新生成。
- 每个有 GitHub 副作用的写入遵循：search-by-operation → 有则 validate+adopt
  （内容 hash 不一致 → **Conflict**，receipt `failed`，不覆盖不再发）→
  无则 publish → 确认远端 → 写 receipt。
- Producer submit：`submit.json` schema 2 携带 `submission_id`；issue body
  嵌 `<!-- gateflow:source-id: <operation_id> -->`；任何 API 未知结果先
  reconcile（按 source-id 全量检索 adopt），绝不直接重发 POST。
- 目标语义：**at-least-once + 确定性去重 + 远端 reconciliation +
  fail-closed conflict**，不承诺 exactly-once（GitHub API 无跨请求事务）。

## 8. 本地安全边界（冻结）

- **Personal Mode**（默认，如实声明）：通信隔离 + 误操作防护 + 凭证不
  下传；不保证对恶意 Agent 的 OS 级权限隔离。
- **Secure Mode**（宣称前提）：Human/Driver/Gate 独立受控身份、Agent 无法
  取得凭证、OS 级目录边界、最小权限 GitHub 写入。文档明确 V1 代码只提供
  Personal Mode 的技术措施。
- **凭证继承**：所有 spawn 路径使用 `buildAgentEnv()` 白名单环境
  （PATH/HOME/TEMP 等系统键 + 配置 `env_passthrough` 显式列表）；`GITHUB_TOKEN`
  等 secret 键即使在 passthrough 中也强制剥除。Driver 凭证永不写入
  `.gateflow/`、日志、prompt、错误输出。
- **Driver 私有状态**：receipts / locks / logs 移至 `.gateflow/driver/`；
  POSIX 上 0o700/0o600 权限；Windows 以 ACL 说明为限（如实声明）。
- **FS 防护**：dispatch id 语法 + 解析后路径包含检查（已有）；新增 symlink
  拒绝（lstat 目录与文件非链接）、outbox 目录数量上限、原子写（已有）。
- **Organization 仓库**：owner type 经 API 核实（不信 payload）；org 仓库
  且 trusted-humans 为空 → Gate `setFailed` / Driver 启动报错（fail closed）。
  `trusted-humans ∩ trusted-agents ≠ ∅` → Gate 拒绝启动。禁止把 org login
  当普通 Human。

## 9. 精确 Dispatch / 并发 / Activation（冻结）

- 正式 prompt 与 Manual 指引只指向
  `.gateflow/inbox/<dispatch-id>/dispatch.json`；`current.json` 仅为人工
  UI 指针，永不参与任务身份判定。
- **Inbox 快照绑定**：`context.input_snapshot_sha256` 绑定 TASK/PLAN/
  FEEDBACK 内容 hash；同 dispatch id 内容不同 → 拒绝覆盖（`input-changed`），
  相同 → 幂等重建。
- **工作区并发**：`.gateflow/driver/locks/executor.lock`（同 Worktree 单
  Executor，冲突排队）；`.gateflow/driver/locks/driver.lock`（同机 Driver
  单实例，启动失败退出）。本地锁只约束同机；跨机互斥需外部协调（文档声明）。
- **Activation 语义**：`notified`（通知送达/进程已启动）≠ 任务已被接收；
  无稳定 Ack API 时永不宣称 started/accepted。`cancel()` 返回显式
  `cancelled | unsupported | unknown`，不再静默 no-op。

## 10. 版本策略

- GitHub Protocol Schema：1 → **2**（approval/epoch/feedback 记录、
  `<!-- gateflow:source-id -->`）。
- Workspace Protocol Schema：1 → **2**（dispatch id 语法、receipt 状态机、
  dispatch/context/receipt 字段、`.gateflow/driver/` 布局）。
- `gateflow.config.yml` version 保持 1（本轮配置变更为增量：`gate_logins`、
  `agents.*.env_passthrough`）。
- Label 集、命令集、workflow marker 集、状态机 T0–T6 不变。
