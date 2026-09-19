# 命令任务 · 交接记录（状态：**实现待验收**）

> **当前状态：确定性回归全绿（1453 tests / 0 skipped），命令任务 E2E 15/15 通过，
> 改动面所选 14 个 E2E 套件回归通过（4 个曾因并发超时，串行 4/4 通过）。**
> 三个缺陷都已"先证伪、再修复、再用测试钉住"；**尚未验收**的是终端/外部修改等
> 改动面之外的回归（见第六节）。

## 一、复现命令

```bash
cd /Users/huyouda/tnotesjs/tnotes
pnpm --filter desk exec vitest run src/main/gitManager.test.ts       # 17 passed
pnpm --filter desk exec vitest run src/main/ipc/commandTask.test.ts  # 9 passed
pnpm --filter desk test                                              # 1453 passed / 165 files / 0 skipped
pnpm --filter desk lint && pnpm --filter desk typecheck && pnpm format:check

# E2E（需要先构建）
pnpm --filter desk exec electron-vite build
node apps/desk/scripts/e2e-command-task.mjs                          # 15/15
node scripts/run-e2e.mjs --only command-task                         # 走 runner
```

## 二、本轮修掉的三个缺陷（都有"撤掉修复即变红"的证据）

| #   | 缺陷                                              | 影响                                                                                     | 钉住它的测试                                                                             |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | `publishRepository` 的 `commit` 调用漏传 `extras` | commit 阶段收不到取消信号（取消 push 时 commit 会跑到底），输出也进不了面板              | `gitManager.test.ts`：add/commit/push 都收到 extras；取消发生在 commit 阶段时不 push     |
| 2   | `refresh()` 不检查 `disposed`                     | 退出时收尾的 best-effort 刷新会在 `dispose()` 排空后**再派生**一个没人管、没人杀的子进程 | `gitManager.test.ts`：退出开始后刷新不再派生进程（含"退出前会派生"的对照）               |
| 3   | 取消同库某个任务时**不带队列身份**                | 同库有两个任务（后者在 gitManager 队列里排队）时，取消后者会**误杀**正在跑的前者         | `commandTask.test.ts` 两条 + `gitManager.test.ts` 的 `onEnqueued` 用例；E2E 侧见第五节注 |

缺陷 3 的修法：`gitManager.enqueue` 新增 `onEnqueued(operationId, cancel)` 回调（**入队时**就给出身份），
命令任务执行层据此在"排队中"也能精确取消这一项；已开始执行的才走
`cancelRunningOperation(kb, operationId)` 并等进程 close 结算。

## 三、取消语义（已确认事实）

1. **排队取消只让该项失效**：不终止正在跑的前一项，也不碰其他知识库。
2. **运行中取消绑定身份**：`cancelRunningOperation(kb, operationId)` 身份不匹配即拒绝。
3. **终态只在进程 close 之后**：abort 只发终止信号，此时仍是「取消中」、不可重试。
4. **排队项的取消在轮到时立即结算**，不会挂在「取消中」等一个根本不该执行的操作超时。
5. **被取消的操作不做自动刷新**，避免一次挂住的刷新把队列尾拖住。

## 四、E2E 覆盖（`scripts/e2e-command-task.mjs`，真实 git 子进程 + 裸远端）

- T0–T1：知识库发现、Git 状态就绪、底部面板可打开
- T2：拉取 → 面板出现命令任务标签，显示实际命令行与真实输出，成功结算
- T3：推送 → 未提交改动被提交并**真的推到裸远端**，工作区干净
- T4：同一 (知识库, 操作) 只有**一个**标签，重复执行不新增
- T5：远端不可达 → 标 failed（不是成功）；恢复后**重试**把本地提交真的推上去、run 递增、不新增标签
- T6：全程无未捕获异常

## 五、明确未覆盖（不要当成已验）

- **E2E 没有断言"取消排队任务不误杀同库正在跑的"**：要稳定复现"同库两任务、后者在队列里排队"，
  就得让前者的 fetch 一直挂着；任何真实远端都会自己失败（实测不可路由地址约 5s），窗口太窄，
  硬写会变成碰运气。该语义由第三、四节的两条单测**确定性**覆盖（已证伪）。
- **超时路径**：`gitManager` 的 `/超时/` → `timeout` 映射有单测，但没有端到端等待 60s 超时。
- **保存失败不得写 Git**：`publishWithSave` 的"保存失败 → 结束任务、不执行 Git"逻辑在渲染端，
  本轮没有补渲染端断言。
- **后台定时 fetch 失败入口**：未端到端验证。

## 六、原有功能回归（本轮已跑）

命令任务这轮改动碰了 `main/gitManager.ts`（`enqueue`、`refresh`）与 `main/ipc/*`，
用 runner 按改动面选出 14 个套件回归：

- **10/14 直接通过**，包含直接依赖 gitManager 的 `e2e-delete-dialog`、`e2e-excalidraw-git`
  与本轮的 `e2e-command-task`。
- **4 个曾 305s 超时**（`kb-assets` / `markdown-input` / `numbered-tabs` / `quit-flush`）：
  日志为空、卡在启动阶段；`--concurrency 1` 重跑 **4/4 通过**（各 2.9–7.2s）。
  判定为**并发启动多个 Electron 的环境问题**，不是本轮回归。

仍未验收（改动面之外，按需再跑）：

1. 交互式终端（新建/切换/关闭、cwd 绑定）——本轮的 14 个套件不含终端套件。
2. 外部修改文件后 Desk 的感知与未保存冲突处理。
3. 打开/切换知识库、资源面板、历史版本等流程（`e2e-kb-assets` 已通过，其余未跑）。

跑法：`node scripts/run-e2e.mjs --smoke` 后再按需全量；`--since <ref>` 可选相关套件。
机器较忙时用 `--concurrency 1`，避免上面那种启动阶段互相拖死。
