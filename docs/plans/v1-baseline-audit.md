# GateFlow V1 当前代码基线审计

## 1. 审计范围与快照

- 审计日期：2026-09-09
- 工作目录：`E:\code\gateflow`
- 分支：`main`
- HEAD：`bf8886a3200dc54a67f0db974c52ae10d8bea109`（`Merge origin/main (V1.1 correctness hardening): superseded by the V1 simplification`）
- Node：`v24.14.0`
- npm：`11.9.0`
- TypeScript：`7.0.2`
- Vitest：`5.0.0`
- esbuild：`0.28.2`

本审计以用户提供的收尾计划、`docs/plans/v1-simplification-plan.md`（文档标注为 2026-09-08 已实施的简化版）以及当前源码为准。没有依据旧 schema 2 时代的历史架构恢复组件。

审计开始前工作树已有一个未跟踪文件：`docs/plans/v1-closeout-project-onboarding-dispatch-plan.md`。该文件属于主计划，本任务未修改它。除本审计文件外，未修改实现、测试、脚本、dist 或主计划。

审计冻结点说明：四项 npm 命令、Bootstrap 只读冒烟和主要源码读取均在上述初始工作树状态下完成。最后复核时发现共享工作区已被其他并发子任务修改/新增：`src/gate/gate.ts`、`scripts/bootstrap.mjs`、`src/gate/execution-chain.ts`（当前 `git status` 分别显示 `M`、`D`、`??`）。这些变更不属于 Task 01，本任务没有读取其后续语义，也没有回滚或覆盖；本文件的结论和命令结果对应审计冻结点，不宣称并发修改后的工作树已重新验证。

## 2. 实际文件地图

### 2.1 运行时代码

```text
src/
├── index.ts                         # GitHub Action 入口，组装 GateInput
├── cli.ts                           # gateflow run/sync/status/retry CLI
├── gate/
│   ├── gate.ts                      # 事件处理、权限检查、T0-T6、记录签发
│   ├── protocol.ts                  # labels、状态、命令、marker、迁移表
│   ├── commands.ts                  # /ai-plan /approve /change /cancel 严格解析
│   ├── states.ts                    # 标签快照与迁移合法性
│   ├── permissions.ts               # Trusted Human/Agent 判断
│   ├── identity.ts                  # User/Organization 身份配置 fail-closed
│   ├── markers.ts                   # 行独占、代码围栏、重复 marker 检查
│   ├── tracker.ts                   # Tracker Status 机器值解析
│   ├── approvals.ts                 # 当前 Plan 与 /approve 目标校验
│   └── github.ts                    # Gate 侧 GitHub API seam
├── driver/
│   ├── driver.ts                    # run/sync 编排与 Driver 单实例锁
│   ├── config.ts                    # gateflow.config.yml 与仓库解析
│   ├── discovery.ts                 # Issue/Comment → Discovery
│   ├── intent.ts                    # canonical state → plan/execute 意图
│   ├── prepare.ts                   # 意图 → tasks/<task-id> + prompt
│   ├── preflight.ts                 # sync 前 epoch/Plan/Approval 重验
│   ├── sync.ts                      # result → Plan/Tracker/Report 评论
│   ├── prompts.ts                   # Manual Activation 提示词
│   └── workspace-lock.ts            # driver.lock 的 pid/holder 保护
├── protocol/
│   ├── records.ts                   # schema 2 Gate record + Operation ID
│   ├── epoch.ts                     # CSPRNG workflow epoch
│   ├── plan.ts                      # Plan canonicalization/hash
│   └── index.ts                     # 协议导出
├── workspace/
│   ├── protocol.ts                  # Workspace schema 3 类型与 task-id
│   ├── paths.ts                     # 路径解析、目录扫描、大小上限
│   ├── tasks.ts                     # 原子写入、输入快照、结果读取
│   ├── validation.ts                # task/result/current/state 校验
│   └── driver-state.ts              # Driver 私有同步缓存
└── github/
    ├── client.ts                    # Driver 侧只读 + 评论 API seam
    ├── comments.ts                  # Plan/Tracker/Report 评论拼装
    └── issue-sync.ts                # record 读取、反馈投影、评论发布
```

### 2.2 脚本、入口、工作流与产物

```text
scripts/bootstrap.mjs               # 标签/Workflow 初始化脚本
scripts/check-dist.mjs              # dist 内存重建比较
skills/gateflow/SKILL.md             # 唯一 Skill，plan/execute 两模式
templates/workflow.yml              # 目标仓库 Gate Workflow 模板
action.yml                          # Gate JavaScript Action 清单（node24）
.github/workflows/ci.yml             # typecheck/test/build/dist/协议/smoke CI
dist/index.js                       # Gate bundle（已跟踪）
dist/cli.js                         # Driver bundle（已跟踪）
package.json / package-lock.json     # npm 脚本、依赖、Node >=24
tsconfig.json                       # strict + noUncheckedIndexedAccess
```

### 2.3 测试与文档

```text
tests/gate/                          # Gate 状态、命令、marker、身份、API、tracker
tests/driver/                        # intent 与测试辅助 fake client
tests/github/                        # Driver 评论模板
tests/protocol/                      # epoch、Plan canonicalization/hash
tests/workspace/                     # task-id、路径、文件、schema 校验、state
tests/hardening/                     # Organization/身份 hardening
tests/integration/e2e.test.ts        # FakeDriverClient 的本地闭环与异常场景

docs/protocol.md                     # 当前 GitHub 协议说明
docs/workspace-protocol.md           # 当前 Workspace schema 3 契约
docs/driver.md                       # 当前 Driver 手册
docs/integration.md                  # 当前接入与本地冒烟说明
docs/security.md                     # 当前安全模型
docs/usage.md                        # 当前日常使用手册
docs/migration.md                    # schema 2 → schema 3 迁移摘要
docs/release.md                      # 发布手册（存在旧内容漂移）
docs/architecture-v1.md              # 已标注历史的上一代架构
docs/architecture.md                 # 已标注历史的 V0 架构
docs/plans/v1-simplification-plan.md # 简化版 V1 计划/实施差异说明
docs/plans/v1_hardening_decisions.md # schema 2 hardening 冻结决策（历史基线）
docs/plans/v1-hardening-plan.md      # hardening 历史计划
docs/plans/v1-workspace-driver-refactor-plan.md # 旧 Workspace/Driver 计划
docs/plans/v0-development-and-usage-guide.md   # V0 历史计划
docs/plans/v1-closeout-project-onboarding-dispatch-plan.md # 主任务计划，未修改
```

仓库根目录没有 `AGENTS.md`、`CONTRIBUTING.md` 或 `CONTRIBUTING`。仓库中没有 `protocol/` 根目录；因此 CI 中引用的 `protocol/github-schema-v2.json`、`protocol/workspace-schema-v2.json` 当前实际不存在。

## 3. 当前已经存在的能力

### 3.1 Gate 与 GitHub 协议

- `src/gate/protocol.ts` 已有 6 个 `ai:*` 标签、`PLANNING → REVIEW → READY → WORKING → DONE` 主链，以及 `BLOCKED` 的 T4/T5 执行期子状态。
- `/ai-plan`、`/approve <plan-comment-id>`、`/change <feedback>`、`/cancel` 使用严格整行/锚定解析；`/choose` 已从当前命令解析器删除。
- Marker 必须独占一行、同一评论不能出现多个 marker、代码围栏中的 marker 不计数；marker 仍只是结构提示，不是权限证明。
- 命令只允许 Trusted Human；T1/T3/T6 marker 允许 Trusted Human 或 Trusted Agent；Organization 仓库的身份类型从 GitHub API 读取，默认要求显式 `trusted-humans`，Human/Agent 交集会拒绝运行。
- `src/protocol/records.ts` 已有严格 schema 2 的 `workflow_epoch`、`approval`、`feedback_accepted` 记录解析，字段未知/缺失、格式错误、Operation ID 不绑定内容时拒绝。
- `/approve` 已校验引用的 Plan 评论存在、是当前有效 Plan、Plan marker 合法，并以 `plan_sha256` 绑定 Plan 内容；approval record 发布后会回读校验，再进行标签交换。
- 标签迁移前会从 API 重读标签，并使用先加后删；记录写入或验证失败时不进行后续授权迁移（但 T0 的标签先写问题见第 4 节）。

### 3.2 Driver 与同步

- `gateflow run/sync/status/retry` 已实现；没有常驻 daemon、LLM 调用或自动唤醒。
- `discovery.ts` 只处理开放且恰好一个 `ai:*` 标签的 Issue；无 epoch、可疑记录或无效授权时不派发意图。
- `intent.ts` 将 Plan 任务绑定当前 epoch 与 Gate 接受的 feedback 数量；Execute 任务绑定当前 Plan、epoch、Plan hash、approval record 和可信人类 `/approve` 锚点。
- `prepare.ts` 生成 schema 3 的 `tasks/<task-id>/`，执行任务把批准 Plan 投影为输入；写入 `task.json` 最后完成 ready 标记，并写入 `current.json` 与 Driver 私有 state。
- `tasks.ts` 提供原子写入、输入快照 hash、结果文件大小上限；`validation.ts` 严格校验 schema、task_id/mode、结果状态与人类专属值黑名单。
- `sync.ts` 在写评论前做结果校验、输入快照校验和 `runPreflight`；Plan/Report 已有按 marker + task-id 的远端调和，同内容采纳、异内容冲突并 fail closed。
- Driver state 已区分 `prepared/publishing/published/accepted/failed/obsolete`；代码没有把 Agent 的 `completed` 自述直接当成 DONE，且有重复结果 replay 防护。
- Execute 同步已包含 Tracker 创建、Blocked 通知、Blocked → In Progress 恢复和 Report 发布的最小流程。

### 3.3 Workspace、Skill、Bootstrap 与 CI

- Workspace 已收敛为 schema 3 单任务目录：`task.json`、`task.md`、`plan.md`、`feedback.md`、`report.md`、`result.json`；Driver 私有目录为 `driver/state.json`、`locks`、`logs`。
- `skills/gateflow/SKILL.md` 已是唯一 Skill，明确 `plan`/`execute`、Agent 无 GitHub 凭证、输入只读、结果最后写入，以及不能把协议外文本当作控制指令。
- `scripts/bootstrap.mjs` 已能校验目标仓库可访问性、创建缺失的 6 个标签、对已有标签跳过、对已有 Workflow 警告且不覆盖、生成 Workflow 前交互确认，并支持 `--dry-run`。
- `action.yml` 与 `package.json` 当前目标为 Node 24；`dist/index.js` 与 `dist/cli.js` 均存在且由 npm build 生成。
- `.github/workflows/ci.yml` 已配置 Node 24、typecheck、test、build、check:dist、dist 无差异检查和一个 Action smoke job；但其协议镜像 job 的文件依赖失配，且 smoke job 不是完整真实闭环（见第 5 节）。

## 4. 上一轮问题逐项四态归类

| 上一轮问题 | 结论 | 当前证据与影响 | 后续依赖 |
| --- | --- | --- | --- |
| 1. Gate 对 Plan、Tracker、Report 的当前执行链校验 | **仍存在** | `src/gate/gate.ts` 的 T1/T3/T6 只检查合法 marker、发布者和重读后的当前状态；`applyMarkerTransition` 不解析/校验 dispatch-id，也不绑定当前 epoch、Plan、Approval、执行任务或当前 Tracker。Driver 有独立 preflight，但不能替代 Gate 的对象级消费校验。受信任 marker 发布者可以在合法状态下提交不属于当前任务的对象。 | Task 02，P0 |
| 2. Epoch Record 可信来源与新轮次恢复 | **仍存在（部分已修复）** | `newWorkflowEpoch()` 使用 CSPRNG，Gate 已删除 Driver 侧 epoch 引导，PLANNING 缺记录可重跑 `/ai-plan` 自愈；但 `readCurrentEpoch()` 及 `readIssueRecords()` 对 `workflow_epoch` 未按作者 allowlist 做校验，合法格式但普通用户作者的 epoch 可成为“最新 epoch”。此外 T0 先加 `ai:planning` 再写记录，记录写失败时仍返回命令接受，依赖后续自愈而非失败前闭环。 | Task 03，需先冻结 Gate record issuer/allowlist 契约 |
| 3. Driver 同步的精确 accepted | **仍存在** | `src/driver/sync.ts` 的 Report 接受判断是 `task.mode === 'execute' && snapshot.aiState === 'ai:done'`，没有确认 `ai:done` 由本 task 的具体 Report/dispatch 触发。Plan 接受观察也只检查 epoch + approval 的 `plan_comment_id`，未在该观察分支复用完整 hash/anchor 证明。`published` 与 `accepted` 已分层，但接受对象绑定仍不完整。 | Task 03，P0/P1 |
| 4. Tracker/Report 事件顺序与恢复 | **仍存在** | `syncExecuteMode()` 可在同一轮创建 Tracker 后立即发布 Report，并允许 `ai:ready` 作为 Report 发布前状态；没有重新读取并确认 Gate 已接受 WORKING，也没有等待 T3 后再发 T6。注释/测试依赖评论创建顺序，真实 GitHub Actions 的完成顺序没有被证明。 | Task 03；Task 09/10 真实验证 |
| 5. Executor Workspace Lock 的安全释放 | **仍存在** | 当前只有 `driver.lock`，`src/driver/workspace-lock.ts` 明确没有 executor lock。并且实际 `stale` 条件为 `existing === null || !isAlive(pid) || age > MAX_LOCK_AGE_MS`，因此存活超过 6 小时的 Driver 仍可按年龄被接管，与文档“绝不按时间抢占存活进程”不一致。`releaseLock()` 本身有 pid + holder 校验，但没有覆盖 Executor 生命周期。 | Task 04，P1 |
| 6. Gate/Driver 协议解析一致性 | **仍存在（部分已修复）** | Gate 与 Driver 已复用 marker 检查、记录解析和 Plan hash；但 `/change` 的锚定正则在 `src/gate/commands.ts` 与 `src/github/issue-sync.ts` 各维护一份，`src/github/comments.ts` 的 dispatch-id 正则仍接受旧 `consumer|executor` token 和可选旧 epoch，而 schema 3 的 `TASK_ID_PATTERN` 只接受 `plan|execute`。`action.yml` 与 `templates/workflow.yml` 仍把已删除的 `/choose` 写入说明。 | Task 04，亦影响 Task 06/07/11 |
| 7. 真实 GitHub 与客户端 E2E | **仍存在（当前未证明）** | `tests/integration/e2e.test.ts` 通过 `FakeDriverClient` 在内存中模拟 Gate/Driver，197 个通过测试不等于真实 GitHub 通过。CI `action-smoke` 的两次本地 Action 调用使用当前 push 上下文；创建 scratch Issue/comment 的步骤不会把后续本地 Action 调用变成真实 `issue_comment` 事件，也没有真实 Driver、ChatGPT 或 ZCode 闭环。 | Task 09/10；需要隔离仓库、凭证与客户端 |

### 4.1 已修复的相关基础项

以下是上一轮 hardening 中当前代码确实已经落地、可以作为后续任务基线复用的部分：

- Plan hash canonicalization 只有 `src/protocol/plan.ts` 一份实现，Gate 与 Driver 共同导入。
- Approval 的 Plan ID、当前 Plan、hash、可信人类命令锚点和 Gate record 写后回读已存在。
- Driver preflight 已重读 Issue、comments、epoch、Plan、Approval，并对可疑 record fail closed。
- Operation reconciliation、`published`/`accepted` 分层、输入快照、结果 replay 保护、原子写入和任务目录大小上限已存在。
- 命令权限、marker 结构校验、Organization 身份 fail-closed 和标签迁移前 API 重读已存在。

### 4.2 已被简化版替代的设计

下列旧设计不是当前遗漏，不应在后续任务中恢复：

- Producer / Consumer / Executor 三套角色 Skill → 当前由一个 `skills/gateflow` 的 `plan`/`execute` 两模式替代。
- 自动派发、ChatGPT/ZCode Adapter、常驻轮询、远程 Driver、Agent Registry、Server、数据库、消息队列、Dashboard、复杂 Scheduler → 当前由 Manual Activation + 本地 Driver 替代或延后。
- `.gateflow/inbox`/`outbox`/`submit`、公开 receipt/status/progress 多层协议 → 当前由 schema 3 单任务目录 + Driver 私有 `state.json` 替代。
- `/choose` → 当前并入 `/change`；不应为兼容旧文档恢复独立命令。

### 4.3 不再需要的旧产品能力

根据简化版 V1 的明确边界，以下不是本轮收尾目标：多 Agent 并行、多项目自动调度/Worktree Scheduler、自动唤醒框架、GitHub App、Web Dashboard、独立服务端/数据库/消息队列、npm CLI 产品化包装。它们应保持不做，而不是作为基线缺陷修复。

## 5. 实际验证结果

### 5.1 按要求执行的 npm 命令

| 命令 | 结果 | 实际输出摘要 |
| --- | --- | --- |
| `npm run typecheck` | **PASS，exit 0** | 执行 `tsc --noEmit`，无错误 |
| `npm test` | **PASS，exit 0** | `Test Files 16 passed (16)`；`Tests 197 passed (197)`；Vitest duration 约 1.97s |
| `npm run build` | **PASS，exit 0** | Node24 target 构建 `dist/index.js`（约 1.0 MB）与 `dist/cli.js`（约 664.2 KB） |
| `npm run check:dist` | **PASS，exit 0** | `dist/index.js is in sync`；`dist/cli.js is in sync` |

构建后检查工作树，`dist/` 没有产生差异。以上通过只说明本地类型、现有自动化测试、bundle 构建和当前 dist 比较通过，不证明真实 GitHub、Actions 排队顺序、真实 `gh`、ChatGPT 或 ZCode 流程通过。

### 5.2 额外只读冒烟

- `node scripts/bootstrap.mjs --help`：exit 0，帮助文本正常打印；显示默认 `--action-ref jesongit/gateflow@v0`。
- `node scripts/bootstrap.mjs --repo owner/target --token placeholder --dry-run`：exit 0；脚本明确未访问网络、未修改文件，打印 6 个标签与 Workflow 生成计划。

这两个命令不替代 Bootstrap 的真实目标仓库验证，也不证明非交互安装、已有 Workflow 差异处理或 GitHub 权限处理完整。

## 6. 当前基线结论与后续任务依赖

### 6.1 可以直接复用的基线

后续实现可以直接以 schema 3 Workspace、schema 2 Gate records、当前 `planSha256`、Driver preflight、Operation reconciliation 和 4 个 npm 脚本为现有契约，不需要重建旧 inbox/outbox 或旧 Skill。

### 6.2 任务依赖

1. **Task 02 Gate 执行链**：必须先定义并测试 marker 中 dispatch-id 与当前 epoch/Plan/Approval/Task 的最小绑定；不能只扩展 Driver 侧校验。
2. **Task 03 Epoch 与同步恢复**：依赖 Task 02 确定 Gate 可接受对象的字段；要处理 epoch record 作者、T0 失败闭环、Report 对象级 accepted，以及 Tracker → WORKING → Report 的重读/恢复。
3. **Task 04 Lock 与协议一致性**：依赖 Task 02 的命令/对象绑定结论；写集包含 lock 与共享解析的最小公共位置，不要在 Driver 再复制一套命令语义。
4. **Task 05 Bootstrap 复用**：当前只对当前 checkout 写 Workflow、只做仓库 GET/标签/新文件生成，尚无目标工作目录、安装模式、非交互执行、配置生成、gitignore 增量或差异报告；Task 05 需要明确实际参数后，Task 06/07 才能写使用文案。
5. **Task 06/07 文档与 Skill**：必须以 Task 05 的真实接口为准，删除 Bootstrap 的旧三 Skill 提示；项目创建/已有项目接入尚未进入当前 Skill。
6. **Task 08 目标仓库 Workspace**：当前 `DriverDeps`、`RepositoryInfo`、`TaskFile`、GitHub ref 和 sync 都默认同一个 repository；没有 `control_repository`、`target_repository`、`target_workspace` 字段或路径绑定，需跨 workspace/schema/driver/test 一起设计，且保持 Canonical State 回 Control Issue。
7. **Task 09/10 真实 E2E**：依赖 Task 02/03/05/07/08；必须使用隔离测试仓库、批准的 `gh` 权限和可清理资源。当前本地通过测试不可替代真实 E2E，缺少权限时应记录阻塞而不伪造通过。
8. **Task 11 文档与发布**：必须在实现稳定后统一修复 release/CI/Action/template 等陈旧入口，避免只更新 README 造成第二套使用说明。

## 7. 风险清单

| 优先级 | 风险 | 基线证据 | 影响/建议 |
| --- | --- | --- | --- |
| P0 | Gate 接受对象没有当前执行链绑定 | `src/gate/gate.ts` 的 `applyMarkerTransition()` 只收 `from/to/marker/publisher`，不收 task/epoch/plan/approval | 旧或串线的 Plan/Tracker/Report 可能在状态合法时被 Gate 消费；Task 02 必须先修复并加回归测试 |
| P0 | epoch record 作者不被 Gate/Driver 统一校验 | `readCurrentEpoch()` 直接取可解析记录；`readIssueRecords()` 对 epoch 未加入 untrusted-author suspect | 普通用户可伪造格式合法的最新 epoch，污染后续任务身份；Task 03 需统一 issuer allowlist 和失败闭环 |
| P0 | Report accepted 仍由标签单独证明 | `sync.ts` 使用 `ai:done` 即接受 Execute 任务 | 任意同 Issue 的完成迁移可能被错误归因到当前 Report；需绑定具体 Report comment/task/epoch |
| P1 | Driver 假设评论顺序等于 Gate 消费顺序 | `syncExecuteMode()` 同轮创建 Tracker 并发布 Report，注释依赖创建顺序 | 真实 Actions 乱序时可能先消费 T6，导致 READY/WORKING 不一致或需要人工重发 |
| P1 | Executor 锁缺失，Driver 锁可年龄抢占活进程 | `workspace-lock.ts` 无 executor lock，`stale` 含 `age > MAX_LOCK_AGE_MS` | 桌面客户端仍运行时存在第二写入者风险；Task 04 需区分 Driver 进程锁与 Executor workspace 锁 |
| P1 | CI 协议镜像 job 引用不存在文件 | `.github/workflows/ci.yml` 读取 `protocol/*.json`，根目录无 `protocol/` | GitHub CI 的 `protocol` job 可能失败；本地四项 npm 命令未执行该 YAML job，不能把本地绿灯当 CI 全绿 |
| P1 | CI Action smoke 不是实际 Issue/comment 事件闭环 | smoke job 在 push 上下文执行本地 Action；scratch Issue/comment 不改变后续 step 的 event payload | 不能证明 Action 在真实 `issue_comment` 事件上工作；留给 Task 09/10 或专门 CI 修复 |
| P1 | Bootstrap 与简化版文档漂移 | `--help` 默认 `@v0`，dry-run/收尾提示仍要求 `skills/producer`、`consumer`、`executor`；这些目录不存在 | 新用户会走旧流程，Task 05/06/07 必须以实际实现更新，不写不存在的命令/Skill |
| P1 | Release 文档仍含 schema 1/旧 CLI/旧四 Skill | `docs/release.md` 同时引用缺失的 protocol JSON、`driver start/once` 和四 Skill | 发布操作可能按错误文档执行；Task 11 必须整体校对而非局部追加 |
| P1 | Control/Target 仓库未建模 | 当前所有 Driver API ref 从 `repositoryInfo` 和 Issue number 生成 | 新建项目或已有项目接入无法安全保证报告回 Control Issue；Task 08 是项目创建功能的前置 |
| P2 | 声称存在的符号链接防护未接入调用路径 | `paths.ts` 有 `isRealDirectory()`，但 `rg` 未发现调用；`writeTaskDir()`/文件读取未调用该 helper | 需要在 Task 08 或安全回归中确认任务目录 symlink/junction 行为，不能仅凭 helper 存在宣称已防护 |
| P2 | 真实客户端/权限/组织策略未知 | 当前测试全为 fake client；没有真实 `gh` 创建仓库、PR、Bootstrap 或 ChatGPT/ZCode 执行 | E2E 需隔离环境和明确用户批准范围；缺凭证应标记阻塞，不把静态推断当通过 |

## 8. 审计结论

本地工程基线是可构建、现有自动化测试全绿的 schema 3 简化版，但不是“V1 收尾已完成”。最需要优先处理的是 Gate 对象级执行链、epoch 来源、精确 accepted 和 Tracker/Report 乱序恢复；随后是锁与解析一致性。Bootstrap、Template/Skill、Control/Target 和真实 GitHub E2E 都尚未达到项目创建接入所需的完成条件。

后续任务应以本文件的“仍存在”和风险清单为准；“已被简化版替代”和“不再需要”的旧组件不得恢复。
