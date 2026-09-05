# Fixture: direction —— L1 已有方向

> 用途：Consumer Skill 的成熟度判定 / 最小补全测试输入（计划文档第二十六节 Skill Fixture，对应协议第 5 节 L1）。
> 本文件模拟一个 GitHub Issue：下方依次为"Issue 正文"（含文末 schema 块）与一条模拟的 Producer append 评论。
> 场景对应使用手册"场景 C"的前置：方向已定，方案未定。

## Issue 正文（模拟）

标题：插件远程更新：走"启动时检查 + 手动确认"方向

```markdown
## Goal

为 gamer 插件提供远程更新能力。

## Context

对话讨论结论：不需要后台静默更新，采用"启动时检查 → 提示有新版本 → 用户确认后更新"的方向；检查频率不做可配置（V0 固定为每次启动检查一次）。

## Current State

插件只在本地安装时读一次包；无任何网络代码。

## Confirmed Requirements

- 启动时检查更新（每次启动至多一次）；
- 用户确认后才下载安装；
- 更新失败不影响本次正常启动。

## Proposed Direction

检查更新走插件市场的 HTTP 接口；下载与安装复用现有本地安装流程。

## Execution Plan

（待规划）

## Acceptance Criteria

（待规划）

## Open Questions

- 检查接口的响应格式与版本比较规则？

<!-- ai-workflow
schema: 1
source: producer
kind: feature
maturity_hint: direction
-->
```

## 评论（模拟：Producer APPEND）

```markdown
## AI Discussion Summary

- 补充确认：版本比较用 semver；market 服务端已有 `/api/plugins/latest?name=` 端点可查。

## Proposed Direction

- 版本比较直接用现有依赖树里已有的 semver 库，不引新依赖。

<!-- ai-workflow:append:v1 -->
```

---

## Fixture 元信息（非 Issue 内容）

- Producer hint：`direction`（L1）
- **预期 Effective Maturity：L1 Direction**（方向明确：启动检查 + 手动确认 + HTTP 接口 + semver；但模块划分、数据流、错误处理路径未设计）
- Consumer 预期动作：
  1. 读取真实仓库：验证"现有本地安装流程""现有 semver 依赖""market 端点假设"在仓库中确实成立（Repository Validation）；
  2. "验证方向 → 补完整方案 → 生成执行计划"：方向成立则沿用，不推翻、不重新发起选型讨论；把缺失的方案层（模块边界、失败路径、缓存失效）补齐；
  3. 发布带 `<!-- ai-workflow:plan:v1 -->` 的 Plan Comment（Gate T1：`ai:planning` → `ai:review`）。
- 检查点：是否重复讨论已定方向（不允许再问"要不要做自动更新"）；append 评论中的确认结论是否全部进入 Plan；若验证发现 market 端点假设不成立，是否降级处理并说明。
