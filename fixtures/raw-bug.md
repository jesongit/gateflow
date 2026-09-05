# Fixture: raw-bug —— L0 Bug 报告

> 用途：Consumer Skill 的成熟度判定 / 最小补全测试输入（计划文档第二十六节 Skill Fixture，对应协议第 5 节 L0）。
> 本文件模拟一个 GitHub Issue：下方"Issue 正文"即 body（含文末 schema 块）；本例无评论。
> 场景对应使用手册"场景 E"变体：Bug 进入工作流后（Producer 整理或 Owner `/ai-plan`），Consumer 接手。

## Issue 正文（模拟）

标题：插件更新后本地缓存未失效，仍加载旧版本

```markdown
## Goal

修复：插件更新成功后，再次启动仍加载旧版本代码。

## Context

用户报告（#42 的评论区）：更新进度条走完、提示"更新成功"，重启 gamer 后插件行为还是旧的；手动删除缓存目录后才恢复。

## Current State

- 更新流程会把新包解压到缓存目录；
- 启动时插件加载器优先读缓存目录；
- 疑似解压后没有让缓存索引失效。

## Confirmed Requirements

- 更新成功后的下一次启动必须加载新版本；
- 不要求立刻热重载（重启生效即可）。

## Proposed Direction

（待定，由 Consumer 规划）

## Execution Plan

（待规划）

## Acceptance Criteria

（待规划）

## Open Questions

- 缓存失效应该由更新器主动触发，还是由加载器按版本号判断？

<!-- ai-workflow
schema: 1
source: producer
kind: bug
maturity_hint: requirement
-->
```

## 评论（模拟）

（无）

---

## Fixture 元信息（非 Issue 内容）

- Producer hint：`requirement`（L0）
- **预期 Effective Maturity：L0 Requirement**（是 Bug 报告：有复现描述与一条已确认需求，但无根因结论、无修复方案）
- Consumer 预期动作：
  1. 读取真实仓库：更新器解压逻辑、缓存目录与索引结构、插件加载器的读取顺序、相关 tests；
  2. 自己完成根因假设验证（"分析问题"）→ 确定失效机制（"设计方案"）→ 生成执行计划；
  3. Plan 的 Validation 必须包含复现 / 回归测试方式（先旧版本 → 更新 → 重启加载新版本的端到端用例）；
  4. 发布带 `<!-- ai-workflow:plan:v1 -->` 的 Plan Comment（Gate T1：`ai:planning` → `ai:review`）。
- 检查点：是否把"疑似"当成结论（应先在 repo 中验证根因）；kind=bug 的 Plan 是否包含回归测试任务。
