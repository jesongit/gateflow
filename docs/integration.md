# 接入指南（把 GateFlow 装进你的项目仓库）

目标：在一个新仓库完成 `安装 → 配置 → 创建 Issue → 规划 → 审批 → 执行 → 报告` 的闭环。只需 README + 本文即可完成，不需要理解历史版本。

## Part 1 · 接入 Gate（GitHub Action）

### 1.1 前提：让目标仓库能引用 GateFlow

目标仓库的 workflow 通过 `uses:` 引用 GateFlow 仓库，三选一：

1. **public 仓库**（最简单）：直接 `uses: <you>/gateflow@main`；
2. **私有仓库 + Access 策略**：在 GateFlow 仓库 Settings → Actions → Access 里允许目标仓库；
3. **内嵌**：把 gateflow 检出为目标仓库的子目录，用本地路径引用。

### 1.2 bootstrap（幂等，不会覆盖已有文件）

在**目标仓库的本地检出目录**里运行：

```bash
node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target --token "$GITHUB_TOKEN"
```

它会：创建 6 个 `ai:*` 标签（planning / review / ready / working / blocked / done）+ 生成 `.github/workflows/ai-workflow.yml`。检查生成的 workflow 后手动 commit + push。

### 1.3 配置身份

在 workflow 中（bootstrap 已生成默认值，按需修改）：

```yaml
uses: <you>/gateflow@main
with:
  github-token: ${{ secrets.GITHUB_TOKEN }}
  trusted-humans: ''            # 额外可信人类（逗号分隔）；repo owner 永远可信
  trusted-agents: 'gateflow-agent[bot]'   # Driver 的 bot 身份（发布协议评论用）
  require-explicit-humans: 'true'         # Organization 仓库必须显式配置 trusted-humans
```

> Driver 需要以某个 GitHub 身份发评论。个人项目最简单的方式：用 PAT 创建 `gateflow-agent[bot]` 风格的账户或 fine-grained token，并在 `trusted-agents` 里登记该登录名。该身份**只有 Driver 使用**，AI 永远接触不到。

## Part 2 · 安装本地 Driver

```bash
git clone <you>/gateflow && cd gateflow
npm install && npm run build        # dist/cli.js（bin: gateflow）
export GITHUB_TOKEN=…               # Driver 专用 token（repo 权限）
```

在**目标仓库的本地工作检出**里创建可选的 `gateflow.config.yml`（缺失即全默认）：

```yaml
version: 1
repository: owner/target     # 可省：默认从 git remote origin 解析
trusted_humans: []           # Organization 仓库必须配置
```

安装 AI Skill：把 `skills/gateflow/` 装入你的 AI 客户端（ChatGPT / ZCode 等）。只有一个 Skill，`plan` 与 `execute` 是它的两种模式。

## Part 3 · 冒烟闭环（10 分钟验证）

1. 在目标仓库创建一个测试 Issue（写一个真实的小需求）；
2. 评论 `/ai-plan` → 等 Gate Action 跑完 → Issue 应带 `ai:planning`，且出现一条 Gate 记录评论（`gateflow:workflow:v2`）；
3. `gateflow run` → 应输出任务目录与提示词；
4. 把提示词粘给 AI → AI 读写 `.gateflow/tasks/<task-id>/`，产出 plan.md + result.json；
5. `gateflow sync` → Issue 出现 Plan 评论，标签变 `ai:review`；
6. `gateflow sync`（再跑一次）→ 应无重复发布（幂等验证）；
7. 评论 `/approve <plan-comment-id>` → Gate 固化 approval 记录，标签变 `ai:ready`；
8. `gateflow run` → execute 任务 + 新提示词 → AI 执行并写 report.md + result.json；
9. `gateflow sync` → Tracker 与 Report 评论出现，标签 `ai:working` → `ai:done`；
10. 检查结果，关闭 Issue。完成。

## Part 4 · CI 提示

- Gate workflow 由 `issue_comment`（created/edited）与 `issues` 事件触发（bootstrap 已配置）；
- 无需为 Driver 配置任何 CI——它只在你本地按需运行；
- GateFlow 自身仓库的 CI（typecheck + test + check:dist）可作为接入后的健康参照。

遇到问题：先看 Gate 的 Actions 日志，再 `gateflow status` 看本地状态；恢复语义速查见 [driver.md](driver.md) §5。
