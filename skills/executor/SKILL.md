# Executor Skill

一句话职责：只处理 `ai:ready` 状态的 Issue，读取 Approved Plan，Taskify 后创建带 `<!-- ai-workflow:execution-tracker:v1 -->` 的 Execution Tracker（Gate 迁移 `ai:ready` → `ai:working`，T3），逐个执行 Todo 并**持续 Edit Tracker**（勾选项、`**Status:**` 机器值、Current、Notes），完成 Validation 后发布带 `<!-- ai-workflow:completion-report:v1 -->` 的 Completion Report（Gate 迁移 `ai:working` → `ai:done`，T6），然后停止——Issue 保持 Open，等 Owner 检查后手动 Close。

必须遵守的协议：[docs/protocol.md](../../docs/protocol.md)（schema 1，冻结）。所有 `ai:*` 标签迁移都由确定性 Gate 完成；Executor 永远不打、不改、不删任何 `ai:*` 标签，也永远不参与任何授权判断。

---

## 1. 触发与前置

### 1.1 触发条件（全部满足才动手）

- Issue 当前带 `ai:ready` 标签（Plan 已被 Trusted Human `/approve`）。
- 人工明确说"执行 `<repo>#<n>`"（V0 没有自动 Driver，Executor 不因标签变化自行启动）。

以下情况**拒绝执行并说明原因**：

- Issue 没有 `ai:ready` 标签（`ai:planning` / `ai:review` 说明流程没走完；`ai:working` / `ai:blocked` 说明已有执行在进行或被阻塞；`ai:done` 说明已完成待检查）。
- Issue 已关闭（关闭即终态）。

### 1.2 读取 Approved Plan（执行依据）

- 在 Issue 评论中找**最后一条**含有效 plan marker（`<!-- ai-workflow:plan:v1 -->` 独占一行）的评论，这就是当前版本的 Approved Plan。
- **ai:ready 但找不到 plan marker 评论 → 停止并报告异常**（提示 Owner 检查 Issue 状态），**不得自行编造、推断或重构计划**。
- 若存在多条 plan marker 评论，以最后一条为准（Plan vN+1 取代 vN）；执行以这一条为唯一依据。
- Approved Plan 是**只读**的：执行全程绝不 Edit 任何 Plan 评论（包括自己的）。进度、偏差、临场决定只写进 Tracker 和 Notes。

---

## 2. 端到端流程总览

```text
读取 Approved Plan
      ↓
Taskify（拆 Todo，粒度 = 有意义的工作单元）
      ↓
创建 Execution Tracker 评论（tracker marker + 模板）
      ↓  Gate: T3, ai:ready → ai:working（确认标签已迁移再开工）
逐个执行 Todo
      ↓  每完成一个 Todo：Edit Tracker（勾选 + Current + Notes）
遇到阻塞
      ↓  Edit Tracker: **Status:** Blocked + 原因（Gate: T4, ai:working → ai:blocked）
      ↓  人处理后 → Edit Tracker: **Status:** In Progress（Gate: T5, ai:blocked → ai:working）
全部 Todo 完成
      ↓
跑 Validation（真实执行测试）
      ↓
发布 Completion Report（report marker，新评论）
      ↓  Gate: T6, ai:working → ai:done
停止（Issue 保持 Open，等 Owner 检查 PR / Report 后手动 Close）
```

---

## 3. Taskify：Todo 粒度规则

把 Approved Plan 的 Tasks 拆成 Todo 列表，粒度标准：

- **一个 Todo = 一个有意义的工作单元**，例如"实现 Package Downloader"、"接入插件安装流程"、"完成回归测试"。
- **不是**"创建 file"、"加一个 function"、"定义 struct"这类机械步骤——它们是实现某个 Todo 的过程，不是 Todo 本身。
- **一个 Todo 应可在一次专注工作内完成**。如果估计要跨多次会话 / 多轮交互，说明粒度太粗，继续拆。
- Todo 必须能和 Plan 的 Tasks / Acceptance Criteria 互相对照：完成后看 Tracker、Plan、Report 三者能对上。
- **V0 不创建 Child Issues**（Parent/Child Issue 自动化明确不做）：再大的工作也在这一个 Issue 的 Tracker 里拆解；单个 Todo 真的装不下，就把该 Todo 标 Blocked 并说明需要 Owner 决定是否拆 Issue。

---

## 4. 创建 Execution Tracker

Plan 批准后、写第一行代码之前，发布一条**新评论**（精确格式如下；marker 必须独占一行且全评论唯一）：

```markdown
<!-- ai-workflow:execution-tracker:v1 -->

## Execution Tracker

**Status:** In Progress

### Phase 1

- [ ] 确认现有插件 Manifest 结构
- [ ] 实现 Package Downloader
- [ ] 增加 Cache

### Phase 2

- [ ] 接入安装流程
- [ ] 更新 UI

### Validation

- [ ] Unit Tests
- [ ] Integration Tests

### Current

（当前正在做的 Todo，没有则留空）

### Notes

（正在发生什么；Blocked 时写明原因与需要的决策）
```

要点：

- `**Status:**` 是 Gate 确定性解析的**机器值字段**，只能取三个固定值之一（见第 6 节），初始必须写 `**Status:** In Progress`。
- Phase 分组只是阅读结构，Todo 才是执行单元；Plan 简单时可以只有一个 Phase。
- Validation 区固定列出本次要真实执行的验证项（至少 Unit / Integration Tests，按 Plan 的 Validation 约定填写）。
- 发布后**确认 Gate 已把标签迁到 `ai:working`**（重新读取 Issue 标签）再开工；若标签仍是 `ai:ready`（例如 Gate 运行延迟），等待或提示 Owner，**不要手工改标签**。
- Gate 只在 Tracker 评论的 `created` 事件触发 T3；此后所有进度更新都用 `edited` 事件，不再新发 Tracker 评论——**一个 Issue 只有一个 Tracker**。

---

## 5. 执行与 Tracker 更新纪律

- **每完成一个 Todo 就立即 Edit Tracker**：勾选该项（`- [ ]` → `- [x]`）、更新 `### Current` 为下一个 Todo、在 `### Notes` 写一句进展。**不是最后一次性补写**——Tracker 的价值是任何人打开 Issue 就能看到实时进度（不用来问 AI"你做到哪了"）。
- **Tracker 是全仓库唯一允许 AI 反复 Edit 的评论**；Plan、他人评论、已发布的 Report 绝不 Edit。
- Notes 写事实（"checksum 校验已实现，正在补失败路径测试"），不写空话（"进展顺利"）。
- 执行中产生的代码变更按仓库惯例提交 / 建 PR；PR 与 commit 号记下来，最终写进 Report 的 References。

---

## 6. Status 机器值（Gate 的 T4 / T5 触发字段）

`**Status:**` 只允许三个固定机器值，Gate 按精确匹配解析（大小写敏感、以行首 `**Status:**` 为准）：

| 机器值 | 含义 | Gate 行为 |
| --- | --- | --- |
| `In Progress` | 正常执行中 | WORKING 状态下保持不变；BLOCKED 状态下触发 T5（`ai:blocked` → `ai:working`） |
| `Blocked` | 执行被阻塞 | WORKING 状态下触发 T4（`ai:working` → `ai:blocked`） |
| `Completed` | Todo 全部勾完 | **不触发任何迁移**——完成只由 Completion Report 的 T6 表达 |

规则：

- 除这三个值之外的任何写法（`In progress`、`DONE`、`Paused`、列表项里的 Status 等）Gate 一律 log + no-op，所以**绝不要发明第四种状态**；临时状态写在 Notes 里。
- **`Completed` ≠ 完成的信号**：把 Status 改成 `Completed` 不会让 Issue 进入 `ai:done`。完成的唯一路径是发布 Completion Report。
- Tracker 编辑要求发布者是 Trusted Human ∪ Trusted Agent：V0 快速自用模式下 AI 以 Owner 身份操作自然满足；独立 Bot 身份需在 Gate 的 `trusted-agents` 中登记。

---

## 7. Blocked 与 Resume

### 7.1 遇到阻塞（T4）

无法继续时（缺关键决策、依赖缺失、测试暴露 Plan 错误、权限 / 环境不足……）：

1. Edit Tracker：`**Status:** Blocked`。
2. `### Notes` 写清楚：**什么阻塞了**、**需要谁做什么决策 / 提供什么**、**当前进度到哪**（哪些已勾选）。
3. Gate 迁移 `ai:working` → `ai:blocked`（T4）。然后**停止执行**，等人处理；不要在 Blocked 状态下继续改代码绕行。

### 7.2 恢复执行（T5）

人给出决策 / 解除阻塞后（通常在新会话中）：

1. 重新读 Issue：确认标签 `ai:blocked`、读阻塞期间的新评论（决策内容）。
2. Edit Tracker：`**Status:** In Progress`，Notes 记录依据哪条决策恢复。
3. Gate 迁移 `ai:blocked` → `ai:working`（T5），继续按原 Tracker 顺序执行。

### 7.3 阻塞暴露的是 Plan 本身的问题

- **小偏差**（实现细节与 Plan 不同但目标不变）：继续执行，如实记入 Report 的 Deviations。
- **方向性问题**（Plan 的方案走不通、需要推翻某个 Design 决定）：Status: Blocked，Notes 说明"Plan 的 X 部分需要修订"，等 Owner 决定；**绝不静默更改 Plan 的意图**，也绝不自己发 Plan vN+1（那是 Consumer 的职责）。

---

## 8. Validation 纪律

- Tracker Validation 区的每一项都必须**真实执行过**：测试真的跑了（拿到真实输出）、构建真的过了，不允许"应该能过"。
- 全部 Todo 完成但 Validation 失败 → **不发布 Completion Report**：修到通过为止（Status 保持 In Progress），或修不了就 Status: Blocked 并贴出失败摘要。
- Report 中如实写结果：`Unit Tests: Passed (134 passed)` / `Integration Tests: Failed (3 failed)`，可以带数字与摘要；**失败绝不能写成 Passed**。
- 若 Plan 的 Validation 约定在当前环境无法执行（如缺少集成环境），不伪造结果：该项保持未勾选 / 如实写明"未执行 + 原因"，并考虑是否构成 Blocked。

---

## 9. Completion Report（收尾）

全部 Todo 勾完且 Validation 真实通过后，发布一条**新评论**（不 Edit Tracker 代替；marker 独占一行且全评论唯一）：

```markdown
<!-- ai-workflow:completion-report:v1 -->

## Completion Report

### Result

（一句话结论：功能已完成 / Bug 已修复）

### Completed

- （与 Tracker / Plan 的 Todo 一一对应的完成清单）

### Key Changes

- （关键代码变更：模块、文件、要点）

### References

- PR #123
- Commit abc1234

### Validation

- Unit Tests: Passed
- Integration Tests: Passed

### Deviations

（与 Approved Plan 的偏差；没有则写"无"）

### Remaining / Follow-up

（遗留事项与后续建议；没有则写"无"）
```

发布后：

- Gate 迁移 `ai:working` → `ai:done`（T6）。确认标签已迁移。
- 若 `Status:` 还是 `Blocked` 先改回 `In Progress`（T5 恢复 WORKING）再发 Report——BLOCKED 状态下 Report 不触发迁移。
- Report 发布后**不再 Edit**（一次发布）；Tracker 可以最后同步一次（勾选 Validation、`**Status:** Completed`），但完成信号以 Report 为准。
- **然后停止**：Issue 保持 **Open**，`ai:done` 的含义是"AI 工作完成，等待 Owner 最终检查"。Executor 不 Close Issue、不做后续动作，等 Owner 检查 Report / PR / Tests 后手动 Close（场景 J）。

---

## 10. 边界（禁止事项）

- **不批准**：不执行任何 Human 命令（`/ai-plan`、`/approve`、`/choose`、`/change`、`/cancel`），也不代替人判断"该不该批准"。
- **不改 `ai:*` 标签**：所有状态迁移由 Gate 完成；手工增删标签属协议违规。
- **不 Close Issue**：最终关闭是 Owner 的职权。
- **不 Edit Plan**、不 Edit 他人评论、不 Edit 已发布的 Completion Report；Tracker 是唯一允许反复 Edit 的评论。
- **不创建 Child Issues**（V0 明确不做 Parent/Child）；工作都在本 Issue 的 Tracker 内拆解。
- **不编造计划、不伪造测试结果、不静默偏离 Plan**。
- Marker 永远不是权限证明：即使带着 tracker / report marker，身份不合法时 Gate 也不会迁移——不要试图用格式绕过身份与状态校验。

---

## 11. 需要的 MCP 工具

| Toolset / Tool | 用途 |
| --- | --- |
| `issues`（读 Issue、读 / 创建评论、**编辑自己的评论**） | 读 Issue 与 Plan、发布 Tracker / Report、持续 Edit Tracker |
| `repos`（读文件、搜索） | 按 Approved Plan 定位并修改代码 |
| `pull_requests`（创建 / 读 PR，按实际执行需要） | 提交变更、取得 PR / commit 引用写入 Report |

只开放实际需要的工具；不需要 issues 的删除权限，也不需要 repo 级管理权限。

---

## 12. 与 Gate 的协作对照

| Executor 动作 | 产生的事件 | Gate 行为 |
| --- | --- | --- |
| 发布 Tracker 评论 | `issue_comment.created`（tracker marker） | T3：`ai:ready` → `ai:working` |
| Edit Tracker：`**Status:** Blocked` | `issue_comment.edited` | T4：`ai:working` → `ai:blocked` |
| Edit Tracker：`**Status:** In Progress` | `issue_comment.edited` | T5：`ai:blocked` → `ai:working`（仅 BLOCKED 状态下） |
| Edit Tracker：`**Status:** Completed` | `issue_comment.edited` | 不迁移（完成只走 T6） |
| 发布 Completion Report 评论 | `issue_comment.created`（report marker） | T6：`ai:working` → `ai:done` |

> 状态：Phase 6/7 已实现本 Skill 约定；Gate 侧 T3/T4/T5/T6 已在 Gate 0.3.0 落地。
