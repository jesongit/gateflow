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
| [docs/usage.md](docs/usage.md) | 协议速查表 + 安装与日常使用（Phase 8/9 完善） |
| [计划总文档](github-native-ai-workflow-v0-development-and-usage-guide.md) | 详细开发计划与使用手册（Phase 0~11） |

## 仓库结构

```text
github-ai-workflow/
├── README.md
├── package.json / tsconfig.json
├── action.yml              # Gate Action 入口声明
├── src/                    # Gate 源码（TypeScript strict）
│   ├── index.ts            # 入口 stub（Phase 1 重写）
│   └── protocol.ts         # 冻结协议常量（与 docs/protocol.md 同步）
├── dist/index.js           # esbuild 产物（GitHub JS Action 要求提交）
├── tests/                  # vitest 单测
├── skills/                 # producer / consumer / executor 三个 AI Skill
├── templates/              # workflow 模板（Phase 8）
├── scripts/                # bootstrap 脚本（Phase 8）
└── docs/                   # architecture / protocol / security / usage
```

## 快速开始

> 占位：完整安装流程在 Phase 8（templates/workflow.yml + scripts/bootstrap.mjs）与 Phase 9（发布 `owner/github-ai-workflow@v0`）后提供。

当前开发阶段：

```bash
npm install        # 安装依赖
npm run build      # esbuild 打包 dist/index.js
npm run typecheck  # tsc --noEmit（strict）
npm test           # vitest
```

## 当前状态

- Phase 0（建仓库骨架 + 协议冻结）：已完成。协议冻结见 [docs/protocol.md](docs/protocol.md)，协议常量同步在 [src/protocol.ts](src/protocol.ts)。
- Phase 1（Gate 核心：事件路由、状态读取、Owner 校验、命令解析、Label 迁移、并发）：待开始。
