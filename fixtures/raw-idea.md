# Fixture: raw-idea —— L0 模糊想法

> 用途：Consumer Skill 的成熟度判定 / 最小补全测试输入（计划文档第二十六节 Skill Fixture，对应协议第 5 节 L0）。
> 本文件模拟一个 GitHub Issue：下方"Issue 正文"即 body（含文末 schema 块），本例无评论。
> 场景对应使用手册"场景 B"：Issue 只有一个模糊想法。

## Issue 正文（模拟）

标题：希望插件支持远程更新

```markdown
## Goal

希望 gamer 的插件能支持远程更新，不用每次都手动重新打包安装。

## Context

现在插件更新要用户自己下载新包再装一遍，好几个人反馈嫌麻烦，有人就一直用旧版本。

## Current State

插件目前只在本地安装时读一次包。

## Confirmed Requirements

（暂无）

## Proposed Direction

（待定，由 Consumer 规划）

## Execution Plan

（待规划）

## Acceptance Criteria

（待规划）

## Open Questions

- 更新检查的频率和时机？
- 更新失败怎么办？

<!-- ai-workflow
schema: 1
source: producer
kind: feature
maturity_hint: requirement
-->
```

## 评论（模拟）

（无）

---

## Fixture 元信息（非 Issue 内容）

- Producer hint：`requirement`（L0）
- **预期 Effective Maturity：L0 Requirement**（Issue 只有想法与开放问题，无方向、无方案）
- Consumer 预期动作：
  1. 读取真实仓库：现有插件加载 / 安装代码、README、测试；
  2. 自己完成"分析问题 → 设计方案 → 生成执行计划"全程（更新检查机制、包获取与校验、失败回退等设计都要 Consumer 补齐）；
  3. 发布带 `<!-- ai-workflow:plan:v1 -->` 的 Plan Comment（Gate T1：`ai:planning` → `ai:review`）。
- 检查点：Plan 是否包含完整设计方案与任务拆分（而不是反过来向用户索要方案）；是否先读了 repo 再设计；Open Decisions 编号是否可供 `/choose` 使用。
