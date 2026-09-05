# 协议（Protocol）—— V0 冻结版

> **Schema 版本：1（冻结）**
> 冻结范围：Labels / 状态机 / Commands / Markers / Maturity / Permissions / 并发与一致性规则。
> 本文档是协议的唯一权威来源；协议常量同步实现在 [`src/protocol.ts`](../src/protocol.ts)。任何修改必须同时更新两处并视为协议升级（提升 schema / marker 版本号）。
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
                         REVIEW ──── /approve (Trusted Human, T2) ───► READY
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
| T2 | REVIEW | READY | Trusted Human 发 `/approve` |
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
3. 无参命令（`/ai-plan`、`/approve`、`/cancel`）使用**全等匹配**，例如 `trim(body) === "/approve"`。
4. 带参命令（`/choose`、`/change`）使用**锚定正则**（`^...$`）匹配。
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
| `/approve` | 全等 `/approve` | Trusted Human | REVIEW | T2：`ai:review` → `ai:ready`，✅ |
| `/choose` | 锚定 `^/choose (\S+) (\S+)$` | Trusted Human | REVIEW | ✅；解析出 `问题号` `选项` 两参数原样转交 Consumer；**不迁移状态** |
| `/change` | 锚定 `^/change (.+)$`（自由文本至少 1 个字符） | Trusted Human | REVIEW | ✅；自由文本原样转交 Consumer；**不迁移状态** |
| `/cancel` | 全等 `/cancel` | Trusted Human | 任一 `ai:*` 状态（含 BLOCKED、DONE） | 移除该 Issue 全部 `ai:*` 标签；**不关闭 Issue**；✅ |

### 3.3 命令语义边界

- `/choose 1 B` 表示"问题 1 选 B"。Gate **只校验格式**（恰好两个非空白参数，多一个少一个都无效），不解释参数含义；选项语义由 Consumer 根据当前 Plan 的 Open Decisions 处理。
- `/change` 之后的全部文本是**不可信自由数据**，Gate 原样传递给 Consumer；Consumer 只修改受影响的 Plan 部分并发布 Plan vN+1（新 Comment，不编辑旧 Plan）。
- `/approve` 的"目标 Plan 是当前版本"：Gate 只认可最后一条含有效 plan marker 的 Comment 为当前版本；V0 仅强校验 REVIEW 状态（版本级校验在 Phase 5 完善）。
- Reaction 只是操作反馈（成功 ✅ / Owner 无效命令 👎），**不是权限证明，也不是状态的一部分**。

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
- 已知留白（不算协议变更）：`/approve` 的版本级校验（Phase 5）、👎 反馈实装（Phase 2）、Tracker Status 解析细节（Phase 6）。
