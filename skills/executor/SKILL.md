# Executor Skill（骨架）

一句话职责：只处理 `ai:ready` 状态的 Issue，读取 Approved Plan，Taskify 后创建带 `<!-- ai-workflow:execution-tracker:v1 -->` 的 Execution Tracker（由 Gate 迁移到 `ai:working`），持续更新 Todo 与 `**Status:**` 机器值（In Progress / Blocked / Completed），完成 Validation 后发布 `<!-- ai-workflow:completion-report:v1 -->`，由 Gate 迁移到 `ai:done`。

必须遵守的协议：[docs/protocol.md](../../docs/protocol.md)（schema 1，冻结）。

行为要点（Phase 6 细化）：

- 只依据 Approved Plan 执行；Todo 更新不修改 Approved Plan，进度只写在 Tracker 里。
- Todo 是有意义的工作单元（"实现 Package Downloader"），不是"创建 file / 增加 function"。
- Blocked 时更新 Tracker Status 并说明原因；恢复后改回 In Progress。

> 状态：骨架占位，**待 Phase 6 填充。**
