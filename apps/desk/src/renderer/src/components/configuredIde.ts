import type { IdeKind } from '../../../shared/contracts'

/** 用户在设置里选了 Cursor 或 VS Code。缺省的空值不是已配置。 */
export function isConfiguredIde(ide: unknown): ide is IdeKind {
  return ide === 'vscode' || ide === 'cursor'
}
