# GateFlow V1 Task 10：已有项目增量接入 E2E 报告

> 日期：2026-09-09
> 初始记录状态：**blocked（无明确测试资源，且本轮按用户指令停止）**
> 当前复验状态：真实 GitHub Release E2E 的 reconnect 路径已通过；命令仅因清理权限限制未以 0 退出

## 范围与写集

本报告是本轮 Task 10 唯一新增文件。以下写集和测试结果均是 Task 10 初始执行时的历史记录；
`tests/integration/existing-project-onboarding.e2e.test.ts` 当时尚未新增；没有修改 `src/**`、
`scripts/**`、`skills/**`、README、既有集成测试、`dist` 或主计划文档。

当前工作区中的其它改动来自并发的 Task 01–08，不属于本 Task 10 写集；本轮未回滚或改写它们。

## 权限与外部资源检查

- `gh auth status`：通过。
  - GitHub：`github.com`
  - 当前账号：`jesongit`
  - 已登录，Git 协议为 SSH
  - 可见 scope：`admin:public_key`、`gist`、`read:org`、`repo`
- `GATEFLOW_E2E_*` 环境变量检查：未发现明确的测试仓库授权。
- 因此没有选择任何目标仓库，也没有执行真实 GitHub 写操作：未创建/修改标签、Issue、评论、分支或 PR，未合并、删除或推送任何远端资源。

## 测试实际结果

本轮 Task 10 在新增测试文件前被用户中断，以下命令没有在本轮重新执行：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 未执行本轮 Task 10 验证；并发 Task 08 的最新报告为 242/243 通过，唯一失败是既有 `tests/integration/e2e.test.ts` 对旧的同轮 Tracker/Report 行为的断言 |
| `npm run typecheck` | 未执行本轮；并发任务报告通过 |
| `npm run build` | 未执行本轮；Task 01 基线报告通过，不能替代当前工作树复验 |
| `npm run check:dist` | 未执行本轮；Task 01 基线报告通过，不能替代当前工作树复验 |
| `git diff --check` | 未执行本轮；并发任务报告通过 |

## 历史结论与当前复验

Task 10 初次执行时，真实已有项目接入 E2E 标记为 **blocked**，不是通过；当时没有选择目标
仓库，也没有执行外部写操作。这一历史结论仍然有效，不应改写为当时已经完成独立目标仓库
和 PR 验证。

随后在 2026-09-09 的真实 GitHub Release E2E 中，已有 checkout 的 reconnect 路径已实际通过，
并且 Preflight、local gates、Bootstrap、workflow、reconnect 和 security 四项 smoke 全部通过。
这证明当前 Release E2E 的已有项目重接路径可运行，但不等同于单独指定的 Control Repository、
入口 Issue、目标仓库接入分支和 PR 合并流程已经另行验收。

该次命令唯一失败发生在成功后的 `gh repo delete`：本机 `gh` token 缺少 `delete_repo` scope，
远端临时仓库因此被保留。它是清理权限限制，不是已有项目重接或安全断言失败。完整清理前执行
`gh auth refresh -h github.com -s delete_repo`，再运行 `npm run e2e:release`；该 scope 仅用于
本地 E2E 清理。

ChatGPT/ZCode 客户端驱动的真实任务尚未执行，按计划属于可选 smoke，不能在发布说明中声称已
通过。
