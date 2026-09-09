# Driver 手册（gateflow CLI）

Driver 是运行在本地的确定性 CLI：准备任务、校验 AI 产出、把 Plan / Report 同步到 GitHub。它不调用 LLM，也从不迁移标签——正式状态迁移只属于 Gate。

## 1. 安装与凭证

```bash
npm install && npm run build     # 产出 dist/cli.js（bin: gateflow）
export GITHUB_TOKEN=ghp_…        # 只存在于进程环境，永不落盘
```

仓库解析顺序：`gateflow.config.yml` 的 `repository` → 环境变量 `GATEFLOW_REPOSITORY` → git remote `origin`。

## 2. 配置（gateflow.config.yml，可缺省）

```yaml
version: 1
repository: owner/name        # 可省（见解析顺序）
trusted_humans: []            # 额外可信人类（repo owner 永远可信）
gate_logins:                  # 允许签发 Gate 记录的身份（独立重验用）
  - github-actions[bot]
require_explicit_humans: true # Organization 仓库无 trusted_humans 时拒绝运行（fail closed）
driver:
  workspace_dir: .gateflow
  max_attempts: 3
```

缺失文件 = 全默认值；类型错误直接 ConfigError（fail fast）。`routing` / `agents` / `activation` 等 V1 已删除。

## 3. 命令

```bash
gateflow run    [--issue <n>] [--root <dir>] [--config <file>]
gateflow sync   [--root <dir>] [--config <file>]
gateflow status [--root <dir>] [--config <file>]
gateflow retry  <task-id> [--root <dir>]
```

### run — 准备任务并打印提示词

1. 拉取仓库与开放 Issue，识别恰好带一个 `ai:*` 标签的 Issue；
2. 从 Gate 记录推导任务意图（无有效 epoch / 记录可疑 → 拒绝，fail closed）；
3. 按**单活动任务**规则选择：显式 `--issue` > 当前未完成任务 > 最小 Issue 号；
4. 构建 `.gateflow/tasks/<task-id>/`（task.json 最后写入）+ `current.json` + 私有状态；
5. 打印可直接粘贴给 ChatGPT / ZCode 的提示词（Manual Activation）。

隐式切换被拒绝：当前任务未完成时换 Issue 必须显式 `--issue`。重复 run 已准备的任务只会重打提示词，不会重建不同内容（输入快照保护）。

### sync — 同步结果

对每个任务目录按序执行：

1. `task.json` 校验（未知任务拒绝）；
2. Driver 私有状态存在性校验（从未在此准备过的任务不同步）；
3. `result.json` 严格校验（schema / task_id / mode / 交叉约束 / 人类专属黑名单）；
4. **输入快照校验**（Agent 改过输入 → 拒绝）；
5. **Preflight 授权校验**（重新拉取 Issue + 评论：epoch 一致、无可疑记录、execute 任务需有效 approval 记录绑定当前 Plan 字节）；
6. 接受观察（`published` 且 Gate 已背书 → `accepted`）与重放保护（已发布不再重复发布）；
7. 按模式发布：Plan 评论（T1）/ Tracker + Report 评论（T3/T6）/ blocked 通知 + Tracker Blocked（T4）。所有发布先按 Operation ID 调和（已有同内容 → 采纳；不同内容 → 冲突 fail closed；无 → 发布）。

Infrastructure 错误（网络/认证/限流）向上抛出；单个任务的校验失败只记录并跳过。

### status — 本地状态（离线）

显示当前活动任务、每个任务的同步状态、下一步建议。

### retry — 清除任务状态（离线）

`gateflow retry <task-id>` 删除该任务的私有状态记录，使下一次 `run` 可以重新准备（前提是 GitHub 状态仍然支持该意图）。`failed` 且达到 `max_attempts` 的任务必须显式 retry。

## 4. 单实例锁

`run` / `sync` 全程持有 `.gateflow/driver/locks/driver.lock`（含 pid + holder）。已有**存活**进程持锁时第二实例直接失败；仅当持锁 pid 已死或锁超过 6 小时才判定为陈旧并接管——绝不按时间抢占存活进程。释放时校验 pid + holder，从不删除他人的锁。锁只约束同一台机器。

## 5. 崩溃恢复速查

| 场景 | 行为 |
| --- | --- |
| 任务目录写完、状态记录未写 | 下次 `run` 以相同内容幂等重建 |
| 评论已发布、状态未推进 | 下次 `sync` 按 Operation ID 采纳已发布评论，推进状态 |
| GitHub 超时（写入结果未知） | 下次 `sync` 先调和再决定，绝不盲目重发 |
| Agent 改了输入文件 | sync 拒绝并说明；删除任务目录 + retry 可重新开始 |
| Plan 审批后被编辑 | approval 记录哈希不再匹配 → 执行任务不会准备（旧审批失效） |
| Issue 被 cancel（标签清空）/ 关闭 | 任务标记 `obsolete`，结果永不发布 |
| 出现伪造协议记录 | 该 Issue 整体 fail closed（无意图、不同步），等待人工处理 |
