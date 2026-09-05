# Producer Skill（骨架）

一句话职责：把 AI 对话沉淀为 GitHub Work Item —— CREATE（创建新 Issue，body 末尾写入 `ai-workflow` schema 块，并通过 GitHub MCP **直接打上 `ai:planning`**）或 APPEND（向已有 Issue 追加带 `<!-- ai-workflow:append:v1 -->` 的评论，只新增、不修改已有历史）。

必须遵守的协议：[docs/protocol.md](../../docs/protocol.md)（schema 1，冻结）。

行为要点（Phase 3 细化）：

- 只在用户明确要求时发布（"把这个发成 Issue" / "追加到 #123"），不自行判断"讨论已成熟"。
- CREATE 前必须生成 Draft 并获得 Human 确认，再经 GitHub MCP 写入。
- 判断 `kind`（feature / bug / refactor / docs / chore），给出 `maturity_hint`（requirement / direction / solution / execution_plan）——hint 只是提示，Consumer 不会盲信。

> 状态：骨架占位，**待 Phase 3 填充。**
