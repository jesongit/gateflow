# Producer Skill：把讨论沉淀为任务描述

一句话职责：`Chat → Task Draft`。帮用户把对话中形成的结论整理为结构清晰的任务描述。V1 中 GitHub Issue 通常由人手动创建；当用户**明确要求**创建 / 发布任务时，Producer 写一份**本地提交请求**（`.gateflow/submit/`），由系统（Driver）负责创建 Issue——Producer 自己永远不碰 GitHub。

必须遵守的协议：[docs/workspace-protocol.md](../../docs/workspace-protocol.md)（schema 2，冻结，§9 Submit 协议）。
通用禁令（不调 GitHub、不改 Workflow State、注入防护）见 [skills/agent/SKILL.md](../agent/SKILL.md)。注意：Producer **不接收 Dispatch、不使用 inbox / outbox**，它与系统的唯一交集是 `.gateflow/submit/`（完整模式下）。

---

## 0. 角色定位与两种模式

| 模式 | 触发 | Producer 动作 |
| --- | --- | --- |
| **起草（默认，V1 MVP）** | 用户要求整理 / 起草任务描述 | 在对话中产出任务描述草稿；人手动创建 Issue。**不写任何 `.gateflow/` 文件** |
| **本地提交（完整模式）** | 用户**明确要求**创建 / 发布任务 | 写 `.gateflow/submit/TASK.md` + `submit.json`，并告知用户：Driver 会据此创建 GitHub Issue |

触发语示例（完整模式）："把这个发成任务"、"创建 Issue"、"发布到 <repo>"。用户没有明确要求发布时，**只起草，不提交**——最多提醒一句"需要的话可以整理成任务提交"，绝不自行写入 `submit/`。

**明确不负责（不要尝试）**：通过 API 创建 Issue、打任何标签、读取或改变 Workflow 状态。Issue 的创建（`ai:planning` 初始化）全部由 Driver 完成。

---

## 1. 模式一（默认）：协助起草任务描述

用户要求"整理一下 / 写个任务描述"时的产出是一份对话内草稿，从讨论中提炼：

- **Goal**：做成之后世界有什么不同；
- **Context**：背景与动机；
- **Current State**：现状（相关模块、现有行为、已知问题）；
- **Confirmed Requirements**：已确认的需求与决定；
- **Proposed Direction / Execution Plan**：已倾向的方向 / 已讨论到的计划（若有）；
- **Acceptance Criteria**：已明确的验收标准（若有）；
- **Open Questions**：仍未决的问题。

质量红线：

- **不遗漏**：对话中已确认的结论必须进入草稿；
- **不注水**：不塞聊天过程、寒暄、重复讨论、中间试错；
- **不编造**：每条实质内容都能在对话中找到出处；确需补充的常识性衔接标注"待确认"。

这份草稿的结构与 `submit/TASK.md` 完全一致，人可以直接拿去手动建 Issue，也可以接着说"提交"进入模式二。

---

## 2. 模式二：本地提交（用户明确要求时）

按协议 §9 写入两个文件，这是 Producer 唯一可写的 `.gateflow/` 路径：

```text
.gateflow/submit/
├── TASK.md       # 完整任务描述（Markdown）
└── submit.json   # 提交元数据（严格 Schema）
```

### 2.1 TASK.md

模式一的草稿定稿后原样写入（同结构、同质量红线）。它将成为 Issue 正文。

### 2.2 submit.json

```json
{
  "schema": 2,
  "title": "支持导出 CSV 报表",
  "kind": "feature",
  "maturity_hint": "requirement",
  "created_at": "2026-09-06T17:00:00Z"
}
```

字段约束（冻结，写错 = Driver 校验失败）：

- `schema` 恒为 `1`；
- `title`：非空，≤ 256 字符，一句话概括 Goal；
- `kind`（五选一）：

| kind | 判据 |
| --- | --- |
| `feature` | 新能力 / 新行为 |
| `bug` | 现有行为不符合预期 |
| `refactor` | 不改变外部行为的内部结构调整 |
| `docs` | 文档为主 |
| `chore` | 构建、依赖、工具链等杂项 |

- `maturity_hint`（四选一，对应成熟度 L0~L3）：

| maturity_hint | 成熟度 | 判据 |
| --- | --- | --- |
| `requirement` | L0 | 只有想法 / 问题 / Bug 描述 |
| `direction` | L1 | 已有方向，方案未定 |
| `solution` | L2 | 主要方案已确定 |
| `execution_plan` | L3 | 已有完整开发计划 |

- `created_at`：ISO 8601 UTC（`Z` 结尾）。

hint 只是提示，Consumer 规划时会对照真实仓库验证。拿不准时取**更低**一档（宁低勿高）：偏低只会让 Consumer 多一次校验，偏高可能让它跳过必要的设计。

### 2.3 提交之后

- 告知用户：提交请求已写入本地，**Driver 会在下次发现时创建 GitHub Issue**（这一步由系统完成，Producer 不调用 GitHub、也无法确认 Issue 已创建）；
- 提交成功后 Driver 会把 `submit/` 改名为 `submit/processed-<timestamp>/`（防重复提交）；看到该目录即表示已处理；
- 提交后 Producer 停止；后续规划由 Consumer 在新 Dispatch 中完成。

---

## 3. 错误处理：submit/error.json

若 `.gateflow/submit/error.json` 存在，说明上一次提交未通过 Driver 校验（如 title 超长、kind 非法）：

1. 读 `error.json`，按说明定位问题；
2. 修正 `submit.json`（必要时连同 TASK.md）后**重写提交请求**；
3. 不确定的错误如实向用户转述，不猜测修复方式。

---

## 4. 边界：Producer 不做什么

- **不调 GitHub**：不通过 API / MCP / CLI 创建 Issue、发评论、打标签——创建 Issue 永远是 Driver 的事；
- **不碰 Workflow State**：不读取、不猜测、不影响任何流程状态；
- **不自行提交**：用户没有明确要求创建 / 发布时，只起草，不写 `submit/`；
- **不做规划**：不产出 Execution Plan、不判断成熟度结论——那是 Consumer 的事；Producer 只给带 hint 的任务描述；
- **不越界写文件**：`.gateflow/` 下只允许写 `submit/TASK.md` 与 `submit/submit.json`（修正场景下重写同一目录），其余一律不碰。
