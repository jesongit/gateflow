# GateFlow V1 当前流与新建项目 E2E 报告

## 结论

本次 Task 09 已修正现有集成闭环中与当前契约冲突的断言，并新增当前流 fake E2E 覆盖。后续窄范围修复已完成：超时夹具使用独立 workspace，任务确认进入 `syncAll`，并按 Driver 的 per-task 基础设施错误语义保留超时日志断言。当前本地验证全绿。

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

## GitHub 权限与真实 E2E

已实际执行：

- `gh auth status`：已登录 `jesongit`（keyring），active account；GitHub CLI 版本 `2.98.0`；可见 token scopes 为 `repo`、`read:org`、`gist`、`admin:public_key`。
- `gh api user`：账号类型为 `User`，login 为 `jesongit`。
- `gh repo view`：当前仓库为 `jesongit/gateflow`，public，当前账号权限 `ADMIN`。
- `gh api user/orgs`：没有返回组织；因此没有可确认的组织测试资源或组织级权限。

真实新仓库 E2E 状态：**blocked，未执行**。

原因是当前没有明确指定且已登记的隔离测试仓库/资源；虽然当前账号具备创建仓库的权限，但本次中止后没有创建临时仓库、没有推送代码、没有运行 Bootstrap 的 GitHub 配置模式，也没有向任何 Control Issue 回写链接。没有外部通过结果可报告，也没有删除或覆盖任何仓库。

ChatGPT/ZCode 客户端驱动的外部 E2E 本次未执行，未将其可用性或结果推断为通过。

## 后续唯一阻塞点

真实 GitHub 新仓库 E2E 仍因没有明确登记的隔离测试资源而 blocked；本次 follow-up 不执行任何外部写操作。除该外部条件外，本地 Task 09 验证已完成。
