# 日常使用手册（V1）

一条任务的完整生命周期与常见场景速查。协议速查见 [protocol.md](protocol.md)，CLI 细节见 [driver.md](driver.md)。

## 标准闭环

```text
1. 创建 Issue（普通聊天或手动）        —— 写清需求
2. Issue 上评论 /ai-plan               —— Gate: PLANNING + epoch 记录
3. gateflow run                        —— 生成任务目录，打印提示词
4. 粘贴提示词到 ChatGPT / ZCode        —— AI（plan 模式）写 plan.md + result.json
5. gateflow sync                       —— Plan 评论发布（Gate: REVIEW）
6a. 满意 → /approve <plan-comment-id>  —— Gate: READY（approval 记录固化）
6b. 不满意 → /change <反馈>            —— 回到第 3 步（新 plan 轮次，feedback.md 投影）
7. gateflow run                        —— 生成 execute 任务（plan.md 为输入）
8. 粘贴提示词（execute 模式）          —— AI 开发、真实验证，写 report.md + result.json
9. gateflow sync                       —— Tracker + Report 发布（Gate: WORKING → DONE）
10. 人工检查，Close Issue
```

## 常用命令

| 命令 | 作用 | 需要 Token |
| --- | --- | --- |
| `gateflow run` | 准备当前任务 + 打印 AI 提示词（`--issue N` 显式切换任务） | 是 |
| `gateflow sync` | 校验并发布任务结果（可安全重复执行） | 是 |
| `gateflow status` | 查看本地任务与同步状态 | 否 |
| `gateflow retry <task-id>` | 清除任务状态，下次 run 重新准备 | 否 |

## 场景速查

**修改需求（REVIEW 阶段）**：`/change 用方案 B，去掉登录模块` → `gateflow run` → AI 消化 feedback.md 重新出 plan.md → `gateflow sync` → 重新审批。多轮反馈按轮次递增（`_plan_02`、`_plan_03`…），旧 Plan 与旧任务自动作废。

**AI 说任务有问题（question/blocked）**：sync 会把原因以普通评论贴到 Issue；澄清后用 `/change` 回应，重新走规划轮。

**执行中受阻**：AI 写 `result.json`（status=blocked）→ sync 将 Tracker 置为 Blocked（Issue 显示 ai:blocked）+ 贴通知；障碍解除后 AI 继续完成，最终 `status=completed` 的同一任务照常发布（sync 先恢复 In Progress 再发报告）。

**中途想换任务**：当前任务未同步前 `gateflow run` 会保持原任务；确实要切换用 `gateflow run --issue <n>`（旧任务保持 prepared，可稍后 sync 或 retry 丢弃）。

**放弃当前任务**：Issue 上 `/cancel`（工作流退出）；本地 `gateflow retry <task-id>` 清状态；重新开始就再 `/ai-plan`（新 epoch，旧任务自动作废）。

**Driver 状态可疑**：`gateflow status` 看本地；`gateflow sync` 可随时安全重跑（Operation 调和保证不重复发布）；`gateflow retry <task-id>` 重置单个任务。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `GITHUB_TOKEN` | run / sync 必需；只存在于进程环境 |
| `GATEFLOW_REPOSITORY` | 仓库解析兜底（owner/name） |

## 常见问题

- **sync 报 `input files no longer match the snapshot`**：AI（或人）改了 task.md / plan.md / feedback.md。删除该任务目录后 `gateflow retry <task-id>` 重新准备；若 AI 已完成工作，把它的产出复制出来再重试。
- **run 提示 no pending task**：Issue 不在正确状态。确认已 `/ai-plan`（规划）或已 `/approve`（执行）；Gate Action 是否成功运行（看 Actions 日志）。
- **sync 报 preflight fail closed**：Issue 上存在可疑记录或身份不符。检查是否有非 Gate 身份发布的协议评论，删除后重试。
- **审批后想改 Plan**：直接让 AI 出新 Plan 需要先 `/change`（REVIEW 状态）；READY 状态下旧审批绑定的是旧字节，任何编辑都会使其失效——安全设计，不是 bug。
