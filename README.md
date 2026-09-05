# GateFlow

> GitHub-native AI Workflow V0 —— 把 AI 编码协作的原生载体放在 GitHub 上：**GitHub 保存正式工作状态（Issue / Comment / Label / PR），AI 负责理解、规划、执行和汇报，权限、审批和状态迁移由确定性程序（Gate）控制。**

没有常驻 Server、没有数据库、没有 Web UI。整条 Workflow 只有四部分：

```text
AI Conversation
      │
      ▼
 Producer Skill            （Chat → GitHub Work Item）
      │
      ▼
 GitHub Issue              （唯一正式状态存储）
      │
      ▼
 TypeScript Gate           （确定性：身份 / 命令 / 状态 / Marker / Label 迁移）
      │
      ▼
 Consumer / Executor Skills
      │
      ▼
 Plan → Todo → Code → Report
```

核心原则：

1. **确定性优先**：`/approve` 等授权动作只由 TypeScript Gate 按"actor 身份 + 严格命令解析 + 当前状态"判定，AI 永远不参与授权判断。
2. **Marker 只是结构标记**：任何人都能写出 Marker 文本，Marker 永远不能当权限证明。
3. **两个身份概念永不合并**：Trusted Human（默认 = repo owner）与 Trusted Agent（V0 默认空）在代码与协议中严格分离。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 整体架构、组件职责、数据流、V0 明确不做的清单 |
| [docs/protocol.md](docs/protocol.md) | **协议冻结**：Labels / 状态机 / Commands / Markers / Maturity / Permissions / 并发规则 |
| [docs/security.md](docs/security.md) | 权限边界、为什么审批交给确定性 Gate、Marker 伪造与 Prompt Injection 防线 |
| [docs/usage.md](docs/usage.md) | 协议速查表 + 四步安装指南（bootstrap）+ 场景 A~J 日常操作手册 |
| [docs/release.md](docs/release.md) | 发布手册：发布步骤清单、版本策略（package.json / GATE_VERSION / 协议 schema）、`@v0` 浮动 tag 策略、发布前 checklist |
| [计划总文档](github-native-ai-workflow-v0-development-and-usage-guide.md) | 详细开发计划与使用手册（Phase 0~11） |

## 仓库结构

```text
gateflow/
├── README.md
├── package.json / tsconfig.json
├── action.yml              # Gate Action 入口声明
├── src/                    # Gate 源码（TypeScript strict）
│   ├── index.ts            # Action 入口：构造 GateInput 并调用 gate（非 Actions 环境安全退出）
│   ├── gate.ts             # 主流程：Event → Permission → State → Command → Validate → Transition
│   ├── commands.ts         # 严格命令解析（无参全等 + 带参锚定正则，五个命令全部生效）
│   ├── states.ts           # 状态快照 + 迁移合法性（以 protocol.ts 为单一事实来源）
│   ├── permissions.ts      # Trusted Human / Trusted Agent 判定（两概念永不合并）
│   ├── markers.ts          # Comment Marker 识别（独占整行 + 单 marker 校验 + 围栏代码块剔除）
│   ├── github.ts           # Octokit API 封装（业务逻辑不散落 API 调用）
│   └── protocol.ts         # 冻结协议常量（与 docs/protocol.md 同步）
├── dist/index.js           # esbuild 产物（GitHub JS Action 要求提交）
├── tests/                  # vitest 单测
├── skills/                 # producer / consumer / executor 三个 AI Skill
├── fixtures/               # Consumer 成熟度测试输入（raw-idea / raw-bug / direction / solution / full-plan）
├── templates/workflow.yml  # 目标仓库的 Gate workflow 模板（事件 / 并发组 / Action 输入）
├── scripts/bootstrap.mjs   # 目标仓库初始化脚本（创建 ai:* 标签 + 生成 workflow，幂等不覆盖）
└── docs/                   # architecture / protocol / security / usage / release
```

## 快速开始

把工作流接入一个新项目只需要四步（完整说明见 [docs/usage.md](docs/usage.md) 第 2 节）：

```bash
# 在目标仓库的检出目录里运行（--dry-run 可先预览将做什么）：
node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target
```

1. **bootstrap 一键初始化**（幂等，可重复执行）：创建 6 个 `ai:*` 标签——已存在的同名标签跳过、绝不修改；生成 `.github/workflows/ai-workflow.yml`——已存在则警告跳过、绝不覆盖，不触碰已有 issue templates 与 PR workflow；
2. **workflow 模板**（`templates/workflow.yml`）：监听 `issues [opened, labeled, closed]` + `issue_comment [created, edited]`，串行并发组 `ai-workflow-<issue_number>`（`cancel-in-progress: false`），显式传入 `trusted-humans` / `trusted-agents`（默认空 = 仅 repo owner / 无 Trusted Agent）；
3. **配置 GitHub MCP**：最小 toolsets `repos` / `issues` / `pull_requests`；
4. **安装 Skills**：`skills/producer`、`skills/consumer`、`skills/executor` 装入你的 AI Client。

> Action 正式发布前，模板中的 `uses: jesongit/gateflow@v0` 是占位引用，可用 bootstrap `--action-ref` 指向实际 owner/repo@ref；发布步骤与 `@v0` 浮动 tag 策略见 [docs/release.md](docs/release.md)。

不装 Action 也能先理解流程（详见 [docs/usage.md](docs/usage.md) 第三节）：配置 MCP + 安装 Skills 后，和 AI 聊需求 → "把刚才讨论整理成 <repo> 的 Issue"（Producer）→ "规划 <repo>#<n>"（Consumer 出 Plan）→ Issue 上 `/approve`（Gate 迁状态）→ "执行 <repo>#<n>"（Executor 按计划开发并汇报）。

本仓库自身开发：

```bash
npm install        # 安装依赖
npm run build      # esbuild 打包 dist/index.js
npm run typecheck  # tsc --noEmit（strict）
npm test           # vitest
```

## 并发与一致性（重要）

Gate 自身是确定性的，但**串行化必须由 workflow 层保证**（`templates/workflow.yml` 已内置，bootstrap 生成的文件同样带上）：

- 同一 Issue 的所有 Gate run 必须落在同一个 concurrency group：`group: ai-workflow-<issue_number>`，且 `cancel-in-progress: false`（排队执行，不取消）。
- 无论是否配置并发组，Gate 在**每次状态迁移前都会通过 GitHub API 重新读取当前 labels**，绝不信任 event payload 中的快照；重读结果与命令前提不符时按无效命令处理（no-op + log 原因）。
- 如手工编写 workflow 而不用模板，请务必自行加上相同的 concurrency 配置，否则两个并发 run 仍可能交错执行。

## 当前状态

- Phase 0（建仓库骨架 + 协议冻结）：已完成。协议冻结见 [docs/protocol.md](docs/protocol.md)，协议常量同步在 [src/protocol.ts](src/protocol.ts)。
- Phase 1（Gate 核心）：已完成。纯确定性状态机，不接任何 AI——支持 `/ai-plan`（T0）、`/approve`（T2）、`/cancel`（退出，不关闭 Issue）；非法命令 / 错误状态 / 非 Trusted Human 一律 no-op 并记录原因，不会产生红 X 噪音。`/choose`、`/change`、reaction 反馈、Marker 校验在 Phase 2；workflow 模板在 Phase 8。
- Phase 2（Gate 完整命令 + Marker 校验）：已完成。五个命令全部生效：`/ai-plan`（T0）、`/approve`（T2）、`/choose` / `/change`（仅 REVIEW，✅ 后转交 Consumer，不迁移）、`/cancel`；接受的命令加 ✅，非 Trusted Human 命令加 👎（invalid owner command）后静默；marker 校验实装：独占整行 + 单 marker + 围栏代码块剔除，plan / tracker / report marker 分别触发 T1 / T3 / T6（发布者须为 Trusted Human ∪ Trusted Agent），append marker 与 Issue body schema 块只记录不迁移。reaction 为 best-effort，失败不影响主流程。偏差记录见 [docs/protocol.md](docs/protocol.md) 文末"实现备注"。
- Phase 3（Producer Skill）：已完成。[skills/producer/SKILL.md](skills/producer/SKILL.md) 定义 Chat → Work Item：仅在用户明确要求时发布；CREATE（body 模板 + 文末 schema 块 + 直接打 `ai:planning`）与 APPEND（append marker 评论，只新增不改历史）；Draft 必须经 Human 确认后才经 GitHub MCP 写入。
- Phase 4 / 5（Consumer Planning Skill + Plan Review 闭环）：已完成。[skills/consumer/SKILL.md](skills/consumer/SKILL.md) 定义 Issue → Execution Plan：读 Issue 与真实仓库、判断 Effective Maturity（hint 只是提示，可降级）、按最小补全原则发布 Plan（plan marker，Gate 迁 `ai:review`）；消费 `/choose` / `/change`（Gate ✅ 后不迁移）发布 Plan vN+1 新评论（最小变更、不覆盖旧版）；`/approve` 后停止，执行移交 Executor。成熟度测试输入见 [fixtures/](fixtures/)（raw-idea / raw-bug / direction / solution / full-plan 五档）。日常操作手册见 [docs/usage.md](docs/usage.md)。
- Phase 6（Tracker 状态迁移 T4/T5）：已完成。Gate 从 Execution Tracker 的 `**Status:**` 机器值确定性解析 `WORKING ↔ BLOCKED`（仅 tracker marker 评论的 edited 事件、受信发布者、迁移前 API 重读；`Completed` 不触发迁移，完成只走 T6）。偏差与解析口径见 [docs/protocol.md](docs/protocol.md) 文末"实现备注"。
- Phase 7（Executor Skill + Completion Report）：已完成。[skills/executor/SKILL.md](skills/executor/SKILL.md) 定义 Approved Plan → TodoList（tracker marker，T3）→ 开发并持续更新 Tracker → Validation → Completion Report（T6 → `ai:done`，Issue 保持 Open，最终由 Owner 检查后 Close）。
- Phase 8（安装与 Bootstrap）：已完成。[templates/workflow.yml](templates/workflow.yml)（目标仓库的 Gate workflow 模板：协议事件矩阵 + 串行并发组 + 显式 `trusted-humans` / `trusted-agents` 输入）与 [scripts/bootstrap.mjs](scripts/bootstrap.mjs)（零新增依赖、幂等可重复执行：校验仓库 → 创建缺失的 6 个 `ai:*` 标签（同名跳过、绝不修改已有标签）→ 经确认生成 workflow 文件（已存在警告跳过、绝不覆盖）→ 打印 MCP / Skills 手动安装提示；支持 `--dry-run`）。四步安装流程见 [docs/usage.md](docs/usage.md) §2。
- Phase 9（Package / Release 就绪）：已完成（就绪状态）。[docs/release.md](docs/release.md) 固化发布步骤清单（typecheck / test / build 产物同步 → tag → Release → `@v0` 浮动 tag 维护）与版本策略（`package.json` 仓库版本 = `0.1.0`；`GATE_VERSION` = `0.3.0` 为 Gate 行为版本；协议 `schema: 1` 冻结）；发布前 6 项全量验证（typecheck 零错误、156 个测试全绿、build 后 dist 无变化、非 Actions 环境安全退出、bootstrap `--help`、YAML 解析）全部通过。实际的打 tag / push / GitHub Release 留待真实发布时按 [docs/release.md](docs/release.md) 执行。
