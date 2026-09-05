# GitHub-native AI Workflow V0

把 AI 编码协作的原生载体放在 GitHub 上：**GitHub 保存正式工作状态（Issue / Comment / Label / PR），AI 负责理解、规划、执行和汇报，权限、审批和状态迁移由确定性程序（Gate）控制。**

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
| [docs/usage.md](docs/usage.md) | 协议速查表 + 场景 A~J 日常操作手册 + 安装（Phase 8 占位） |
| [计划总文档](github-native-ai-workflow-v0-development-and-usage-guide.md) | 详细开发计划与使用手册（Phase 0~11） |

## 仓库结构

```text
github-ai-workflow/
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
├── templates/              # workflow 模板（Phase 8）
├── scripts/                # bootstrap 脚本（Phase 8）
└── docs/                   # architecture / protocol / security / usage
```

## 快速开始

> 本仓库尚不能"开箱安装到目标项目"：workflow 模板、bootstrap 脚本与 Action 发布在 Phase 8 / 9 提供。当前已有的能力：**Gate 完整实现（五个命令 + 六状态状态机 + Marker 校验）**，**Producer / Consumer 两个 Skill 已定义**（Markdown 协议文档，配合 GitHub MCP 使用）。

当前开发阶段：

```bash
npm install        # 安装依赖
npm run build      # esbuild 打包 dist/index.js
npm run typecheck  # tsc --noEmit（strict）
npm test           # vitest
```

手动体验工作流的路径（不装 Action 也能理解流程，详见 [docs/usage.md](docs/usage.md) 第三节）：

1. 在 AI Client 配置 GitHub MCP（toolsets：repos / issues），安装 `skills/producer`、`skills/consumer`；
2. 和 AI 聊需求 → "把刚才讨论整理成 <repo> 的 Issue"（Producer 创建 Issue + schema 块 + `ai:planning`）；
3. 对 AI 说"规划 <repo>#<n>"（Consumer 读仓库、判成熟度、发布 Plan）；
4. 在 Issue 上 `/change` / `/choose` / `/approve`（Gate Action 就绪前，这些命令由人按协议语义执行）；
5. 执行阶段（Executor）在 Phase 6/7 提供。

## 并发与一致性（重要）

Gate 自身是确定性的，但**串行化必须由 workflow 层保证**（Phase 8 提供 `templates/workflow.yml`）：

- 同一 Issue 的所有 Gate run 必须落在同一个 concurrency group：`group: ai-workflow-<issue_number>`，且 `cancel-in-progress: false`（排队执行，不取消）。
- 无论是否配置并发组，Gate 在**每次状态迁移前都会通过 GitHub API 重新读取当前 labels**，绝不信任 event payload 中的快照；重读结果与命令前提不符时按无效命令处理（no-op + log 原因）。
- 在 Phase 8 模板可用之前，如手动编写 workflow，请务必自行加上 concurrency 配置，否则两个并发 run 仍可能交错执行。

## 当前状态

- Phase 0（建仓库骨架 + 协议冻结）：已完成。协议冻结见 [docs/protocol.md](docs/protocol.md)，协议常量同步在 [src/protocol.ts](src/protocol.ts)。
- Phase 1（Gate 核心）：已完成。纯确定性状态机，不接任何 AI——支持 `/ai-plan`（T0）、`/approve`（T2）、`/cancel`（退出，不关闭 Issue）；非法命令 / 错误状态 / 非 Trusted Human 一律 no-op 并记录原因，不会产生红 X 噪音。`/choose`、`/change`、reaction 反馈、Marker 校验在 Phase 2；workflow 模板在 Phase 8。
- Phase 2（Gate 完整命令 + Marker 校验）：已完成。五个命令全部生效：`/ai-plan`（T0）、`/approve`（T2）、`/choose` / `/change`（仅 REVIEW，✅ 后转交 Consumer，不迁移）、`/cancel`；接受的命令加 ✅，非 Trusted Human 命令加 👎（invalid owner command）后静默；marker 校验实装：独占整行 + 单 marker + 围栏代码块剔除，plan / tracker / report marker 分别触发 T1 / T3 / T6（发布者须为 Trusted Human ∪ Trusted Agent），append marker 与 Issue body schema 块只记录不迁移。reaction 为 best-effort，失败不影响主流程。偏差记录见 [docs/protocol.md](docs/protocol.md) 文末"实现备注"。
- Phase 3（Producer Skill）：已完成。[skills/producer/SKILL.md](skills/producer/SKILL.md) 定义 Chat → Work Item：仅在用户明确要求时发布；CREATE（body 模板 + 文末 schema 块 + 直接打 `ai:planning`）与 APPEND（append marker 评论，只新增不改历史）；Draft 必须经 Human 确认后才经 GitHub MCP 写入。
- Phase 4 / 5（Consumer Planning Skill + Plan Review 闭环）：已完成。[skills/consumer/SKILL.md](skills/consumer/SKILL.md) 定义 Issue → Execution Plan：读 Issue 与真实仓库、判断 Effective Maturity（hint 只是提示，可降级）、按最小补全原则发布 Plan（plan marker，Gate 迁 `ai:review`）；消费 `/choose` / `/change`（Gate ✅ 后不迁移）发布 Plan vN+1 新评论（最小变更、不覆盖旧版）；`/approve` 后停止，执行移交 Executor。成熟度测试输入见 [fixtures/](fixtures/)（raw-idea / raw-bug / direction / solution / full-plan 五档）。日常操作手册见 [docs/usage.md](docs/usage.md)。
