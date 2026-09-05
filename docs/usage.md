# 使用手册（Usage）

> 本页先提供**协议速查表**（已冻结）；"安装"与"日常使用"两章为占位，Phase 8（templates/workflow.yml + scripts/bootstrap.mjs）与 Phase 9（发布 Action）后完善。
> 完整协议见 [protocol.md](protocol.md)。

## 1. 协议速查表

### 1.1 命令（Issue 评论，整条评论只写命令）

| 命令 | 示例 | 谁能用 | 何时 | 效果 |
| --- | --- | --- | --- | --- |
| `/ai-plan` | `/ai-plan` | Trusted Human（默认 repo owner） | 无 `ai:*` 标签的 Issue | 进入 `ai:planning`，AI 开始规划 |
| `/approve` | `/approve` | Trusted Human | `ai:review` | 批准 Plan，进入 `ai:ready` |
| `/choose` | `/choose 1 B` | Trusted Human | `ai:review` | 选择"问题 1 的选项 B"，Consumer 出新版 Plan |
| `/change` | `/change 还需要考虑离线安装` | Trusted Human | `ai:review` | 要求修改，Consumer 只改受影响部分出 Plan vN+1 |
| `/cancel` | `/cancel` | Trusted Human | 任一 `ai:*` 状态 | 移除全部 `ai:*` 标签退出工作流（不关闭 Issue） |

解析规则要点：命令必须独占整条评论（trim 后全等 / 锚定匹配）；大小写敏感；非 Owner 静默忽略；Owner 姿势错误不产生状态迁移。

### 1.2 状态标签

```text
ai:planning → ai:review → ai:ready → ai:working → ai:done
                                     ↕
                               ai:blocked
```

| 标签 | 含义 | 你要做什么 |
| --- | --- | --- |
| `ai:planning` | Consumer 正在分析 / 补设计 | 等待 Plan，或手动对 AI 说"规划 #N"（V0 无自动唤醒） |
| `ai:review` | Plan 待审批 | 读 Plan → `/approve`，或 `/change` / `/choose` |
| `ai:ready` | 已批准，待执行 | 对 AI 说"执行 #N"（V0 手动触发） |
| `ai:working` | 执行中 | 看 Execution Tracker 的实时进度 |
| `ai:blocked` | 执行被阻塞 | 看 Tracker 的 Notes，必要时介入 |
| `ai:done` | AI 完成，待你检查 | 检查 Report / PR / Tests → 手动 Close Issue |

### 1.3 Markers（一般无需手写，供机器识别）

| Marker | 位置 | 含义 |
| --- | --- | --- |
| `<!-- ai-workflow` `schema/source/kind/maturity_hint` 块 | Issue body 末尾 | Producer 创建的 Work Item 元信息 |
| `<!-- ai-workflow:append:v1 -->` | Comment | Producer 追加的讨论（只新增不改历史） |
| `<!-- ai-workflow:plan:v1 -->` | Comment | Execution Plan（修订 = 新版本新评论） |
| `<!-- ai-workflow:execution-tracker:v1 -->` | Comment | Execution Tracker（实时 Todo，允许编辑） |
| `<!-- ai-workflow:completion-report:v1 -->` | Comment | 最终完成报告 |

> Marker 只是结构标记，永远不能当权限证明。

### 1.4 成熟度（Consumer 依据）

`L0 Requirement`（只有想法）→ Consumer 全程规划；`L1 Direction`（有方向）→ 验证方向补全；`L2 Solution`（方案已定）→ 只补遗漏不重新选型；`L3 Execution Plan`（完整计划）→ Readiness Check 后直接进入待审批，禁止重新设计。

## 2. 安装（占位 — Phase 8/9 完善）

将包含以下内容（届时更新本节）：

- 在目标仓库放置 `.github/workflows/ai-workflow.yml`（模板：`templates/workflow.yml`）；
  - **并发要求（Phase 8 前手动配置时必须遵守）**：同一 Issue 的所有 Gate run 必须共享 concurrency group `ai-workflow-<issue_number>` 且 `cancel-in-progress: false`。Gate 在每次迁移前会通过 API 重读 labels 做最终校验，但串行化本身由 workflow 并发组保证；Phase 1 阶段模板尚未提供，README 有详细说明。
- 运行 `scripts/bootstrap.mjs` 创建 6 个 `ai:*` 标签并检查环境；
- 在 AI Client（Codex / Claude Code / Cursor / VS Code）配置 GitHub 官方 MCP Server（最小 toolsets：repos / issues / pull_requests）；
- 安装 producer / consumer / executor 三个 Skill（全局或项目级）；
- Action 发布后直接 `uses: owner/github-ai-workflow@v0`。

## 3. 日常使用（占位 — Phase 8/9 完善）

先记住最终形态的日常操作（计划文档第三十一节）：

```text
和 AI 聊完：        “发成 Issue”
已有 Issue 入流程：  /ai-plan
批准：              /approve
选择：              /choose 1 B
修改：              /change xxx
取消：              /cancel
执行阶段：          看 Execution Tracker
完成阶段：          看 Completion Report，然后 Close
```

V0 初期没有 Consumer Driver，需要在相应状态手动对 AI 说“规划 #N” / “执行 #N”——这是可接受的（先验证工作流，再解决自动唤醒）。
