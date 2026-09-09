# 迁移说明：schema 2 → schema 3（V1 精简重构）

这是一次破坏性协议升级。项目尚未正式发布，因此不保留兼容层；本文给出最小迁移路径。

## 1. 变化总览

| 概念 | schema 2 | schema 3 |
| --- | --- | --- |
| Skill | agent / consumer / executor / producer 四个 | `skills/gateflow` 一个（plan / execute 两模式） |
| 工作区 | `.gateflow/inbox/` + `.gateflow/outbox/` + receipts | `.gateflow/tasks/<task-id>/` + `.gateflow/driver/state.json` |
| 任务标识 | `…_consumer_01` / `…_executor_p<id>` | `…_plan_01` / `…_execute_p<id>` |
| 机器文件 | dispatch.json / context.json / status.json / result.json / submit.json | task.json + result.json（其余为 Markdown） |
| Agent 输出 | status.json（过程）+ result.json（终态） | 只有 result.json（schema 3，最小字段） |
| 唤醒 | Driver 轮询自动派发 + Adapter（manual/chatgpt/zcode） | Manual Activation：`gateflow run` 打印提示词 |
| CLI | `gateflow driver start/once/status/retry` | `gateflow run/sync/status/retry` |
| 配置 | routing / agents / activation / poll / progress-sync | repository / trusted_humans / gate_logins / workspace_dir / max_attempts |
| 人类命令 | /ai-plan /approve /change /choose /cancel | /choose 并入 /change |
| Producer | `.gateflow/submit/` 提交协议 | 删除：普通聊天或手动创建 Issue |
| 执行进度 | status.json + PROGRESS.md + Tracker 进度编辑 | 删除：Tracker 只表达 In Progress / Blocked |
| epoch 引导 | Driver 可代签 workflow_epoch 记录 | Gate 是唯一签发者；PLANNING 缺记录时重跑 `/ai-plan` 自愈 |

## 2. 迁移步骤（旧工作区 → 新工作区）

1. **结束在途工作**：旧的 inbox/outbox 内容不再被识别。若有未同步的 PLAN.md / REPORT.md，按新格式手工放入任务目录（见下），或直接重新走一轮流程（通常更简单）；
2. **升级代码**：拉取本仓库，`npm install && npm run build`；
3. **更新 workflow 输入**：`trusted-agents` 继续登记 Driver 的 bot 身份（语义不变）；
4. **精简配置**：`gateflow.config.yml` 只保留 §2 列出的键（未知键仍被忽略，但 routing/agents 已无效果）；
5. **更换 Skill**：删除客户端里的四个旧 Skill，安装 `skills/gateflow`；
6. **归档旧工作区**：`rm -rf .gateflow/inbox .gateflow/outbox .gateflow/submit`（旧 receipts 不迁移；GitHub 才是正式状态）。残留的旧格式任务目录会被新 Driver 拒绝（task-id 语法不含 `consumer|executor`），不会误同步。

### 手工搬运一个未同步的 Plan（可选）

```text
.gateflow/tasks/gf_r<repo>_i<issue>_w<epoch>_plan_01/
├── task.md      # 从旧 TASK.md 复制，并在正文后追加 "## Mode\n\nplan\n"
├── plan.md      # 旧 outbox PLAN.md 原样
└── result.json  # {"schema":3,"task_id":"<同目录名>","mode":"plan","status":"completed","report":"plan.md"}
```

然后 `gateflow sync` 前必须先让 Driver 拥有该任务的状态记录——即先跑一次 `gateflow run`（幂等重建输入）再放回 plan.md 与 result.json，最后 sync。

## 3. GitHub 侧

标签、状态机、marker、Gate 记录格式（schema 2 记录）**全部不变**；进行中的 Issue 无需任何处理。唯一的协议变化是 `/choose` 不再是命令——历史 feedback 记录中的 `choose` 条目将被视为不可解析并使该 Issue fail closed（fail-safe 方向），若遇到请人工删除该旧记录评论或 `/cancel` 重开一轮。

## 4. 不变的承诺

审批绑定 Plan 字节、Gate 唯一状态迁移权、Agent 无凭证、重放保护、输入绑定、路径安全——这些不变量在 schema 3 中全部保留（见 [security.md](security.md) §1）。
