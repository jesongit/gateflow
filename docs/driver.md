# Driver 运维手册（gateflow CLI）

> Driver 是 V1 新增的**本地确定性程序**（`src/driver/`，构建产物 `dist/cli.js`，bin 名 `gateflow`）。它轮询 GitHub、构建 `.gateflow/inbox/` 派发、唤醒 Agent、校验 outbox 产出并把结果同步回 GitHub。
> 契约以 [docs/architecture-v1.md](architecture-v1.md)（组件边界）与 [docs/workspace-protocol.md](workspace-protocol.md)（协议与 `gateflow.config.yml` §10）为准；本文是运维视角的操作手册。

---

## 1. Driver 是什么 / 不是什么

| Driver 负责 | Driver 明确不做 |
| --- | --- |
| Discovery：从 GitHub Canonical State 推导待办（DispatchIntent） | **不调用 LLM**——Driver 里没有任何 AI，全部行为是确定性程序 |
| Dispatch：构建 `.gateflow/inbox/<dispatch_id>/`（TASK.md / PLAN.md / FEEDBACK.md / dispatch.json / context.json） | **不写任何 `ai:*` 标签**——标签迁移是 Gate（GitHub Action）的职权 |
| Activation：经 Activation Adapter 唤醒 Agent 客户端 | **不自己决定状态迁移**——它只发布协议对象（marker 评论 / Tracker 编辑），PLANNING→REVIEW→READY→WORKING→DONE 全部由 Gate 完成 |
| Validation：按严格 Schema + 角色白名单校验 outbox | **不绕过 Gate**：即使 outbox 校验通过，Driver 也只能"发布"，不能"迁移" |
| Sync：以 Bot 身份发布 Plan / Tracker / Completion 评论 | 不解析 Markdown 语义——PROGRESS.md / REPORT.md 只透传 |
| Dedup / Retry / Crash Recovery / Feedback 回流 | 不持有除 `GITHUB_TOKEN` 之外的任何凭证，也不把凭证写入 `.gateflow/` 与配置文件 |

一句话：**Driver 管"什么时候做"，Gate 管"能不能做"**——Driver 永远不能替 Gate 做决定（见 [docs/security.md](security.md) 的 V1 安全模型）。

---

## 2. 安装与构建

```bash
cd /path/to/gateflow
npm install
npm run build:cli        # esbuild 打包 src/cli.ts → dist/cli.js
```

- 运行方式二选一：`node dist/cli.js driver …`，或将 `gateflow` bin 链接到 PATH（`package.json` 已声明 `"bin": { "gateflow": "dist/cli.js" }`）。
- `npm run build` 会同时构建 Gate 产物 `dist/index.js` 与 Driver 产物 `dist/cli.js`；两个产物都必须提交进仓库，`npm run check:dist`（CI 内置）校验产物与 `src/` 同步。
- 运行环境：Node ≥ 20（CI 基线为 Node 24）。

---

## 3. 配置：`gateflow.config.yml`

位置：目标仓库根目录（即 `--root` 指向的目录）；可用 `--config <file>` 指向其他文件。**以下 YAML 即 [docs/workspace-protocol.md](workspace-protocol.md) §10 的冻结示例**：

```yaml
version: 1
repository: owner/name            # 可省略：回退解析 git remote origin，再回退 GATEFLOW_REPOSITORY
driver:
  poll_interval_seconds: 30       # start 模式轮询间隔
  workspace_dir: .gateflow
  progress_sync_seconds: 60       # Tracker 编辑 debounce
  max_attempts: 3                 # 同一 dispatch 自动重试上限
trusted_humans: []                # 除 repo owner 外的 Trusted Humans（Driver 校验 Approval 用）
routing:
  consumer: chatgpt-main
  executor: zcode-main
agents:
  chatgpt-main: { activation: chatgpt }
  zcode-main:   { activation: zcode }
activation:
  fallback: manual
```

### 3.1 字段参考

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `version` | 必填 `1` | 配置文件版本；不匹配 = 配置校验失败 |
| `repository` | 省略时回退 | `owner/name`；缺省时依次回退：解析 `git remote origin` → 环境变量 `GATEFLOW_REPOSITORY` |
| `driver.poll_interval_seconds` | `30` | `driver start` 模式的轮询间隔 |
| `driver.workspace_dir` | `.gateflow` | Workspace Protocol 目录（必须已在 `.gitignore` 中） |
| `driver.progress_sync_seconds` | `60` | Tracker 评论编辑的 debounce 间隔（见 §7） |
| `driver.max_attempts` | `3` | 同一 dispatch 的自动重试上限 |
| `trusted_humans` | `[]` | 除 repo owner 外的 Trusted Humans；Driver 在 Executor 派发前独立校验 Approval Record 时使用（与 Gate 的 `trusted-humans` 输入保持同一份名单） |
| `routing.consumer` / `routing.executor` | 必填 | role → agent 名。**Role 与 Provider 分离**：任意 role 可路由到任意 agent，例如 `consumer: zcode-main` + `executor: chatgpt-main` 同样合法 |
| `agents.<name>.activation` | 必填 | 该 agent 的唤醒方式：`manual | chatgpt | zcode` |
| `activation.fallback` | `manual` | 某 agent 的 adapter probe 失败时回退到该激活方式 |

`manual` 是一等公民：没有 ChatGPT / ZCode 的自动唤醒能力时，Driver 仍完整工作——它把 inbox 准备好，由人打开客户端让 Agent 开始（见 §8）。

---

## 4. 凭证与身份

### 4.1 `GITHUB_TOKEN`：只在 Driver 进程里

- Driver 是整个 V1 系统中**唯一**需要 GitHub 凭证的本地组件；`GITHUB_TOKEN` 以环境变量提供给 Driver 进程，**永不写入** `.gateflow/`、`gateflow.config.yml` 或日志。
- 权限收敛建议：只需读 Issue / 评论、发布 Issue 评论、（Producer submit 场景）创建 Issue——不要给 Administration 等高权权限。
- **Agent 永远接触不到这个凭证**：Agent（ChatGPT / ZCode）没有 GitHub MCP、没有 PAT，只读写本地 `.gateflow/` 文件（见 [docs/agent-skills.md](agent-skills.md)）。

### 4.2 Driver 的 GitHub Identity = Trusted Agent（V1 语义）

- Driver 以一个专用 Bot 身份（如 `gateflow-agent[bot]`，由 `GITHUB_TOKEN` 对应的账号决定）发布 Plan / Tracker / Completion 评论。
- 该身份**必须登记**在目标仓库 Gate workflow 的 `trusted-agents` 输入里：Gate 只认可发布者 ∈ Trusted Human ∪ Trusted Agent 的 marker 评论（T1 / T3 / T6），未登记的 Bot 发的 marker 是普通文本、不触发迁移。
- V1 对 Trusted Agent 的重定义：**"受控 GateFlow Driver 的 GitHub Identity"**，而不是"AI 直接操作 GitHub 的身份"。凭证在 Driver（本地进程）里，AI 本身不持有它。
- Trusted Agent 与 Trusted Human 仍是两个概念且永不合并：Bot 身份发布 marker 合法，但它在 Issue 上发的任何命令（`/approve` 等）永远无效。

---

## 5. CLI 参考

```text
gateflow driver start|once|status|retry <dispatchId>

全局 flags：
  --root <dir>      工作目录（目标仓库检出目录），缺省 = 当前目录
  --config <file>   配置文件路径，缺省 = <root>/gateflow.config.yml
```

### 5.1 `driver start`：常驻轮询（标准运行方式）

```bash
gateflow driver start
```

每 `poll_interval_seconds`（默认 30s）执行一轮"Discovery → Dispatch → Sync"。示例输出：

```text
[driver] gateflow driver started (repository=owner/target, root=/path/to/target)
[driver] poll #1: no pending intents
[driver] poll #2: dispatch gf_r123_i42_consumer_01 (role=consumer, reason=planning)
[driver] inbox built: .gateflow/inbox/gf_r123_i42_consumer_01/
[driver] activation: manual (chatgpt probe unavailable, fallback=manual) — notify sent
[driver] poll #5: outbox result accepted: gf_r123_i42_consumer_01 (plan_ready)
[driver] synced: plan comment published (identity=gateflow-agent[bot])
```

### 5.2 `driver once`：单轮执行（CI / 调试 / 确定性运行）

```bash
gateflow driver once
```

只执行一轮 Discovery → Dispatch → Sync 后退出（不使用 watcher，直接扫描 outbox）。适合：CI 中的确定性调度、crontab 定时运行、以及手动分步调试。

### 5.3 `driver status`：查看本地状态（离线可用）

```bash
gateflow driver status
```

**只读本地**（receipts + `.gateflow/` 现状），不访问 GitHub、不需要 `GITHUB_TOKEN`。示例输出：

```text
dispatch_id                      role      status     attempts  last_sync_at
gf_r123_i42_consumer_01          consumer  synced     1         2026-09-06T17:31:00Z
gf_r123_i42_consumer_02          consumer  dispatched 1         —
gf_r123_i42_executor_p3472198451 executor  failed     3         2026-09-06T18:02:00Z  (error: sync rejected: result not in role whitelist)
```

### 5.4 `driver retry <dispatchId>`：清除本地回执后重派

```bash
gateflow driver retry gf_r123_i42_executor_p3472198451
```

清除该 dispatch 的本地 receipt（缓存），使**下一个周期重新派发**。用途：sync 失败修复后重试、本地 workspace 误删后重建、或你想让同一 dispatch 完整重跑一遍。相同 `dispatch_id` 不重复派发的去重规则（§6）对显式 `retry` 让位。

---

## 6. Discovery：按状态推导派发

每轮 Discovery 从 GitHub 重读 Issue 的 Canonical State（标签 + 评论），推导 DispatchIntent：

| Issue 状态 | Driver 动作 |
| --- | --- |
| `ai:planning`（PLANNING） | 派发 **Consumer**（`reason=planning`，inbox = TASK.md，`revision` 从 `01` 起） |
| `ai:review` + 有未投影的人类反馈（`/change` / `/choose`） | 写 `FEEDBACK.md`，派发**新一轮 Consumer**（`reason=feedback_applied`，轮次 = 1 + 反馈命令总数，dispatch_id 随之变化） |
| `ai:ready` + 有效批准 | 派发 **Executor**（inbox = TASK.md + PLAN.md + FEEDBACK.md?；`revision=p<plan_comment_id>`）。派发前 Driver **再次独立校验 Approval Record**：`ai:ready` + 有效 `/approve <id>` 评论（作者 ∈ Trusted Humans）+ id 指向 Current Plan + Plan 未在批准后被编辑——**手改的假 `ai:ready` 标签无法通过校验** |
| `ai:working` / `ai:blocked` / `ai:done` | **sync-only**：不派发，只继续同步 outbox 的 PROGRESS / 状态 / 报告 |

要点：

- `dispatch_id` 规则冻结：`gf_r<repository_id>_i<issue_number>_<role>_<revision>`（完整规则见 [docs/workspace-protocol.md](workspace-protocol.md) §3）。反馈后的重新规划必然产生新 dispatch_id，因此不会与旧轮次混淆。
- Activation 失败不影响状态：Issue 保持 `ai:ready`，Agent 没写 `status=working` 之前不产生 Tracker、不触发 T3。

---

## 7. 同步与去重

### 7.1 Outbox 校验（同步的前置条件）

Driver 处理 outbox 前必须全部通过（否则记录并跳过该文件，不 crash）：

1. JSON 可解析且 `schema === 1`；`dispatch_id` / `role` 与 dispatch.json、目录名一致；
2. `result` / `state` 在该 role 的白名单内（consumer：`plan_ready / question / failed`；executor：`completed / blocked / question / failed`）；
3. **Human-only 词黑名单**：`approve / ready / cancel / human-close`（含大小写变体）出现在 Agent 输出里一律判非法、拒绝同步（对 GitHub no-op + 记日志）；
4. 引用的内容文件存在且非空（PLAN.md / REPORT.md）；单文件 ≤ 512 KB。

### 7.2 进度同步 debounce

Executor 运行中会反复覆盖写 `status.json` / `PROGRESS.md`，但 Driver 对 GitHub 上同一条 Tracker 评论的编辑**最多每 `progress_sync_seconds`（默认 60s）一次**——避免频繁编辑评论制造通知噪音；DRIVER 不解析 PROGRESS 语义，只透传正文。

### 7.3 Dedup

相同 `dispatch_id` 不重复派发（receipts 去重），除非：显式 `gateflow driver retry <dispatch_id>`，或 `attempts < max_attempts` 的自动重试。

### 7.4 Crash Recovery：receipts 只是缓存

`.gateflow/receipts/<dispatch_id>.json` 记录派发与同步状态（`dispatched | syncing | synced | failed`、`attempts`、`tracker_comment_id` 等），但它是**本地缓存，不是正式状态**：

- receipts 丢失 / 损坏可随时删除——Driver 通过扫描 GitHub 评论（tracker marker + dispatch_id 字符串）与 outbox 现状**重建**；
- `result.json` 一旦被接受并同步（`status=synced`），同 dispatch 的后续覆盖写不再被接受（幂等、防重放）；
- 正式状态永远在 GitHub 侧，本地的一切都可由 GitHub Canonical State 重建。

---

## 8. Manual Activation：手动唤醒的完整闭环

`manual` adapter 是一等公民，不是临时凑合。闭环：

```text
Driver 准备 Dispatch（inbox 就绪，dispatch.json 最后写 = 就绪标记）
→ OS / CLI 通知（日志 + 终端提示）
→ Human 在 ChatGPT / ZCode 打开项目
→ Agent Skill 读取 .gateflow/current.json（拿到当前 dispatch_id）
→ Agent 读 inbox、开始工作，把产出写 outbox
→ Driver 监听 / 扫描 outbox，校验后同步回 GitHub
```

只要这个模式能完整闭环，Workspace 架构就成立——自动唤醒（`chatgpt` / `zcode` adapter，probe 失败回退 `activation.fallback`）只是把"人打开客户端"这一步自动化，通信方式不变。

---

## 9. FAQ

**Q1：GitHub API 限流怎么办？**
`poll_interval_seconds` 调大（30 → 60/120）；Driver 对无变化的轮询是廉价读操作，也可结合 GitHub 的条件请求（ETag / `updated_since` 类增量手段）降低请求量。`status` 命令完全离线，排查时优先用它，不消耗 API 配额。

**Q2：多个仓库怎么跑？**
一个检出一个 Driver：每个目标仓库的检出目录有自己的 `.gateflow/`、自己的 `gateflow.config.yml`、自己的 receipts。在该检出目录内运行 `gateflow driver start`（或用 `--root <dir>` 指定），互不干扰；不要让两个 Driver 指向同一个检出目录。

**Q3：Windows 上能跑吗？**
能。原子写（临时文件 → rename）与路径解析在 Windows（NTFS）下已按 Workspace Protocol §6 的兼容约定处理；`.gateflow/` 必须加入目标仓库的 `.gitignore`。路径含空格 / 中文时用引号包住 `--root` 的值即可。

**Q4：Driver 挂了 / 机器重启会怎样？**
不会丢状态：正式状态在 GitHub。重启后 Driver 从 GitHub Canonical State 重建 DispatchIntent；已同步过的 dispatch 靠 receipts（或重建）去重，不会重复发布。

**Q5：Driver 会不会自己推进状态（比如直接打 `ai:working`）？**
不会。Driver 不写任何标签，只发布协议对象（marker 评论 / Tracker 编辑）；状态迁移只由 Gate 在 GitHub Actions 上完成。这是冻结的架构边界（[docs/architecture-v1.md](architecture-v1.md) §6）。

**Q6：`once` 和 `start` 该用哪个？**
日常开发用 `start`（常驻、低延迟）；CI / cron / 调试用 `once`（单轮、确定性、可重复执行）。
