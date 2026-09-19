# 命令操作与底部终端面板联动 · 验收报告

**日期**：2026-09-19
**状态**：**实现待验收** —— 代码与验证都已完成，等待最终验收。

---

## 一、这次交付的是什么

把**手动 Git 操作**（获取/拉取/提交推送）做成**底部面板里的命令任务标签**，
而不是新造一套任务系统：

- 一次手动操作 = 一个任务标签，实时显示阶段、实际命令行、git 的真实输出、耗时；
- 同一 `(知识库, 操作)` 只有一个标签，重复点击只定位、不再执行；
- 可取消、可重试；重试复用**完整业务流程**（推送会重新保存未提交更改）。

## 二、修复清单（每条都先证伪、再修复、再用测试钉住）

| #   | 缺陷                                              | 用户可见后果                                                                                                                                      | 钉住它的证据（撤掉修复即变红）                                              |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `publishRepository` 的 `commit` 调用漏传 `extras` | 取消推送时 **commit 子进程收不到终止信号**（push 能取消、最耗时的 commit 反而不能）；commit 输出进不了面板                                        | `gitManager.test.ts` 2 条                                                   |
| 2   | `refresh()` 不检查 `disposed`                     | 退出时收尾的 best-effort 刷新会在 `dispose()` 排空后**再造一个没人等、没人杀的 git 进程**                                                         | `gitManager.test.ts` 1 条（含"退出前会派生"的对照）                         |
| 3   | 取消同库某任务时**不带队列身份**                  | 同库有两个任务（后者在 gitManager 队列里排队）时，取消后者会**误杀正在跑的前者**（前者变 failed，被取消的那个卡在「取消中」）                     | `commandTask.test.ts` 1 条（确定性）                                        |
| 4   | 无执行记录时**按知识库盲取消**                    | 取消处理器在找不到本轮记录时仍调 `cancelQueuedOperation(kb)`，会取消该库第一个未运行节点——**不一定是目标任务**（推送停在保存阶段时必然命中）      | `commandTask.test.ts` 1 条                                                  |
| 5   | 保存期间取消后**仍继续推送**                      | `publishWithSave` 在 `saveAllDocuments()` 返回后无条件进入 Git：用户点了停止，保存完成后照样 add/commit/push                                      | `git/workspace/git.test.ts` 1 条                                            |
| 6   | `runGit` 超时后**不结算**（git 孙子进程占着管道） | 远端"接受连接但不响应"时，超时杀了 git 之后 `close` 永不触发（孙子进程 `git-remote-http` 继承管道），任务**永远停在「运行中」**，该库队列一起卡死 | `runGit.test.ts` 2 条（真 git + 可控挂起服务）                              |
| 7   | `runGit` 无条件在 `exit` 时结算并清理             | 主进程先退出时把**忽略 SIGTERM 的孙子进程留下**（真残留），或反过来丢掉还没收尾的尾部输出；还会清掉 SIGKILL 兜底定时器                            | `runGitLifecycle.test.ts` 2 条（可控子进程）                                |
| 8   | `runGit` 从不 `register` 到 `onSpawn`             | 应用退出（`gitManager.dispose`）时**谁也碰不到正在跑的 git 进程**，孙子进程会卡住退出                                                             | `runGitLifecycle.test.ts` 注册/注销配对 + `gitManager.test.ts` dispose 收敛 |
| 9   | 运行期间输出缓存**无上限**                        | 一次大输出（几十万条变更的 status）在任务面板上限之外把主进程内存吃满                                                                             | `runGitLifecycle.test.ts` 大输出只留尾部 + 截断量进 DTO 的贯通用例          |

缺陷 3/4/5 的修法：

- `gitManager.enqueue` 新增 `onEnqueued(operationId, cancel)`，**入队时**就交出这一项的
  队列身份；执行层据此区分：身份 == 当前运行项 → 只终止这一轮的 spawn 并等进程 close；
  否则 → 只让这一项失效，**绝不碰**任何进程。
- **没有身份就不取消任何 Git 队列项**：只把任务本身收尾。
- 推送在保存前先 `commandTaskBegin` 登记本轮（取消在保存阶段即有归属），
  `saving`/`precheck` 两次上报都校验这一轮是否仍有效；无效就收尾为 canceled，
  不进 Git、也不重新认领（不复活已取消的操作）；git 通道带 `run`，主进程只认那一轮。
- `runGit`：spawn 时 `detached` 自成进程组，终止时杀**整个进程组**，
  并把结算同时挂在 `exit` 与 `close` 上。

## 三、验收依据

### 1. 确定性单测

```
pnpm --filter desk test     # 1469 passed / 168 files / 0 skipped
```

关键覆盖：

- `gitManager.test.ts`（17）：跨库隔离、同库先后/排队取消、身份精确取消、abort 与 close 分离、
  `dispose` 四步、`onEnqueued` 入队身份、退出后刷新守卫、commit 阶段 extras。
- `ipc/commandTask.test.ts`（12）：业务结果映射、同一运行只执行一次（并发 3 次→1 次）、
  运行中取消带身份、排队取消不误杀、**保存阶段取消**（无记录时不取消任何队列项、
  执行层一条 Git 命令都不执行）。
- `runGit.test.ts`（2，真 git）：超时必须结算、超时后不留 git 子孙进程。
- `runGitLifecycle.test.ts`（9，可控子进程）：正常退出等输出收尾、大输出只留尾部、
  父进程退出而孙子进程持有管道时不提前结算且强杀兜底仍执行（无残留）、
  取消信号同样等收尾、**主进程先关输出流但仍存活时取消不提前结算**、
  **孙进程关输出流但仍在跑时不得解除占用（清理完成才进终态）**、
  **清理超时到点但进程组仍在时不结算/不注销、不伪造成功**、
  注册/注销配对、无注册表也能工作。
- `disposeSpawn.test.ts`（1，**真实执行路径**）：真实 `GitManager` + 真实 `runGit`
  - 可控远端，验证 `dispose()` 能收掉仍在挂着的 git fetch 且不留进程
    （撤掉 `onSpawn.register` 后该用例 60s 超时失败）。
- `backgroundGitFailure.test.ts`（5）：后台失败落成可见 failed 任务、同因去抖、跨库独立。
- `stores/workspace/git.test.ts`（4）：保存期间取消后不进入 Git、不重新认领、
  保存失败不发生 Git 写操作、正常路径把 run 传给主进程。
- `stores/workspace/documents.test.ts`：外部修改 → `REVISION_CONFLICT` → 标冲突、
  保留本地编辑、revision 不变。

### 2. E2E（真实 Electron + 真实 git + 真实 pty）

| 套件                      | 条数 | 覆盖                                                                                                                                                              |
| ------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e-command-task.mjs`    | 23   | 标签建立、真实输出、推送真的到裸远端、标签复用、失败重试真的推上去、失败通知 +「查看输出」、**超时端到端**（120s 后进程关闭进入 timeout、已有输出不清空、可重试） |
| `e2e-terminal.mjs`        | 13   | 真 node-pty 起 shell、命令经真 PTY 有回显与输出、cwd 绑定知识库、多会话并存、关闭隔离、旧代次输入被拒绝                                                           |
| `e2e-external-change.mjs` | 12   | 打开笔记 → 编辑器输入 → 外部改盘 → 保存 → 弹冲突横幅、**磁盘未被覆盖**、本地编辑没丢、「载入磁盘」可恢复                                                          |

**关于取消隔离的证据口径（统一说明）**：缺陷 3 的"取消排队任务不得误杀同库正在跑的任务"，
**目前只有确定性单测覆盖，E2E 尚未做**。E2E 里只覆盖了它的可观测部分
（排队中的 B 被取消 → B 结算 canceled）。

这不是"不可验证"：本轮已经证明**本地"接受连接但不响应"的 HTTP 服务**是可行的可控装置
（`runGit.test.ts` / `runGitLifecycle.test.ts` 就靠它稳定复现了超时与孙进程占管道的场景），
配合"让前一个任务的 fetch 挂在这个服务上"完全可以把该场景做成 E2E。它列为**尚未做**，
不是做不了。

**关于"重复操作只执行一次"的证据口径**：标签数量不变**只能**说明没有新增标签，
不足以证明命令只执行了一次。真正证明"只执行一次"的是
`ipc/commandTask.test.ts` 的并发用例（3 次并发 `ensureExecution` → 底层调用 1 次）。

### 3. 原有功能回归

按改动面由 runner 选出的套件全部通过；另有冒烟核心集。详见
`command-task-handoff.md` 第六节（含并发超时的环境注记）。

## 四、明确未验证（不要当成已验）

1. **取消隔离的 E2E**：**尚未做**（不是不可做——可控装置已具备，见第三节说明）。
   目前只有确定性单测。
2. **后台定时 fetch / 自动推送的 E2E 触发**：这两条是主进程内部路径，从界面无法确定触发；
   其产物（"一个 failed 任务 → 面板弹通知"）由 `backgroundGitFailure.test.ts` 直接覆盖，
   通知与「查看输出」链路由 `e2e-command-task.mjs` 用一次真实失败覆盖。
3. **Windows**：`detached` 进程组只在非 Windows 生效，Windows 仍是 `child.kill`；
   平台相关行为未在 Windows 上验证。

## 五、门禁

```
pnpm --filter desk test        # 1482 passed / 170 files / 0 skipped
pnpm --filter desk lint        # 0 errors（41 warnings 均为既有）
pnpm --filter desk typecheck   # 0 errors
pnpm format:check              # All matched files use Prettier code style
node apps/desk/scripts/e2e-command-task.mjs       # 23/23
node apps/desk/scripts/e2e-terminal.mjs           # 13/13
node apps/desk/scripts/e2e-external-change.mjs    # 12/12
node scripts/run-e2e.mjs --only delete-dialog,excalidraw-git --concurrency 1   # 2/2
```

## 六、交付物

- `apps/desk/src/main/gitManager.ts`：`onEnqueued` 入队身份、退出后刷新守卫、
  commit 传 extras、进程组终止、`exit`/`close` 与输出收尾分离结算、
  `onSpawn` 登记、运行期间输出缓存上限
- `apps/desk/src/main/ipc/commandTask.ts`：按队列身份精确取消、保存阶段登记、
  无身份不取消任何队列项、按 run 只认本轮
- `apps/desk/src/renderer/src/stores/workspace/git.ts`：保存前 `begin` + 保存后校验
- `apps/desk/src/main/backgroundGitFailure.ts`：后台失败 → 可见任务
- 测试：`gitManager.test.ts`、`ipc/commandTask.test.ts`、`runGit.test.ts`、
  `runGitLifecycle.test.ts`、
  `backgroundGitFailure.test.ts`、`stores/workspace/git.test.ts`、`documents.test.ts`
- E2E：`e2e-command-task.mjs`、`e2e-terminal.mjs`、`e2e-external-change.mjs`（均已注册）
- 文档：本报告与 `command-task-handoff.md`
