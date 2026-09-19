# 命令操作与底部终端面板联动 · 验收报告

**日期**：2026-09-19
**状态**：**实现待验收** —— 命令任务链路本身已确定性验证 + E2E 验收；终端/外部修改等改动面之外的回归只走了冒烟集，未做专项验收。

---

## 一、这次交付的是什么

把**手动 Git 操作**（获取/拉取/提交推送）与 IDE 启动做成**底部面板里的命令任务标签**，
而不是新造一套任务系统：

- 一次手动操作 = 一个任务标签，实时显示阶段、实际命令行、git 的真实输出、耗时；
- 同一 `(知识库, 操作)` 只有一个标签，重复点击只定位、不再执行；
- 可取消、可重试；重试复用**完整业务流程**（推送会重新保存未提交更改）。

## 二、修复清单（每一条都先证伪、再修复、再用测试钉住）

| #   | 缺陷                                              | 用户可见后果                                                                                                                    | 证据                                                       |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `publishRepository` 的 `commit` 调用漏传 `extras` | 取消推送时 **commit 子进程收不到终止信号**（push 能取消、最耗时的 commit 反而不能）；commit 输出不进面板                        | 撤掉修复 → `gitManager.test.ts` 2 条变红                   |
| 2   | `refresh()` 不检查 `disposed`                     | 退出时收尾的 best-effort 刷新会在 `dispose()` 排空后**再造一个没人等、没人杀的 git 进程**                                       | 撤掉守卫 → 对应用例变红                                    |
| 3   | 取消同库某任务时**不带队列身份**                  | 同库有两个任务（后者在 gitManager 队列里排队）时，取消后者会**误杀正在跑的前者**（前一个变 failed，被取消的那个卡在「取消中」） | 撤掉修复 → `commandTask.test.ts` 1 条 + E2E 的隔离场景变红 |

缺陷 3 的修法：`gitManager.enqueue` 新增 `onEnqueued(operationId, cancel)`，**入队时**就交出
这一项的队列身份与"只让这一项失效"的入口；命令任务层据此区分：

- 身份 == gitManager 当前运行项 → 已开始执行：只终止这一轮的 spawn，**等进程 close** 才结算；
- 否则 → 还在排队：只让这一项失效，**绝不碰**任何进程，轮到它时立即以「已取消」结算。

## 三、验收依据

### 1. 确定性单测（注入假执行器 / 假 gitManager）

```
pnpm --filter desk exec vitest run src/main/gitManager.test.ts       # 17 passed
pnpm --filter desk exec vitest run src/main/ipc/commandTask.test.ts  # 9 passed
pnpm --filter desk test                                              # 1453 passed / 165 files / 0 skipped
```

覆盖的取消语义（本轮的核心风险区）：

- 跨库隔离：取消 kb1 的运行，kb2 的进程不受影响；
- 同库先后：取消排队中的后任务，前任务照常完成、后任务**永不启动**；
- 同库多任务：取消绑定到**具体运行项**，身份不匹配即拒绝；
- abort 与 close 分离：abort 后进程未退出前**不得**算结束（仍是「取消中」、不可重试）；
- 排队中取消：只让该项失效、**不**调用按知识库的取消、轮到时立即结算；
- `dispose()`：停受理、使未启动项失效、等进程关闭、退出中不让排队项启动；
- 退出后刷新不再派生进程。

### 2. 命令任务 E2E（真实 git 子进程 + 裸远端）

```
pnpm --filter desk exec electron-vite build
node apps/desk/scripts/e2e-command-task.mjs        # 15/15
```

| 断言                                 | 说明                                                |
| ------------------------------------ | --------------------------------------------------- |
| 手动操作在面板里建出命令任务标签     | 底部面板 + 任务标签真实渲染                         |
| 面板显示实际命令行与真实输出         | `command=git pull --ff-only`，首行是 git 自己的输出 |
| 推送成功且提交**真的到了裸远端**     | 比对本地与远端 HEAD                                 |
| 同一 (知识库, 操作) 只有一个标签     | 重复执行前后标签数不变                              |
| 远端不可达时标 failed（不是成功）    | 错误原文进入任务                                    |
| 重试把失败时留在本地的提交真的推上去 | 重试前远端缺、重试后远端有；run 递增；不新增标签    |

### 3. 原有功能回归

按改动面（`main/gitManager.ts`、`main/ipc/*`）由 runner 选出 **14 个 E2E 套件**：

- **10/14 直接通过**，含直接依赖 gitManager 的 `e2e-delete-dialog`、`e2e-excalidraw-git`；
- **4 个曾 305s 超时**（`kb-assets` / `markdown-input` / `numbered-tabs` / `quit-flush`）：
  日志为空、卡在启动阶段；`--concurrency 1` 重跑 **4/4 通过**（各 2.9–7.2s）。
  判定为**并发启动多个 Electron 的环境问题**，非代码回归。
- 冒烟核心集 12 个套件由上表覆盖。

## 四、明确未验证（不要当成已验）

1. **E2E 未断言"取消排队任务不误杀同库正在跑的"**：稳定复现需要让前者的 fetch 一直挂着，
   而任何真实远端都会自己失败（实测不可路由地址约 5s），窗口太窄、硬写会变成碰运气。
   该语义由第三节的确定性单测覆盖（已证伪）。
2. **超时路径**：`/超时/ → timeout` 的映射有单测，但**没有端到端等 60s 超时**。
3. **保存失败不得写 Git**：`publishWithSave` 的该逻辑在渲染端，本轮未补渲染端断言。
4. **后台定时 fetch 失败入口**：未端到端验证。
5. **交互式终端**（新建/切换/关闭、cwd 绑定）：本阶段没有终端 E2E 套件；改动面不含
   `main/terminalManager.ts`，其 32 条单测通过，但**未做终端专项 E2E**。
6. **外部修改文件 / 未保存冲突**：由 8 个单测文件覆盖且全绿，**未做 E2E 专项**。

## 五、门禁

```
pnpm --filter desk test        # 1453 passed / 165 files / 0 skipped
pnpm --filter desk lint        # 0 errors（41 warnings 均为既有）
pnpm --filter desk typecheck   # 0 errors
pnpm format:check              # All matched files use Prettier code style
```

## 六、交付物

- `apps/desk/src/main/gitManager.ts`：`onEnqueued` 入队身份、退出后刷新守卫、commit 传 extras
- `apps/desk/src/main/ipc/commandTask.ts`：按队列身份精确取消（排队/运行两条路径）
- `apps/desk/src/main/gitManager.test.ts`、`apps/desk/src/main/ipc/commandTask.test.ts`
- `apps/desk/scripts/e2e-command-task.mjs`（新增，已注册进 `e2e-registry.mjs`）
- `apps/desk/docs/command-task-handoff.md`（交接记录，含环境注记）
