# TNotes Monorepo

| 目录                    | 包                       | 说明             |
| ----------------------- | ------------------------ | ---------------- |
| `packages/kb`           | `@tnotesjs/kb`           | 知识库读写 + CLI |
| `packages/ssg`          | `@tnotesjs/ssg`          | 静态站点生成     |
| `packages/ui`           | `@tnotesjs/ui`           | 共享 UI          |
| `packages/mindmap-core` | `@tnotesjs/mindmap-core` | 思维导图引擎     |
| `apps/desk`             | `desk`                   | Electron 桌面端  |
| `apps/nav`              | `tnotes-nav`             | VSCode 导航扩展  |

思维导图 Web 与 VSCode 思维导图扩展已归档（最后版本见提交 `fce5f925`），导图只服务 SSG（只读）与 Desk（可写）。

内部依赖 `workspace:^`。tag：`<目录名>@<版本>`（`desk@*` 触发桌面 Release）。npm：`pnpm -r --filter='./packages/*' publish --no-git-checks`。Node >= 22，pnpm 11.10.0。

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```
