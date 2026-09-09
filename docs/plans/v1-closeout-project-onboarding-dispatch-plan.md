# GateFlow V1 收尾与项目创建接入：执行与派发计划

> 项目：`jesongit/gateflow`
> 计划日期：2026-09-09
> 来源：用户提供的《GateFlow V1 收尾与项目创建接入开发计划》
> 执行约束：主任务只负责基线确认、拆分、派发、协调和验收；实现工作由子任务完成。

## 1. 目标与不可变边界

本轮目标分为两组：

1. 完成当前简化版 V1 的正确性收尾：Gate 执行链、Epoch、Driver 同步恢复、Workspace Lock、协议解析和真实流程验证。
2. 让用户可以把 GateFlow 作为 Template 入口，在入口仓库 Issue 中请求新建项目或接入已有项目；Agent 在批准范围内使用本地 `gh`，并通过同一套 Bootstrap 完成初始化。

本轮保持现有轻量架构，不恢复或新增：多角色 Agent、自动唤醒 Adapter、Agent Registry、远程调度服务、Server、数据库、消息队列、GitHub App、Dashboard、复杂多项目 Scheduler、自动并行 Worktree Scheduler、npm CLI 产品化包装。

Canonical State 始终在 Control Repository 的入口 Issue：

```text
Control Repository / Issue
        ↓ Plan → Approve → Execute → Report
Target Repository / Workspace（可与 Control 不同）
        ↓ gh + Bootstrap
GateFlow-ready Target Repository
```

所有任务必须遵守：

- Gate 继续独占正式状态迁移和 Gate-issued 授权记录；
- Agent 不持有 GitHub 凭证，`gh` 只由本地 Driver / 批准后的执行流程使用；
- Marker、普通评论、AI 自述都不是授权证明；
- 已有项目只做增量安装，不静默覆盖业务源码、目录、CI、README、Issue Template 或已有同名 Workflow；
- 主任务不直接实现代码；子任务写集必须互不重叠，跨任务契约先在计划中冻结。

## 2. 当前基线快照

已确认的实际入口：

| 能力 | 当前文件 | 基线判断 |
| --- | --- | --- |
| Gate 状态/命令/Marker/身份 | `src/gate/` | 已有 schema 2 授权记录和简化状态机，需补当前执行链绑定回归 |
| Epoch/Approval/Feedback | `src/protocol/records.ts`, `src/protocol/epoch.ts`, `src/gate/gate.ts` | 已有 Gate-issued 记录，需要验证新轮次、来源和恢复语义 |
| Driver 派发/同步 | `src/driver/prepare.ts`, `src/driver/preflight.ts`, `src/driver/sync.ts` | 已有 Operation ID、published/accepted 和远端调和，需要补精确确认与乱序恢复 |
| Workspace Protocol | `src/workspace/` | schema 3、单任务目录、单 repository 字段，需要扩展 Control/Target 绑定 |
| Workspace Lock | `src/driver/workspace-lock.ts` | 需确认 Executor 锁不能因固定年龄自动抢占 |
| Bootstrap | `scripts/bootstrap.mjs` | 已能校验仓库、创建标签、生成 Workflow；仍需复用、非交互和单 Skill 文案收尾 |
| Skill | `skills/gateflow/SKILL.md` | 已是 plan/execute 单 Skill，需要加入新建/接入项目指引 |
| 文档 | `README.md`, `docs/*.md`, `docs/plans/` | 已有简化版文档，需按最终实现更新，避免写入不存在的 CLI 命令 |
| 验证 | `tests/`, `npm run typecheck/test/build/check:dist` | 现有测试脚本明确；真实 GitHub E2E 需使用受控测试仓库和凭证 |

### 基线门槛

Task 01 先完成实际代码基线与现有测试结果，输出上一轮问题的四态清单：`已修复 / 仍存在 / 已被简化版替代 / 不再需要`。后续任务以 Task 01 的文件级结论为准，不按历史计划的完成勾选推断状态。

## 3. 派发任务总表

任务编号沿用需求中的 11 个任务，但把文档与验证拆成明确的交付物。每个实现任务必须：

1. 先阅读当前实现和测试；
2. 只修改声明的写集；
3. 为行为变化补测试；
4. 在最终说明中列出修改文件、验证命令和未完成依赖；
5. 不自行扩大协议或恢复已删除架构。

| ID | 任务 | 优先级 | 依赖 | 允许写入的主要范围 | 交付物 |
| --- | --- | --- | --- | --- | --- |
| 01 | 当前代码基线确认 | P0 | 无 | 仅新增 `docs/plans/v1-baseline-audit.md`（不改实现） | 实际文件地图、脚本结果、问题四态清单、后续风险 |
| 02 | Gate 执行链校验 | P0 | 01 | `src/gate/**`、相关 `tests/gate/**`、必要 `tests/protocol/**` | Plan/Tracker/Report 绑定当前 Epoch/Plan/Approval/Task/Dispatch，旧输出拒绝 |
| 03 | Epoch 与同步恢复 | P0/P1 | 01、02 的协议结论 | `src/protocol/**`、`src/driver/sync.ts`、`src/driver/preflight.ts`、相关 `tests/protocol/**`、`tests/driver/**` | 可信 Epoch、新轮次失败闭环、精确 accepted、乱序/超时/重启恢复 |
| 04 | Lock 与协议一致性 | P1 | 01、02 | `src/driver/workspace-lock.ts`、命令/身份共享解析的最小公共位置、相关 `tests/driver/**` 与 `tests/gate/**` | 安全释放、无不安全自动抢占、Gate/Driver 语义一致 |
| 05 | Bootstrap 复用 | P0/P1 | 01 | `scripts/bootstrap.mjs`、Bootstrap 专属测试（如新增） | 新/已有项目共用幂等初始化，差异提示不覆盖，必要非交互参数 |
| 06 | Template 入口文档 | P1 | 01、05 的接口结论 | `README.md`、入口/模板相关 `.github/**`、`docs/usage.md`（仅入口使用章节） | Use this template、首次配置、最小验证流程 |
| 07 | 单 Skill 项目创建/接入指引 | P1 | 01、05、06 | `skills/gateflow/SKILL.md`、必要 `docs/` 参考文档 | 新建/接入的规划、批准、gh、Bootstrap、验证、权限边界 |
| 08 | 目标仓库工作区 | P0/P1 | 01、02、03 | `src/workspace/**`、`src/driver/prepare.ts`、`src/driver/discovery.ts`、`src/driver/driver.ts`、相关 `tests/workspace/**`、`tests/driver/**` | Control/Target 字段与路径绑定，报告仍回入口 Issue，防串线 |
| 09 | 新建项目 E2E | P1 | 02、03、05、07、08 | `tests/integration/**`、`docs/plans/` 验收记录（不改核心实现） | 在批准范围内用 `gh` 创建临时测试仓库、Bootstrap、验证新仓库可运行 |
| 10 | 已有项目接入 E2E | P1 | 02、03、05、07、08 | `tests/integration/**`、`docs/plans/` 验收记录（与 09 使用不同文件） | 增量接入测试仓库、差异/PR/合并后完整 GateFlow 验证 |
| 11 | 文档与发布收尾 | P1 | 02–10 | `README.md`、`docs/architecture.md`、`docs/protocol.md`、`docs/security.md`、`docs/usage.md`、`docs/release.md` | 文档与最终实现一致，安全边界准确，DoD 和已知限制明确 |

## 4. 并行与依赖调度

```text
Task 01 基线
   ├── Task 02 Gate 执行链
   ├── Task 05 Bootstrap
   └── Task 04 Lock/协议（需吸收 02 的共享解析结论）

Task 02 + Task 03
   └── Task 08 目标仓库 Workspace

Task 05
   ├── Task 06 Template 文档
   └── Task 07 Skill 指引（与 06 可并行，需共享 Bootstrap 实际接口）

Task 02 + 03 + 05 + 07 + 08
   ├── Task 09 新建项目 E2E
   └── Task 10 已有项目接入 E2E

Task 02–10 全部完成
   └── Task 11 文档与发布收尾
```

首批派发：Task 01、Task 02、Task 05。Task 02/05 可在基线审计期间并行，但实现者必须以当前代码为准；Task 04 等待 Task 02 的解析结论，避免产生第二套语义。Task 03 在 Task 02 明确授权字段后派发。Task 06/07/08 在对应契约稳定后派发。E2E 任务必须最后执行，并且默认使用隔离的临时仓库；若缺少 GitHub 权限、组织策略或客户端环境，只记录为阻塞，不修改核心代码绕过。

## 5. 子任务通用提示词约束

派发给实现任务时附带以下约束：

- 这是 GateFlow 简化版 V1，不得恢复 producer/consumer/executor 三 Skill 或新增服务端架构；
- 先读 `docs/protocol.md`、`docs/workspace-protocol.md` 和相关源码，接口名以当前实现为准；
- 不修改其他任务的写集；如发现跨边界问题，记录为依赖/建议，不直接顺手改动；
- 所有授权相关变更必须 fail closed，不能把标签、Marker、AI 自述或 `Issue == ai:done` 当成对象级接受证明；
- 新增字段必须同步更新 schema 校验、任务构造、读取路径、测试和文档契约；
- 不在文档中写入尚未实现的 `gateflow init` / `gateflow provision` 等命令；
- 真实 `gh` 操作仅限批准的 E2E 测试范围，禁止删除或覆盖非测试仓库内容。

## 6. 统一验收口径

### 工程验证

```text
npm run typecheck
npm test
npm run build
npm run check:dist
```

任务只报告实际执行过的命令。任一命令失败时，结果必须标记失败或阻塞并保留错误原因。

### V1 正确性 DoD

- 旧 Epoch 的 Plan、Tracker、Report 不能推进当前轮次；
- Tracker 必须绑定当前已批准 Plan/Approval/执行任务；
- Report accepted 必须对应具体远端对象；
- Epoch 来源可信，新 `/ai-plan` 不沿用旧 Epoch，创建失败不落入错误状态；
- Tracker/Report 乱序、Driver 重启、API 成功但本地超时可通过远端调和恢复且不重复创建；
- Executor 工作区不会因固定锁年龄被自动抢占；
- Gate/Driver 命令解析和身份规则一致；
- 真实 GitHub Issue 闭环通过。

### 项目创建与接入 DoD

- GateFlow 可作为 Template 入口使用；
- 入口 Issue 可请求新建项目或接入已有项目；
- 新建与已有项目复用同一 Bootstrap；
- Bootstrap 可重复运行，已有标签跳过，同名 Workflow 差异提示且不静默覆盖；
- Control Repository / Target Repository / Target Workspace 不串线；
- 新项目可独立接收 GateFlow Issue；
- 入口 Issue 收到目标仓库链接和完整报告；
- Personal Mode 的 `gh` 权限边界、Human Approval、本地协议隔离说明准确；
- ChatGPT / ZCode 至少各完成一次真实任务；
- 不依赖额外 Server、DB 或 GitHub App。

## 7. 明确不做与阻塞处理

以下情况不得通过扩大范围解决：缺少 GitHub 写权限、组织禁止创建仓库、无法确认旧客户端是否停止、目标仓库需要未批准的高影响操作、缺少 ChatGPT/ZCode 客户端或无法获得安全测试凭证。

子任务遇到上述情况时：

1. 停止会改变外部状态的动作；
2. 在任务结果中写清阻塞条件、已完成检查和所需用户动作；
3. 不伪造 E2E 通过，不把静态单元测试当成真实 GitHub 验收。

## 8. 派发记录

| 任务 | 子任务 ID | 状态 | 备注 |
| --- | --- | --- | --- |
| 01 | `01a08450-4b93-7363-af09-b112609b3f20`（Sagan） | completed | 已交付 `docs/plans/v1-baseline-audit.md`；typecheck/test/build/dist check 全部通过 |
| 02 | `01a08450-4e1f-7a23-ab98-7f9d440754d5`（Ptolemy） | completed | 已完成 Gate 执行链对象绑定与 fail-closed 回归 |
| 03 | `01a0845d-9089-7ea2-a0d4-c1373b234396`（Locke） | completed | 已完成可信 Epoch、对象级 accepted、Tracker/Report 顺序和 reconciliation |
| 04 | `01a0845d-92d1-7a33-980f-ad844ce371de`（Hubble） | completed | 已完成 Driver/Executor Lock 安全回收、命令解析复用和身份边界 |
| 05 | `01a08450-5063-7a53-868c-c1fbea025f58`（Peirce） | completed | 已完成 Bootstrap 参数化、幂等差异检查和专属测试 |
| 06 | `01a0845b-e348-78f3-a5cd-3fd1f8dc9da1`（Nash） | completed | 已完成 Template 入口、首次配置和使用示例 |
| 07 | `01a0845b-e730-7242-8d91-fb7b4d181d25`（Ampere） | completed | 已完成单 Skill 与项目创建/接入参考文档 |
| 08 | `01a0846a-8cd0-7c40-ac92-aecb981f1bd4`（Dirac） | completed | 已完成 Control/Target 字段、路径绑定和 Executor lock 生命周期 |
| 09 | `01a08477-e8a6-7541-8fa3-f7b163851ea6`（Volta） | completed | 当前 flow fake E2E 6/6；全量测试 249/249，typecheck/build/dist check 通过；真实新仓库仍 blocked |
| 10 | `01a08477-ea9a-7bd0-bcb4-078946bce702`（Lovelace） | blocked | 无明确隔离测试资源；已记录 `docs/plans/v1-existing-project-e2e-report.md`，未执行外部写入 |
| 11 | `01a084da-742b-7c42-8a0a-5e1c61055ee5`（Ohm） | completed | 已清理 Action/Template 的 /choose 与 CI 旧 protocol 依赖；全量 249/249、typecheck/build/dist check 通过 |

本表由主任务在派发后补写子任务 ID 和状态；实现者不得修改本计划的派发记录，避免并发冲突。
