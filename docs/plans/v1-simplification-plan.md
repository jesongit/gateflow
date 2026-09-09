# GateFlow V1 精简重构开发计划

> 状态：**已实施（2026-09-08）**。落地的实际形态与本计划的差异：
> - 任务目录采用 `tasks/<task-id>/`（task.json + task.md + plan.md + feedback.md + report.md + result.json），task-id 沿用 epoch 绑定语法（`…_plan_01` / `…_execute_p<id>`）；
> - BLOCKED 保留为 WORKING 的执行期子状态（tracker 驱动 T4/T5），`/change` 是唯一反馈命令（/choose 已删除）；
> - Gate 是唯一的记录签发者（删除了 Driver 侧 epoch 引导；PLANNING 缺记录由重跑 `/ai-plan` 自愈）；
> - CLI 为 `run / sync / status / retry`；schema 3 契约见 docs/workspace-protocol.md，迁移见 docs/migration.md。
> 目标：收敛现有架构，完成一个简单、可靠、可实际使用的 GitHub-native AI 工作流。
> 原则：优先复用现有代码，允许破坏性修改，不为尚未出现的需求提前设计复杂架构。

---

## 1. 项目目标

GateFlow 第一版只解决一个核心问题：

**用户在 GitHub Issue 中提出任务，AI 生成计划，人类批准后 AI 执行，最后将结果同步回 GitHub。**

标准流程：

```text
Chat
  ↓
GitHub Issue
  ↓
Plan
  ↓
Human Review
  ↓
/approve <plan-id>
  ↓
Execute
  ↓
Report
  ↓
Done
```

V1 主要面向个人开发者和少量项目，优先支持本地 ChatGPT、ZCode 等 AI 客户端。

不以多 Agent 平台、自动调度平台或通用 AI Control Plane 为目标。

### 1.1 V1 完成标准

用户能够完成以下闭环：

1. 创建一个 GitHub Issue。
2. 启动规划，AI 读取任务并生成 Plan。
3. Driver 将 Plan 发布到 GitHub。
4. 用户提出修改，AI 重新生成 Plan。
5. 用户批准指定 Plan。
6. Driver 校验授权后准备执行任务。
7. 用户使用 ChatGPT 或 ZCode 完成开发。
8. Driver 同步执行报告。
9. Gate 确认完成，用户检查并关闭 Issue。

同时必须支持：

* Driver 重启后恢复。
* 重复同步不产生重复结果。
* Plan 修改后旧审批失效。
* 未授权评论不能触发执行。
* 旧任务输出不能覆盖新任务。
* GitHub API 写入失败后能够安全重试。

除此之外的能力，除非有明确实际需求，否则不进入 V1。

---

## 2. README 必须确认的架构原则

**本阶段第一项工作是更新 README，而不是先修改代码。**

README 必须明确当前架构、V1 边界和后续开发原则，避免以后每次讨论又重新引入复杂角色、适配器、调度器或协议层。

建议在 README 中增加独立章节：

### V1 Architecture & Design Principles

必须明确以下内容：

#### 2.1 产品定位

GateFlow 是一个轻量的 GitHub-native AI 工作流工具，不是通用 Agent 平台。

核心能力只有：

```text
Issue → Plan → Approve → Execute → Report
```

#### 2.2 核心架构

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

职责固定：

* **GitHub**：唯一正式状态来源。
* **Gate**：负责身份、审批、授权和正式状态迁移。
* **Driver**：负责本地任务准备、同步、重试和恢复。
* **Skill**：指导 AI 如何规划、开发、验证和汇报。
* **Agent**：负责实际 AI 工作，不直接操作 GateFlow 的 GitHub 协议。

#### 2.3 确定性优先

能够通过普通程序完成的事情，不交给 AI。

AI 不负责：

* 解析 GitHub 协议。
* 判断审批是否有效。
* 修改正式工作流状态。
* 管理 GitHub Token。
* 执行同步重试和幂等处理。

#### 2.4 不提前复杂化

README 必须明确写入以下原则：

> GateFlow V1 以满足当前实际使用需求为目标。后续讨论和开发应优先使用现有组件解决问题，不为假设中的多 Agent、远程部署、大规模并发或未来插件需求提前增加抽象。只有真实需求出现，并且现有设计确实无法合理满足时，才考虑增加新的组件、协议或扩展机制。

具体约束：

* 不为了未来可能支持多个 Agent 而提前设计复杂路由。
* 不为了未来可能自动唤醒客户端而提前设计 Adapter 框架。
* 不为了未来可能远程部署而增加 Server。
* 不为了未来可能并行执行而增加 Scheduler。
* 不为了未来可能扩展功能而增加插件系统。
* 不为了未来可能需要查询而增加数据库。
* 不为了未来可能兼容旧版本而长期保留两套实现。
* 不为了“架构完整”增加没有实际使用场景的状态、记录或配置。

**新增设计必须能够回答：当前哪个真实需求需要它？现有实现为什么不能满足？最简单的替代方案是什么？**

#### 2.5 允许破坏性修改

项目仍处于开发阶段。

V1 精简重构允许：

* 删除旧协议。
* 删除旧配置。
* 删除不再使用的 Skill。
* 合并模块。
* 重命名命令。
* 调整 Workspace 文件格式。
* 删除不再适用的测试和文档。

不需要为尚未正式发布的旧版本维护复杂兼容层。必要时提供简单迁移说明即可。

#### 2.6 安全性不因简化而退化

简化不等于删除必要的安全约束。

必须保留：

* 人类审批绑定具体 Plan。
* Plan 内容变化后旧审批失效。
* 只有 Gate 能确认正式状态迁移。
* Agent 不持有 GitHub 凭证。
* Driver 不凭标签或 AI 自述直接放行执行。
* 重复事件和重复同步不得造成重复执行。
* 旧任务输出不得被当作当前任务结果。

可以简化实现方式，但不能取消这些不变量。

### 2.7 后续计划的约束

README 还应明确：

> 后续开发计划默认遵循本架构。除非用户明确提出新需求，否则不得主动扩展为多 Agent 平台、复杂自动化框架或通用 Control Plane。架构变更应以实际问题为依据，优先局部修改，而不是重新设计整个系统。

本计划完成后，README 应成为后续讨论的主要架构依据，旧版架构文档仅作为历史参考。

---

## 3. V1 最终架构

### 3.1 保留的核心组件

只保留四个核心部分：

```text
GitHub + Gate + Driver + Skill
```

不增加新的架构层。

### GitHub

负责保存：

* Issue 需求。
* 当前 Plan。
* 人类审批。
* 执行报告。
* 正式工作流状态。
* 必要的审计记录。

GitHub 是唯一正式状态来源。

本地文件只是工作副本和运行缓存。

### Gate

运行在 GitHub Actions 中。

只负责确定性逻辑：

* 校验 GitHub 事件和身份。
* 解析人类命令。
* 校验 Plan 和审批。
* 校验执行结果的授权关联。
* 进行正式状态迁移。
* 修复可安全恢复的状态投影。

Gate 不启动 AI、不调用 LLM、不管理本地 Workspace。

### Driver

运行在本地。

负责：

* 拉取 GitHub 当前任务。
* 准备本地任务文件。
* 输出可复制的 AI 提示词。
* 校验 AI 产出。
* 将 Plan 和 Report 同步到 GitHub。
* 处理重试、去重和恢复。

Driver 不调用 LLM，也不自行决定 GitHub 正式状态。

### Skill

只保留一个主要 Skill：

```text
gateflow
├── plan
└── execute
```

同一个 AI 客户端可以先规划，再执行。

Skill 负责指导 AI 工作，不负责 GitHub API、授权和状态迁移。

---

## 4. 明确删除或延后的设计

| 当前能力                               | V1 处理方式                    |
| ---------------------------------- | -------------------------- |
| 独立 Producer 生命周期                   | 删除，普通聊天或简单 CLI 创建 Issue    |
| Consumer / Executor 独立安装 Skill     | 合并为一个 gateflow Skill       |
| Role → Agent → Adapter 多级路由        | 删除，使用一个默认配置                |
| ChatGPT / ZCode 自动唤醒 Adapter       | 延后，V1 使用 Manual Activation |
| Adapter probe / notify / cancel 框架 | 删除或从主路径移除                  |
| 自动多任务调度                            | 延后                         |
| 多 Agent 并行执行                       | 延后                         |
| 多工作区自动调度                           | 延后                         |
| 复杂 Tracker 生命周期                    | 简化为必要进度和报告                 |
| 多层对外 receipt 状态                    | 收敛为内部同步状态                  |
| 独立 submit 协议                       | 删除，按需提供简单创建 Issue 命令       |
| Dashboard / Web UI                 | 不做                         |
| Server / 数据库 / 消息队列                | 不做                         |
| 插件系统                               | 不做                         |
| 远程 Agent 管理                        | 不做                         |
| 复杂角色权限矩阵                           | 不做                         |

注意：删除的是不必要的产品能力和抽象，不是直接删除所有底层安全代码。现有实现中有实际用途的校验、幂等和恢复逻辑应尽量复用。

---

## 5. 简化后的工作流

### 5.1 状态

V1 保留五个主要状态：

```text
PLANNING
    ↓
REVIEW
    ↓
READY
    ↓
WORKING
    ↓
DONE
```

其中：

* `PLANNING`：等待或正在生成计划。
* `REVIEW`：Plan 已发布，等待人类确认。
* `READY`：当前 Plan 已获得有效审批。
* `WORKING`：执行中。
* `DONE`：执行报告已被 Gate 接受。

`BLOCKED` 不再作为必须迁移的独立主状态，优先作为执行结果或进度中的状态表达。

如果保留 `BLOCKED` 标签确实能简化现有实现，也可以暂时保留，但不得因此增加新的审批或恢复生命周期。

### 5.2 人类命令

V1 只需要三个主要动作：

```text
/ai-plan
/change <feedback>
/approve <plan-id>
```

`/ai-plan`：开始规划。

`/change`：提交修改意见，重新生成 Plan。

`/approve <plan-id>`：批准指定 Plan。

`/choose` 可以合并到 `/change` 的反馈语义中，不再作为独立复杂流程维护。

取消任务可以保留一个简单命令或 CLI 操作，但不需要设计完整的取消、撤销、恢复状态机。

### 5.3 Plan 修订

每次 Plan 发布都形成一个明确版本。

审批必须绑定：

```text
Issue + Plan ID + Plan Hash
```

Plan 修改后，旧审批自动失效。

不允许仅凭 `ai:ready` 标签启动执行。

### 5.4 执行

Driver 只在确认当前 Plan 已获得有效授权后准备执行。

Executor 读取已批准 Plan，完成开发、测试和报告。

Agent 不能自行批准计划，也不能自行将 Issue 标记为 DONE。

---

## 6. Workspace Protocol 精简

### 6.1 目标

减少 Agent 需要理解的协议概念。

Agent 只需要知道：

* 当前任务是什么。
* 当前是规划还是执行。
* 应该读取哪些文件。
* 应该把结果写到哪里。

不需要理解 Epoch、Transition、Operation ID、Receipt、GitHub Marker 等内部机制。

### 6.2 建议目录

```text
.gateflow/
├── tasks/
│   └── <task-id>/
│       ├── task.md
│       ├── plan.md
│       ├── report.md
│       └── result.json
└── driver/
    ├── state.json
    └── logs/
```

目录只是目标形态，可根据现有代码合理调整，不要求为了目录形式重新实现一套 Workspace。

### 文件职责

`task.md`

* Driver 生成。
* 包含 Issue 需求、当前模式、必要上下文和工作要求。
* Agent 只读。

`plan.md`

* AI 生成或修改的计划。
* 规划阶段输出。
* 执行阶段作为已批准计划输入。

`report.md`

* AI 执行结果。
* 包含完成内容、测试结果、未完成项和必要说明。

`result.json`

* 机器可解析的最小结果声明。
* 只表达本次工作结果，不表达 GitHub 正式状态。

例如：

```json
{
  "task_id": "123",
  "mode": "execute",
  "status": "completed",
  "report": "report.md"
}
```

实际实现应保留必要的任务实例标识和输入绑定，避免旧输出被当前任务误收。

### 6.3 不需要保留的复杂度

如果现有实现可以安全替代，应删除或合并：

* 多层 inbox/outbox 公开状态。
* Agent 可见的复杂 receipt。
* 多种角色专属结果 Schema。
* 不必要的 revision 字段。
* 不必要的 dispatch 生命周期。
* Producer submit 协议。
* 仅服务于自动唤醒的状态。

Driver 内部仍可保留必要的同步状态、幂等键和授权标识，但不应暴露给 Agent。

### 6.4 文件安全

必须保留：

* 任务目录隔离。
* 路径穿越防护。
* 输入文件不可被 AI 随意覆盖。
* 输出文件 Schema 校验。
* 写入完成后再读取，避免半写入。
* 旧任务结果不能覆盖当前任务。
* GitHub Token 不进入 Workspace。

---

## 7. Driver 简化方案

### 7.1 V1 优先使用主动命令

第一版不要求常驻自动调度。

建议提供简单命令：

```text
gateflow sync
gateflow status
gateflow run
```

具体命令名称可结合现有 CLI 调整，避免为了命名重新设计命令框架。

### sync

负责：

* 拉取 GitHub 当前状态。
* 对账本地状态。
* 同步待发布结果。
* 修复可恢复的同步中断。

### status

负责展示：

* 当前 Issue。
* 当前阶段。
* 当前 Plan。
* 是否已批准。
* 是否存在待同步结果。
* 是否需要用户操作。

### run

负责：

* 准备当前任务。
* 生成任务文件。
* 输出可复制提示词。
* 告诉用户应该在 AI 客户端执行什么。

不要求自动打开或唤醒 ChatGPT / ZCode。

### 7.2 Manual Activation

V1 标准方式：

```text
Driver 准备任务
    ↓
输出提示词
    ↓
用户复制到 ChatGPT / ZCode
    ↓
AI 读取 .gateflow 任务
    ↓
AI 写入结果
    ↓
用户运行 sync
```

可以提供一个简短的提示词：

```text
请使用 gateflow Skill，读取当前工作区的 GateFlow 任务，
按照 task.md 中的模式完成规划或执行，
并将结果写入指定输出文件。
不要直接修改 GitHub 工作流状态。
```

实际提示词应由 Driver 根据当前任务生成，避免用户手动填写 Issue ID、路径和模式。

### 7.3 单活动任务

V1 默认一个工作区只处理一个活动任务。

不做：

* 自动并行调度。
* 多 Agent 抢占。
* 任务优先级队列。
* 跨工作区资源调度。

如果需要处理另一个任务，先完成、暂停或显式切换当前任务。

### 7.4 锁与恢复

保留最简单可靠的单实例保护。

要求：

* 同一工作区不能同时存在两个有效写入者。
* 不得仅凭时间过期抢占仍然存活的 Driver。
* 锁必须有唯一持有者标识。
* 释放锁时必须确认持有者身份。
* 异常退出后允许明确、安全地恢复。
* 不需要设计分布式锁或租约服务。

---

## 8. Gate 与授权链精简

### 8.1 保留必要的授权链

```text
Current Plan
    ↓
Human Approval
    ↓
Gate Authorization
    ↓
Execution
    ↓
Report
    ↓
Gate Completion
```

必须确保：

1. 审批人可信。
2. 审批绑定当前 Plan。
3. Plan Hash 匹配。
4. 执行绑定当前授权。
5. 报告属于当前执行。
6. 旧轮次或旧任务结果不能被接受。

### 8.2 减少重复协议概念

现有 Schema 2 中的 Epoch、Approval Record、Dispatch Authorization、Transition Record 等机制，不应简单删除。

应先审查：

* 哪些字段真正用于安全校验。
* 哪些字段只是重复表达同一状态。
* 哪些记录只为旧兼容存在。
* 哪些公开协议可以收敛成内部实现。

目标是减少概念和重复代码，而不是削弱授权校验。

### 8.3 正式状态与标签

GitHub 正式记录应作为状态事实来源，标签作为展示投影。

当 Transition Record 已提交但标签更新失败时，应允许 Gate 在下一次运行中安全对账，而不是永久卡在多标签异常状态。

不引入数据库或额外事务系统。

### 8.4 不可信评论

公开 Issue 中，普通用户可能发布看起来像 GateFlow 协议的文本。

要求：

* 普通用户伪造的协议文本不能获得权限。
* 不可信协议文本不能轻易冻结整个工作流。
* 受信任签发者产生的冲突或无效记录仍应安全拒绝。
* Marker 不能作为身份或授权证明。

---

## 9. 分阶段开发计划

## Phase 0：架构确认与基线检查

### 目标

先确认现有代码和文档，再开始删除功能，避免误删已经承担安全职责的实现。

### 任务

* [ ] 检查当前 `main` 的 README、架构文档、协议文档和 CLI。
* [ ] 梳理 Gate、Driver、Workspace、Activation、Skills 的实际调用关系。
* [ ] 列出当前所有命令、状态、配置和协议记录。
* [ ] 标记哪些功能属于 V1 必需、哪些可删除、哪些延后。
* [ ] 检查现有测试覆盖和构建命令。
* [ ] 保存当前可运行基线，记录测试结果。
* [ ] 更新 README，写入第 2 章的架构和反复杂化原则。
* [ ] 将旧架构文档标记为历史资料，避免与新 README 冲突。

### 验收

README 能清楚回答：

* GateFlow 是什么？
* V1 有哪些组件？
* 用户如何完成一条任务？
* 哪些功能不做？
* 后续什么情况下才允许增加架构复杂度？

**本阶段完成前，不开始大规模代码重构。**

---

## Phase 1：删除不必要的角色与适配层

### 目标

将 Agent 侧收敛为一个 Skill、两种模式和 Manual Activation。

### 任务

* [ ] 合并 Consumer / Executor Skill 为统一的 `gateflow` Skill。
* [ ] 保留 `plan` 和 `execute` 两种工作模式。
* [ ] 删除独立 Producer 生命周期。
* [ ] 删除不再需要的 Producer 提交协议和 receipt。
* [ ] 删除或停用复杂 Role → Agent → Adapter 路由。
* [ ] 删除 ChatGPT / ZCode 自动唤醒专属主流程。
* [ ] 保留简单 Manual Activation。
* [ ] 简化配置文件，只保留仓库、工作区和必要身份配置。
* [ ] 更新 Skill 安装和使用文档。
* [ ] 删除不再适用的测试和旧配置示例。

### 验收

用户只需要安装一个 GateFlow Skill。

同一个 ChatGPT 或 ZCode 能够完成：

```text
Plan → Review → Execute
```

不需要配置 Agent 路由、Adapter、自动唤醒命令或复杂角色表。

---

## Phase 2：Workspace 与 Driver 精简

### 目标

让 Agent 只面对简单任务文件，Driver 负责所有系统集成。

### 任务

* [ ] 确定最小 Workspace 文件格式。
* [ ] 合并不必要的 inbox/outbox 公开协议层。
* [ ] 简化 Agent 输出 Schema。
* [ ] 将同步和授权元数据保留在 Driver 私有目录。
* [ ] 实现或调整 `sync / status / run` 主动命令。
* [ ] Driver 生成可复制的任务提示词。
* [ ] 默认单工作区、单活动任务。
* [ ] 简化 Driver 锁。
* [ ] 保留任务隔离、输入绑定和路径安全。
* [ ] 保留同步幂等和重启恢复。
* [ ] 删除不再使用的自动派发和调度代码。

### 验收

用户可以：

```text
gateflow run
```

获得当前任务和提示词。

AI 完成后：

```text
gateflow sync
```

即可同步结果。

Driver 重启后不会丢失已完成但尚未同步的结果。

---

## Phase 3：Gate 状态与授权链收敛

### 目标

保留安全性，同时减少重复状态和协议概念。

### 任务

* [ ] 收敛主状态为 PLANNING / REVIEW / READY / WORKING / DONE。
* [ ] 评估 BLOCKED 是否可作为执行状态而非主阶段。
* [ ] 将 `/choose` 合并到 `/change` 反馈流程。
* [ ] 保留 Plan ID + Hash 绑定审批。
* [ ] 保留执行与当前授权的关联校验。
* [ ] 删除不再需要的旧协议兼容分支。
* [ ] 合并重复的身份、命令和授权校验实现。
* [ ] 明确 Plan 已接收与 Plan 已批准的区别。
* [ ] 完善 Transition Record 与标签之间的对账。
* [ ] 修复不可信协议评论可能导致的拒绝服务问题。
* [ ] 检查 GitHub Actions 并发与事件丢失后的恢复能力。

### 验收

* 未审批不能执行。
* 审批后修改 Plan，旧审批失效。
* 伪造标签不能放行。
* 伪造协议文本不能轻易冻结任务。
* 重复 webhook 不产生重复迁移。
* 标签更新中断后可以恢复。
* 旧执行报告不能完成新任务。

---

## Phase 4：完整闭环与异常恢复

### 目标

验证精简后的架构能够真实使用，而不是只通过单元测试。

### 基础场景

* [ ] Issue → Plan → Review。
* [ ] Review → Change → 新 Plan。
* [ ] Review → Approve → Ready。
* [ ] Ready → Execute → Working。
* [ ] Working → Report → Done。
* [ ] Done → 人工检查 → Close Issue。

### 异常场景

* [ ] Driver 在 Plan 生成后重启。
* [ ] Driver 在 GitHub 评论发布后、receipt 更新前崩溃。
* [ ] GitHub API 超时后重复同步。
* [ ] 同一 webhook 重复投递。
* [ ] Plan 审批后被修改。
* [ ] Agent 提交旧任务输出。
* [ ] 两个 Driver 尝试操作同一工作区。
* [ ] GitHub 状态记录已写入但标签更新失败。
* [ ] 普通用户发布伪造协议评论。
* [ ] 用户取消或切换当前任务。

### 验收

所有基础场景通过。

关键异常能够安全恢复，或者明确拒绝并给出可操作的恢复方式。

不要求设计复杂自动恢复平台，但不能出现静默错误、重复执行或错误授权。

---

## Phase 5：文档、清理与发布准备

### 目标

让仓库只保留一套清晰的 V1 使用方式。

### 任务

* [ ] README 与最终代码一致。
* [ ] 更新安装指南。
* [ ] 更新 GitHub Actions 接入指南。
* [ ] 更新 Driver CLI 使用说明。
* [ ] 更新统一 Skill 使用说明。
* [ ] 更新 Workspace Protocol。
* [ ] 更新安全与授权说明。
* [ ] 删除或归档旧版 Producer、Adapter、路由相关文档。
* [ ] 删除无效配置、死代码和旧测试。
* [ ] 检查构建产物与源码一致。
* [ ] 运行类型检查、单元测试和构建检查。
* [ ] 在真实 GitHub 测试仓库完成端到端验证。
* [ ] 编写简单迁移说明。
* [ ] 更新 README 中的 V1 能力边界和已知限制。

### 验收

新用户只看 README 和一份使用指南，就能完成：

```text
安装 → 配置 → 创建 Issue → 规划 → 审批 → 执行 → 报告
```

不需要理解历史版本、复杂角色路由或多个协议版本。

---

## 10. 实施顺序与代码修改原则

推荐顺序：

```text
README 架构确认
    ↓
删除角色和适配层
    ↓
简化 Workspace / Driver
    ↓
收敛 Gate 协议
    ↓
完整闭环测试
    ↓
文档清理与发布
```

每个阶段都应遵循：

1. 先确认现有实现。
2. 优先复用已有代码。
3. 删除不再需要的代码，而不是保留双轨兼容。
4. 不新增没有明确用途的抽象。
5. 修改协议时同步修改测试和文档。
6. 阶段结束后保证主流程可运行。
7. 不因发现一个局部问题而重新设计整个架构。

如果某项简化会明显增加风险或实现成本，可以保留现有简单实现，不必为了“代码更少”强行重写。

---

## 11. 明确不进入 V1 的功能

以下能力全部延后：

* 多 Agent 并行协作。
* 自动任务分配和任务队列。
* Agent Registry。
* 复杂角色权限系统。
* ChatGPT / ZCode 自动唤醒。
* 远程 Agent 执行。
* 多机器 Driver。
* 分布式锁。
* 常驻 Server。
* 独立数据库。
* 消息队列。
* Web Dashboard。
* 插件市场。
* 通用 Scheduler。
* 自动 PR 合并。
* 自动代码审查平台。
* 复杂的组织级权限管理。
* 为未来扩展预留的通用事件总线或抽象框架。

以后确实需要其中某项功能时，再根据实际使用场景设计。

---

## 12. 后续新增需求的判断规则

以后讨论新功能时，先回答：

1. 当前真实需求是什么？
2. 现有 GitHub + Gate + Driver + Skill 能否直接解决？
3. 是否可以通过增加一个简单命令、配置或函数完成？
4. 是否真的需要新增组件或协议？
5. 新增复杂度是否明显小于它解决的问题？

默认优先级：

```text
复用现有功能
    ↓
局部修改
    ↓
增加简单配置或命令
    ↓
增加小型模块
    ↓
确有必要时才增加新架构层
```

不要因为“以后可能需要”而提前实现。

**V1 的目标是把一条 AI 开发工作流做好，而不是把所有可能的 AI 工作流都设计出来。**

---

## 13. 最终交付物

本计划完成后，应交付：

* 更新后的 README 架构说明。
* 一套精简的 Gate + Driver 实现。
* 一个统一的 GateFlow Skill。
* 简单的 Manual Activation 使用方式。
* 精简后的 Workspace Protocol。
* 最小必要的 GitHub 授权与状态协议。
* 完整的基础闭环测试。
* 关键异常恢复测试。
* 真实 GitHub E2E 验证结果。
* 更新后的安装、使用和安全文档。
* 旧架构和旧配置的清理结果。

最终 README 应明确：

> GateFlow V1 已收敛为 GitHub + Gate + Driver + Skill 的轻量架构。后续以实际需求驱动演进，优先保持简单，不提前建设通用 Agent 平台。需要新能力时，再在现有架构上按需增加。
