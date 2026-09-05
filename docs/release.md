# 发布手册（Release）—— Package / Release 就绪（Phase 9）

> 本页回答三个问题：**怎么发布**（§1 步骤清单）、**版本号怎么管**（§2 版本策略）、**消费者怎么接入**（§3 最小清单，详见 [usage.md](usage.md) §2）。
> §4 是每次发布前必须逐项打勾的 checklist（即全量最终验证项的复述）。
> 本仓库目前处于**随时可发布的就绪状态**：实际的 `git tag` / push / GitHub Release 操作在真实发布时执行（本文档就是届时照着做的操作手册）。

---

## 1. 发布步骤清单（未来实际执行用）

假设发布 `v0.1.0`（首个公开版本）。Action 的最终引用为：

```text
jesongit/gateflow@v0
```

按顺序执行：

### Step 1：本地全量验证（全部通过才继续）

```bash
npm run typecheck   # tsc --noEmit（strict），必须零错误
npm test            # vitest，必须全绿
npm run build       # esbuild 打包 dist/index.js
git status          # build 之后 dist/index.js 必须显示"无变化"
```

`git status` 若显示 `dist/index.js` 有改动，说明上次提交的产物不新鲜（src 在上次 build 后又变过）：先 `git add dist/index.js && git commit` 刷新产物，再继续。**GitHub JS Action 运行的是仓库里提交的 `dist/index.js`，不是 src**——这条是发布正确性的硬前提。

### Step 2：版本对齐

- 确认 `package.json` 的 `version` 与本次 tag 一致（如 `0.1.0`），并已同步 `package-lock.json`；
- 若本次包含 Gate 行为变更，确认 [src/index.ts](../src/index.ts) 的 `GATE_VERSION` 已提升，且 [tests/protocol.test.ts](../tests/protocol.test.ts) 中的 `GATE_VERSION` 断言已同步（见 §2）；
- 确认工作树干净（所有改动已提交）。

### Step 3：打 tag 并推送

```bash
git tag v0.1.0
git push origin v0.1.0
```

### Step 4：创建 GitHub Release

在 GitHub 上基于 `v0.1.0` tag 创建 Release。Release notes 至少包含：

- 本次 Gate 行为变化摘要（含 `GATE_VERSION` 从 / 到）；
- 协议状态声明（当前为 `schema: 1` 冻结，未发生协议升级）；
- Action 输入接口现状（`github-token` / `trusted-humans` / `trusted-agents`，与 [action.yml](../action.yml) 一致）。

### Step 5：维护浮动 tag `v0`（关键）

消费者统一写 `uses: jesongit/gateflow@v0`。`v0` 是一个**浮动 tag**：始终指向最新的 `v0.x` release commit，每次发布后手动移动：

```bash
git tag -f v0 v0.1.0        # 指向本次 release commit
git push -f origin v0       # 强制更新远端 v0
```

策略说明：

- **v0.x 期间**：每个 patch / minor 发布后都把 `v0` 重新指到新 release commit。由于协议 `schema: 1` 冻结（§2），minor / patch 更新对消费者是兼容的，浮动跟随是安全的；
- **消费者写法**：`uses: jesongit/gateflow@v0`（自动获得 v0.x 内的全部修复与新能力）。想锁死版本可以把 ref 写成完整 tag（如 `@v0.1.0`），但常规使用不需要；
- **何时停止移动 `v0`**：只有发生协议升级（schema → 2、marker `:v1` → `:v2`，或 Action 输入语义破坏性变更）时，冻结被打破——届时引入新浮动 tag `v1`（消费者显式迁移），`v0` 停留在最后一个 `schema: 1` 版本不再移动。V0 冻结期内这一步不会发生。

### Step 6：发布后确认

- 在 GitHub 上确认 `v0` tag 指向了新 release commit（仓库的 tags 页）；
- 在一个目标仓库跑一次 Gate workflow（或重新执行一次历史 run），确认 `uses: jesongit/gateflow@v0` 解析到新版本、Action 正常启动（log 首行含 `gateflow <GATE_VERSION>`）。

> 本仓库 `package.json` 为 `"private": true`：**不发布 npm 包**，npm 只承担开发依赖与脚本；`version` 字段纯粹作为仓库发布版本与 git tag 对应。

---

## 2. 版本策略：三个版本号各管什么

本项目有三个"版本"概念，职责不同、**互不同步提升**：

| 版本 | 定义位置 | 含义 | 何时提升 |
| --- | --- | --- | --- |
| **仓库版本** | `package.json` `version`（如 `0.1.0`） | 仓库/Action 的发布版本，与 git tag `v<version>` 一一对应 | 每次对外发布（tag + Release） |
| **Gate 行为版本** | [src/index.ts](../src/index.ts) `GATE_VERSION`（当前 `0.3.0`） | Gate 实现的行为版本，打进 `dist/index.js`，出现在每次 Actions run 的 log 首行 | Gate 的**判定行为**发生变化时（新增命令路径、迁移逻辑修正、反馈行为调整等）；纯文档/注释/测试改动不动它 |
| **协议 schema** | [docs/protocol.md](protocol.md)（`schema: 1`、marker `:v1` 后缀）与 [src/protocol.ts](../src/protocol.ts) | 冻结的 wire 格式：Issue body schema 块与 comment marker 的版本后缀 | **V0 内永不提升**。任何协议本体变更（标签 / 状态机 / 命令 / marker 语法 / 权限规则）都是协议升级，必须同步 protocol.md + protocol.ts + 提升 schema 版本 |

三者的关系：

- `package.json` 版本是**仓库发布版本**：消费者通过 git tag（`@v0` / `@v0.1.0`）感知它；
- `GATE_VERSION` 是**行为版本**：运维者通过 Actions log 感知它。它领先于仓库版本是正常的（Phase 2 → `0.2.0`、Phase 6 → `0.3.0`，而仓库直到首次发布才升 `0.1.0`）；发布时只需在 Release notes 里注明"GATE_VERSION x.y.z"；
- 协议 `schema: 1` 冻结意味着：**v0.x 的 minor / patch 更新永远不会让已存在的 Issue / Comment 失效**——这是 `@v0` 浮动 tag 安全的前提。

### 仓库版本的升级规则（semver）

| 级别 | 允许的变化 | 例子 |
| --- | --- | --- |
| **patch**（`0.1.x`） | 不改变任何 Gate 判定行为的修复：bug fix、log 文案、注释、测试、文档 | 修复某条 log 的措辞；补测试用例 |
| **minor**（`0.x.0`） | 向后兼容的新能力：新增**带默认值**的 Action input、新增 log 可观察性、`GATE_VERSION` 行为版本提升（行为增强但不改协议） | 新增可选 input `foo`（缺省行为不变）；Gate 对某类事件新增更细的 log |
| **major**（`1.0.0+`） | 破坏性变更：协议 schema 升级、marker 后缀变更、命令 / 标签 / 迁移表变化、已有 input 语义变化 | `schema: 2`；`trusted-humans` 语义改变。**V0 冻结期内不发生** |

`action.yml` 本身没有版本号字段：`runs.using: node20` + `main: dist/index.js` 是发布机制（要求 dist 已提交），`inputs` 段是 Action 的公共接口——对 inputs 的任何变更都按上表定级（新增带默认值 input = minor；改既有 input 语义 = major）。

---

## 3. 消费者接入的最小清单

完整四步流程（含每步的命令与参数表）见 [usage.md §2](usage.md#2-安装接入新项目的四步流程)，此处只列清单：

1. **bootstrap 一键初始化**：在目标仓库检出目录运行 `node /path/to/gateflow/scripts/bootstrap.mjs --repo owner/target`（幂等；创建 6 个 `ai:*` 标签 + 生成 `.github/workflows/ai-workflow.yml`，已有同名标签 / workflow 一律跳过绝不覆盖；`--dry-run` 可预览）；
2. **检查并提交 workflow 文件**：确认生成的 `.github/workflows/ai-workflow.yml`（事件矩阵 / 串行并发组 / Action 输入），提交并推送；
3. **配置 GitHub MCP**：最小 toolsets `repos` / `issues` / `pull_requests`；
4. **安装三个 Skills**：`skills/producer`、`skills/consumer`、`skills/executor` 装入你的 AI Client。

发布前（Action 还没公开发布时），目标仓库可用 `--action-ref owner/gateflow@<ref>` 把 `uses:` 指向私有检出 / fork。

---

## 4. 发布前 checklist（复述全量验证项）

每次打 tag 前，以下 6 项必须逐项确认通过（与 Phase 9 全量最终验证一致）：

| # | 验证项 | 命令 | 通过标准 |
| --- | --- | --- | --- |
| 1 | 类型检查 | `npm run typecheck` | `tsc --noEmit` 零错误 |
| 2 | 单元测试 | `npm test` | vitest 全绿（当前基线：8 个文件 156 个用例） |
| 3 | 产物同步 | `npm run build` 后 `git status` | `dist/index.js` **无变化**（已提交产物与 src 同步；有变化则先提交刷新） |
| 4 | 非 Actions 环境安全退出 | `node dist/index.js` | 打印 `gateflow <GATE_VERSION>: not running inside GitHub Actions, exiting.` 后以退出码 0 结束，不抛异常 |
| 5 | 安装入口可用 | `node scripts/bootstrap.mjs --help` | 正常打印用法（中文帮助文本完整、退出码 0） |
| 6 | YAML 可解析 | `python -c "import yaml; yaml.safe_load(open('templates/workflow.yml', encoding='utf-8')); yaml.safe_load(open('action.yml', encoding='utf-8'))"` | 两个 YAML（workflow 模板与 Action 清单）均严格解析通过 |

另加版本对齐两查：`package.json` `version` == 待打 tag；`GATE_VERSION` 与 [tests/protocol.test.ts](../tests/protocol.test.ts) 断言一致（当前 `0.3.0`）。
