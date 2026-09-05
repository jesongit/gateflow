# Fixture: solution —— L2 方案已定

> 用途：Consumer Skill 的成熟度判定 / 最小补全测试输入（计划文档第二十六节 Skill Fixture，对应协议第 5 节 L2）。
> 本文件模拟一个 GitHub Issue：下方依次为"Issue 正文"（含文末 schema 块）与一条模拟的 Producer append 评论。
> 场景对应使用手册"场景 C"：方案讨论得差不多，Consumer 只补遗漏、不重新选型。

## Issue 正文（模拟）

标题：插件远程更新：方案已定（启动检查 + HTTP manifest + 确认后安装）

```markdown
## Goal

按已定方案为 gamer 插件实现远程更新。

## Context

方案在对话中已逐项确认（见 Confirmed Requirements / Proposed Direction）。

## Current State

插件只在本地安装时读一次包；`packages/loader` 负责加载，`packages/installer` 负责本地安装。

## Confirmed Requirements

- 启动时请求一次更新检查；用户确认后才下载安装；
- 更新失败（网络 / 校验 / 解压）必须降级为"本次照常启动"，并记录日志。

## Proposed Direction

- 检查：`UpdateChecker` 调 market 的 `/api/plugins/latest?name=<plugin>`，返回 semver 与下载地址；
- 比较：用仓库现有依赖 semver 库比较 `installed < latest`；
- 下载安装：复用 `packages/installer` 的安装管线，下载到临时文件，校验 sha256 后走既有安装流程，成功后使缓存索引失效；
- 失败路径：任何一步失败 → 删除临时文件 → 记 log → 跳过本次更新。

## Execution Plan

大步骤：UpdateChecker 模块 → 接入 loader 启动流程 → installer 复用与缓存失效 → 端到端测试。（细节由 Consumer 补全为可执行任务）

## Acceptance Criteria

- 有新版本时启动出现确认提示，确认后重启加载新版本；
- 断网 / 接口 500 / sha256 不匹配时启动不受影响且留下日志；
- 上述均有自动化测试覆盖。

## Open Questions

（暂无）

<!-- ai-workflow
schema: 1
source: producer
kind: feature
maturity_hint: solution
-->
```

## 评论（模拟：Producer APPEND）

```markdown
## AI Discussion Summary

- 确认：缓存索引用 `cache/index.json`，失效 = 更新成功后删除该文件并在下次加载时重建。

## Proposed Direction

- 无方向变化。

<!-- ai-workflow:append:v1 -->
```

---

## Fixture 元信息（非 Issue 内容）

- Producer hint：`solution`（L2）
- **预期 Effective Maturity：L2 Solution**（模块划分、数据流、失败路径、验收标准都已确定；缺的是与仓库对齐后的可执行任务序列）
- Consumer 预期动作：
  1. "检查 Repo → 补遗漏 → 生成执行计划"：验证 `packages/loader`、`packages/installer`、`cache/index.json`、semver 依赖等引用真实存在且行为如 Issue 所说；
  2. **不重新选型**：不再讨论"要不要用 HTTP""要不要自动更新"；已定方案逐条沿用；
  3. 补的只有执行层遗漏：任务拆分与顺序、每任务完成标志、Validation 的具体测试命令与用例清单；
  4. 发布带 `<!-- ai-workflow:plan:v1 -->` 的 Plan Comment（Gate T1：`ai:planning` → `ai:review`）。
- 检查点：Design 是否与 Issue 方案逐条一致（最多做仓库实况要求的小修正并说明）；Tasks 是否是有意义的工作单元（而非"创建文件 / 加函数"碎片）。
