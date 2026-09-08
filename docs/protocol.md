# 协议（Protocol）—— V0 冻结版 · V1 修订 · Schema 2 Hardening

> **文档版本：Schema 2（2026-09 Hardening）。** 本轮为破坏性协议升级：`SCHEMA_VERSION` 1 → **2**。核心变化是**持久授权事实从"Human 的命令评论"改为"Gate 签发的记录（Record）"**，并引入 **workflow epoch**（工作流轮次身份）——详见文末 [§9 Schema 2 Hardening](#9-schema-2-hardening-冻结) 与决策文档 [docs/plans/v1_hardening_decisions.md](plans/v1_hardening_decisions.md)。Labels / 状态机 / Commands / Markers / Maturity 保持既有形态。机器可读的 GitHub 侧协议面见 [`protocol/github-schema-v2.json`](../protocol/github-schema-v2.json)；记录解析的单一实现在 [`src/protocol/records.ts`](../src/protocol/records.ts)。
>
> **Schema 版本：2（冻结）**
> 冻结范围：Labels / 状态机 / Commands / Markers / Maturity / Permissions / 并发与一致性规则 / Gate 记录格式与签发规则。
> 本文档是协议的唯一权威来源；协议常量同步实现在 `src/gate/protocol.ts` 与 `src/protocol/`。任何修改必须同时更新并视为协议升级（提升 schema / marker 版本号）。
> 设计原则：GitHub 是唯一正式状态存储；权限、审批与状态迁移只由确定性 Gate 执行；AI 永远不参与授权判断；所有命令解析都是严格匹配，不做任何"智能"猜测。

---

## 1. Labels

六个 `ai:*` 标签构成全部工作流状态。一个 Issue 同一时刻持有 **0 或 1 个** `ai:*` 标签（`ai:blocked` 是 WORKING 的子状态，用独立标签表达，不与其他标签叠加）。

| Label | 状态 | 含义 | 建议颜色（hex） |
| --- | --- | --- | --- |
| `ai:planning` | PLANNING | Work Item 已进入 Workflow，Consumer 正在分析 / 补全设计 | `d4c5f9` |
| `ai:review` | REVIEW | Execution Plan 已发布，等待 Trusted Human 审批 | `fef2c0` |
| `ai:ready` | READY | Plan 已批准，等待 Executor 接手 | `c2e0c6` |
| `ai:working` | WORKING | Executor 正在按 Approved Plan 执行 | `1d76db` |
| `ai:blocked` | BLOCKED | 执行被阻塞（WORKING 的子状态） | `d93f0b` |
| `ai:done` | DONE | AI 工作已完成，等待 Owner 最终检查（**不等于 Issue 已关闭**） | `0e8a16` |

补充规则：

- 标签由 Gate（或 Producer 创建 Issue 时）写入；其他人手工增删 `ai:*` 标签属于协议违规。Gate 不阻止手工修改，但永远以迁移前从 GitHub API 重读的标签为准。
- `ai:done` 的语义是"AI 工作完成，等待 Owner 最终检查"；Issue 保持 Open，由 Owner 检查后手动 Close。
- 建议颜色供 Phase 8 的 bootstrap 脚本创建标签时使用，不是协议语义的一部分。

---

## 2. 状态机

```text
                     /ai-plan (Trusted Human)
                           │
   (非 Workflow Issue) ───► PLANNING
                           │  Consumer 发布 Plan（plan marker，T1）
                           ▼
                         REVIEW ──── /approve <plan-comment-id> (Trusted Human, T2) ───► READY
                                                                         │
                                            Executor 创建 Tracker（tracker marker，T3）
                                                                         ▼
                                                     WORKING ◄─────────► BLOCKED
                                                       │      (T4 / T5，Tracker Status 机器值)
                                                       │  Executor 发布 Completion Report（T6）
                                                       ▼
                                                     DONE（终态，Issue 保持 Open，Owner 检查后关闭）
```

### 2.1 合法迁移表（全集，共 7 条）

| # | From | To | 触发条件 |
| --- | --- | --- | --- |
| T0 | 无（无任何 `ai:*` 标签） | PLANNING | Trusted Human 发 `/ai-plan`；或 Producer CREATE 时直接打 `ai:planning` |
| T1 | PLANNING | REVIEW | Gate 检测到包含有效 plan marker 的新 Comment；发布 actor ∈ Trusted Human ∪ Trusted Agent |
| T2 | REVIEW | READY | Trusted Human 发 `/approve <plan-comment-id>`（V1 Plan-ID 绑定，见 §3.4） |
| T3 | READY | WORKING | Gate 检测到包含有效 execution-tracker marker 的新 Comment；actor ∈ Trusted Human ∪ Trusted Agent |
| T4 | WORKING | BLOCKED | Gate 从 Tracker 的 `**Status:** Blocked` 机器值确定性解析（Tracker Comment edited） |
| T5 | BLOCKED | WORKING | Gate 从 Tracker 的 `**Status:** In Progress` 机器值确定性解析（Tracker Comment edited） |
| T6 | WORKING | DONE | Gate 检测到包含有效 completion-report marker 的新 Comment；actor ∈ Trusted Human ∪ Trusted Agent |

### 2.2 终态

- **DONE 是工作流终态**：不接受任何常规迁移。唯一出口是 Trusted Human 的 `/cancel`（移除全部 `ai:*` 标签）或 Owner 直接关闭 Issue。
- **Issue 关闭即终态**：Gate 收到 `issues.closed` 事件后校验并**静默结束，不做任何状态迁移**。已关闭 Issue 上的任何命令与 Marker 一律无效。
- **V0 不处理 reopened**：重新打开的 Issue 保留残留标签；Trusted Human 可用 `/cancel` 清除后重新 `/ai-plan` 进入。

### 2.3 非法迁移（Gate 必须拒绝，不做任何状态变更）

包括但不限于：

- 任何跳过 REVIEW 的批准路径：PLANNING → READY / WORKING / DONE；
- REVIEW → WORKING / DONE（未批准不得执行）；
- READY → DONE / BLOCKED（跳过执行）；
- BLOCKED → READY / DONE；
- DONE → 任何状态（终态不可逆；返工走 `/cancel` 后重新 `/ai-plan` 或新建 Issue）；
- 任何状态 → PLANNING（不允许原地回退重规划）；
- 已关闭 Issue 上的任何迁移。

无效命令的处理：不做迁移。V0 约定对 Trusted Human 的无效命令加 👎 reaction（Phase 2 实装，在此之前静默）；非 Trusted Human 一律静默忽略。

---

## 3. Commands（Comment 命令）

### 3.1 解析总规则（对全部命令生效）

1. 输入 = Issue Comment 的 body（`issue_comment.created` / `edited`）。
2. 先 `trim(body)` 去除首尾空白，再匹配。
3. 无参命令（`/ai-plan`、`/cancel`）使用**全等匹配**，例如 `trim(body) === "/cancel"`。（V1 修订：`/approve` 不再是无参命令，见 §3.4。）
4. 带参命令（`/choose`、`/change`、`/approve`）使用**锚定正则**（`^...$`）匹配。
5. **禁止 `body.includes(...)` 等子串 / 前缀匹配**——命令必须独占整条评论。
6. 大小写敏感：`/Approve`、`/approve `（带尾随空格已被 trim）以外的写法都不是命令。
7. 一条 Comment 只识别一个命令；不匹配任何命令的 Comment 是普通评论，静默忽略。
8. 解析出命令但前提不满足（身份 / 状态 / 参数）= 无效命令：不做迁移，按 2.3 反馈。
9. 非 Trusted Human 发出的命令**一律静默忽略**（不 reaction、不评论），避免探测面与噪音。
10. 命令 Comment 被编辑后按同一规则重新解析（幂等：前提不再满足则视为无效）。

### 3.2 命令明细

| 命令 | 精确语法（trim 后） | Actor | 前提状态 | 执行效果 |
| --- | --- | --- | --- | --- |
| `/ai-plan` | 全等 `/ai-plan` | Trusted Human | 无任何 `ai:*` 标签 | T0：打 `ai:planning`，✅ |
| `/approve` | 锚定 `^/approve (\d+)$`：`<plan-comment-id>` = 被批准 Plan 评论的 id（十进制数字，整条评论匹配）。**V1 破坏性变更：裸 `/approve` 不再是命令**，按普通评论静默忽略（规则 7） | Trusted Human | REVIEW | T2：`ai:review` → `ai:ready`，✅；目标评论必须通过 §3.4 全部校验，否则为无 reaction 的 no-op |
| `/choose` | 锚定 `^/choose (\S+) (\S+)$` | Trusted Human | REVIEW | ✅；解析出 `问题号` `选项` 两参数原样转交 Consumer；**不迁移状态** |
| `/change` | 锚定 `^/change (.+)$`（自由文本至少 1 个字符） | Trusted Human | REVIEW | ✅；自由文本原样转交 Consumer；**不迁移状态** |
| `/cancel` | 全等 `/cancel` | Trusted Human | 任一 `ai:*` 状态（含 BLOCKED、DONE） | 移除该 Issue 全部 `ai:*` 标签；**不关闭 Issue**；✅ |

### 3.3 命令语义边界

- `/choose 1 B` 表示"问题 1 选 B"。Gate **只校验格式**（恰好两个非空白参数，多一个少一个都无效），不解释参数含义；选项语义由 Consumer 根据当前 Plan 的 Open Decisions 处理。
- `/change` 之后的全部文本是**不可信自由数据**，Gate 原样传递给 Consumer；Consumer 只修改受影响的 Plan 部分并发布 Plan vN+1（新 Comment，不编辑旧 Plan）。
- `/approve` 的"目标 Plan 是当前版本"：V1 起审批绑定 Plan 评论 id（`/approve <plan-comment-id>`），Gate 只认可最后一条含有效 plan marker 的 Comment 为当前版本；完整校验见 §3.4。
- Reaction 只是操作反馈（成功 ✅ / Owner 无效命令 👎），**不是权限证明，也不是状态的一部分**。

### 3.4 V1 审批证明（Plan-ID 绑定）

V1 将审批绑定到具体 Plan 评论：`/approve <plan-comment-id>`。**持久化的 Approval Record 就是人类自己发出的这条 `/approve <id>` 评论**——作者 = 审批人，参数 = 被批准的 Plan 评论 id，二者在 GitHub 上天然可审计。

Gate 在执行 T2 前按顺序校验以下全部条件；**任何一条不满足即为记 Actions log 的 no-op：不迁移、不加任何 reaction**（状态前提不满足约定，见 §2.3 / 实现备注）：

1. actor 是 Trusted Human（不满足时保持原有 👎 反馈路径，见实现备注 Phase 2）；
2. Issue 处于 open 且 REVIEW 状态（迁移前照例按 §7 经 API 重读 labels）；
3. 被引用评论（`<plan-comment-id>`）**存在且属于本 Issue**（Issue 归属只能通过本 Issue 的评论列表核实）；
4. 被引用评论携带**有效** plan marker（与一切 marker 评论相同的唯一性 / 独占整行规则，§4.3）；
5. 被引用评论是**当前 Plan**：本 Issue 上按评论 id 时间序的**最后一条**有效 plan-marker 评论（更新的 Plan 发布后，指向旧 Plan 的 `/approve` 立即失效）；
6. 冻结迁移表允许 REVIEW → READY（T2）。

全部通过后：执行 T2（`ai:review` → `ai:ready`，先加后删）并对命令评论加 ✅。

边界与分工：

- **Executor 派发前的二次校验由 Driver 负责**（见 [architecture-v1.md](architecture-v1.md) §3.3）：`ai:ready` + 有效 `/approve <id>` 评论（作者 ∈ Trusted Humans）+ id 指向当前 Plan + Plan 在批准后未被编辑（内容哈希 / 陈旧性校验发生在派发时）。Gate 只保证标签迁移本身是 Plan 绑定的。
- **伪造 `ai:ready`（手工把 `ai:review` 改成 `ai:ready`）无法产生合法 Executor 派发**：不存在对应的 Approval Record。
- Marker 只是结构标记（§4）：plan marker 的存在永远不等于审批；审批只来自 Trusted Human 的 `/approve <id>` 评论。

---

## 4. Markers

Marker 是嵌入 Markdown 的 HTML 注释结构标记，让 Gate 与 Skills 能机器可读地识别内容类型。

> **Marker 只是结构标记，永远不能当权限证明。** 任何人（包括 AI 与恶意用户）都能写出 Marker 文本；Marker 的存在不授予任何权限。所有授权只依赖 GitHub actor 身份 + Gate 确定性校验（见 [security.md](security.md)）。

### 4.1 Issue Body Schema 块（Producer CREATE 时写入 body 末尾）

精确格式：

```markdown
<!-- ai-workflow
schema: 1
source: producer
kind: feature
maturity_hint: solution
-->
```

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `schema` | 整数，V0 固定 `1` | 协议版本 |
| `source` | `producer`（V0 唯一合法值） | 写入方标识 |
| `kind` | `feature` / `bug` / `refactor` / `docs` / `chore` | Work Item 类型（V0 冻结枚举） |
| `maturity_hint` | `requirement` / `direction` / `solution` / `execution_plan` | Producer 对成熟度的提示，仅供 Consumer 参考 |

解析规则：只解析 `<!-- ai-workflow` 与 `-->` 之间每行 `key: value`；仅接受上表 4 个 key；出现未知 key、重复 key 或非法取值时，**整个 schema 块视为无效**（该 Issue 按普通 Issue 对待）。

### 4.2 Comment Markers

| Marker | 用途 | 发布者 | 后续是否允许编辑 |
| --- | --- | --- | --- |
| `<!-- ai-workflow:append:v1 -->` | Producer APPEND：追加讨论摘要 / 方向 | Producer | 不允许（只新增，不修改历史） |
| `<!-- ai-workflow:plan:v1 -->` | Execution Plan；修订 = vN+1 新 Comment | Consumer | 不允许（Approved Plan 不可因进度修改） |
| `<!-- ai-workflow:execution-tracker:v1 -->` | Execution Tracker（TodoList 实时进度） | Executor | 允许持续编辑 |
| `<!-- ai-workflow:completion-report:v1 -->` | 最终完成报告 | Executor | 不允许（一次发布） |

### 4.3 识别规则

- Comment Marker 必须**独占一行**：该行 trim 后与 Marker 字符串全等；嵌在行内、列表里或代码块中的不算。
- 一条 Comment 只允许包含一个 Marker；包含多个（或多种）Marker 的 Comment 视为无效，Gate 不识别、不迁移。
- Marker 识别失败 = 普通内容：静默忽略，不报错、不迁移。
- Plan / Tracker / Report 类 marker 触发迁移（T1 / T3 / T6）时，发布 actor 必须属于 Trusted Human ∪ Trusted Agent；陌生身份发布的 marker 是普通文本，不触发迁移。

---

## 5. Maturity（Work Item 成熟度）

Consumer 不固定走"Idea → Initial Plan → Detailed Plan"，而是按 Issue 当前内容的成熟程度接着工作：

| 级别 | 名称 | 含义 | Consumer 动作 |
| --- | --- | --- | --- |
| L0 | Requirement | 只有想法 / 问题 / Bug 描述 | 分析问题 → 设计方案 → 生成执行计划 |
| L1 | Direction | 已有方向，方案未定 | 验证方向 → 补全方案 → 生成执行计划 |
| L2 | Solution | 主要方案已确定 | 检查 Repo → 补遗漏 → 生成执行计划（**不重新选型**） |
| L3 | Execution Plan | 已有完整开发计划 | Readiness Check → 必要小修正 → 直接整理为待审批执行计划（**禁止重新设计**） |

规则：

- Consumer 的输出永远收敛为同一种东西：待审批的 Execution Plan（发布 plan marker，状态进入 REVIEW）。
- `maturity_hint` 与级别映射：`requirement`=L0、`direction`=L1、`solution`=L2、`execution_plan`=L3。
- **hint 只是提示，不是承诺**：Consumer 必须结合真实仓库判断 Effective Maturity，可以降级（例：hint 为 `execution_plan`，但计划引用的模块已不存在 → 按 L2 处理，只补需要重新设计的部分）；不允许凭 hint 跳过仓库校验。

---

## 6. Permissions（权限边界）

### 6.1 Trusted Human

- **V0 默认 = repository owner login**。
- 可通过 Action 输入 `trusted-humans`（逗号分隔 GitHub login 白名单）扩展。
- 判定：事件 actor（如 `comment.user.login`）与 repo owner 或白名单精确匹配（GitHub login 大小写不敏感）。
- 职权：执行全部五个命令（`/ai-plan`、`/approve`、`/choose`、`/change`、`/cancel`）；最终 Close Issue。

### 6.2 Trusted Agent

- 独立 Action 输入 `trusted-agents`（逗号分隔），**V0 默认为空**。
- 用途：当 AI 以独立 Bot / GitHub App 身份操作时的身份登记（为未来扩展预留）。
- **Trusted Agent 与 Trusted Human 是两个概念，在代码与协议中永不合并**：Trusted Agent 永远不能执行任何命令；它只影响 marker 触发类迁移（T1 / T3 / T6）的发布者合法性。
- V0 快速自用模式（Owner 的 PAT 直连 GitHub MCP）下，AI 操作的 actor 就是 Owner 本身，自然满足 Trusted Human——这是 V0 的现实，不代表概念合并。

### 6.3 AI 能做 / 不能做

AI（Producer / Consumer / Executor）**可以**：

- 创建 Work Item（CREATE：新 Issue + schema 块 + 直接打 `ai:planning`；APPEND：追加 append marker 评论）
- 发布 Execution Plan（修订 = 新版本 Comment，不覆盖旧版）
- 创建 / 编辑 Execution Tracker
- 发布 Completion Report
- 创建 PR、写代码、运行测试

AI **不能**：

- 批准自己的 Plan（`/approve` 永远无效）
- 执行任何 Human 命令（`/ai-plan`、`/choose`、`/change`、`/cancel`）
- 取消或推翻 Human 决策
- 绕过 Gate 修改正式 Workflow 状态（手工增删 `ai:*` 标签属协议违规；Gate 以 API 重读为准，在非法状态上拒绝迁移）
- 通过伪造 Marker 获得任何权限

---

## 7. 并发与一致性

- 同一 Issue 的所有 Gate run **必须串行**：workflow 使用 concurrency group `ai-workflow-<issue_number>`，`cancel-in-progress: false`（排队执行，不取消）。
- **每次状态迁移前，必须通过 GitHub API 重新读取 Issue 当前 labels**，禁止信任 event payload 中的 labels 快照（可能是过期数据，也可能被手工修改）。
- 重读结果与命令前提状态不符 → 放弃本次迁移（按无效命令处理）。
- Label 迁移 = 添加新 `ai:*` 标签 + 移除旧 `ai:*` 标签；并发组串行 + 迁移前重读共同保证不会出现双重迁移或错误状态。

---

## 8. Gate 事件处理矩阵

| 事件 | Gate 行为 |
| --- | --- |
| `issues.opened` | **不自动打标**。Producer 创建的 Issue 已带 `ai:planning` 与 schema 块（T0 已完成）；外部普通 Issue 保持普通 Issue（场景 E），等待 Owner 发 `/ai-plan`。 |
| `issues.labeled` | 仅记录 / 一致性检查，不主动迁移（确认 Producer 打标进入 PLANNING）。 |
| `issue_comment.created` / `edited` | 主处理路径：身份判定 → 严格解析命令 / Marker → **API 重读 labels** → 校验前提 → 迁移 / ✅ / 👎 / 静默忽略。 |
| `issues.closed` | 校验后**静默结束，不做状态迁移**（关闭即终态）。 |
| `issues.reopened` | V0 不处理（残留标签可由 Trusted Human `/cancel` 清除）。 |

---

## 9. 冻结与演进

- 本协议为 V0 冻结版：字段、枚举、语法、迁移表均不得随意变更。
- 变更必须：更新本文档 + 同步 `src/protocol.ts` + 提升 schema 版本（issue body `schema:` 字段、comment marker 的 `:v1` 后缀），保证新旧内容可区分。
- 已知留白（不算协议变更）：`/approve` 的版本级校验已由 **V1 §3.4（Plan-ID 绑定）** 落实；👎 反馈实装（Phase 2）、Tracker Status 解析细节（Phase 6）均已落实。

---

## 实现备注（Implementation Notes）

> 本节**不属于冻结协议本体**，只记录实现与正文条文的偏差与实现口径澄清。正文任何修改仍视为协议升级。

- **2026-09-05（Phase 2 实装）：reaction 反馈方向与 2.3 / 3.1 规则 9 的条文相反，实装取反。**
  - 非 Trusted Human 发出的五个命令：加 👎 reaction（含义 = "invalid owner command"），除此之外静默（不评论、无标签写、无 API 读）。正文写的是"一律静默忽略（不 reaction）"；实装按开发指南 Phase 2 的"👎 invalid owner command"语义，给非 Owner 命令一个明确的拒绝信号。已知权衡：这会向探测者暴露"命令已被解析但身份不足"（正文 3.1 规则 9 想避免的预言机），接受该噪音换取 Owner 的可观察反馈。
  - Trusted Human 的无效命令（状态前提不满足等）：保持静默 no-op + Actions log，**不加** 👎（正文 2.3 写的是"对 Trusted Human 的无效命令加 👎"，实装避免 Owner 自用时的额外噪音；no-op 语义不变）。
  - 接受的命令（效果已执行，或 `/choose` / `/change` 合法转交 Consumer）加 ✅ reaction。Reaction 永远只是操作反馈：不是权限证明、不是状态的一部分、也不被主流程依赖（reaction API 失败只记 warning，迁移照常完成）。
- **2026-09-05（Phase 2 实装）：4.3 "代码块中的不算" 的实现口径**：以行首 ``` 围栏（fenced code block）为开关，围栏内的 marker 出现一律不计数（既不算独占整行、也不算重复出现）；围栏外仍按"独占整行 + 全评论至多一次出现"判定。引用（quote）marker 文本因此不会触发迁移。
- 2026-09-05（Phase 2 实装）：Gate 实现版本号 `GATE_VERSION` 升至 `0.2.0`；冻结的 `schema: 1` 与 marker `:v1` 后缀不变，非协议升级。
- 2026-09-05（Phase 2 实装）：`/choose` / `/change` 的前提状态按 3.2 表格执行，即**仅 REVIEW**；Gate 只做格式与身份校验，参数原样转交 Consumer，不做任何状态迁移（与冻结表一致，无偏差）。
- **2026-09-05（Phase 6 实装）：T4 / T5 的 Tracker Status 解析细节（正文第 9 节留白项的落实）。**
  - 触发事件：仅 `issue_comment.edited`，且被编辑评论通过 4.3 的 marker 校验（唯一、独占整行的 execution-tracker marker），发布 actor ∈ Trusted Human ∪ Trusted Agent；迁移前照例按第 7 节经 API 重读 labels。`created` 事件不触发 T4 / T5（创建 Tracker 走 T3）；READY 状态下的 Tracker 编辑仍按 T3 语义处理（READY → WORKING）。
  - 解析规则：按行扫描评论 body，使用与 4.3 相同的 ``` 围栏约定（围栏内的行一律不计数，引用模板不触发）；取第一条 trim 后以字面量 `**Status:**` 开头的行，冒号后文本 trim 后与三个机器值 `In Progress` / `Blocked` / `Completed` 做**大小写敏感全等比较**。行首不是 `**Status:**` 字面量（如列表项、`Status:` 无加粗）不算 Status 行；找不到 Status 行 → log + no-op；值非机器值（含大小写不符、空值）→ log + no-op，绝不猜测。存在多条 Status 行时取第一条（模板恰有一条，第一条为权威）。
  - 迁移映射：WORKING + `Blocked` → T4（加 `ai:blocked` 移除 `ai:working`）；BLOCKED + `In Progress` → T5（加 `ai:working` 移除 `ai:blocked`），加标签先于移除标签（与其余迁移一致）。同值编辑（WORKING 下 `In Progress`、BLOCKED 下 `Blocked`）为 log no-op，保证事件重复投递幂等；`Completed` 在任何状态下都**不触发迁移**（完成只走 completion-report marker 的 T6；BLOCKED 状态必须先由人处理后改回 `In Progress` 恢复 WORKING，再发布 Report）。
- 2026-09-05（Phase 6 实装）：Gate 实现版本号 `GATE_VERSION` 升至 `0.3.0`；冻结的 `schema: 1` 与 marker `:v1` 后缀不变，非协议升级。
- **2026-09-06（V1 Phase 9 实装）：`/approve` 升级为 `/approve <plan-comment-id>`（§3.4）。**
  - 命令形态：裸 `/approve` 自 V1 起**不再是命令**（`parseCommand` 返回 null，按普通评论静默忽略）；新形态为锚定 `^/approve (\d+)$`，参数为被批准 Plan 评论的数字 id。破坏性变更，无兼容模式（开发期，V1 breaking change）。
  - Gate 校验顺序：Trusted Human（否则 👎）→ Issue open → 重读 labels 后 REVIEW → 目标评论存在且属于本 Issue → 携带有效 plan marker → 是最后一条（当前）Plan 评论；任一失败 = 记 log 的 no-op，**无迁移、无 reaction**；全部通过 = T2（先加 `ai:ready` 后删 `ai:review`）+ ✅。日志含绑定的 Plan 评论 id（形如 `T2 on #42: ai:review -> ai:ready (REVIEW -> READY approving plan comment 123).`）。
  - Approval Record = 人类自己的 `/approve <id>` 评论；Executor 派发前由 Driver 二次校验（当前 Plan 匹配 + Plan 批准后未被编辑），见 architecture-v1 §3.3。
  - Gate 实现版本号 `GATE_VERSION` 升至 `1.0.0`；冻结的 `schema: 1` 与 marker `:v1` 后缀不变，非协议升级。机器可读协议面新增 `protocol/github-schema-v2.json`（仅文档性质，不参与运行时校验）。

---

## 9. Schema 2 Hardening（冻结）

> 本节为 Schema 2 新增的规范面；与前文冲突时以本节为准。单一实现：`src/protocol/records.ts`（Gate 与 Driver 共享，禁止第二套解析）。

### 9.1 Gate-issued Record（持久授权事实）

三类记录 Comment，格式冻结：marker 行独占一行 + 空行 + ` ```json ` 代码块（字段严格校验：缺失/未知键、Operation id 与字段不匹配、坏 JSON、非法枚举/哈希/时间戳 → 记录无效，fail closed）。记录 marker **不是** workflow marker，永远不会触发 T0–T6。

| 记录 | marker | 签发者 | 触发 | 关键绑定 |
| --- | --- | --- | --- | --- |
| `workflow_epoch` | `<!-- gateflow:workflow:v2 -->` | Gate 或 Driver（引导） | T0 / Producer 引导 | `epoch = wf_ + 12 位 base36（CSPRNG）` |
| `approval` | `<!-- gateflow:approval:v2 -->` | **仅 Gate** | `/approve <plan-id>` 全部校验通过后 | epoch + plan id + plan_sha256 + 审批人 + 命令评论 id |
| `feedback_accepted` | `<!-- gateflow:feedback:v2 -->` | **仅 Gate** | `/choose` / `/change` 被接受后 | event_id = fe\<命令评论 id\> |

Operation ID（冻结语法）：`epoch:<repo>:<issue>:<epoch>`、`approval:<repo>:<issue>:<epoch>:p<plan-id>`、`feedback:<repo>:<issue>:<epoch>:<命令id>`、`submit:<submission_id>`。重试永不换新 id；**同 Operation 不同内容 = 冲突，fail closed**（被批准过的 Plan 编辑后即灼烧，需重新规划）。

### 9.2 签发时序（先固化，后迁移）

- `/approve`：状态前置（REVIEW 等）→ Plan 评论校验（存在 / 有效 marker / 当前 Plan）→ 计算 plan_sha256（冻结规范化见 `src/protocol/plan.ts`）→ 读当前 epoch → 复用或冲突检查 → **发布记录并回读校验** → 才执行 T2 标签迁移 + ✅。记录写失败 = 无迁移、无 ✅ 的 no-op；记录成功而标签失败 → 重跑命令按 Operation 复用记录恢复。
- `/choose` / `/change`：校验通过后发布 feedback 记录（幂等），然后 ✅。**被拒绝的命令永不产生记录**——Consumer Revision（= 1 + 本 epoch 内已接受事件数）只认记录。
- `/ai-plan`（T0）：标签迁移后发布新 epoch 记录（全新轮次，绝不复用旧轮次记录；写失败由 Driver 引导兜底）。

### 9.3 Driver 侧独立重验（派发与同步前）

记录作者 ∈ Driver 配置 `gate_logins`（默认 `github-actions[bot]`，禁止包含 Driver 自身）；仓库/Issue/epoch 匹配；plan_sha256 与当前 Plan 正文重算一致；锚定的 `/approve` 命令评论仍存在、由 Trusted Human 发出且作者一致；同 Operation 记录内容一致。任一失败 → 不派发、不同步；Issue 上出现任何 suspect 记录 → 整个 Issue fail closed。

### 9.4 Organization 身份规则（GF-H10）

owner type 必须经 API 核实（`repos.get → owner.type`，绝不信事件 payload）：非 User 类型仓库且 `trusted-humans` 为空 → **Gate 拒绝运行**（任何迁移前即失败）；`trusted-humans ∩ trusted-agents ≠ ∅` → 拒绝运行。Driver 侧对称：org 仓库且 `trusted_humans` 为空 → 拒绝启动。

## 10. V1.1 Correctness Hardening（冻结）

> 本节为 V1.1 收尾轮新增的规范面；与前文（含 §9）冲突时以本节为准。单一实现：
> `src/protocol/workflow-chain.ts`（授权链）、`src/protocol/commands.ts`（命令语法）、
> `src/protocol/identity.ts`（身份解析）——Gate 与 Driver 共享，禁止任何一侧私有第二套。

### 10.1 Gate Dispatch Authorization（P0：执行链授权）

Marker 触发的迁移（T1 / T3 / T4 / T5 / T6）不再满足于「合法 marker + 可信发布者 + 当前标签」。
每次迁移还必须通过 **Dispatch 授权链** 校验（`src/gate/authorization.ts` 适配，`workflow-chain.ts` 实现）：

- **T1（Plan → REVIEW）**：Plan 评论必须内嵌 dispatch-id（`<!-- gateflow:dispatch-id: ... -->`），
  绑定 **当前 epoch**、`role=consumer`、`revision = 当前 consumer 轮次`
  （= 1 + 本 epoch 已接受 feedback 事件数；T1 只可能发生在 PLANNING，故恒为 `01`），且该评论必须是当前 Plan。
- **T3（Tracker → WORKING）**：Tracker 评论的 dispatch 必须绑定当前 epoch、`role=executor`、
  `revision = p<当前 Plan 评论 id>`，且存在 **Gate 签发的 approval 记录** 精确绑定
  （epoch + plan id + plan_sha256 + 锚定的 Trusted Human `/approve` 完好）。
- **T4 / T5（Blocked / Resume）**：被编辑的 Tracker 必须仍属于当前 executor 链（同 dispatch、同 epoch）。
  旧轮次 Tracker 的编辑**绝不**影响新一轮。
- **T6（Report → DONE）**：Report 同 T3 链校验，且其 dispatch 必须已产出 Tracker（孤儿 Report 不能 DONE）。

失败一律为记录日志的 no-op（无迁移、无记录、无 ✅）。Driver 侧语义相同但独立执行
（**Driver Preflight ≠ Gate Authorization**：Driver 可提前拦截，Gate 必须重新证明）。

### 10.2 Epoch Record Trust（Epoch 只可信来源）

- **签发者类别**（新冻结字段 `created_by`）：
  - `"gate"` —— Gate 本身签发（T0）；记录评论作者必须是 Gate 身份；
  - `"driver_bootstrap"` —— 显式 Bootstrap Driver 身份（Producer 提交的 planning issue 引导）；
    记录作者必须在 Bootstrap Driver 允许名单内（Gate 输入 `bootstrap-drivers` / Driver 配置
    `bootstrap_drivers`；缺省规则：个人仓库（owner type=User，API 核实）默认 owner，其余一律无默认 = 禁止）。
  - 普通用户与 **Trusted Agent 伪造的 epoch 均无效**；`repository_id` / `issue_number`
    与所在 issue 不符（移植记录）同样 fail closed。
- **确定性 Operation ID（V1.1 修订 §9 的 epoch 语法）**：
  - Gate T0：`epoch:<repo>:<issue>:c<命令评论id>`；
  - Driver 引导：`epoch:<repo>:<issue>:bootstrap`。
  epoch **随机值不再进入 operation id**——重投的 `/ai-plan` 事件重新推导出同一 id，
  走 search-adopt 恢复，永不铸造第二个 epoch。
- **冲突**：同一 operation id 下出现不同 epoch 值 / 不同签发类别 / 不同签发者 → **fail closed**（绝不取最新）。
- **解析**：任何不可解析的 epoch 记录 → 整个 issue fail closed（append-only 语义不变）。

### 10.3 T0 Record-First（先固化 epoch，后迁移）

`/ai-plan` 的签发顺序冻结为：状态前置（workflow 外 + 合法 T0）→ 按确定性 operation id
search（命中即 adopt；冲突即 fail closed）→ 未命中则**发布并回读校验** epoch 记录 → 才添加
`ai:planning`。记录写失败 = 不进入 PLANNING、无 ✅（fail closed）。新一轮绝不沿用旧轮次 epoch。

### 10.4 gate_transition Record（迁移记录）

每次被接受的 T1–T6 迁移，Gate 在**标签交换之前**发布一条迁移记录
（marker `<!-- gateflow:transition:v2 -->`，签发者**仅 Gate**）：

```json
{
  "schema": 2,
  "kind": "gate_transition",
  "repository_id": 123,
  "issue_number": 7,
  "workflow_epoch": "wf_...",
  "dispatch_id": "gf_r..._executor_p...",
  "transition": "T6",
  "from_label": "ai:working",
  "to_label": "ai:done",
  "source_comment_id": 900123,
  "gate_login": "...",
  "gate_user_id": 1,
  "gate_version": "1.1.0",
  "created_at": "...",
  "operation_id": "transition:<repo>:<issue>:<epoch>:<transition>:<source_comment_id>"
}
```

- 记录写失败 = **不迁移**（record-first，与 T2 approval 记录同一约定）；标签已迁而记录未达的崩溃
  由同 operation id 的 search-adopt 恢复；同 operation id 内容冲突 → fail closed。
- **Driver receipt 的 `accepted` 必须绑定迁移记录**：`TransitionRecord.source_comment_id ==
  receipt.published_comment_id` 且 epoch、dispatch_id、transition 全部一致。`Issue == ai:done →
  accepted` 被禁止；epoch/dispatch 已变化时旧 receipt 走 `obsolete`。
- `dispatch_id` 对无 dispatch 的迁移（T2）为 `null`。

### 10.5 Operation ID 统一（Idempotent Publishing with Remote Reconciliation）

所有远端创建统一 Operation ID 语义：准备 id → 远端按 id 搜索 → 完全一致则 adopt → 冲突则
fail closed → 不存在则创建（超时后下一轮按 id 搜索恢复）。适用对象：Issue Submit（`submit:`）、
Epoch Record、Plan / Tracker / Report（marker + dispatch-id 对账）、Approval、Feedback、
Transition Record。同一逻辑操作的重试永不铸造新 id。

### 10.6 共享命令语法与身份解析

- 命令解析（五条冻结命令的 exact/anchored 正则与语义）唯一实现于 `src/protocol/commands.ts`；
  Driver 的 feedback 投影与 approval 锚定复验共用同一语法（Phase 8：Gate / Driver 不再各自解析）。
- Consumer Revision 基于本 epoch 的 **Accepted Feedback Sequence**（feedback_accepted 记录且其
  命令评论仍存在、仍解析、作者仍可信）；被拒绝 / 重复 / 旧 epoch / 纯文本评论永不计数。
- 身份解析唯一实现于 `src/protocol/identity.ts`：Effective Humans（个人仓库 = owner + 配置；
  其他 = 仅配置）、Effective Agents（仅配置）、Bootstrap Drivers（配置；个人仓库缺省 owner）、
  Human ∩ Agent = ∅、Bootstrap Driver ∩ Human = ∅（个人仓库 owner 缺省例外）。
  Gate / Driver / Bootstrap 三方共用同一解析结果（Phase 9）。
