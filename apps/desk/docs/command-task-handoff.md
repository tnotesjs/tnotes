# 命令任务修复 · 交接记录（状态：**修复待验证**）

> **当前状态：修复待验证。** 源码改动已完成并通过 typecheck，但确定性回归 **9/11 通过、2 条红**，
> 因此**不能**声明"源码修复完成"。下列"已确认事实"与"待验证假设"严格区分。

## 一、复现命令

```bash
cd /Users/huyouda/tnotesjs/tnotes
pnpm --filter desk exec vitest run src/main/gitManager.test.ts      # 9 passed / 2 failed
pnpm --filter desk run typecheck                                   # 通过
```

## 二、红测（2 条）

| 用例                                                           | 现象     | 已定位到哪一步                                                                                        |
| -------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `同库先后：取消排队中的后任务，不影响前任务，且后任务永不启动` | 超时 5s  | 卡在最后一步"队列已释放：后续 fetch 能执行"——前两步（前任务完成、排队项被跳过且调用数不变）**已通过** |
| `dispose 终止所有在跑的进程并等队列收敛`                       | 超时 15s | `dispose()` 未被 resolve；假线程的 `periodicFetchTimer`/`operationTails` 可能仍挂着                   |

## 三、已确认事实（有测试或代码为证）

1. **跨库隔离成立**：`跨库并行：取消一个库的运行，另一个库的进程不受影响` ✅
   —— 只关闭 kb1 的挂起调用，kb2 仍挂着并最终正常完成。
2. **取消绑定到具体队列项**：`同库多任务：取消绑定到具体正在运行的那一项（身份不匹配则拒绝）` ✅
   —— `cancelRunningOperation(kb, 'op-不存在')` 返回 false 且不动进程；传真实 `operationId` 才取消。
3. **abort 与 close 分离**：`abort 与 close 分离：abort 后进程未退出前不得算结束` ✅
   —— abort 后 30ms 仍 `settled === false`、挂起调用仍在；手动 close 后才 reject。
4. **业务结果映射**：`本地有未提交变更时 pull 返回 conflict，而不是抛错` ✅
   —— `left=ahead / right=behind` 的顺序已核对；mock 需 `upstream` 存在才进入该分支。
5. **排队取消不误杀前任务**：该用例的**前半段已通过**（前任务正常完成、排队项从未启动、调用数不变）。
6. 源码改动（见第五节）通过 `typecheck`；全量单测此前为 1432 passed。
7. **已修掉一个真实缺陷**：被取消的操作原先也会触发 `refreshRepository`，而该刷新（含 fetch）
   可能挂住 → 队列尾永不收敛。现改为 `if (node.canceled) return`。

## 四、待验证假设（**不是结论**）

- **假设 A**：那 2 条红测仍属测试装置问题（假执行器/初始化时序），源码无需再改。
  **反证方向**：`cancelQueuedOperation` 标记的后继 `pull` 在 rejecting 时若走 `cancelQueuedOperation`
  分支之外的路径，可能仍有刷新或尾部不收敛。**需按下方"下一步"逐步验证**。
- **假设 B**：`dispose()` 超时只是测试环境残留计时器，不影响生产退出。
  **反证方向**：真实应用里若有挂起的后台 refresh，`dispose()` 同样可能长时间不返回。
- **假设 C**：源码修复（P1-1…P1-5）语义正确。**已由 5 条通过用例部分支持，但未全覆盖。**

## 五、当前改动（未提交）

源码（`apps/desk/src/`）：

| 文件                                                 | 改动                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main/gitManager.ts`                                 | 删除全局 `activeKills`/`killThisOperation`；改为**按队列项**节点（`QueueNode.id`）；`cancelQueuedOperation(kb)` 只让排队项失效、`cancelRunningOperation(kb, operationId?)` 精确取消；`whenQueueIdle(kb)`；`disposeKills` 仅用于退出；`enqueue` 返回 `{ result, node }`；extras 支持工厂（执行时求值）；取消的操作不触发刷新；构造函数注入 `execute` 便于测试 |
| `main/ipc/commandTask.ts`                            | 整文件重写：`runningExecutions`（同 `taskId::run` 只启动一次）、`ensureExecution`、`runGitTask` 做业务结果映射（`conflict` → failed）、取消先进入 `canceling` 并等 close 结算、重试改为发 `commandTaskRetryRequested` 由渲染端重跑；IDE 启动任务                                                                                                             |
| `main/commandTaskManager.ts`                         | `claimHandle()`/`claim()`（DTO 与句柄分离）、`canceled()`、`canceling` 阶段与状态、`isActive` 公开                                                                                                                                                                                                                                                           |
| `main/ipc/git.ts`                                    | Git 三个通道带可选 `taskId`；IDE 启动接任务                                                                                                                                                                                                                                                                                                                  |
| `main/index.ts`、`main/ipc.ts`、`main/ipc/shared.ts` | 注册/清理；zod 错误响应改为纯数据（否则不可克隆）                                                                                                                                                                                                                                                                                                            |
| `shared/contracts.ts`、`preload/index.ts`            | `canceling` 阶段/状态、`onRetryRequested`、`commandTaskRetryRequested`                                                                                                                                                                                                                                                                                       |
| 删除                                                 | `main/git.ts`（死代码，无任何导入）                                                                                                                                                                                                                                                                                                                          |

渲染端：`stores/commandTask.ts`（canceling 视为活动、retry 只发请求）、`stores/workspace/git.ts`（`publishWithSave` 完整流程 + `retryCommandTask`）、`stores/workspace/index.ts`、`App.vue`（接重试请求）、`terminal/CommandTaskPane.vue`（取消中禁用重试）、`terminal/TerminalPanel.vue`。

测试：`main/gitManager.test.ts`（新增 6 条确定性用例，9/11 通过）。

## 六、剩余验收项（全部未完成）

1. 让上述 2 条红测变绿（装置问题按"下一步"定位；若暴露源码问题则修源码）。
2. `commandTask.ts` 的确定性回归：**保存失败后重试推送会重新保存；保存仍失败则不得执行 Git 写操作**。
3. **连续点击同一操作，实际执行次数为一次**（`ensureExecution` 的行为断言）。
4. **commit 阶段的输出与取消正常工作**（`publishRepository` 的 `add`/`commit`/`push` 已接 extras，未验证）。
5. E2E（既未完成、也不作为遗留项）：超时端到端、推送全流程、重试、后台失败入口。
6. 原有功能回归：交互式终端、文件外部修改、未保存冲突处理。
7. 仓库门禁与提交（`gitManager.test.ts` 修绿后跑 lint/typecheck/prettier）。

## 七、下一步（按顺序，避免再绕）

1. 在 `同库先后` 用例里，把"后续 fetch 能执行"这一步拆开观察：先断言 `whenQueueIdle('kb1')` 能返回，
   再断言新 fetch 被调用。若 `whenQueueIdle` 不返回，说明**尾部仍被某次 refresh 拖住**，
   此时查 `cancelQueuedOperation` 路径上的 `pull` 是否真的走了 `node.canceled` 分支
   （可在 `enqueue` 的 `if (node.canceled) throw` 处临时计数，**不要**用静默窗口猜）。
2. `dispose` 用例：确认 `periodicFetchTimer` 与 `operationTails` 都由 `dispose()` 收敛；
   如仍是环境残留，用 `vi.useFakeTimers()` 或在断言前 `await manager.whenQueueIdle(id)`。
3. 之后按第六节 2–4 补 `commandTask` 层回归，再做 5–7。
