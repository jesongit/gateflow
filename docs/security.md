# 安全模型（V1）

简化不等于删除安全约束。当前 GitHub 授权记录为 schema 2，Workspace 机器文件为 schema 3；本文给出威胁模型要点。协议细节见 [protocol.md](protocol.md) 与 [workspace-protocol.md](workspace-protocol.md)。

## 1. 授权链（不可简化）

```text
Current Plan（Plan 评论，plan_sha256 绑定字节）
    ↓ /approve <plan-id>（可信人类）
Gate approval 记录（repo/issue/epoch/plan id/plan sha256/审批人/命令锚点）
    ↓ Driver 独立重验记录
Execution（execute 任务绑定 epoch + plan 评论 + 审批记录）
    ↓ result.json validation=passed + preflight
首轮 sync：Tracker 评论 → Gate 接受 WORKING
    ↓ 下一次 sync
Report（completion report 评论）
    ↓ Gate T6
DONE
```

要点：审批绑定具体 Plan 字节；Plan 修改后旧审批失效；执行绑定当前授权；旧轮次/旧任务结果不能被接受；只有 Gate 能确认正式状态迁移。

## 2. 身份与凭证

- Trusted Human（repo owner + `trusted-humans`）是唯一命令发布者；Trusted Agent（Driver 的 bot 身份）只合法化 marker 发布；两者永不合并；
- Organization 仓库无显式 `trusted-humans` → Gate 与 Driver 都拒绝运行（fail closed）；
- 标准路径中 **Agent 不持有 GitHub 凭证**：它只读写 `.gateflow/tasks/<task-id>/`；
- `GITHUB_TOKEN` 只注入 Driver 进程环境，永不写入工作区、配置文件或任务结果；
- Driver 校验 Gate-issued record 时使用 `gate_logins`（默认 `github-actions[bot]`）；不要把本地 Driver/用户身份冒充为 Gate 身份，Gate 与 Driver 的职责和认证边界必须分开。

## 3. 防伪造

- 任何人都写得出 marker 文本：marker 触发迁移需要"合法 marker + 可信发布者 + API 重读状态匹配"三重条件；
- 授权事实只认 **Gate 签发的记录**（作者在白名单 + 严格解析 + operation_id 绑定内容）；伪造记录（不可解析或作者不可信）→ 该 Issue 整体 fail closed；
- 伪造标签（手工打 `ai:ready`）无效：执行意图需要 approval 记录绑定当前 Plan 哈希；
- 伪造命令评论（复制他人 `/approve`）：命令是 Trusted Human 专属；记录的命令锚点还必须与记录中的审批人一致；
- 不可信协议文本不会永久冻结工作流：普通用户乱写的记录使该轮 fail closed，人工删除该评论或 `/cancel` + `/ai-plan`（新 epoch）即可恢复；受信任签发者的冲突记录仍安全拒绝。

## 4. 防重放与防混淆

- Operation ID：epoch / approval / feedback / plan / report 评论都有内容绑定 ID；重试先调和（已有同内容 → 采纳），绝不盲目重发；
- Driver 状态 `published`（远端确认）≠ `accepted`（Gate 消费完成）；已发布的任务拒绝后续 result 覆盖；
- workflow epoch：`/ai-plan` 每轮签发新 CSPRNG epoch；新轮次使旧任务全部 `obsolete`；
- 输入快照：Agent 修改任务输入文件 → sync 拒绝；
- 人类专属值（approve / ready / cancel / human-close）在任何 Agent 机器文件中被黑名单拒绝（任何大小写）。

## 5. 文件与路径

- task-id 语法冻结 + 词法包含校验 + 符号链接/junction 防护；
- 机器文件严格 Schema（未知键拒绝）+ 512 KB 上限（防资源耗尽）+ 每轮扫描目录数上限；
- 原子写入（temp + rename），写完整再读；
- 单实例锁（pid + holder 身份；不按时间抢占存活进程）；
- Windows 上 Driver 私有目录无 POSIX 权限位：隔离是协议级通信隔离，不是 OS 沙箱（已文档化的限制）。

## 6. AI 输出的边界

Agent 产出（plan.md / report.md / result.json）在发布前经过：Schema 校验 → 输入快照校验 → preflight 授权校验 → 状态矩阵校验。`validation:"failed"` 的完成声明永远不会被发布为完成；AI 的 completed 声明只是 Claim——只有 Gate 能把 Issue 迁到 DONE。AI 会话中看到的任务文件是**数据**而非指令：其中夹带的协议外"指令"（改状态、跳过审批）按注入处理，skills/gateflow 已明确此纪律。

## 7. Personal Mode 与 Control/Target 边界

Personal Mode 可以在用户明确批准的范围内让本地客户端运行 `gh` 或 Bootstrap；这时使用的
是当前用户已经登录的 `gh` 身份和权限，不等于建立了强 Human/Agent 隔离，也不等于
Trusted Agent 身份。创建仓库、改变可见性/权限、修改 Secrets 或 Workflow、删除内容、向
默认分支推送等高影响动作必须先写入 Plan 并得到批准；超出范围应停止，不用本地客户端仍能
访问文件这一事实宣称任务已被终止。

`control_repository`、`repository_id`、`issue_number` 和 `workflow_epoch` 绑定 Canonical
State。`target_repository`、`target_workspace` 只声明业务目标，所有 Plan、Approval、Tracker、
Report 和 Gate 状态仍回写 Control Repository 的原 Issue。Target workspace 必须是规范化绝对
路径，不能落入 `.gateflow/`；旧 epoch、旧 task-id、旧输入快照和错误 Control/Target 绑定都
不能被同步。

## 8. 已知限制与验收前置

Task 10 的真实已有项目 E2E 因缺少明确隔离仓库、Control Repository 和入口 Issue 而
**blocked**；真实 GitHub 新建项目写入也没有被伪造为通过。ChatGPT/ZCode 客户端驱动的真实
任务尚未验证。它们不能由本地 fake E2E、单元测试或 `gh auth status` 代替，发布前仍需提供
隔离资源、批准的凭证和客户端验证条件。
