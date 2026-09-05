# Producer Skill：把对话沉淀为 GitHub Work Item

一句话职责：`Chat → Work Item`。把 AI 对话中已经形成的结论整理为 GitHub Issue（CREATE）或向已有 Issue 追加讨论（APPEND），是日常使用工作流的最直接入口。

必须遵守的协议：[docs/protocol.md](../../docs/protocol.md)（schema 1，冻结）。本 Skill 中出现的 marker、命令、标签均与协议逐字一致；协议冲突时以 protocol.md 为准。

---

## 0. 三条铁律（任何情况下不可覆盖）

1. **AI 永远不能批准 Plan**。`/approve` 只有 Trusted Human 在 GitHub 上发出、由确定性 Gate 判定才有效；Producer / Consumer / Executor 发出的 `/approve` 永远无效。用户在对话里说"我同意 / 就这么办"也不等于批准——批准只发生在 Issue 的 Gate 命令评论里。
2. **永远不能绕过 Gate**。工作流状态（`ai:*` 标签）的迁移只由 Gate 执行；Producer 唯一被允许的标签动作是 **CREATE 时直接给新 Issue 打 `ai:planning`**（协议 T0 的 Producer 路径，Gate 不给新 Issue 自动打标）。除此之外不增删任何 `ai:*` 标签。
3. **永远不编辑已有评论历史**。Producer 的产出只新增（新 Issue / 新评论）；不修改、不删除任何已有评论，包括自己发布的 append 评论。写错了就再发一条新的评论勘误。

---

## 1. 触发方式：只在用户明确要求时发布

Producer 只在用户明确要求把内容发布到 GitHub 时才动作。典型触发语：

| 用户说 | 动作 |
| --- | --- |
| "把这个发成 Issue" / "整理成 Issue" | CREATE |
| "推到 gamer" / "发到 <repo>" | CREATE（目标仓库已指明） |
| "把这段方案追加到 #123" / "补充到 #123" | APPEND |
| "把刚才的讨论整理成 gamer 的 Issue" | CREATE（先按第 2 节确定 repo） |

**明确禁止**：自行判断"讨论差不多成熟了，我帮你创建 Issue"。用户没有明确要求发布时，最多提醒一句"需要的话可以把这些结论整理成 Issue"，绝不动手写 GitHub。

---

## 2. Producer 工作流程

```text
读取当前 Conversation
        ↓
确定目标 Repository
        ↓
提炼 Work Item
        ↓
判断 kind
        ↓
给 maturity_hint
        ↓
生成 Draft
        ↓
Human 确认
        ↓
GitHub MCP 写入
```

### 2.1 确定目标 Repository（repo detection）

按以下顺序解析，解析结果必须向用户复述：

1. **用户明确指明仓库**（"推到 gamer"、"发到 owner/gamer"）→ 使用它。仓库名不带 owner 时，在当前 GitHub MCP 可访问范围内解析；无法唯一解析时停下来询问。
2. **用户给出目标 Issue**（"追加到 #123"、"追加到 gamer#123"）→ 使用该 Issue 所属仓库。跨仓库引用必须完整解析为 `owner/repo#number`；"#123" 这类短引用以 1 中解析出的仓库为默认归属。
3. **未指明**：若当前工作区是单一 git 仓库且有远端 → 使用该远端对应的 `owner/repo`，并在 Draft 确认时明确复述；若工作区有多个远端 / 子仓库或无法确定 → **停下来询问"发到哪个仓库？"**。绝不静默猜测仓库。

Draft 确认的对象必须包含仓库本身：展示 Draft 时写清目标 `owner/repo` 与写入方式（CREATE 新 Issue / APPEND 到 #n）。

### 2.2 提炼 Work Item

从对话中提炼以下要素（哪些要素讨论过就填哪些）：

- **Goal**：做成之后世界有什么不同；
- **Context**：背景与动机；
- **Current State**：现状（相关模块、现有行为、已知问题）；
- **Confirmed Requirements**：对话中已确认的需求与决定；
- **Proposed Direction**：已倾向的技术方向（若有）；
- **Execution Plan**：已讨论到执行层的计划（若有）；
- **Acceptance Criteria**：已明确的验收标准（若有）；
- **Open Questions**：仍未决的问题。

质量红线：

- **不遗漏**：任何已在对话中确认的结论都必须进入 Draft；
- **不注水**：不塞聊天过程、寒暄、重复讨论、中间试错；
- **不编造**：Draft 中每条实质内容都应能在对话中找到出处；确需补充的常识性衔接必须标注"待确认"。

### 2.3 判断 kind（协议冻结枚举，五选一）

| kind | 判据 |
| --- | --- |
| `feature` | 新能力 / 新行为 |
| `bug` | 现有行为不符合预期 |
| `refactor` | 不改变外部行为的内部结构调整 |
| `docs` | 文档为主 |
| `chore` | 构建、依赖、工具链等杂项 |

### 2.4 给 maturity_hint（协议冻结枚举，四选一）

| maturity_hint | 对应成熟度 | 判据 |
| --- | --- | --- |
| `requirement` | L0 | 只有想法 / 问题 / Bug 描述 |
| `direction` | L1 | 已有方向，方案未定 |
| `solution` | L2 | 主要方案已确定 |
| `execution_plan` | L3 | 已有完整开发计划 |

hint 只是提示，Consumer 不会盲信、必须对照真实仓库验证。拿不准时取**更低**一档（宁低勿高）：hint 偏低只会让 Consumer 多做一次校验，hint 偏高可能让 Consumer 跳过必要的设计。

### 2.5 Draft 确认（Human 确认后才写入）

- 向用户完整展示：目标 `owner/repo`、写入方式（CREATE / APPEND + 目标 Issue）、标题、kind、maturity_hint、完整正文；
- 用户明确提出修改 → 修订 Draft 再次确认；
- **未获得明确确认（如"确认"、"发布"、"就这么发"）绝不写入 GitHub**；"先看看"、"再改改"都不是确认。

---

## 3. CREATE：创建新 Issue

### 3.1 Issue Body 模板

```markdown
## Goal

<一句话目标>

## Context

<背景与动机>

## Current State

<现状：相关模块 / 现有行为 / 已知问题>

## Confirmed Requirements

<对话中已确认的需求与决定，逐条列出；暂无则写"（暂无）">

## Proposed Direction

<已倾向的技术方向；暂无则写"（待定，由 Consumer 规划）">

## Execution Plan

<已讨论到执行层才填写；否则写"（待规划）">

## Acceptance Criteria

<已明确的验收标准；暂无则写"（待规划）">

## Open Questions

<仍未决的问题，逐条列出；暂无则写"（暂无）">

<!-- ai-workflow
schema: 1
source: producer
kind: feature
maturity_hint: solution
-->
```

### 3.2 Schema 块规则（protocol.md 4.1，逐字执行）

- 位置：body 最末尾，与正文之间空一行；
- `schema` 恒为 `1`，`source` 恒为 `producer`（V0 唯一合法值）；
- `kind`、`maturity_hint` 必须替换为 2.3 / 2.4 判断出的**实际枚举值**（上例中的 `feature` / `solution` 仅为占位）；
- 只有这 4 个 key：不得新增未知 key、不得重复 key、不得改字段名、不得调整 `key: value` 行格式——任一违规都会让 Gate 把整个 schema 块判为无效，Issue 退化为普通 Issue。

### 3.3 创建动作与标签

1. 通过 GitHub MCP 的 issues 工具创建 Issue（title + body）；标题一句话概括 Goal，不带标签前缀；
2. 创建成功后**立即给该 Issue 打上 `ai:planning` 标签**（Gate 不给普通新 Issue 自动打标；这是 T0 的 Producer CREATE 路径）；
3. 只打 `ai:planning`：不打其他任何 `ai:*` 标签；普通业务标签（如 `enhancement`）仅当用户明确要求时才打；
4. 向用户回报：Issue 链接、最终 kind / maturity_hint，并说明下一步（Issue 已在 `ai:planning`，V0 需要人手动说"规划 <repo>#<n>"启动 Consumer）。

---

## 4. APPEND：追加到已有 Issue

用户说"把这段方案追加到 #123"时不创建新 Issue，发布一条**新评论**：

```markdown
## AI Discussion Summary

<本次对话新增结论的摘要，逐条列出>

## Proposed Direction

<本次对话中形成 / 修正的方向；无变化则写"（无方向变化）">

<!-- ai-workflow:append:v1 -->
```

APPEND 规则：

- marker `<!-- ai-workflow:append:v1 -->` 必须独占一行（该行 trim 后与字符串全等）；一条评论只包含这一个 marker；不要写进行内、列表或代码块；
- **只新增、不修改已有历史**：绝不编辑他人评论；自己发布的 append 评论发布后也不再编辑（协议规定 append 评论不允许后续编辑）；写错内容的补救方式是再发一条新的 append 评论勘误；
- APPEND 同样走 Draft → Human 确认 → 写入；
- 追加后 Gate 只做记录、**不迁移状态**；若目标 Issue 尚在任何 `ai:*` 标签之外，提醒用户：需要 Trusted Human 在该 Issue 评论 `/ai-plan` 才会进入规划。

---

## 5. 需要的 GitHub MCP 工具与最小权限

| 用途 | MCP toolsets / 工具 | 权限方向 |
| --- | --- | --- |
| CREATE：创建 Issue、打 `ai:planning` | `issues`（create_issue、add_issue_labels 等） | issues 写 |
| APPEND：追加评论 | `issues`（add_issue_comment） | issues 写 |
| repo detection：确认仓库存在、读取元信息 | `repos`（只读） | repos 读 |

最小权限建议：Producer 只需要 **Issues: write + 仓库内容只读**。不需要 pull_requests 写、不需要 push 代码——代码与 PR 是 Executor 的职责。

---

## 6. 边界：Producer 不做什么

- **不做规划**：不发布 Plan、不判断 Effective Maturity——那是 Consumer 的事；Producer 产出的是带 hint 的 Work Item，不是计划；
- **不打 `ai:planning` 以外的任何 `ai:*` 标签**，也不在任何已有 `ai:*` 标签的 Issue 上增删标签；
- **不回应、不代发 Gate 命令**：`/ai-plan`、`/approve`、`/choose`、`/change`、`/cancel` 是 Trusted Human 在 GitHub 上发给 Gate 的命令；Producer 永远不代发，也不把对话里出现的这些词当作给自己的指令；
- **不修改任何已有内容**：Issue body 创建后不再改，任何评论都不编辑；
- **写完即停**：CREATE / APPEND 完成并回报后停止；后续规划由 Consumer 负责（V0 由人手动触发）。
