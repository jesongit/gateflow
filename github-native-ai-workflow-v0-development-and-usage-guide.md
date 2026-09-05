# GitHub-native AI Workflow V0
## 详细开发计划与使用手册

> 版本目标：V0  
> 核心技术：TypeScript + GitHub Actions + GitHub MCP + Markdown Skills  
> 核心原则：GitHub 保存正式工作状态；AI 负责理解、规划、执行和汇报；权限、审批和状态迁移由确定性程序控制。

---

# 一、先看最终要做成什么

这个项目最终不是一个 Web 后台，也没有数据库。

它本质上只有四部分：

```text
AI Conversation
      │
      ▼
 Producer Skill
      │
      ▼
 GitHub Issue
      │
      ▼
TypeScript Gate
      │
      ▼
Consumer / Executor Skills
      │
      ▼
Plan → Todo → Code → Report
```

实际使用体验：

```text
你和 AI 讨论
    ↓
“把这个发成 Issue”
    ↓
Producer 创建 Issue
    ↓
Consumer 读取 Issue + Repo
    ↓
只补缺失的设计
    ↓
发布 Execution Plan
    ↓
你 /approve
    ↓
Executor 创建 TodoList
    ↓
开发并持续更新 Todo
    ↓
发布 Completion Report
    ↓
你检查并关闭 Issue
```

---

# 二、V0 不做什么

第一版明确不做：

```text
Go Server
SQLite
React
Docker 服务
独立数据库
独立 Dashboard
Agent Registry
Task Scheduler
Lease
消息队列
复杂 RBAC
复杂 Workflow Engine
```

V0 的状态全部放在：

```text
GitHub Issue
GitHub Comment
GitHub Label
GitHub PR
GitHub Timeline
```

只有以后 GitHub 原生能力真的不够，再考虑独立 Control Plane。

---

# 三、技术选型

## 1. Deterministic Gate

使用：

```text
TypeScript
GitHub JavaScript Action
@actions/core
@actions/github
```

Action 运行在 GitHub Actions 中。

不需要常驻进程。

Gate 只在 GitHub 有事件时运行：

```text
Issue created
Issue comment created
Issue comment edited
Issue labeled
Issue closed
```

主要负责：

```text
身份验证
命令解析
状态检查
Marker 检查
Label 状态迁移
操作反馈
并发保护
```

---

## 2. AI 与 GitHub 的连接

使用 GitHub 官方 MCP Server。

需要的主要能力：

```text
读取 Repo
读取 Issue
创建 Issue
读取 / 创建 / 编辑 Comment
读取 PR
创建 PR
```

建议只打开实际需要的 Toolsets / Tools。

不要直接给 AI 所有 GitHub 权限。

---

## 3. AI 行为

通过三个 Skill 定义：

```text
Producer Skill
Consumer Skill
Executor Skill
```

### Producer

负责：

```text
AI Conversation
→ GitHub Work Item
```

### Consumer

负责：

```text
Work Item
→ Repository Analysis
→ Maturity 判断
→ 补设计
→ Execution Plan
```

### Executor

负责：

```text
Approved Plan
→ TodoList
→ Development
→ Validation
→ Completion Report
```

---

# 四、推荐项目结构

建议单独创建一个仓库，例如：

```text
github-ai-workflow
```

目录：

```text
github-ai-workflow/
│
├── README.md
│
├── package.json
│
├── tsconfig.json
│
├── action.yml
│
│
├── src/
│   ├── index.ts
│   ├── gate.ts
│   ├── commands.ts
│   ├── states.ts
│   ├── markers.ts
│   ├── permissions.ts
│   └── github.ts
│
├── dist/
│   └── index.js
│
├── tests/
│   ├── commands.test.ts
│   ├── states.test.ts
│   ├── permissions.test.ts
│   └── gate.test.ts
│
├── skills/
│   ├── producer/
│   │   └── SKILL.md
│   ├── consumer/
│   │   └── SKILL.md
│   └── executor/
│       └── SKILL.md
│
├── templates/
│   └── workflow.yml
│
├── scripts/
│   └── bootstrap.mjs
│
└── docs/
    ├── architecture.md
    ├── protocol.md
    ├── security.md
    └── usage.md
```

---

# 五、GitHub Workflow 状态设计

V0 只保留少量可见状态。

使用 Label：

```text
ai:planning
ai:review
ai:ready
ai:working
ai:blocked
ai:done
```

概念上：

```text
Issue
 ↓
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

异常：

```text
WORKING
  ↕
BLOCKED
```

`ai:done` 的含义不是 Issue 已经正式关闭。

它表示：

> AI 工作已完成，等待 Owner 最终检查。

最后：

```text
Owner Review
↓
Close Issue
```

---

# 六、权限边界

这是第一版最重要的安全设计。

## Human Authority

Human 负责：

```text
Approve
Choose
Change Request
Cancel
最终 Close
```

V0 默认 Trusted Human：

```text
Repository Owner
```

---

## Agent Authority

AI 可以：

```text
创建 Work Item
发布 Plan
发布新版 Plan
创建 / 编辑 Execution Tracker
发布 Completion Report
创建 PR
```

AI 不能：

```text
批准自己的 Plan
取消 Human 决策
绕过 Gate
自己修改正式 Workflow State
```

---

# 七、Human 和 Agent 身份

## 快速自用模式

最简单：

```text
你的 GitHub OAuth / PAT
→ GitHub MCP
→ Producer / Consumer / Executor
```

优点：

```text
配置最少
立即能用
```

缺点：

```text
AI 发出的 GitHub 操作和 Human 身份可能无法完全区分
```

因此这个模式适合：

```text
个人仓库
自己 Dogfood
V0 验证
```

---

## 推荐安全模式

长期建议：

```text
Human
= 你的 GitHub Account

Agent
= 独立 Bot / GitHub App Identity
```

这样：

```text
Owner /approve
→ 可以批准

Agent /approve
→ 永远无效
```

可以从身份层切断 Prompt Injection 导致的“AI 自我批准”。

第一版开发时要把代码设计成：

```text
Trusted Human
Trusted Agent
```

是两个概念。

即使 MVP 暂时使用同一账号，也不要把两个概念在代码里合并。

---

# 八、Work Item 成熟度

Consumer 不固定走：

```text
Idea
→ Initial Plan
→ Detailed Plan
```

而是根据 Issue 当前内容的成熟程度接着工作。

定义：

```text
L0 Requirement
L1 Direction
L2 Solution
L3 Execution Plan
```

---

## L0 Requirement

只有想法、问题、Bug。

Consumer：

```text
分析问题
↓
设计方案
↓
生成执行计划
```

---

## L1 Direction

已经有方向。

Consumer：

```text
验证方向
↓
补完整方案
↓
生成执行计划
```

---

## L2 Solution

主要方案已经确定。

Consumer：

```text
检查 Repo
↓
补遗漏
↓
生成执行计划
```

不重新做方案选型。

---

## L3 Execution Plan

已经有完整开发计划。

Consumer：

```text
Readiness Check
↓
必要的小修正
↓
直接进入待审批执行计划
```

禁止重新把整套方案设计一遍。

---

# 九、Producer Skill 设计

Producer 是你日常最直接的入口。

触发方式：

```text
“把这个发成 Issue”
“整理成 Issue”
“推到 gamer”
“把这段方案追加到 #123”
```

Producer 只有用户明确要求时才发布。

不能自己判断：

```text
“讨论差不多成熟了，我帮你创建 Issue”
```

---

## Producer 工作流程

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

---

## Producer CREATE

生成新 Issue。

建议 Body：

```markdown
## Goal

...

## Context

...

## Current State

...

## Confirmed Requirements

...

## Proposed Direction

...

## Execution Plan

如果已经讨论到执行层则填写。

## Acceptance Criteria

如果已经明确则填写。

## Open Questions

...

<!-- ai-workflow
schema: 1
source: producer
kind: feature
maturity_hint: solution
-->
```

---

## Producer APPEND

如果你说：

```text
“把这个追加到 #123”
```

则不创建新 Issue。

发布新的 Comment：

```markdown
## AI Discussion Summary

...

## Proposed Direction

...

<!-- ai-workflow:append:v1 -->
```

原则：

```text
只新增
不修改已有历史
```

---

# 十、Consumer Skill 设计

Consumer 接手：

```text
ai:planning
```

状态的 Work Item。

流程：

```text
Issue
 ↓
读取 Repo
 ↓
读取项目规则
 ↓
Repository Validation
 ↓
判断 Effective Maturity
 ↓
只补缺失内容
 ↓
形成 L3 Execution Plan
 ↓
发布 Plan Comment
```

---

## Consumer 读取内容

至少：

```text
Issue Body
Producer Append Comments
README
AGENTS.md
CONTRIBUTING
相关 docs
相关源码
现有 tests
```

---

## Producer 的 maturity_hint 只是提示

例如 Producer 写：

```text
maturity_hint: execution_plan
```

Consumer 不能直接相信。

必须检查真实仓库。

例如：

```text
Producer:
L3

实际 Repo:
计划引用的模块已经不存在
```

Consumer 可以降级成：

```text
Effective Maturity = L2
```

然后只补需要重新设计的部分。

---

# 十一、Plan Comment

Consumer 最终发布：

```markdown
<!-- ai-workflow:plan:v1 -->

## Execution Plan

### Objective

...

### Design

...

### Tasks

...

### Dependencies

...

### Acceptance Criteria

...

### Validation

...

### Open Decisions

...
```

发布后进入：

```text
ai:review
```

---

## Plan 不覆盖

例如：

```text
Plan v1
↓
Human 要求修改
↓
Plan v2
```

Plan v2 是新 Comment。

不 Edit Plan v1。

批准的 Plan 相当于：

> 执行依据。

后面的 Todo 更新不能修改 Approved Plan。

---

# 十二、审批命令

V0 推荐以 Comment Command 为主。

## 开始 AI Planning

```text
/ai-plan
```

适用于：

```text
外部用户创建的 Issue
已有老 Issue
Owner 想显式加入 Workflow
```

---

## 批准

```text
/approve
```

推荐作为 V0 主审批方式。

Gate 判断：

```text
actor 是 Trusted Human
+
当前状态是 REVIEW
+
目标 Plan 是当前版本
```

才允许：

```text
ai:review
→ ai:ready
```

---

## 选择方案

```text
/choose 1 B
```

表示：

```text
问题 1
选择 B
```

Gate 只解析格式。

具体选项语义由 Consumer 根据当前 Plan 处理。

---

## 要求修改

```text
/change 还需要考虑离线安装
```

Gate 判断命令是否合法。

后面的文本作为普通不可信数据交给 Consumer。

Consumer：

```text
只修改受影响的 Plan 部分
↓
发布 Plan vN+1
```

---

## 取消

```text
/cancel
```

退出 AI Workflow。

---

# 十三、为什么不让 AI 判断 `/approve`

以下流程禁止：

```text
Comment
 ↓
AI：
“我认为这是 Owner，而且用户已经同意”
 ↓
执行
```

正确方式：

```text
Comment Event
 ↓
TypeScript Gate
 ↓
GitHub actor 校验
 ↓
严格命令解析
 ↓
当前状态校验
 ↓
确定性状态迁移
```

AI甚至不需要参与授权判断。

---

# 十四、Gate 的开发内容

Gate 是整个 V0 唯一比较正式的程序。

建议拆成以下模块。

---

## `commands.ts`

负责：

```text
/ai-plan
/approve
/choose
/change
/cancel
```

只做：

```text
严格 Parse
```

例如：

```text
trim(body) === "/approve"
```

禁止：

```text
body.includes("/approve")
```

---

## `states.ts`

定义：

```text
PLANNING
REVIEW
READY
WORKING
BLOCKED
DONE
```

以及允许的迁移：

```text
PLANNING → REVIEW
REVIEW → READY
READY → WORKING
WORKING ↔ BLOCKED
WORKING → DONE
```

---

## `permissions.ts`

负责：

```text
Is Trusted Human?
Is Trusted Agent?
```

V0：

```text
Trusted Human = Repo Owner
```

未来可扩展：

```text
maintain/admin
allowlist
GitHub App identity
```

---

## `markers.ts`

识别：

```text
Plan
Execution Tracker
Completion Report
Producer Append
```

Marker 只是结构标记。

Marker 永远不能当权限证明。

---

## `github.ts`

封装：

```text
getIssue
getLabels
replaceWorkflowLabel
getComments
addReaction
editComment
```

业务逻辑不要散落 API 调用。

---

## `gate.ts`

负责：

```text
Event
↓
Permission
↓
Current State
↓
Command / Marker
↓
Validate
↓
Transition
```

---

# 十五、Gate 并发

同一个 Issue 的多个 Gate Run 必须串行。

例如：

```text
Issue #123
```

使用同一个 concurrency group。

并且每次迁移前：

```text
重新从 GitHub API 读取当前 Labels
```

不要只相信 Event Payload 里的旧快照。

---

# 十六、Execution Skill

Executor 只处理：

```text
ai:ready
```

状态。

流程：

```text
读取 Approved Plan
        ↓
Taskify
        ↓
创建 Execution Tracker
        ↓
ai:working
        ↓
执行 Todo
        ↓
持续更新 Tracker
        ↓
Validation
        ↓
Completion Report
        ↓
ai:done
```

---

# 十七、Execution Tracker

Plan 批准后必须先创建 TodoList。

推荐：

```markdown
<!-- ai-workflow:execution-tracker:v1 -->

## Execution Tracker

**Status:** In Progress

### Phase 1

- [x] 确认现有插件 Manifest 结构
- [ ] 实现 Package Downloader
- [ ] 增加 Cache

### Phase 2

- [ ] 接入安装流程
- [ ] 更新 UI

### Validation

- [ ] Unit Tests
- [ ] Integration Tests

### Current

Package Downloader

### Notes

正在实现 checksum 校验。
```

---

## Tracker 的规则

Tracker：

```text
允许 Edit
```

Plan：

```text
不允许因为进度 Edit
```

因此：

```text
Plan
= 准备怎么做

Tracker
= 当前做到哪里
```

---

## Todo 粒度

不要：

```text
创建 file
创建 struct
增加 function
```

应该：

```text
实现 Package Downloader
接入插件安装流程
完成回归测试
```

Todo 是有意义的工作单元。

---

# 十八、Tracker Status

V0：

```text
In Progress
Blocked
Completed
```

这些字段必须是固定机器值。

例如：

```markdown
**Status:** Blocked
```

可以由 Gate 确定性解析。

---

# 十九、Completion Report

全部工作完成后，Executor 必须新增最终报告：

```markdown
<!-- ai-workflow:completion-report:v1 -->

## Completion Report

### Result

远程插件安装功能已完成。

### Completed

- ...
- ...

### Key Changes

- ...
- ...

### References

- PR #123
- Commit abc123

### Validation

- Unit Tests: Passed
- Integration Tests: Passed

### Deviations

与原计划相比：
...

### Remaining / Follow-up

...
```

然后：

```text
ai:done
```

Issue 保持 Open。

最后由 Owner：

```text
检查 Report
↓
检查 PR / Tests
↓
Close Issue
```

---

# 二十、复杂任务

V0 初期不要先做 Child Issue 自动化。

先运行简单单 Issue 模式。

等真实使用发现单个 Todo 太复杂，再增加：

```text
Parent Issue
├── Child Issue A
├── Child Issue B
├── Child Issue C
└── Integration
```

Parent Tracker：

```text
- [x] #101 Backend
- [ ] #102 Frontend
- [ ] #103 Tests
```

---

# 二十一、分阶段开发计划

---

# Phase 0 — 建仓库与协议冻结

## 目标

建立项目骨架。

## 开发内容

创建：

```text
README.md
docs/
skills/
src/
tests/
templates/
```

确定：

```text
Labels
Commands
Markers
States
Maturity
Human / Agent 权限边界
```

## 完成标准

任何开发者阅读：

```text
architecture.md
protocol.md
security.md
```

都能理解整个 Workflow。

---

# Phase 1 — Gate 核心

## 目标

先不接 AI，单独把确定性状态机跑通。

## 实现

```text
TypeScript Action
Event Router
State Reader
Owner Check
Command Parser
Label Transition
Concurrency
```

先支持：

```text
/ai-plan
/approve
/cancel
```

## 测试

必须覆盖：

### Case 1

Owner：

```text
/approve
```

REVIEW → READY。

### Case 2

外部用户：

```text
/approve
```

无效。

### Case 3

Owner 在错误状态：

```text
/approve
```

无状态迁移。

### Case 4

Issue 连续两个命令：

```text
并发 Run
```

不能产生错误状态。

## 完成标准

完全不用 AI，人工操作 Issue 就能验证状态机。

---

# Phase 2 — Gate 完整命令

增加：

```text
/choose
/change
```

增加：

```text
✅ accepted
👎 invalid owner command
```

非 Owner：

```text
静默忽略
```

增加 Marker 校验：

```text
Plan
Tracker
Completion Report
```

---

# Phase 3 — Producer Skill

## 目标

实现：

```text
Chat → Issue
```

## 开发内容

完成：

```text
skills/producer/SKILL.md
```

支持：

```text
CREATE
APPEND
Repo detection
Conversation summarization
kind
maturity_hint
Draft confirmation
GitHub MCP
```

## Dogfood

实际和 AI 讨论一个 Gamer 需求。

然后说：

```text
“把刚才的讨论整理成 gamer 的 Issue”
```

验证：

```text
Issue 质量
是否遗漏已确认结论
是否塞入过多聊天废话
Maturity Hint 是否合理
```

---

# Phase 4 — Consumer Planning Skill

## 目标

实现：

```text
Issue → Execution Plan
```

## 开发内容

Consumer：

```text
读取 Repo
读取 Existing Instructions
判断 Effective Maturity
按最小补全原则规划
Readiness Check
Plan Version
```

## 测试输入

至少准备：

```text
Raw Idea
Raw Bug
Direction
Solution
Full Execution Plan
```

五种 Fixture。

## 完成标准

Full Plan 不会重新规划。

Raw Idea 能得到完整 Execution Plan。

---

# Phase 5 — Plan Review 闭环

## 目标

完整跑通：

```text
Consumer Plan
↓
Gate Review
↓
Human Feedback
↓
Consumer Plan v2
↓
Approve
```

实现：

```text
/change
/choose
/approve
```

Consumer 必须遵守：

```text
最小变更
新版本 Comment
不覆盖旧 Plan
```

---

# Phase 6 — Executor Skill

## 目标

实现真正开发。

完成：

```text
skills/executor/SKILL.md
```

支持：

```text
读取 Approved Plan
Taskify
创建 Tracker
更新 Todo
Blocked
Resume
Validation
```

## 完成标准

一个小 Bug 可以：

```text
Plan
↓
Approve
↓
Todo
↓
Code
↓
Tests
```

完整执行。

---

# Phase 7 — Completion Report

加入：

```text
Completion Report
ai:done
Owner Close
```

必须验证：

```text
Plan
Todo
Report
```

三者可以互相对照。

---

# Phase 8 — 安装与 Bootstrap

## 目标

让新项目接入只需要几分钟。

提供：

```text
templates/workflow.yml
scripts/bootstrap.mjs
```

Bootstrap 负责：

```text
创建 ai:* Labels
检查已有 workflow
生成项目 workflow stub
提示安装 Skills
```

不要修改：

```text
已有 labels
已有 issue templates
已有 PR workflow
```

---

# Phase 9 — Package / Release

将 Action 发布成：

```text
owner/github-ai-workflow@v0
```

项目只需要：

```yaml
uses: owner/github-ai-workflow@v0
```

不要把 Gate 源码复制到每个仓库。

维护只在中央仓库进行。

---

# Phase 10 — Dogfood

至少跑：

```text
5~10 个真实 Issues
```

覆盖：

```text
Bug
Feature
Refactor
已有 Issue
外部用户 Issue
Producer 创建 Issue
L0
L2
L3
```

只记录真实痛点。

不要立刻加功能。

---

# Phase 11 — 根据 Dogfood 决定是否继续

只有真实出现以下问题，再开发：

```text
Child Issues
多 Agent 并行
Consumer Driver
自动唤醒
Stale 检测
Agent 独立身份
GitHub App
Cross-repo Dashboard
```

---

# 二十二、怎么安装到一个新项目

假设 Workflow 项目发布为：

```text
jesongit/github-ai-workflow
```

目标仓库：

```text
jesongit/gamer
```

---

## Step 1：创建 Workflow 文件

目标项目：

```text
.github/workflows/ai-workflow.yml
```

概念上：

```yaml
name: AI Workflow Gate

on:
  issues:
    types: [opened, labeled, closed]
  issue_comment:
    types: [created, edited]

permissions:
  issues: write
  contents: read

jobs:
  gate:
    runs-on: ubuntu-latest

    concurrency:
      group: ai-workflow-${{ github.event.issue.number }}
      cancel-in-progress: false

    steps:
      - uses: jesongit/github-ai-workflow@v0
```

具体字段以 Action 最终接口为准。

---

## Step 2：初始化 Labels

创建：

```text
ai:planning
ai:review
ai:ready
ai:working
ai:blocked
ai:done
```

以后 Bootstrap Script 可以自动创建。

---

## Step 3：安装 GitHub MCP

在你使用的 AI Client：

```text
Codex
Claude Code
Cursor
VS Code
其他 MCP Host
```

配置 GitHub 官方 MCP Server。

最少开放：

```text
repos
issues
pull_requests
```

如果只做 Planner，可以进一步限制写权限。

---

## Step 4：安装 Skills

AI 环境加入：

```text
producer
consumer
executor
```

可以：

```text
全局安装
```

或者：

```text
项目级引用
```

---

# 二十三、日常怎么用

下面是最重要的实际使用流程。

---

# 场景 A：你先和 AI 聊，再发布 Issue

你：

```text
我想把 gamer 的插件包更新机制简化……
```

和 AI 正常讨论。

讨论结束：

```text
把刚才讨论整理成 gamer 的 Issue
```

Producer：

```text
整理 Draft
↓
给你确认
↓
GitHub MCP 创建 Issue
```

Issue 自动进入：

```text
ai:planning
```

---

# 场景 B：Issue 只有一个模糊想法

例如：

```text
希望插件支持远程更新
```

Consumer：

```text
读取 Repo
↓
识别 L0
↓
分析现有实现
↓
设计方案
↓
发布 Execution Plan
```

Issue：

```text
ai:review
```

你查看 Plan。

满意：

```text
/approve
```

---

# 场景 C：你已经和 AI 把方案讨论得差不多

Producer：

```text
maturity_hint = solution
```

Consumer：

```text
读取 Repo
↓
验证方案
↓
只补遗漏
↓
生成 Execution Plan
```

不会再重新问：

```text
“我们是否应该用 HTTP Repository？”
```

如果这个决定已经明确且现实仍成立。

---

# 场景 D：Producer 已经提交完整开发计划

Consumer：

```text
识别 L3
↓
Readiness Check
```

如果：

```text
READY
```

直接整理成最终 Execution Plan。

不重新做架构设计。

然后你：

```text
/approve
```

即可进入执行。

---

# 场景 E：别人提交 Bug

外部用户：

```text
创建 #123
```

默认：

```text
普通 GitHub Issue
```

AI 不自动处理。

你觉得值得处理：

```text
/ai-plan
```

Gate 验证：

```text
actor == repo owner
```

然后：

```text
ai:planning
```

Consumer 才开始工作。

---

# 场景 F：Plan 需要改

AI 发布 Plan v1。

你：

```text
/change V1 暂时不要做自动更新，只保留手动更新
```

Gate：

```text
验证 Owner
↓
接受 Change Request
```

Consumer：

```text
只修改受影响部分
↓
发布 Plan v2
```

不是从头重新写整份 Plan。

---

# 场景 G：Plan 有多个选择

Plan：

```text
1. 更新方式

A. 自动
B. 手动（推荐）
C. 两者都做
```

你：

```text
/choose 1 B
```

Consumer 读取选择。

发布对应新版 Plan。

---

# 场景 H：批准以后执行

你：

```text
/approve
```

Gate：

```text
ai:review
→
ai:ready
```

然后让 Executor 处理：

```text
执行 #123
```

Executor：

```text
读取 Approved Plan
↓
创建 Tracker
↓
执行 Todo
```

---

# 场景 I：查看实时进度

不用问 AI：

```text
“你现在做到哪了？”
```

直接打开 Issue。

Execution Tracker：

```text
[x] Manifest
[x] Downloader
[ ] Cache
[ ] Integration
```

即可看到。

---

# 场景 J：完成

Executor 最终发布：

```text
Completion Report
```

Issue：

```text
ai:done
```

你检查：

```text
代码
PR
Tests
Report
```

确认：

```text
Close Issue
```

完成闭环。

---

# 二十四、如果暂时没有 Consumer Driver 怎么办

V0 初期是：

```text
GitHub Label
= Workflow Signal
```

但是 Label 不一定自动启动一个 AI Session。

所以第一版可能需要你手动：

```text
“规划 gamer#123”
```

或者：

```text
“执行 gamer#123”
```

这是可以接受的。

因为第一阶段先验证：

```text
Workflow 是否好用
```

而不是先解决：

```text
怎么自动唤醒 Agent
```

等真实使用确认流程合理，再做 Driver。

---

# 二十五、未来 Consumer Driver

如果以后想做到：

```text
ai:planning
→ 自动调用 Planner

ai:ready
→ 自动调用 Executor
```

再增加：

```text
Automation / Webhook / Local Daemon
```

Driver 只是：

> 根据 GitHub State 唤醒 AI。

它不能接管：

```text
权限
Approval
Canonical State
```

这些仍然属于 Gate。

---

# 二十六、测试策略

Gate 必须大量使用单元测试。

AI Skills 主要使用 Scenario / Fixture 测试。

---

## Gate 单测

必须覆盖：

```text
Owner command
Non-owner command
Invalid command
Invalid state
Duplicate event
Concurrent event
Marker spoofing
Issue close
```

---

## Skill Fixture

创建：

```text
fixtures/
├── raw-idea.md
├── raw-bug.md
├── direction.md
├── solution.md
└── full-plan.md
```

验证 Consumer：

```text
是否正确判断 Maturity
是否重复设计
是否漏掉关键阶段
```

---

## 端到端测试

至少人工跑：

```text
CREATE Issue
↓
Planning
↓
Plan
↓
Review
↓
Approve
↓
Ready
↓
Tracker
↓
Work
↓
Report
↓
Done
```

---

# 二十七、开发优先级

必须先做：

```text
Gate
Producer
Consumer
Executor
Tracker
Report
```

可以晚点做：

```text
Child Issues
Auto Driver
Bot Identity
GitHub App
Reaction Approval
Stale Detection
Cross Repo
```

---

# 二十八、MVP 完成标准

只要能够稳定跑通：

```text
Chat
↓
Producer
↓
Issue
↓
Consumer
↓
Plan
↓
/approve
↓
Executor
↓
Todo
↓
Code
↓
Report
↓
Close
```

就算 MVP 成功。

不需要等多 Agent、自动调度等能力。

---

# 二十九、什么时候才需要重新引入 Go / SQLite / React

只有真实出现：

```text
多个 Agent 同时抢任务
需要精确 Lease
跨几十个 Repo 管理
需要统一 Dashboard
GitHub Issue 太难追踪
需要独立 Approval Inbox
复杂 DAG
需要跨项目 Knowledge
```

才重新考虑：

```text
Go + SQLite + React Control Plane
```

它应该是：

> GitHub-native Workflow 的增强层。

而不是现在 V0 的前置条件。

---

# 三十、推荐的实际开发路线

最推荐：

```text
Week / Iteration 1
Gate MVP
↓
Producer

Iteration 2
Consumer
↓
Plan Review

Iteration 3
Executor
↓
Tracker
↓
Report

Iteration 4
真实拿 gamer Dogfood
↓
连续运行 5~10 个 Issue

Iteration 5
只解决真实痛点
```

不要先做：

```text
Child Issues
Agent Scheduler
Dashboard
Auto Wakeup
```

---

# 三十一、开发完成以后你每天真正需要记住的操作

其实只有几个：

```text
和 AI 聊完：
“发成 Issue”

让已有 Issue 进入 AI Workflow：
/ai-plan

批准：
/approve

选择：
/choose 1 B

修改：
/change xxx

取消：
/cancel

执行阶段：
看 Execution Tracker

完成阶段：
看 Completion Report，然后 Close
```

如果最终使用体验能保持这么简单，这个项目就达到了它最初的目标：

> **不是增加一个新的管理系统，而是减少你和 AI 之间重复规划、重复确认和进度追问的成本。**

---

# 三十二、当前推荐结论

V0 最适合的架构就是：

```text
GitHub
+
TypeScript GitHub Action
+
GitHub MCP
+
Producer Skill
+
Consumer Skill
+
Executor Skill
```

没有常驻 Server。

没有数据库。

没有 Web UI。

开发工作的重点应该放在：

```text
协议是否清晰
Gate 是否安全可靠
Skill 是否真的减少重复沟通
Issue 是否能完整展示 Plan / Progress / Result
```

先用真实项目验证。

等真实瓶颈出现，再决定下一层系统应该长什么样。

---

# 参考

GitHub 官方文档：

- GitHub MCP Server:
  https://github.com/github/github-mcp-server
- GitHub MCP Server Configuration:
  https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md
- Configure GitHub MCP toolsets:
  https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/configure-toolsets
- Create a JavaScript Action:
  https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action
- Authenticate with a GitHub App:
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app
