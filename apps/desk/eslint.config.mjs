import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

const CREPE_PORT = 'src/renderer/src/markdown/crepePort'

/**
 * `crepePort/` 的检查范围按「这个文件还是不是上游代码」划，不按目录划。
 * 目录里现在有三种东西（判定方法、上游来源映射与比对命令见该目录的 README）：
 *
 *  1. 与 `@milkdown/crepe@7.22.1` 逐字节相同的移植件（30 个）→ 整体豁免，保住 diff / 重新移植；
 *  2. 搬自上游、已改写，但保留了上游写法（函数不标返回类型等）的文件（24 个）→ 纳入 lint，
 *     只在个别规则上豁免（见下方三处 override），不改写 vendored 代码；
 *  3. Desk 自己写 / 重写的文件（5 个）→ 完全按本仓规则检查，无任何豁免。
 *
 * 这是**持续维护**的边界，不是一次性名单：新移植上游文件、或把某个文件深度重写到不再是
 * 上游代码时，都要回来更新这两份清单与 README 的边界说明。
 *
 * 注意 `VENDORED_VERBATIM` 里有三条是**目录通配**（`theme/**` / `icons/**` / `utils/**`）：
 * 往这三个目录里新增文件不会自动受检，必须回来决定它进哪份清单。其余位置（`blockEdit/`、
 * `latex/`、`toolbar/`、crepePort 根下）的新文件默认纳入 lint。
 */

/** 与上游逐字节相同：只有这些整体豁免。 */
const VENDORED_VERBATIM = [
  // theme 全是 CSS（eslint 本来就不看 CSS），逐字节对照 lib/theme/common/。
  `${CREPE_PORT}/theme/**`,
  // 22 个图标常量逐字节相同；icons/index.ts 是 Desk 自己写的 barrel（只导出这 22 个），
  // 必须取反留在检查范围内。
  `${CREPE_PORT}/icons/**`,
  `!${CREPE_PORT}/icons`,
  `!${CREPE_PORT}/icons/index.ts`,
  // 6 个工具函数逐字节对照 src/utils/。
  `${CREPE_PORT}/utils/**`,
  // 这两个对照 src/feature/latex/ 逐字节相同。
  `${CREPE_PORT}/latex/constants.ts`,
  `${CREPE_PORT}/latex/inline-tooltip/tooltip.ts`
]

/** 搬自上游、保留上游写法的文件：纳入 lint，但豁免「必须写返回类型」。 */
const PORTED_WITH_UPSTREAM_STYLE = [
  `${CREPE_PORT}/blockEdit/handle/component.tsx`,
  `${CREPE_PORT}/blockEdit/handle/index.ts`,
  `${CREPE_PORT}/blockEdit/index.ts`,
  `${CREPE_PORT}/blockEdit/menu/component.tsx`,
  `${CREPE_PORT}/blockEdit/menu/config.ts`,
  `${CREPE_PORT}/blockEdit/menu/index.ts`,
  `${CREPE_PORT}/blockEdit/menu/utils.ts`,
  `${CREPE_PORT}/codemirror.ts`,
  `${CREPE_PORT}/cursor.ts`,
  `${CREPE_PORT}/icons/index.ts`,
  `${CREPE_PORT}/latex/block-latex.ts`,
  `${CREPE_PORT}/latex/command.ts`,
  `${CREPE_PORT}/latex/index.ts`,
  `${CREPE_PORT}/latex/inline-latex.ts`,
  `${CREPE_PORT}/latex/inline-tooltip/view.ts`,
  `${CREPE_PORT}/latex/input-rule.ts`,
  `${CREPE_PORT}/latex/remark.ts`,
  `${CREPE_PORT}/linktooltip.ts`,
  `${CREPE_PORT}/listitem.ts`,
  `${CREPE_PORT}/placeholder.ts`,
  `${CREPE_PORT}/table.ts`,
  `${CREPE_PORT}/toolbar/component.tsx`,
  `${CREPE_PORT}/toolbar/config.ts`,
  `${CREPE_PORT}/toolbar/index.ts`
]

export default defineConfig(
  {
    // electron-builder 的配置必须是 CJS（它用 require 加载），满足不了 TS 规则的
    // 「禁止 require / 必须写返回类型」，所以交给 prettier 管格式、不进 eslint。
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      'playground/**',
      'electron-builder.cjs',
      ...VENDORED_VERBATIM
    ]
  },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  {
    // 上游函数一律不标返回类型（Crepe 自己的风格），补齐等于改写 vendored 代码。
    // 只豁免这一条：其余规则在这 24 个文件里照常生效；Desk 在这些文件里新写的函数
    // 也不受这一条约束 —— 这是明确取舍，等某个文件被深度重写到不再是上游代码时，
    // 把它从 PORTED_WITH_UPSTREAM_STYLE 移出即可。
    files: PORTED_WITH_UPSTREAM_STYLE,
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    // `latex/command.ts:20` 是上游原句：两个分支各自声明 `_tr`，第二处（第 36 行）
    // 会被重新赋值，`prefer-const` 只对第一处成立。为保住与上游的一致不改写。
    files: [`${CREPE_PORT}/latex/command.ts`],
    rules: {
      'prefer-const': 'off'
    }
  },
  {
    // `blockEdit/menu/index.ts:93` 的 `const self = this` 同样是上游原句，上游自己在
    // 上一行留了 `// oxlint-disable-next-line ts/no-this-alias`（上游用 oxlint）。
    files: [`${CREPE_PORT}/blockEdit/menu/index.ts`],
    rules: {
      '@typescript-eslint/no-this-alias': 'off'
    }
  },
  {
    // Shared draft object is intentionally mutated by section panels (same as pre-split SettingsPanel).
    files: ['src/renderer/src/components/settings/**/*.vue'],
    rules: {
      'vue/no-mutating-props': 'off'
    }
  },
  {
    // Store/domain factory helpers return large method bags; annotate via usage sites instead.
    files: [
      'src/renderer/src/stores/workspace/**/*.ts',
      'src/renderer/src/markdown/createDeskRawBlockView.ts'
    ],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    // 开发/验收脚本跑在 Node 或 Electron 主进程里，不是产品代码：
    // - 不要求返回类型标注（脚本里大量一次性小函数）；
    // - 允许 `require()`：`.cjs` 探针只能走 CommonJS（Electron 以 CJS 加载主进程脚本）；
    // - 允许正则里的控制字符：解析 PTY 输出要去掉 ANSI 转义序列。
    files: ['**/*.{test,spec}.{ts,mts,tsx}', 'scripts/**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-control-regex': 'off'
    }
  },
  eslintConfigPrettier
)
