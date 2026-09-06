# GateFlow

> **GitHub-native Human-Gated Agent Runtime。GitHub 保存正式状态；Gate 控制授权和状态迁移；Driver 负责任务发现、派发和同步；Agent 只通过本地 Workspace Protocol 接收任务、汇报进度和提交结果。**（V1 定位，引自 [docs/architecture-v1.md](docs/architecture-v1.md) §1）

职责一句话：

```text
Gate 管"能不能做"，Driver 管"什么时候做"，Adapter 管"怎么叫醒"，Skill 管"Agent 怎么干活"。
```

没有常驻 Server、没有数据库、没有 Web UI。GitHub 是唯一正式状态载体；Gate 是运行在 GitHub Actions 上的确定性程序；Driver 是运行在你本地机器上的确定性 CLI（`gateflow`）；Agent（ChatGPT / ZCode / 任意客户端）只读写本地 `.gateflow/` 工作区，**不需要任何 GitHub 凭证**。

## V1 架构总览

```text
GitHub（唯一正式状态：Issue / Comment / Label / PR / Timeline）
   ↕                              ↕
Gate（GitHub Action，事件驱动）   Driver（本地进程，轮询 + 同步）
 授权 / 命令解析 / 状态迁移        发现 / 派发 / 校验 / GitHub 同步
   └──────── GateFlow Runtime ─────────┘
                  ↕
   Workspace Protocol（.gateflow/：inbox / outbox / receipts）
                  ↕
        Any Agent（ChatGPT / ZCode / …，无 GitHub 凭证）
```

- **Gate**（`dist/index.js`，GitHub JS Action）：事件驱动，只做确定性判定——Actor Identity / Human Commands / State Validation / Plan & Approval Validation / Marker Validation / State Transition / Approval Proof。不启动 Agent、不调 LLM、不轮询、不碰本地 Workspace。
- **Driver**（`dist/cli.js`，本地 CLI，`src/driver/`）：轮询 GitHub，构建 `.gateflow/inbox/` 派发，经 Activation Adapter 唤醒 Agent，监听 `.gateflow/outbox/`，按严格 Schema 与角色白名单校验产出，再以注册在 `trusted-agents` 里的 Bot 身份把 Plan / Tracker / Completion 同步回 GitHub。**不调用 LLM；不自己决定状态迁移**——它只发布协议对象，迁移由 Gate 完成。
- **Workspace Protocol**（`.gateflow/`）：Agent 通信边界。inbox（Driver 写，Agent 只读）/ outbox（Agent 写，Driver 读）。契约冻结在 [docs/workspace-protocol.md](docs/workspace-protocol.md)。
- **Agent**：理解、规划、编码、验证、汇报。**不直接访问 GitHub（无 GitHub MCP / PAT）；不改 Workflow State。**

## 组件与职责边界（冻结）

| 组件 | 职责 | 明确不做 |
| --- | --- | --- |
| **GitHub** | 唯一正式状态载体（Issue / Comment / Label / PR / Timeline） | 不引入独立数据库 |
| **Gate**（GitHub Action，确定性） | Actor Identity / Human Commands / State Validation / Plan & Approval Validation / Marker Validation / State Transition / Approval Proof | 不启动 Agent、不调 LLM、不轮询、不碰本地 Workspace、不解析 AI 自然语言 |
| **Driver**（本地，确定性） | Discovery / Dispatch / Inbox 构建 / Outbox 监听与校验 / GitHub 同步 / Dedup / Retry / Crash Recovery / Feedback 回流 | **不调用 LLM**；不自己决定状态迁移（只发布协议对象，迁移由 Gate 完成） |
| **Workspace Protocol**（`.gateflow/`） | Agent 通信边界：inbox（Driver 写，Agent 只读）/ outbox（Agent 写，Driver 读）/ receipts / logs | 不是正式状态（GitHub 才是） |
| **Activation Adapter** | 只负责"Dispatch 准备好后如何唤醒客户端"（probe / notify / cancel） | 不负责通信（通信 = Workspace Protocol）；不做脆弱 GUI 自动化 |
| **Skill** | 教 Agent 怎么规划、开发、验证、汇报 | 不含 GitHub MCP / Label / Marker / Comment / Token 等系统集成知识 |
| **Agent** | 理解、规划、编码、验证、汇报 | 不直接访问 GitHub（无 GitHub MCP / PAT）；不改 Workflow State |

（表引自 [docs/architecture-v1.md](docs/architecture-v1.md) §2，冻结。）

## 核心原则：确定性优先

1. **所有能由确定性程序完成的事情，都不经过 AI**；AI 只参与真正需要理解、判断、规划和开发的部分。
2. **GitHub 是唯一正式状态存储**：`.gateflow/` 工作区、receipts 都是本地缓存，不是正式状态。
3. **状态迁移权唯一属于 Gate**：其余角色只能发布"协议对象"——`Agent Output → Driver（校验）→ GitHub Protocol Object → Gate → State Transition`。
4. **审批永远是人类动作**：`/approve <plan-comment-id>`（Plan 绑定审批，V1）只由 Trusted Human 在 Issue 上发出，Gate 确定性校验；Agent 不猜测、不模拟、不代替批准。
5. **Marker 只是结构标记**：任何人都能写出 Marker 文本，Marker 永远不能当权限证明。
6. **两个身份概念永不合并**：Trusted Human（默认 = repo owner）是唯一命令发布者；Trusted Agent 在 V1 重定义为**受控 Driver 的 GitHub Identity**（如 `gateflow-agent[bot]`），只用于让 Gate 认可 Driver 发布的 marker 评论——AI 本身永远不持有该凭证。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/architecture-v1.md](docs/architecture-v1.md) | **V1 架构（冻结）**：组件边界、数据流、身份模型、目录结构 |
| [docs/workspace-protocol.md](docs/workspace-protocol.md) | **Workspace Protocol 契约（冻结）**：`.gateflow/` 布局、JSON Schema、dispatch_id 规则、角色白名单、`gateflow.config.yml` |
| [docs/driver.md](docs/driver.md) | **Driver 运维手册**：安装构建、配置参考、凭证与身份、CLI（`start / once / status / retry`）、发现规则、去重 / 重试 / 崩溃恢复、FAQ |
| [docs/agent-skills.md](docs/agent-skills.md) | **Agent 指南（V1）**：四个 Skill 的安装与工作方式、无 GitHub 原则、会话生命周期、故障排查 |
| [docs/protocol.md](docs/protocol.md) | V0 Gate 协议（冻结）：Labels / 状态机 / Commands / Markers / Maturity / Permissions / 并发规则 |
| [docs/security.md](docs/security.md) | 安全模型：V0 Gate 权限边界 + **V1 Workspace 安全模型**（凭证隔离 / 审批证明链 / 路径防护） |
| [docs/usage.md](docs/usage.md) | 协议速查表 + V1 六步安装摘要 + 场景 A~J 日常操作手册（附录：V0 手动调试模式） |
| [docs/integration.md](docs/integration.md) | **接入项目仓库详细指南**：Part 1 Gate 接入（三种可引用模式、bootstrap）+ Part 2 Driver + Workspace 接入（配置、Skills、冒烟闭环） |
| [docs/release.md](docs/release.md) | 发布手册：版本策略（`package.json` / `GATE_VERSION`）、两个 dist 产物与 `check:dist`、`@v0` / `@v1` 浮动 tag 策略 |
| [docs/architecture.md](docs/architecture.md) | V0 架构文档（历史，仅供追溯） |
| [计划总文档](github-native-ai-workflow-v0-development-and-usage-guide.md) | V0 详细开发计划与使用手册（Phase 0~11） |

## 仓库结构

```text
src/
├── index.ts               # Gate Action 入口（不变）
├── cli.ts                 # gateflow driver CLI（start / once / status / retry）
├── gate/                  # V0 Gate（原 src/*.ts 平移 + V1 审批增强）
│   ├── gate.ts  commands.ts  states.ts  permissions.ts
│   ├── markers.ts  tracker.ts  github.ts  protocol.ts  approvals.ts
├── driver/                # V1 Local Driver
│   ├── driver.ts          # 编排循环（once / start 共用）
│   ├── discovery.ts       # GitHub Canonical State → DispatchIntent
│   ├── intent.ts          # DispatchIntent 类型与推导
│   ├── dispatch.ts        # Intent → inbox 构建 → 派发记录
│   ├── routing.ts         # role → agent → activation adapter
│   ├── sync.ts            # outbox → GitHub（plan/tracker/completion）
│   ├── dedup.ts           # dispatch_id 去重（receipts）
│   ├── retry.ts           # 重试与上限
│   └── config.ts          # gateflow.config.yml 加载与校验
├── workspace/             # Workspace Protocol 运行时
│   ├── protocol.ts  schemas.ts  paths.ts  inbox.ts  outbox.ts
│   ├── watcher.ts  validation.ts  submit.ts
├── activation/            # Activation Adapters
│   ├── types.ts  manual.ts  chatgpt.ts  zcode.ts
└── github/                # Driver 侧 GitHub 访问层（独立于 gate/github.ts）
    ├── client.ts  issue-sync.ts  comments.ts
protocol/
├── workspace-schema-v1.json
└── README.md
skills/
├── agent/SKILL.md         # 通用 gateflow-agent（Workspace Protocol 用法）
├── consumer/SKILL.md      # 重写：无 GitHub 依赖
├── executor/SKILL.md      # 重写：无 GitHub 依赖
└── producer/SKILL.md      # 重写：.gateflow/submit 本地提交
templates/workflow.yml     # 目标仓库的 Gate workflow 模板
scripts/bootstrap.mjs      # 目标仓库初始化脚本（创建 ai:* 标签 + 生成 workflow，幂等不覆盖）
dist/                      # esbuild 产物（index.js = Gate Action；cli.js = Driver），必须提交
docs/                      # architecture-v1 / workspace-protocol / driver / agent-skills / protocol / …
tests/                     # vitest（gate / workspace / driver / github / activation / integration / security）
```

（目录结构以 [docs/architecture-v1.md](docs/architecture-v1.md) §5 为准。）

## 快速开始（六步）

> 逐步详细操作见 [docs/integration.md](docs/integration.md)；Driver 细节见 [docs/driver.md](docs/driver.md)。

```bash
# 第 1 步：bootstrap Gate（在目标仓库的检出目录里运行；生成后手动 commit + push）
node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target --token "$GITHUB_TOKEN"
```

1. **bootstrap Gate**：初始化目标仓库——创建 6 个 `ai:*` 标签 + 生成 `.github/workflows/ai-workflow.yml`（幂等，绝不覆盖已有文件）；前提是 GateFlow 本体可被 `uses:` 引用（public 仓库 / 私有 + Access 策略 / 内嵌，三选一，见 integration.md 第 2 章）。
2. **安装本地 Driver**：在本仓库执行 `npm install && npm run build:cli`，得到 `dist/cli.js`（或经 `npm run build` 与 Gate 产物一起构建）；之后用 `node dist/cli.js driver …`（或全局 `gateflow` bin）运行。
3. **配置凭证与 `gateflow.config.yml`**：`export GITHUB_TOKEN=…`（**只存在于 Driver 进程环境**，永不写入 `.gateflow/` 与配置文件）；在目标仓库根目录创建 `gateflow.config.yml`（完整示例见 [docs/workspace-protocol.md](docs/workspace-protocol.md) §10）。
4. **安装 Agent Skills**：把 `skills/agent`、`skills/consumer`、`skills/executor`、`skills/producer` 四个 Skill 装入你的 AI 客户端（ChatGPT / ZCode 等）。
5. **配置角色路由**：在 `gateflow.config.yml` 的 `routing:` 里把 `consumer` / `executor` 路由到具体 agent（role 与 provider 分离，任意 role 可路由到任意 agent）。
6. **启动 Driver**：

```bash
gateflow driver start        # 常驻轮询（或 node dist/cli.js driver start）
```

之后的标准闭环：Issue 上 `/ai-plan` → Driver 自动派发 Consumer → Agent 产出 Plan → Driver 发布 Plan 评论（Gate 迁 `ai:review`）→ 你 `/approve <plan-comment-id>` → Driver 校验批准后派发 Executor → Tracker / Completion Report（Gate 迁 `ai:working` → `ai:done`）→ 你检查后 Close Issue。

本仓库自身开发：

```bash
npm install        # 安装依赖
npm run build      # esbuild 打包 dist/index.js（Gate）+ dist/cli.js（Driver）
npm run check:dist # 校验已提交产物与 src 同步
npm run typecheck  # tsc --noEmit（strict）
npm test           # vitest
```

## 从 V0 迁移

V1 保留了 V0 的 Gate 协议（Labels / 状态机 / 命令解析 / Marker 规则不变），但改变了 Agent 与系统的交互边界：

| 变化点 | V0 | V1 |
| --- | --- | --- |
| **Agent 的 GitHub 访问** | Agent 配 GitHub MCP + PAT，直接读 Issue / 发评论 / 打标签 | **Agent 不再需要 GitHub MCP / PAT / Token**：只读 `.gateflow/inbox/`、只写 `.gateflow/outbox/`；GitHub 访问全部收归 Driver |
| **审批命令** | `/approve`（全等匹配） | `/approve <plan-comment-id>`（Plan 绑定审批；细节见 [docs/protocol.md](docs/protocol.md)） |
| **主流程** | 人手动对 AI 说"规划 #123 / 执行 #123"唤醒 Skill，AI 经 MCP 操作 GitHub | Driver 轮询自动发现、派发与同步；人只发 Gate 命令（`/ai-plan`、`/approve`、`/change`、`/choose`、`/cancel`） |
| **人类反馈** | `/change` / `/choose` 后需再手动唤醒 Consumer | Driver 把反馈投影为 `FEEDBACK.md`，自动触发新一轮 Consumer 派发（work_revision 递增） |
| **Trusted Agent 语义** | 为"AI 以 Bot 身份直接操作 GitHub"预留（默认空） | 重定义为**受控 Driver 的 GitHub Identity**（`gateflow-agent[bot]`），登记在 `trusted-agents` 输入 |
| **安装内容** | 配置 GitHub MCP + 装 3 个 Skill | bootstrap Gate + 本地 Driver + `gateflow.config.yml` + 4 个 Skill；**不再配置 MCP** |

V0 的手动直连模式（MCP + 手动唤醒）仍可用于调试，但**不再是标准架构**——见 [docs/usage.md](docs/usage.md) 附录。
