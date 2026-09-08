# E2E 验证手册（V1.1 Phase 11 + Phase 12）

V1.1 把验证拆成两层：**真实 GitHub E2E**（可选，opt-in，对专用测试仓库运行完整生产链）与
**ChatGPT / ZCode 客户端 E2E**（Manual Activation 即算正式通过）。CI 中 `uses: ./` 只做
Action Runtime Smoke（Node24 运行时、bundle、inputs、action metadata），**不**构成 Gate E2E
——普通 CI workflow 里创建 Issue/Comment 后再 `uses: ./` 不会变成真正的 `issue_comment` 事件。
事件层在 CI 内由 `tests/events/`（录制 payload fixture → 注入 `gateInputFromPayload` →
`runGate`）覆盖。

---

## 1. Real GitHub E2E（Phase 11，opt-in）

建立**专用测试仓库**（不要用生产仓库），然后：

```bash
export GATEFLOW_E2E_REPOSITORY=<owner>/<scratch-repo>
export GATEFLOW_E2E_TOKEN=ghp_...        # 仓库 owner 的 token
npx vitest run tests/e2e
# 可选：保留现场供检查
export GATEFLOW_E2E_KEEP=1
```

套件 `tests/e2e/real-github.e2e.test.ts` 驱动完整生产链（真实 API + 真实 Gate + 真实 Driver）：

```text
Issue → /ai-plan → T0（epoch record 先于 PLANNING 标签）
→ Driver discovery → Consumer Dispatch → PLAN.md/result.json → 同步发布 Plan
→ Gate T1（REVIEW）→ /approve <plan-comment-id> → T2（approval + transition record，READY）
→ Driver 派发 Executor → PROGRESS/status → Tracker → Gate T3（WORKING）
→ REPORT.md/result.json → 同步发布 Report → Gate T6（DONE）
→ Driver receipt 经 V1.1 gate_transition 记录进入 accepted
```

未设置环境变量时整个套件自动 skip（常规 CI 不受影响）。

### Security / Recovery E2E（手动或脚本扩展）

安全类攻击（Fake Ready / Fake Epoch / Old Plan / Old Approval / Edited Plan / Old Tracker /
Old Report / Duplicate Report / Cancel 后迟到的 Agent 输出 / Duplicate delivery / API timeout /
Driver restart / Receipt 丢失 / 桌面 Agent 仍在运行）的单测覆盖在：

```text
tests/security/dispatch-chain.test.ts   # V1.1 Phase 1/2/3 验收清单（对抗式）
tests/security/approval-chain.test.ts   # 审批链攻击
tests/security/gate-commands.test.ts    # 命令权限
tests/events/handler.test.ts            # 事件层
tests/hardening/workspace-lock.test.ts  # 锁语义（V1.1：无时间抢占 / unlock）
```

真实 API 维度的恢复演练（建议在 scratch 仓库手动执行一轮并核对）：

```text
API timeout            → 重跑命令 / 下一轮 sync 按 Operation ID search-adopt，不重复创建
Driver restart         → receipt 为本地缓存，重建后不重复发布（published 幂等）
Receipt 删除           → reconcile：tracker/report 按 marker + dispatch-id 对账采纳
Duplicate GitHub 投递  → 状态前置 + operation id 幂等，二次投递为 no-op
```

---

## 2. ChatGPT / ZCode 客户端 E2E（Phase 12，Manual Activation）

没有稳定自动 Task API 时，**Manual Activation 仍算正式通过**。先验证：

```text
Driver 创建 Dispatch → 通知 → 用户打开 ChatGPT/ZCode
→ Agent 读取精确 dispatch path（.gateflow/inbox/<id>/dispatch.json，绝不依赖 current.json）
→ 工作 → outbox（status.json / result.json / PLAN|REPORT.md）→ Driver Sync
```

至少覆盖两个交叉组合，证明 **Role ≠ Provider**：

| # | Consumer | Executor | 检查点 |
| --- | --- | --- | --- |
| 1 | ChatGPT | ZCode | 两端各自的 TASK/PLAN/FEEDBACK 投影可读；outbox 契约文件合法；Driver 同步后 Gate 正常迁移 |
| 2 | ZCode | ChatGPT | 同上 |

### 每组合的检查单

```text
[ ] /ai-plan 后 inbox/<consumer-id>/dispatch.json 出现，TASK.md 含 issue 标题与 Goal
[ ] Agent 只读 dispatch.json 指向的文件；不读 .gateflow/current.json（manual 指针）
[ ] PLAN.md 写入 outbox 后，一个 sync 周期内发布为 Plan 评论（T1 → REVIEW）
[ ] /change 接受后 FEEDBACK.md 投影进下一轮 consumer dispatch（revision 递增）
[ ] /approve <plan-id> 后 executor dispatch 出现，PLAN.md 与批准内容逐字节一致
[ ] Executor 工作中 tracker 评论出现（T3 → WORKING）；Blocked 编辑触发 T4/T5
[ ] REPORT.md + validation=passed 发布 Report（T6 → DONE）
[ ] executor receipt 最终 = accepted（V1.1：由 gate_transition 记录驱动，非裸标签）
[ ] /cancel 后：旧 dispatch receipt = obsolete；迟到的 outbox 写入被拒绝
[ ] 观察日志/记录：每次状态变化可回答——哪个 Epoch？哪个 Plan？谁批准？Plan Hash？
    哪个 Dispatch？哪个 Agent Output？哪个 Comment？Gate 接受的是哪一条？
```

最后一项即 V1.1 的完成标准：**每次状态变化都能确定性追溯完整执行链**。
