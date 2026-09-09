# 发布手册（Release）—— V1

> 本页回答三个问题：**怎么发布**（§1 步骤清单）、**版本号怎么管**（§2 版本策略）、**消费者怎么接入**（§3 最小清单，详见 [usage.md](usage.md) §2 与 [integration.md](integration.md)）。
> §4 是每次发布前必须逐项打勾的 checklist。
> 实际的 `git tag` / push / GitHub Release 操作在真实发布时执行（本文档就是届时照着做的操作手册）。

## 正式 Release 顺序

正式发布按以下顺序执行；前一步失败时停止，不进入后一步：

```text
npm ci
  → npm run typecheck
  → npm test
  → npm run build
  → npm run check:dist
  → npm run e2e:release
  → 可选：Real ChatGPT / ZCode smoke
  → tag / GitHub Release
```

其中前五个命令是当前 `package.json` 已声明的脚本或 npm 标准命令；`e2e:release` 由 `scripts/e2e-release.mjs` 提供。真实 GitHub E2E 仍须按本节的隔离仓库、凭证和清理规则执行，不能以本地 fake 测试冒充远端通过。当前可报告的 E2E 状态以 [Task 09 报告](plans/v1-current-flow-e2e-report.md) 和 [Task 10 报告](plans/v1-existing-project-e2e-report.md) 为准。

---

## 1. 发布步骤清单（未来实际执行用）

假设发布 `v1.0.0`（V1 首个公开版本）。V1 有**两个消费入口**：

```text
Gate Action：  action.yml → dist/index.js（目标仓库 workflow 的 `uses:` 引用）
Driver CLI：   npm run build → dist/cli.js（`bin: gateflow`；消费者从仓库检出源码使用）
```

按顺序执行：

### Step 1：本地全量验证（全部通过才继续）

```bash
npm ci                 # 按 package-lock.json 安装依赖
npm run typecheck    # tsc --noEmit（strict），必须零错误
npm test             # vitest，必须全绿
npm run build        # esbuild 打包 dist/index.js（Gate）+ dist/cli.js（Driver）
npm run check:dist   # 内存中重建两个产物并与已提交版本逐字节比对，必须通过
git status           # build 之后 dist/ 必须显示"无变化"
```

`git status` 若显示 `dist/` 有改动，说明提交的产物不新鲜：先检查并提交刷新产物，再继续。**GitHub JS Action 运行仓库中提交的 `dist/index.js`，Driver 的 `bin` 指向提交的 `dist/cli.js`，产物同步是发布正确性的硬前提**。CI（Node 24）已内置 `check:dist` 与 `git diff --exit-code dist` 两道保险。

### Step 2：真实 GitHub Release E2E

本步骤在 tag/release 前执行：

```bash
npm run e2e:release
```

当前入口的执行顺序是：预检 `gh` 和 Git 状态 → 本地 `typecheck` / `test` / `build` / `check:dist` → 加载场景 → 创建并校验私有临时仓库 → Bootstrap 并 push 测试文件 → 运行场景 → 清理。具体行为如下：

- 使用本机已登录的 `gh`：预检实际执行 `gh --version`、`gh auth status`、`gh api user --jq .login` 和 `gh auth token`。Token 只在内存中取得，并注入 Bootstrap/Driver 子进程环境；不要求用户另外手工导出 `GITHUB_TOKEN`；
- 预检实际执行 `git rev-parse HEAD` 并校验为完整 commit SHA，同时要求工作树干净；Bootstrap 使用固定的 `jesongit/gateflow@<HEAD SHA>` Action ref，该 SHA 也应与失败现场一并记录；
- 通过 `gh repo create ... --private --add-readme` 创建真实的私有临时仓库，默认名称为带时间和随机后缀的 `gateflow-release-e2e-...`，默认 owner 为 `gh api user` 返回的登录名；随后 clone 到系统临时目录，并校验仓库确实为私有、未归档；
- Bootstrap 以非交互方式配置并 push 测试 checkout，然后验证 README 保持不变、`gateflow.config.yml` 存在、`.gitignore` 包含 `.gateflow/`、workflow 的 `uses:` 精确指向 `jesongit/gateflow@<HEAD SHA>`，以及 6 个 `ai:*` labels（`planning` / `review` / `ready` / `working` / `blocked` / `done`）均存在；
- 使用落盘的 Fake Agent 完成 plan、execute/working、execute/completed 三个确定性阶段：它读取 `task.json` 声明的输入，写入 `plan.md` / `report.md` / `result.json`，并为 workflow 场景提交和 push `hello.txt`；不调用 LLM，不依赖 ChatGPT/ZCode；
- 正常完整 E2E 成功时删除临时远端仓库和 clone；失败时保留已创建的远端仓库和 clone，并打印仓库名称与 clone 路径，保留 GitHub run/Issue 等现场供排查。`--prepare-agent` 成功后是有意保留现场的交接例外，便于继续使用输出的 workspace；

当前 CLI 参数如下（支持 `--repo-name=<name>` / `--owner=<login>` 等等号形式）：

| 参数 | 当前行为 |
| --- | --- |
| `--keep` | 成功后保留临时仓库和 clone；失败本来就保留，不需要此参数。 |
| `--repo-name <name>` | 使用指定仓库名；不传则生成唯一临时名称。名称必须符合脚本的 GitHub-safe 字符规则，且 clone 目录不能已存在。 |
| `--owner <login>` | 指定创建仓库的 owner；不传则使用 `gh api user --jq .login`。 |
| `--skip-security` | 跳过可选的 `scripts/e2e/scenarios/security.mjs` 场景；它是跳过安全 smoke，不是安全 smoke 通过。当前四项均有内置 real-GitHub 路径；若协议或对应 runner 不可用，相关用例会回退为 `fixture-only`/`limited`，生命周期会失败，只有明确接受跳过安全层时才使用此参数。 |
| `--prepare-agent` | 在 Bootstrap 后创建 Issue、发布 `/ai-plan`、等待 `ai:planning` 和 workflow epoch、运行一次 Driver `run`，然后输出 `repository`、`issue`、`task`、`workspace` 并停止；这是 Agent 交接准备，不声称完整 E2E 通过，成功现场会保留。 |
| `--help` / `-h` | 打印当前入口帮助并退出，不创建仓库。 |

默认会加载 `workflow`、`reconnect` 和 `security` 三个场景，其中前两个是必需场景，`security` 模块默认也会运行。安全 smoke 包含四个断言：`wrong-approval`（无效 Plan comment id 不得进入 `ai:ready`）、`old-plan-approval`（旧 Plan 审批必须拒绝）、`old-report`（旧执行任务的 Report 不得完成当前任务）和 `fake-ready`（只有 `ai:ready` 标签而没有有效 Approval 时不得准备 execute task）。当前四项均有内置 real-GitHub 路径；如果协议、GitHub 上下文或注入的 runner 不可用，相关用例会回退为 fixture-only 并标记为 `limited`，不冒充远端通过。生命周期要求 security 最终为 `passed`，所以在 real-GitHub 前置条件满足时默认入口可通过；出现 `limited` 时默认入口会失败，`--skip-security` 才会跳过整个 security 场景。

`--prepare-agent` 不启动 LLM 或自动唤醒 ChatGPT/ZCode；它真实完成 Bootstrap、Issue/`/ai-plan`、planning/epoch 等待和 Driver task 准备，并在输出交接信息后停止。真实客户端 smoke 仍按 Step 2.5 单独执行。

真实 E2E 不会在每次 CI 运行。CI 继续运行确定性单元/集成测试、协议/安全契约检查、构建和 `check:dist`；完整 GitHub E2E 需要本机 `gh` 登录、私有临时仓库和外部写权限，因此只在正式发布前按本手册显式运行，并保留现场信息。

### Step 2.5：可选 Real ChatGPT / ZCode smoke

只有在客户端环境和测试凭证已准备好时，才在 `e2e:release` 成功后执行真实 ChatGPT 或 ZCode smoke。它是独立的客户端能力验证，不是 `e2e:release` 的前置依赖；Fake Agent 的通过结果也不能代替它。当前 V1 仍以 Manual Activation 为主，未验证的自动唤醒能力不得写入 Release notes。

### Step 3：版本对齐

- 确认 `package.json` 的 `version` 与本次 tag 一致（V1 首版为 `1.0.0`），并已同步 `package-lock.json`；
- 若本次包含 Gate 行为变更，确认 [src/index.ts](../src/index.ts) 的 `GATE_VERSION` 已提升（V1 首版为 `1.0.0`），且测试中的 `GATE_VERSION` 断言已同步（见 §2）；
- 确认工作树干净（所有改动已提交）。

### Step 3.5：当前 V1 发布门槛

- [ ] `action.yml` 为 `using: node24`，`package.json` 的构建目标为 `target=node24`，且 `engines` 为 `>=24`；
- [ ] Gate-issued record 以 `src/protocol/records.ts` 的 schema 2 为准，Workspace 机器文件以 `src/workspace/protocol.ts` / `src/workspace/validation.ts` 的 schema 3 为准；仓库不存在 `protocol/*.json` 镜像，不应为发布伪造该目录；
- [ ] CI 的本地 Action smoke 只验证无 Issue payload 时安全 no-op；它不等同于真实 `issue_comment`、GitHub 仓库或客户端 E2E；
- [ ] `published` 与 `accepted` 的分层、Tracker → WORKING → 下一次 sync → Report 顺序，以及 Control/Target 绑定与锁规则与 [protocol.md](protocol.md)、[workspace-protocol.md](workspace-protocol.md) 一致。

### Step 4：打 tag 并推送

```bash
git tag v1.0.0
git push origin v1.0.0
```

### Step 5：创建 GitHub Release

在 GitHub 上基于 `v1.0.0` tag 创建 Release。Release notes 至少包含：

- 本次行为变化摘要（含 `GATE_VERSION` 从 / 到）；
- 协议状态声明：Gate-issued records 为 **schema 2**，Workspace Protocol 为 **schema 3**，`gateflow.config.yml` 为 `version: 1`；当前实现没有 `protocol/*.json` 镜像；
- Action 输入接口现状（`github-token` / `trusted-humans` / `trusted-agents` / `require-explicit-humans`，与 [action.yml](../action.yml) 一致）；`trusted-agents` 只登记允许发布 marker 的独立 Bot/App，不授予命令权限；
- Driver CLI 契约现状：`gateflow run|sync|status|retry <task-id>`，支持 `--root <dir>`、`--config <file>`，`run` 另支持 `--issue`、`--target-repository`、`--target-workspace`。

### Step 6：固定 Action 引用

Bootstrap 当前默认生成 `uses: jesongit/gateflow@v0`，这是脚本中的真实默认值，不代表本轮已完成真实发布。实际发布前应在批准的发布流程中显式传入已存在且可访问的 ref，例如：

```bash
node scripts/bootstrap.mjs \
  --repo owner/target \
  --workdir /path/to/target \
  --action-ref jesongit/gateflow@v1.0.0 \
  --generate-only --yes
```

当前按显式 Action ref 发布；Bootstrap 的默认值仍是脚本中的 `jesongit/gateflow@v0`。

> 下方保留的旧 tag 策略仅作发布历史，不是当前 V1 的接入指引；当前消费者应使用上面的显式 `--action-ref`，并先确认远端 ref 确实存在。

- 发布 tag 或浮动 tag 的创建、移动和可访问性必须在实际发布变更中单独验证，本文不预先宣称任何远端 tag 已存在。
- **`@v0` 的处置**：`v0` **停留在最后一个 V0 release commit 不再移动**——V1 引入了新的组件（Driver）与新的交互边界（Workspace Protocol），属于消费者可感知的架构变更，不应该静默浮动给仍按 V0 文档接入的仓库。仍写 `@v0` 的消费者拿到的是最后的 V0 行为；迁移到 V1 按 [usage.md](usage.md) "从 V0 迁移"与 [integration.md](integration.md) Part 2 执行；
- **消费者写法**：`uses: <owner>/gateflow@v1`（自动获得 v1.x 内的全部修复与新能力）。想锁死版本可以把 ref 写成完整 tag（如 `@v1.0.0`），但常规使用不需要；
- **何时引入 `@v2`**：只有发生协议升级（Gate schema / Workspace schema → 2、marker 后缀变更、命令 / 迁移表 / config 语义破坏性变更）时冻结被打破——届时引入新浮动 tag，`v1` 停留在最后一个冻结版本。

### Step 7：发布后确认

- 在 GitHub 上确认本次实际使用的 Action ref 指向预期 commit，并确认目标仓库可以访问它；
- 在一个目标仓库按实际 `on:` 事件运行 Gate workflow，确认 Action 日志出现 `gateflow <GATE_VERSION>`；本地 CI smoke 只覆盖无 Issue payload 的安全 no-op；
- 在一个目标仓库的 Control Workspace 运行 `gateflow run`，再按当前状态运行 `gateflow sync`；用 `gateflow status` 检查本地状态。不要使用旧的 `driver start/once` 子命令。

> 本仓库 `package.json` 为 `"private": true`：**不发布 npm 包**，npm 只承担开发依赖与脚本；`version` 字段纯粹作为仓库发布版本与 git tag 对应，`bin: gateflow` 指向提交在仓库内的 `dist/cli.js`。

---

## 2. 版本策略：各版本号各管什么

本项目的"版本"概念，职责不同、**互不同步提升**：

| 版本 | 定义位置 | 含义 | 何时提升 |
| --- | --- | --- | --- |
| **仓库版本** | `package.json` `version`（V1 起为 `1.0.0`） | 仓库的发布版本，与 git tag `v<version>` 一一对应；V1 起同时覆盖 Gate Action 与 Driver CLI 两个入口 | 每次对外发布（tag + Release） |
| **Gate 行为版本** | [src/index.ts](../src/index.ts) `GATE_VERSION`（V1 首版 `1.0.0`） | Gate 实现的行为版本，打进 `dist/index.js`，出现在每次 Actions run 的 log 首行 | Gate 的**判定行为**发生变化时（新增命令路径、迁移 / 审批校验逻辑修正等）；纯文档/注释/测试改动不动它 |
| **Gate record schema** | [docs/protocol.md](protocol.md) 与 `src/protocol/records.ts`（`schema: 2`） | Gate-issued workflow epoch / approval / feedback records | 记录字段或 marker 破坏性变化时升级协议 |
| **Workspace Protocol schema** | [docs/workspace-protocol.md](workspace-protocol.md) 与 `src/workspace/protocol.ts`（所有机器 JSON 的 `schema: 3`） | `.gateflow/tasks/<task-id>/`、current、Driver 私有 state 与结果文件 | 机器文件字段或 task-id 语义破坏性变化时升级协议 |
| **Driver 配置版本** | `gateflow.config.yml` 的 `version: 1`（[workspace-protocol.md](workspace-protocol.md) §10） | V1 新增：目标仓库 Driver 配置的格式版本 | 不匹配 = 配置校验失败；破坏性变更必须提升并保留旧版解析说明 |

三者（或多者）的关系：

- `package.json` 版本是**仓库发布版本**：Gate 消费者通过 git tag（`@v1` / `@v1.0.0`）感知它，Driver 消费者通过 Release / 检出感知它；
- `GATE_VERSION` 是**行为版本**：运维者通过 Actions log 感知它；发布时只需在 Release notes 里注明；
- 协议冻结意味着：**v1.x 的 minor / patch 更新永远不会让已存在的 Issue / Comment / `.gateflow/` 文件失效**——这是 `@v1` 浮动 tag 安全的前提。

### 仓库版本的升级规则（semver）

| 级别 | 允许的变化 | 例子 |
| --- | --- | --- |
| **patch**（`1.0.x`） | 不改变任何 Gate / Driver 判定行为的修复：bug fix、log 文案、注释、测试、文档 | 修复某条 log 的措辞；补测试用例 |
| **minor**（`1.x.0`） | 向后兼容的新能力：新增带默认值的 Action input、新增 Driver 可观察性、`GATE_VERSION` 行为版本提升（行为增强但不改协议）、新增可选的 config 字段 | 新增可选 input（缺省行为不变）；`driver status` 输出新增一列 |
| **major**（`2.0.0+`） | 破坏性变更：任一协议 schema 升级、marker 后缀变更、命令 / 标签 / 迁移表 / dispatch_id 规则变化、已有 input 或 config 字段语义变化 | `schema: 2`；`trusted-agents` 语义改变。**V1 冻结期内不发生** |

`action.yml` 本身没有版本号字段：`runs.using: node24` + `main: dist/index.js` 是发布机制（要求 dist 已提交）；`package.json` 的 `bin: gateflow → dist/cli.js` 是 Driver 的发布机制（同样要求产物已提交）。对 inputs 或 config 字段的任何变更都按上表定级（新增带默认值 = minor；改既有语义 = major）。

---

## 3. 消费者接入的最小清单

完整六步流程见 [usage.md §2](usage.md#2-安装v1-六步摘要)，逐步操作见 [integration.md](integration.md)，此处只列清单：

1. **Bootstrap 初始化**：在目标仓库检出目录运行 `node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target --action-ref <owner>/gateflow@ref --dry-run`（幂等；缺失标签可在显式 `--github-config` 下创建，已有同名标签跳过；已有 Workflow 有差异时告警且不覆盖）；
2. **检查并提交 workflow 文件**：确认生成的 `.github/workflows/ai-workflow.yml`（事件矩阵 / 串行并发组 / Action 输入，`trusted-agents` 填 Driver Bot 身份），提交并推送；
3. **构建本地 Driver**：`npm ci && npm run build` → `dist/cli.js`；
4. **配置**：`GITHUB_TOKEN` 环境变量（只给 Driver 进程）+ 目标仓库根目录 `gateflow.config.yml`；
5. **安装唯一 Skill**：将 `skills/gateflow` 装入 AI 客户端，按 `plan` / `execute` 两种模式使用；
6. **手动运行**：按 [integration.md](integration.md) 使用 `gateflow run`、`gateflow sync`、`gateflow status` 和 `gateflow retry <task-id>` 验收闭环。

`uses:` 的可引用性仍遵循三种模式：public 发布 / 私有仓库 + Access 共享策略 / 内嵌进目标仓库（`--action-ref ./.github/actions/gateflow`）。私有检出 / fork 默认无法被其他仓库引用，模式选择与操作见 [integration.md](integration.md) 第 2 章。

---

## 4. 发布前 checklist（复述全量验证项）

每次打 tag 前，以下各项必须逐项确认通过：

| # | 验证项 | 命令 | 通过标准 |
| --- | --- | --- | --- |
| 1 | 依赖安装 | `npm ci` | 按 `package-lock.json` 成功安装 |
| 2 | 类型检查 | `npm run typecheck` | `tsc --noEmit` 零错误 |
| 3 | 单元测试 | `npm test` | vitest 全绿（以当前基线为准） |
| 4 | 产物构建与同步 | `npm run build` → `npm run check:dist` → `git status` | `dist/index.js`（Gate）与 `dist/cli.js`（Driver）**均无变化**（`check:dist` 逐字节比对通过；有变化则先提交刷新） |
| 5 | 真实 GitHub E2E | `npm run e2e:release` | Bootstrap 校验、workflow、reconnect 及安全 smoke 按当前参数/资源条件通过；记录当前 HEAD SHA、临时私有仓库和清理结果 |
| 6 | 非 Actions 环境安全退出 | `node dist/index.js` | 打印 `gateflow <GATE_VERSION>: not running inside GitHub Actions, exiting.` 后以退出码 0 结束，不抛异常 |
| 7 | 安装入口可用 | `node scripts/bootstrap.mjs --help` | 正常打印用法（中文帮助文本完整、退出码 0） |
| 8 | YAML 可解析 | `python -c "import yaml; yaml.safe_load(open('templates/workflow.yml', encoding='utf-8')); yaml.safe_load(open('action.yml', encoding='utf-8'))"` | 两个 YAML（workflow 模板与 Action 清单）均严格解析通过 |

另加版本对齐两查：`package.json` `version` == 待打 tag（V1 为 `1.0.0`）；`GATE_VERSION` 与测试断言一致（V1 首版 `1.0.0`）。

## 5. 已知限制与发布阻塞

- Task 10 的真实已有项目 E2E 因缺少明确隔离仓库、Control Repository 和入口 Issue，状态为 **blocked**；不得把本地 fake E2E 当成真实 GitHub 接入通过。
- 真实新建项目的 GitHub 写入闭环尚未完成验证；本地 `gh auth status` 只能证明登录状态，不能证明 Bootstrap、Actions 排队、Issue 回写或目标仓库接入成功。
- ChatGPT/ZCode 客户端驱动的真实任务尚未验证；发布说明不得声称两种客户端已通过验收。
- 以上验证需要用户提供隔离资源、明确批准的 GitHub 写权限和可用客户端环境；在此之前只能发布本地工程验证结果。

### e2e:release 故障现场排查

失败时不要先删除临时仓库或覆盖工作目录。按失败输出中给出的信息保留并记录：当前 HEAD SHA、临时仓库完整名称、失败阶段、Control Issue 编号、评论/Operation ID、Actions run ID、clone/workspace 路径（若有）以及清理是否已执行。入口的失败摘要会打印仓库、local workspace、Issue、失败阶段、最近 workflow 状态、最近 Actions 查询命令和原因；进程包装器还会在命令失败或超时时保留命令、cwd、stdout/stderr 等诊断信息。若某个 ID 未出现在输出中，应以已有的精确 ID 和阶段信息为准，不要猜测资源名称。

可按以下顺序做只读检查：

```bash
git rev-parse HEAD
gh auth status
gh repo view OWNER/TEMP-REPO
gh issue list --repo OWNER/TEMP-REPO --state all
gh run list --repo OWNER/TEMP-REPO
gh run view RUN_ID --repo OWNER/TEMP-REPO --log
```

再对照失败阶段检查对应的 Issue、评论、标签、workflow run 和本地 workspace 文件；优先使用失败输出中的精确 ID，不要用“最新评论”或“最新 run”代替对象绑定。若是 API 超时或结果未知，先查看远端对象和 run 状态再重试，避免重复创建。失败现场默认保留；正常完整 E2E 成功时删除现场，成功使用 `--keep` 或 `--prepare-agent` 时保留。`--skip-security` 会直接跳过四项安全 smoke，不能用于把安全检查跳过后的结果写成发布通过；未执行的真实 E2E 必须明确记录为未执行/阻塞及原因。
