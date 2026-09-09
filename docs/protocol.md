# GitHub 协议（Gate 侧，schema 2 + V1 简化）

Gate 是 GitHub Action 上的确定性程序：`事件 → 权限 → 当前状态 → 命令/Marker → 校验 → 迁移`。本文描述它执行的协议；实现位于 `src/gate/`。

## 1. 标签与状态机

每个 Issue 同时至多持有一个 `ai:*` 标签；0 个 = 工作流外，>1 个 = 违规（除 `/cancel` 外全部拒绝）。

```text
(无标签) --T0 /ai-plan--> ai:planning
ai:planning --T1 plan 评论--> ai:review
ai:review  --T2 /approve--> ai:ready
ai:ready   --T3 tracker 评论--> ai:working
ai:working --T4 tracker Status: Blocked--> ai:blocked
ai:blocked --T5 tracker Status: In Progress--> ai:working
ai:working --T6 report 评论--> ai:done
任意状态   --/cancel--> （移除全部 ai:* 标签，Issue 不关闭）
```

- T0/T2 是可信人类命令；T1/T3/T6 由**协议评论 marker** 触发（发布者须为 Trusted Human ∪ Trusted Agent）；T4/T5 由 tracker 评论编辑中的 `**Status:**` 机器值确定性解析触发；
- "Completed" 状态值永远不触发迁移：完成只走 T6；
- BLOCKED 是 WORKING 的执行期子状态（表达受阻），不是独立审批生命周期；
- DONE 之后由人工检查并关闭 Issue（Gate 不自动关）。

## 2. 人类命令（严格解析，区分大小写，整评论锚定）

| 命令 | 前置状态 | 效果 |
| --- | --- | --- |
| `/ai-plan` | 工作流外 | T0：打 `ai:planning` + 签发 workflow_epoch 记录 |
| `/approve <plan-comment-id>` | REVIEW | T2：签发 approval 记录（先固化后迁标签） |
| `/change <反馈文本>` | REVIEW | 签发 feedback_accepted 记录（**无状态迁移**；V1 将 `/choose` 并入此命令） |
| `/cancel` | 任意 | 移除全部 `ai:*` 标签 |

规则：

- 命令是 **Trusted Human 专属**（repo owner + `trusted-humans` 输入）。其他人（包括 Trusted Agent）发命令 → 👎 reaction，其余什么都不发生；
- 前置状态不满足 → 记录日志的无操作，**无** reaction；
- 接受 → ✅ reaction。reaction 只是反馈，永不是权限；
- 参数畸形（如裸 `/approve`、多行 `/change`）= 普通评论，静默忽略。

**T0 自愈**：PLANNING 状态的 Issue 若没有任何 epoch 记录（T0 标签已打但记录写失败的窗口），重跑 `/ai-plan` 会补签记录；存在合法记录则拒绝；存在不可解析记录则 fail closed。V1 中 **Gate 是唯一的记录签发者**。

## 3. Marker（结构标记，永非权限）

```text
<!-- ai-workflow:plan:v1 -->               T1（PLANNING→REVIEW）
<!-- ai-workflow:execution-tracker:v1 -->  T3（READY→WORKING）；编辑于 WORKING/BLOCKED 时为 T4/T5 通道
<!-- ai-workflow:completion-report:v1 -->  T6（WORKING→DONE）
```

- marker 必须独占一行；代码块内出现不算；一条评论多个 marker = 非法，整体当普通内容；
- 触发迁移需要**同时满足**：合法 marker + 发布者是 Trusted Human/Agent + API 重读的标签状态与迁移 `from` 一致（事件载荷快照永不信任）；
- Marker 永远不能作为身份或授权证明。

## 4. Gate-issued 记录（授权事实的唯一载体）

持久授权事实是 Gate 以自己的身份（`github-actions[bot]`）签发的记录评论，不是人类的命令评论：

```text
<!-- gateflow:workflow:v2 -->   workflow_epoch：绑定 repo/issue/轮次（CSPRNG，非时间戳推导）
<!-- gateflow:approval:v2 -->   approval：绑定 repo/issue/epoch/plan 评论 id/plan_sha256/审批人/命令锚点
<!-- gateflow:feedback:v2 -->   feedback_accepted：绑定 epoch + 反馈评论（T2 之外唯一的 Consumer 修订来源）
```

- 严格解析：字段集合精确匹配、operation_id 与内容绑定、任何不可解析记录 = **整个 Issue fail closed**（防伪造）；
- `/approve` 流程：校验 Plan 评论是**当前 Plan** → 计算 plan_sha256（冻结规范化：去协议行、CRLF 归一）→ 幂等复用或冲突拒绝 → 发布记录并回读校验 → 才执行标签交换；
- Plan 内容在审批后被编辑 → 哈希不再匹配 → 旧审批烧毁，必须重新出 Plan、重新审批；
- Driver 在派发与同步前**独立重验**这些记录（record 作者在 `trusted-agents`/`gate_logins` 白名单内 + 锚点命令仍存在且作者匹配）。

## 5. 身份模型

- **Trusted Human**：repo owner + `trusted-humans` 输入；唯一命令发布者；
- **Trusted Agent**：`trusted-agents` 输入中的受控机器人身份（Driver 的 GitHub identity）；只合法化 marker 发布，永不获得命令权；两个概念永不合并；
- **Organization 仓库**必须显式配置 `trusted-humans`，否则 Gate 拒绝运行（fail closed，GF-H10）；身份配置在任何迁移前先经 API 校验。

## 6. 并发与事件

- 迁移前通过 API 重读标签；标签交换采用先加后删，任何时刻观察者至多看到一枚 `ai:*` 标签；
- 同一 webhook 重复投递：T4/T5 同值编辑与记录 operation_id 幂等消化；
- 记录已固化但标签交换失败：重跑命令按 operation_id 复用记录完成迁移；
- 协议评论事件按评论创建顺序处理，Driver 依赖这一点保证"先 Tracker 后 Report"→ T3 → T6 的次序。

历史背景：schema 1（手动 MCP 模式）与 schema 2 的完整推导过程见 `docs/plans/` 下的历史计划文档。
