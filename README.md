# GateFlow

> **轻量的 GitHub-native AI 工作流工具。** 用户在 GitHub Issue 中提出任务，AI 生成计划，人类批准后 AI 执行，结果同步回 GitHub：
>
> ```text
> Issue → Plan → Approve → Execute → Report → Done
> ```

没有常驻 Server、没有数据库、没有 Web UI、没有消息队列。GitHub 是唯一正式状态来源；Gate 是运行在 GitHub Actions 上的确定性程序；Driver 是运行在你本地机器上的确定性 CLI（`gateflow`）。标准 Driver 流程中，Agent（ChatGPT / ZCode / 任意客户端）只读写本地 `.gateflow/` 工作区，不需要 GitHub 凭证；Personal Mode 也可以在用户批准的范围内调用本地 `gh`，此时继承的是用户自己的 GitHub 权限，不构成强 Human/Agent 隔离。

## V1 Architecture & Design Principles

本章是后续所有讨论与开发的架构依据；旧版架构文档仅作历史参考。

### 产品定位

GateFlow 是一个轻量的 GitHub-native AI 工作流工具，**不是通用 Agent 平台**。核心能力只有一条：

```text
Issue → Plan → Approve → Execute → Report
```

V1 面向个人开发者和少量项目，优先支持本地 ChatGPT、ZCode 等 AI 客户端。不以多 Agent 平台、自动调度平台或通用 AI Control Plane 为目标。

### 核心架构

```text
                  GitHub
           Issue / Plan / Report
                    ↕
             GitHub Actions
                 Gate
          授权校验 / 状态迁移
                    ↕
              Local Driver
       任务准备 / 文件同步 / 结果发布
                    ↕
               .gateflow/
                    ↕
          ChatGPT / ZCode + Skill
               规划 / 执行
```

职责固定，只有四个核心组件：

| 组件 | 职责 | 明确不做 |
| --- | --- | --- |
| **GitHub** | 唯一正式状态来源：Issue 需求、当前 Plan、人类审批、执行报告、正式工作流状态、审计记录 | 不引入数据库；本地文件只是工作副本和运行缓存 |
| **Gate**（GitHub Action） | 校验事件与身份；解析人类命令；校验 Plan 与审批（Gate-issued 记录）；校验执行授权关联；正式状态迁移；修复可安全恢复的状态投影 | 不启动 AI、不调 LLM、不管理本地 Workspace |
| **Driver**（本地 CLI） | 拉取当前任务；准备本地任务文件；输出可复制提示词；校验 AI 产出；将 Plan / Report 同步到 GitHub；重试、去重与恢复 | 不调用 LLM；不自行决定 GitHub 正式状态 |
| **Skill**（`skills/gateflow`） | 指导 AI 如何规划、开发、验证和汇报（`plan` / `execute` 两种模式） | 不含 GitHub API、授权和状态迁移知识 |
| **Agent** | 实际 AI 工作 | 默认不直接操作 GateFlow 协议；若 Personal Mode 在批准范围内允许调用本地 `gh`，则继承用户权限，不形成独立低权限身份 |

### Control Repository 与 Target Repository

在“创建项目”或“接入已有项目”的场景中，需要把三个位置分开：

* **Control Repository**：个人入口仓库，通常由本仓库的 Template 创建。入口 Issue 是这次任务的 Canonical State，Plan、Approval、Tracker、Report 都回到这个 Issue。
* **Target Repository**：实际要创建或修改的业务仓库。它可以尚不存在，也可以是已有的 `owner/name`。
* **Target Workspace**：Target Repository 在本地的检出目录，Agent 在批准范围内于此准备文件、开发和验证。

普通的单仓库任务中，Control Repository 与 Target Repository 可以是同一个仓库；项目创建/接入任务中则可能不同。例如 `you/my-gateflow#12` 是 Control，`you/new-project` 是 Target。目标仓库改变，不会改变报告应该回到的入口 Issue。当前 `gateflow run/sync` 仍按配置中的单个 Control Repository 读取和同步；`control_repository` 是 `repository` 的显式别名，目标信息只能通过任务绑定保存，不要自行添加未实现的跨仓库 CLI 参数或配置字段。

### 确定性优先

能够通过普通程序完成的事情，不交给 AI。AI 不负责：

* 解析 GitHub 协议；
* 判断审批是否有效；
* 修改正式工作流状态；
* 管理 GitHub Token；
* 执行同步重试和幂等处理。

### 不提前复杂化

> GateFlow V1 以满足当前实际使用需求为目标。后续讨论和开发应优先使用现有组件解决问题，不为假设中的多 Agent、远程部署、大规模并发或未来插件需求提前增加抽象。只有真实需求出现，并且现有设计确实无法合理满足时，才考虑增加新的组件、协议或扩展机制。

具体约束：

* 不为了未来可能支持多个 Agent 而提前设计复杂路由；
* 不为了未来可能自动唤醒客户端而提前设计 Adapter 框架；
* 不为了未来可能远程部署而增加 Server；
* 不为了未来可能并行执行而增加 Scheduler；
* 不为了未来可能扩展功能而增加插件系统；
* 不为了未来可能需要查询而增加数据库；
* 不为了未来可能兼容旧版本而长期保留两套实现；
* 不为了"架构完整"增加没有实际使用场景的状态、记录或配置。

**新增设计必须能够回答：当前哪个真实需求需要它？现有实现为什么不能满足？最简单的替代方案是什么？**

### 允许破坏性修改

项目仍处于开发阶段。允许删除旧协议、旧配置、不再使用的 Skill；允许合并模块、重命名命令、调整 Workspace 文件格式、删除不再适用的测试和文档。不为尚未正式发布的旧版本维护复杂兼容层（迁移说明见 [docs/migration.md](docs/migration.md)）。

### 安全性不因简化而退化

简化不等于删除必要的安全约束。以下不变量必须保留：

* 人类审批绑定具体 Plan（`/approve <plan-comment-id>` + Gate-issued approval 记录）；
* Plan 内容变化后旧审批失效（plan sha256 绑定）；
* 只有 Gate 能确认正式状态迁移（标签只由 Gate 写）；
* Agent 不持有 GitHub 凭证；
* Driver 不凭标签或 AI 自述直接放行执行（独立重验 Gate 记录）；
* 重复事件和重复同步不得造成重复执行（Operation ID 调和 + replay 保护）；
* 旧任务输出不得被当作当前任务结果（epoch / 输入快照绑定）；
* Marker 与普通协议文本永远不是身份或授权证明。

### 后续计划的约束

> 后续开发计划默认遵循本架构。除非用户明确提出新需求，否则不得主动扩展为多 Agent 平台、复杂自动化框架或通用 Control Plane。架构变更应以实际问题为依据，优先局部修改，而不是重新设计整个系统。

判断一个新需求时依次回答：

1. 当前真实需求是什么？
2. 现有 GitHub + Gate + Driver + Skill 能否直接解决？
3. 是否可以通过增加一个简单命令、配置或函数完成？
4. 是否真的需要新增组件或协议？
5. 新增复杂度是否明显小于它解决的问题？

优先级：复用现有功能 → 局部修改 → 增加简单配置或命令 → 增加小型模块 → 确有必要时才增加新架构层。

## 用户如何完成一条任务

```text
chat（或手动创建 Issue）
  ↓  /ai-plan
GitHub Issue（Gate 进入 PLANNING）
  ↓  gateflow run
Driver 准备任务目录 + 打印提示词
  ↓  粘贴到 ChatGPT / ZCode（plan 模式）
AI 写 plan.md + result.json
  ↓  gateflow sync
Plan 评论发布（Gate 迁 REVIEW）
  ↓  /approve <plan-comment-id>   （或 /change <反馈> 重新规划）
Gate 固化 approval 记录，迁 READY
  ↓  gateflow run
Driver 准备执行任务（plan.md 作为输入）
  ↓  粘贴到 ChatGPT / ZCode（execute 模式）
AI 开发、验证，写 report.md + result.json
  ↓  gateflow sync（首轮）
Tracker 评论发布，等待 Gate 接受 WORKING
  ↓  再次 gateflow sync
Report 评论发布（Gate 迁 DONE）
  ↓  人工检查，Close Issue
```

人类命令只有三个 + 一个保险：

* `/ai-plan` — 开始规划；
* `/change <反馈>` — 提交修改意见，重新生成 Plan；
* `/approve <plan-comment-id>` — 批准当前 Plan；
* `/cancel` — 退出工作流（保留的简单保险，不做完整取消状态机）。

## 快速开始：Template 入口与第一条任务

> 逐步详细操作见 [docs/usage.md](docs/usage.md) 和 [docs/integration.md](docs/integration.md)；CLI 细节见 [docs/driver.md](docs/driver.md)。

1. 打开 [Use this template](https://github.com/jesongit/gateflow/generate)，创建个人入口仓库，例如 `you/my-gateflow`。这个仓库是 Control Repository，不要求把所有业务项目都放进来。
2. 在本地准备 Driver：Node.js **≥ 24**，然后在 GateFlow 检出目录执行 `npm ci && npm run build`；需要直接使用 `gateflow` 命令时再执行 `npm link`。
3. 登录本地 GitHub CLI：`gh auth login`，用 `gh auth status` 确认账号和目标仓库权限。
4. 在个人入口仓库检出目录运行 Bootstrap。先用 `--dry-run` 检查计划，再按批准范围使用 `--github-config --yes` 创建缺失标签并生成 Workflow；生成后人工检查并 commit + push。
5. 把 `skills/gateflow` 这一个 Skill 装入 ChatGPT / ZCode 等 AI 客户端。在入口 Issue 中评论 `/ai-plan`，按提示词完成 `gateflow run → AI → gateflow sync → /approve → gateflow run → AI → gateflow sync（Tracker）→ 等待 WORKING → gateflow sync（Report）`。

Bootstrap 只负责目标仓库的确定性初始化：它不会创建、删除或覆盖仓库，也不会覆盖有差异的已有 Workflow。新建项目时先在批准范围内用 `gh` 创建 Target Repository，再对它运行同一个 Bootstrap；已有项目则直接以 `--install-mode existing` 增量接入。

> 运行环境要求：**Node.js ≥ 24**（Action 运行时与本地 Driver 均为 node24 目标）。

## Workspace 一览（Agent 视角）

```text
.gateflow/
├── current.json            # 当前活动任务指针
├── tasks/
│   └── <task-id>/          # 一个目录 = 一个任务
│       ├── task.json       # 任务绑定（mode / issue / 输入清单），Driver 最后写入
│       ├── task.md         # 任务描述（Agent 只读）
│       ├── plan.md         # plan 模式输出 / execute 模式输入（已批准计划）
│       ├── feedback.md     # 人类反馈投影（若有）
│       ├── report.md       # execute 模式输出
│       └── result.json     # Agent 的最小结果声明（唯一机器输出）
└── driver/                 # Driver 私有：state.json / locks / logs
```

Agent 只需要知道：当前任务是什么、是规划还是执行、读哪些文件、结果写到哪里。契约见 [docs/workspace-protocol.md](docs/workspace-protocol.md)。

## V1 能力边界与已知限制

**明确不进入 V1**：多 Agent 并行协作、自动任务分配与任务队列、Agent Registry、复杂角色权限系统、ChatGPT/ZCode 自动唤醒、远程 Agent 执行、多机器 Driver、分布式锁、常驻 Server、独立数据库、消息队列、Web Dashboard、插件市场、通用 Scheduler、自动 PR 合并、自动代码审查平台、组织级权限管理、为未来扩展预留的通用事件总线。

**已知限制**：

* 单工作区同一时间只有一个活动任务（显式 `--issue` 切换）；
* Driver 锁只约束同一台机器上的进程，不构成跨机器互斥；
* GitHub"读状态→写入"不是事务：Driver preflight 缩小竞态窗口，Gate 在每次消费协议对象时独立重验（纵深防御）；
* 执行进度不回传 GitHub（Tracker 只表达 In Progress / Blocked），完成即报告；
* Windows 上 Driver 私有目录没有 POSIX 权限位，隔离是协议级的不是 OS 级的。

## 仓库结构

```text
src/
├── index.ts               # Gate Action 入口
├── cli.ts                 # gateflow CLI（run / sync / status / retry）
├── protocol/              # 共享协议层（Gate 与 Driver 的单一事实来源）
│   ├── records.ts         # Gate-issued 记录（epoch / approval / feedback）+ Operation ID
│   ├── plan.ts            # Plan 规范化 + plan_sha256（冻结唯一实现）
│   └── epoch.ts           # workflow epoch（CSPRNG）
├── gate/                  # Gate（授权链 + 状态机，GitHub Action）
│   ├── gate.ts  commands.ts  states.ts  permissions.ts  identity.ts
│   ├── markers.ts  tracker.ts  github.ts  protocol.ts  approvals.ts
├── driver/                # Local Driver（主动命令式）
│   ├── driver.ts          # run / sync 命令编排 + 单实例锁
│   ├── discovery.ts       # GitHub 状态 → Discovery
│   ├── intent.ts          # 任务意图推导（纯函数；伪造审批死在这里）
│   ├── prepare.ts         # 意图 → 任务目录 + 提示词
│   ├── preflight.ts       # 同步前统一授权校验（epoch/plan/approval 绑定）
│   ├── sync.ts            # result.json → GitHub（Operation 调和 + published/accepted）
│   ├── prompts.ts         # Manual Activation 提示词
│   ├── config.ts  workspace-lock.ts
├── workspace/             # Workspace Protocol 运行时（schema 3）
│   ├── protocol.ts  paths.ts  tasks.ts  validation.ts  driver-state.ts
└── github/                # Driver 侧 GitHub 访问层（只读 + 发评论）
    ├── client.ts  comments.ts  issue-sync.ts
skills/gateflow/           # 唯一的 Agent Skill（plan / execute 两模式）
dist/                      # esbuild 产物（index.js = Gate；cli.js = Driver），必须提交
docs/                      # 架构 / 协议 / Driver / 安全 / 发布
tests/                     # vitest（gate / workspace / driver / github / protocol / hardening / integration）
```

## 本仓库自身开发

```bash
npm install        # 安装依赖
npm run build      # esbuild 打包 dist/index.js（Gate）+ dist/cli.js（Driver）
npm run check:dist # 校验已提交产物与 src 同步
npm run typecheck  # tsc --noEmit（strict）
npm test           # vitest
```

正式发布顺序是：`npm ci` → `npm run typecheck` → `npm test` → `npm run build` → `npm run check:dist` → `npm run e2e:release` → 可选的 Real ChatGPT/ZCode smoke → tag/release。完整的本地可验证 E2E 说明、临时私有仓库清理规则和故障排查见 [docs/release.md](docs/release.md)。

`e2e:release` 当前由 `scripts/e2e-release.mjs` 提供：preflight 从本机 `gh auth token` 内存取得 token，注入 Bootstrap/Driver 子进程，记录当前 HEAD SHA；随后创建 `private --add-readme` 临时仓库，用 `jesongit/gateflow@<HEAD SHA>` 执行 Bootstrap，并验证 README、config、`.gitignore`、workflow ref 和 6 个 labels。测试使用 Fake Agent，不依赖 AI；正常成功删除临时仓库和 clone，失败保留现场，`--keep` 可保留成功现场。

使用 `--prepare-agent` 时，入口会真实完成 Bootstrap、创建 Issue、发布 `/ai-plan`、等待 `planning/epoch`、运行一次 Driver，并输出 `repository/issue/task/workspace` 后停止；该成功现场会保留供 Agent 继续使用。当前四项安全 smoke 都有内置 real-GitHub 路径；如果协议、GitHub 上下文或注入的 runner 不可用，相关用例会回退为 fixture-only/`limited`，不会冒充远端通过。real-GitHub 前置条件满足时默认入口可通过；出现 `limited` 时默认入口会失败，`--skip-security` 才会跳过整个安全场景。CLI 参数和实际行为见 [docs/release.md](docs/release.md)。CI 不会在每次运行完整真实 GitHub E2E；完整 E2E 只在正式发布前显式运行，ChatGPT/ZCode 仍是独立的可选 smoke；未执行的真实 E2E 必须记录为未执行/阻塞及原因。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/workspace-protocol.md](docs/workspace-protocol.md) | **Workspace Protocol 契约（schema 3）**：任务目录布局、task.json / result.json、输入快照绑定 |
| [docs/driver.md](docs/driver.md) | **Driver 手册**：安装、配置、CLI（run / sync / status / retry）、同步与恢复语义 |
| [docs/protocol.md](docs/protocol.md) | GitHub 协议：Labels / 状态机 / Commands / Markers / Gate 记录 / 权限 |
| [docs/security.md](docs/security.md) | 安全模型：授权链、凭证隔离、防伪造与防重放 |
| [docs/integration.md](docs/integration.md) | 接入项目仓库指南：Gate 接入 + Driver + Skill + 冒烟闭环 |
| [docs/usage.md](docs/usage.md) | 日常操作手册与场景速查 |
| [docs/release.md](docs/release.md) | 发布手册：版本策略、dist 产物与 check:dist |
| [docs/migration.md](docs/migration.md) | 从 schema 2（inbox/outbox + 四 Skill）迁移到 schema 3 |
| [docs/architecture-v1.md](docs/architecture-v1.md) | 上一代 V1 架构文档（历史参考；本文 README 为现行依据） |
| [docs/architecture.md](docs/architecture.md) | V0 架构文档（历史，仅供追溯） |
| [docs/plans/](docs/plans/) | 历史计划文档（含本轮 V1 精简重构计划） |

## V1 运行模型摘要

V1 使用 schema 3 的单任务目录、Manual Activation 和一个 `gateflow` Skill：

| 方面 | 当前 V1 |
| --- | --- |
| 工作区 | `.gateflow/tasks/<task-id>/`，Driver 私有状态位于 `.gateflow/driver/` |
| 激活 | `gateflow run` 打印提示词，用户将提示词粘贴到 AI 客户端 |
| CLI | `run / sync / status / retry` 主动命令 |
| 命令 | `/ai-plan`、`/approve`、`/change`、`/cancel` |
| Skill | 一个 `skills/gateflow`，支持 `plan` / `execute` 两种模式 |

如需了解协议变更，请参阅 [docs/migration.md](docs/migration.md)；日常使用以本文和 [docs/usage.md](docs/usage.md) 为准。

---

> **GateFlow V1 已收敛为 GitHub + Gate + Driver + Skill 的轻量架构。后续以实际需求驱动演进，优先保持简单，不提前建设通用 Agent 平台。需要新能力时，再在现有架构上按需增加。**
