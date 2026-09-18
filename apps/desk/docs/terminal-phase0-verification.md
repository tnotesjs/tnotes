# Desk 终端 · 阶段 0 验证报告

阶段 0 的目标只有一件事：**把「Electron + node-pty 到底能不能用」证清楚**，以及把它的构建要求、环境要求、未验证项记录下来，作为阶段 1 的依据。本报告只描述实测结果，未实测的部分在末尾单列。

## 一、结论

**通过，可以进入阶段 1。** 在 macOS（arm64）上，开发态与打包态都能起真实交互式 shell，数据完整性、中文往返、中断响应、退出清理均达标；不需要 Electron 专用 prebuild、不需要 node-gyp 编译。

需要一并落地的**两项构建要求**（已在本阶段实现）：

1. `pnpm-workspace.yaml` 的 `allowBuilds` 放行 `node-pty`（根配置默认阻止依赖构建脚本）；
2. 安装后修复 node-pty 预构建里 `spawn-helper` 的**可执行位**——npm 打包不保留它，缺失时 `pty.spawn()` 直接报 `posix_spawnp failed.`。

## 二、被测环境

| 项                    | 值                                        |
| --------------------- | ----------------------------------------- |
| Electron              | 39.8.10（仓库锁定版本）                   |
| Node（Electron 内置） | 22.22.1                                   |
| node-pty              | 1.1.0                                     |
| 平台                  | darwin arm64                              |
| 默认 shell            | `/opt/homebrew/bin/bash`（取自 `$SHELL`） |

## 三、验证结果

### 3.1 可用性（开发态，`electron scripts/phase0-pty-probe.cjs`）

| 编号 | 验证点                                             | 结果                                                                                      |
| ---- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A    | node-pty 在 Electron 39 主进程加载并起交互式 shell | ✅ 加载成功、`pid` 正常、起止标记都收到                                                   |
| B    | 环境变量「继承并补全」                             | ✅ **补全项 0 个**（`LANG`/`PATH` 全部继承），shell 内可见 `LANG=en_US.UTF-8`、PATH 27 段 |
| C    | 中文输入输出往返                                   | ✅ 与源串字节一致（含 emoji）                                                             |
| D    | 可计数有限输出完整性                               | ✅ 回读 **100/100 行**，`1..100` 连续且无重复                                             |
| E    | 持续高吞吐完整性                                   | ✅ `seq 1 200000`（1.23MB），shell 侧与宿主侧 md5 **一致**                                |
| F    | `yes` 洪水下的 Ctrl+C                              | ✅ 中断时已收 ~87MB；中断后 600ms 内字节增量仅 34（≈停住），随后 shell 可继续执行命令     |
| G    | 退出清理                                           | ✅ `exitCode=0`，进程不再存活（无残留）                                                   |

### 3.2 打包态

| 编号 | 验证点                                | 结果                                                                              |
| ---- | ------------------------------------- | --------------------------------------------------------------------------------- |
| P1   | `node-pty` 进入打包产物               | ✅ `Contents/Resources/app/node_modules/node-pty`                                 |
| P2   | 预构建可执行位在打包后仍保留          | ✅ `spawn-helper` 为 `-rwxr-xr-x`                                                 |
| P3   | 打包运行时加载 node-pty 并起 shell    | ✅ 在打包 app 的 Electron 运行时里 `LOADED=ok`、`LANG` 正常、中文一致、退出无残留 |
| P4   | 最小环境（模拟 Finder 启动）下的 PATH | ✅ 见下方「PATH 结论」                                                            |

**PATH 结论（P4）**：用 `env -i` 模拟干净启动时，进程继承的 PATH 只有 **5 段**（`/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin:.`，**不含 `/opt/homebrew/bin`**）。此时以 `$SHELL -l` 起登录 shell，shell 自己把 PATH 解析回 **23 段**，`node` / `git` / `brew` 均可用。**因此"继承 + 登录 shell"这一策略足以覆盖 Finder 启动场景，不需要在主进程里手工拼 PATH。**

同一最小环境下补 `TERM`/`COLORTERM`/`LANG` 后，中文往返**仍然字节一致**。

### 3.3 文档级验证不了、已排除的干扰项

- 隔离验证了 F 段的"洪水是否真的停下"：比较中断后 600ms 的字节增量（34 字节，来自提示符输出），而不是只看"后续命令能否执行"。
- 隔离验证了打包态与 dev 态加载的是**同一份 N-API 预构建**：`electron-builder` 的 rebuild 只处理 `@parcel/watcher`，**从未重建 node-pty**。

## 四、构建要求（阶段 1 必须保持）

| 要求         | 落点                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖声明     | `apps/desk/package.json` 的 `node-pty: 1.1.0`（锁定精确版本）                                                                                                          |
| 放行安装脚本 | 根 `pnpm-workspace.yaml` 的 `allowBuilds` 增加 `node-pty: true`                                                                                                        |
| 修复可执行位 | `apps/desk/scripts/fix-node-pty-exec-bits.mjs`，挂在 `postinstall`（在 `electron-builder install-app-deps` 之前）                                                      |
| 打包配置     | **无需改动**：`asar: false` 已让预构建落在真实路径上；entitlements 已含 `com.apple.security.cs.disable-library-validation`（ad-hoc 签名 + hardenedRuntime 场景下需要） |

**不需要**的：Electron 专用 prebuild、`node-gyp` 编译、`asarUnpack` 配置。node-pty 1.1.0 走 **N-API**，npm 包内自带各平台预构建（`prebuilds/<platform>-<arch>/`），ABI 与 Electron 39 兼容。

## 五、踩过的坑（供阶段 1 与后续排查参考）

1. **`spawn-helper` 丢可执行位** → `Error: posix_spawnp failed.`。npm 打包不保留该位；已用 postinstall 修复，并验证幂等（修好后重跑无输出）。
2. **`#` 开头的标记会被 shell 当注释**：`echo #MARK#X:1` 在 bash/zsh 下**输出为空**（`#` 起头的词即注释）。探针标记改用 `@@MARK@@`。
3. **回显会污染计数**：PTY 默认回显输入，命令里出现的字面量会被误当输出（曾把 100 行读成 200 行，也误判过 `LINE=0/100`）。阶段 0 的探针因此改为「只认带独立标记的输出行」。
4. **`os.tmpdir()` ≠ `/tmp`**：macOS 上是 `/var/folders/...`；排查脚本文件是否存在时不要假设 `/tmp`。
5. **`cat -A` 在 macOS 不可用**（GNU 选项），误用它会导致"文件是空的"这类错误判断。

## 六、已定的产品决策（阶段 1 生效）

| 项         | 决定                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 形态       | **独立底部面板**，与编辑器分组并行；终端自己维护会话标签；第一版不扩展 `EditorTab`、不接入 `EditorLayoutNode`；支持拖高、收起、最大化                                                                                                                                                                                                             |
| 快捷键     | **`Cmd/Ctrl+J`**。核查结果：渲染端键盘处理只用到方向键/Backspace/Delete/Enter/Escape/Home/End/Tab，主进程 `tabShortcuts.ts` 绑定 P/U/W/K/A 与 `Ctrl+Alt+C`/`Ctrl+Alt+R`，菜单 accelerator 无 J —— **无冲突**。唯一要留意的是 Monaco 内置把 `Cmd+J` 绑给「切换建议详情」，阶段 1 需要在面板开关上取得优先级（先注册/更早拦截），并把该风险写进验收 |
| Shell 选择 | 第一版只自动探测：`$SHELL` 有效则用；否则回退系统可用 shell；Windows 探测 PowerShell、`cmd.exe` 兜底。配置项留第二版                                                                                                                                                                                                                              |
| 平台       | macOS 先跑通（本阶段已含打包态）；实现保持跨平台结构，未实测平台见下                                                                                                                                                                                                                                                                              |

## 七、未验证项（明确不宣称已支持）

| 项                                                      | 状态                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11                                           | **未实测**。node-pty 包内有 `win32-x64` / `win32-arm64` 预构建；但 Windows 编译需要 Spectre-mitigated 库，且 ConPTY/winpty 行为未验证 |
| Linux（x64/arm64）                                      | **未实测**。仅有 `darwin-*` 与 `win32-*` 预构建（无 `linux-*`），若在 Linux 上安装**会走 node-gyp 编译**，需确认构建镜像具备工具链    |
| 系统自带的正式安装版（`/Applications/TNotes Desk.app`） | 未在其上验证终端（那是既有安装，不属于本次改动）                                                                                      |
| 真正的 Finder 双击启动                                  | 用 `env -i` 最小环境**近似**验证（从终端调用 `open` 会继承父进程环境，不能代表 Finder）。**至今仍未做真实双击验证**，需人工确认一次   |
| 渲染端渲染/流控                                         | 阶段 0 只验证主进程 PTY 数据链路；xterm 接入与水位线流控已在**阶段 1 实现并验收**，见 `terminal-phase1-verification.md`               |

## 八、本阶段落下的改动

| 文件                                           | 改动                                                   |
| ---------------------------------------------- | ------------------------------------------------------ |
| `apps/desk/package.json`                       | 依赖加 `node-pty: 1.1.0`；`postinstall` 前面挂修复脚本 |
| `apps/desk/scripts/fix-node-pty-exec-bits.mjs` | 新增：修复预构建可执行位（幂等、失败不影响安装）       |
| `apps/desk/scripts/phase0-pty-probe.cjs`       | 新增：阶段 0 探针（开发态/打包态均可跑，不进产品入口） |
| `pnpm-workspace.yaml`                          | `allowBuilds` 放行 `node-pty`                          |
| `pnpm-lock.yaml`                               | 新增 node-pty 依赖树                                   |
