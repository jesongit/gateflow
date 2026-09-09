# GateFlow V1 当前流与新建项目 E2E 报告

## 结论

本次 Task 09 已修正现有集成闭环中与当前契约冲突的断言，并新增当前流 fake E2E 覆盖。后续窄范围修复已完成：超时夹具使用独立 workspace，任务确认进入 `syncAll`，并按 Driver 的 per-task 基础设施错误语义保留超时日志断言。当前本地验证全绿。

本报告保留 Task 09 初次执行时的本地验证和资源阻塞记录。随后在 2026-09-09 完成的真实
GitHub Release E2E 中，Preflight、local gates、Bootstrap、workflow、reconnect 和 security
四项 smoke 均通过；因此“真实新仓库 E2E blocked/未执行”不再代表当前复验状态。

当前契约已在测试中固定为：

```text
READY
  → sync：创建 Tracker，不发布 Report
  → Gate 接受 Tracker，进入 WORKING
  → 下一次 sync：发布 Report
  → Gate 接受精确 Report，进入 DONE
  → 下一次 sync：Driver 记录 accepted
```

## 本次写集

- `tests/integration/e2e.test.ts`
  - 修正 Tracker/Report 同轮发布断言。
  - 增加 READY 首轮无 Report、WORKING 后下一轮发布、DONE 后精确 receipt accepted 的检查。
- `tests/integration/current-flow.e2e.test.ts`
  - 新增 fake 闭环回归：旧 Epoch、旧 Plan、伪 READY、旧 Tracker、旧 Report、取消后的迟到输出、Driver 重启、远端写入后 API 超时、重复 sync，以及 Control/Target 元数据隔离。
  - 修复 API 超时夹具：使用独立 workspace，显式断言 `run.prepared === true`；由于 `syncAll` 隔离单任务基础设施异常，断言空 outcome、Driver 日志中的真实超时、`publishing` 状态和远端单评论 reconciliation。
- `docs/plans/v1-current-flow-e2e-report.md`
  - 本报告。

未修改 `src/**`、`scripts/**`、`skills/**`、README/docs 正文、`dist` 或主计划文档。本工作树中其他任务的改动不属于本次写集。

## 实际本地验证结果

| 命令 | 实际结果 |
| --- | --- |
| `npm test -- --run tests/integration/e2e.test.ts` | 通过：1 个文件，12/12 tests passed |
| `npx vitest run tests/integration/current-flow.e2e.test.ts` | 通过：1 个文件，6/6 tests passed |
| `npm test` | 通过：23 个文件，249/249 tests passed |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过：`dist/index.js`、`dist/cli.js` 均成功构建 |
| `npm run check:dist` | 通过：构建产物与当前源码检查一致 |
| `git diff --check` | 通过 |

此前现有闭环定向验证 `npm test -- --run tests/integration/e2e.test.ts` 也已通过：12/12 tests passed。

`npm run build` 期间生成的 `dist/cli.js` 与 `dist/index.js` 变化已撤销，以保持 Task 09 窄写集；本次未保留任何 `dist` 修改。构建和 `check:dist` 的实际通过结果已如上记录。

## GitHub 权限与真实 E2E（历史记录与当前复验）

已实际执行：

- `gh auth status`：已登录 `jesongit`（keyring），active account；GitHub CLI 版本 `2.98.0`；可见 token scopes 为 `repo`、`read:org`、`gist`、`admin:public_key`。
- `gh api user`：账号类型为 `User`，login 为 `jesongit`。
- `gh repo view`：当前仓库为 `jesongit/gateflow`，public，当前账号权限 `ADMIN`。
- `gh api user/orgs`：没有返回组织；因此没有可确认的组织测试资源或组织级权限。

### 历史记录：初次执行

真实新仓库 E2E 初次执行状态：**blocked，未执行**。

原因是当前没有明确指定且已登记的隔离测试仓库/资源；虽然当前账号具备创建仓库的权限，但本次中止后没有创建临时仓库、没有推送代码、没有运行 Bootstrap 的 GitHub 配置模式，也没有向任何 Control Issue 回写链接。没有外部通过结果可报告，也没有删除或覆盖任何仓库。

### 当前复验：真实 GitHub Release E2E

最新一次真实 Release E2E 的阶段结果如下：

| 阶段 | 结果 |
| --- | --- |
| Preflight | 通过 |
| local gates | 通过 |
| Bootstrap | 通过 |
| workflow | 通过 |
| reconnect | 通过 |
| security：`wrong-approval` / `old-plan-approval` / `old-report` / `fake-ready` | 全部通过 |

命令唯一失败发生在成功后的 `gh repo delete`：本机 `gh` token 没有 `delete_repo` scope，
所以远端临时仓库被保留。该失败属于清理权限限制，不是业务阶段或安全断言失败。要让完整
命令完成清理并返回 0，先执行 `gh auth refresh -h github.com -s delete_repo`，再运行
`npm run e2e:release`；该 scope 仅用于本地清理。

ChatGPT/ZCode 客户端驱动的外部 E2E 在当前复验中仍未执行。它按计划是可选 smoke，不能把
其未执行写成客户端已通过，也不能用它否定核心 Release E2E 的真实通过结果。

## 当前限制与后续事项

本次真实 Release E2E 的核心链路没有遗留业务阻塞。若要单独验收用户指定的 Control/Target
仓库、入口 Issue 和 PR 接入流程，仍需另行提供隔离资源并执行对应测试；本报告当前复验覆盖的
是 Release E2E 的新建仓库与已有 checkout reconnect 路径。
