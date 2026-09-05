# Consumer Skill（骨架）

一句话职责：接手 `ai:planning` 状态的 Work Item，读取 Issue、Append 评论与真实仓库（README / AGENTS.md / 源码 / 测试），判断 Effective Maturity（L0~L3），按最小补全原则只补缺失设计，最终发布带 `<!-- ai-workflow:plan:v1 -->` 的 Execution Plan，由 Gate 迁移到 `ai:review`。

必须遵守的协议：[docs/protocol.md](../../docs/protocol.md)（schema 1，冻结）。

行为要点（Phase 4/5 细化）：

- 不盲信 `maturity_hint`，必须结合仓库实况判断，可降级（如 L3 → L2），不允许跳过仓库校验。
- 处理 `/choose`、`/change` 的语义（Gate 只做身份校验、格式解析与 ✅，不迁移状态）。
- 修订 = 发布 Plan vN+1 新评论；最小变更，不覆盖旧 Plan。

> 状态：骨架占位，**待 Phase 4 填充。**
