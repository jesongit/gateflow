# Fixture: full-plan —— L3 完整执行计划

> 用途：Consumer Skill 的成熟度判定 / 最小补全测试输入（计划文档第二十六节 Skill Fixture，对应协议第 5 节 L3）。
> 本文件模拟一个 GitHub Issue：下方依次为"Issue 正文"（含文末 schema 块）与一条模拟的 Producer append 评论。
> 场景对应使用手册"场景 D"：Producer 已提交完整开发计划，Consumer 只做 Readiness Check。

## Issue 正文（模拟）

标题：插件远程更新：完整开发计划（可直接执行）

```markdown
## Goal

按以下计划为 gamer 插件交付远程更新能力。

## Context

方案与执行层已在对话中完整敲定，本 Issue 由 Producer CREATE 承载，等待规划校验后执行。

## Current State

- `packages/loader/src/startup.ts` 在启动时同步加载已安装插件；
- `packages/installer/src/install.ts` 提供 `installFromBuffer(buf)`；
- `packages/cache/src/index.ts` 读写 `cache/index.json`；
- tests 使用 vitest，现有用例位于各包 `__tests__/`。

## Confirmed Requirements

- 启动时检查一次更新；用户确认后才下载安装；
- 任何失败降级为正常启动并记录日志。

## Proposed Direction

（同 Execution Plan，略）

## Execution Plan

1. 新增 `packages/updater`：`checkUpdate(name, installed)` 请求 `/api/plugins/latest`，semver 比较，返回 `{ available, url, sha256 } | null`；失败抛 `UpdateCheckError` 由调用方吞掉。
2. `packages/updater`：`downloadAndInstall(url, sha256)` 下载到临时文件、校验 sha256、调 `installFromBuffer`、成功后删除 `cache/index.json`；每步失败清理临时文件并记 log。
3. `packages/loader/src/startup.ts`：启动流程插入"检查 → 提示确认 → 调 downloadAndInstall"分支；`UpdateCheckError` 与用户拒绝都走"照常启动"。
4. 测试：`packages/updater/__tests__/updater.test.ts` 覆盖检查成功 / 无更新 / 接口 500 / sha256 不匹配 / 安装成功清缓存；`packages/loader/__tests__/startup.test.ts` 覆盖确认安装与失败降级两条路径。
5. 文档：README"插件更新"小节说明行为与失败语义。

依赖：`semver`（仓库现有依赖）；market `/api/plugins/latest`（已上线）。

## Acceptance Criteria

- 全部新增测试通过（`npm test -w packages/updater packages/loader`）；
- 手工冒烟：断网启动正常；有新版本时确认后重启加载新版本。

## Open Questions

（暂无）

<!-- ai-workflow
schema: 1
source: producer
kind: feature
maturity_hint: execution_plan
-->
```

## 评论（模拟：Producer APPEND）

```markdown
## AI Discussion Summary

- 勘误：计划第 2 步中"删除 cache/index.json"应发生在 installFromBuffer 成功之后（原表述顺序有歧义）。

## Proposed Direction

- 无方向变化。

<!-- ai-workflow:append:v1 -->
```

---

## Fixture 元信息（非 Issue 内容）

- Producer hint：`execution_plan`（L3）
- **预期 Effective Maturity：L3 Execution Plan**（前提：Readiness Check 发现计划引用的 `packages/loader/src/startup.ts`、`packages/installer/src/install.ts`、`cache/index.json`、vitest 布局在真实仓库中全部存在且签名相符）
- Consumer 预期动作：
  1. "Readiness Check → 必要的小修正 → 直接整理为待审批执行计划"：逐条核对计划引用的模块 / 接口 / 测试布局是否在真实仓库中成立；
  2. **禁止重新设计**：不重排架构、不重新选型、不把 L3 降格为"重新规划一轮"；小修正只限于与仓库实况冲突的细节（如路径、函数签名、命令名），并在 Plan 的 Design 中注明修正点；
  3. 消费 append 勘误（缓存删除时序）后整理为最终 Plan；
  4. 发布带 `<!-- ai-workflow:plan:v1 -->` 的 Plan Comment（Gate T1：`ai:planning` → `ai:review`），随后停止等待 `/approve`。
- 降级分支（本 fixture 的反向检查点）：若 Readiness Check 发现计划引用的模块已不存在 / 计划基于错误假设 → Effective 降为 **L2**，只补需要重新设计的部分，并在 Plan 中写明降级原因；不允许凭 hint 直接放行。
- 检查点：最终 Plan 的 Design 是否与原计划实质一致；Tasks 是否只是原计划的对齐与勘误而非重构。
