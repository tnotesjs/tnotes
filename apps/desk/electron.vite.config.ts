import { cpSync, existsSync } from 'node:fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'

/**
 * Excalidraw 官方字体随包分发。
 *
 * 官方包把资源基址硬编码成 esm.sh CDN；Desk 的 CSP 只允许 self/data，
 * 不把字体放进产物就会出现 `font-src` 报错 + 画布回退字体。渲染端把
 * `EXCALIDRAW_ASSET_PATH` 指到 `tnotes-asset://app/excalidraw/`，主进程
 * 的协议处理器再把 `out/renderer` 下的文件读出来。
 */
function copyExcalidrawFonts(): Plugin {
  let outDir = resolve('out/renderer')
  return {
    name: 'desk:copy-excalidraw-fonts',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const source = resolve(
        '../../packages/ui/node_modules/@excalidraw/excalidraw/dist/prod/fonts'
      )
      if (!existsSync(source)) {
        this.warn(`未找到 Excalidraw 字体目录，画布文本将回退：${source}`)
        return
      }
      cpSync(source, resolve(outDir, 'excalidraw/fonts'), { recursive: true })
    }
  }
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          searchWorker: resolve('src/main/searchWorker.ts'),
          encodeWorker: resolve('src/main/encodeWorker.ts')
        },
        external: ['sharp']
      }
    }
  },
  preload: {},
  renderer: {
    server: {
      /*
       * 允许 dev server 通过 /@fs/ 读取工作区根目录下的文件。
       *
       * 只放行 `apps/`（`resolve('..')`）是不够的：
       * - 兄弟包（`packages/ui` 等）在 `packages/` 下，改它们时要能直接读到源码；
       * - 依赖装在仓库根的 pnpm store（`node_modules/.pnpm/**`）里，Monaco 的
       *   codicon 字体等资源就来自那里，否则会被判成 "outside of Vite serving
       *   allow list"（dev 下 403，表现为字体/模块加载失败）。
       */
      fs: { allow: [resolve('../..')] }
    },
    resolve: {
      alias: [
        { find: '@renderer', replacement: resolve('src/renderer/src') },
        // Use the prebundled ESM build: its diagram chunks ship with CJS deps
        // (dayjs etc.) already inlined. `mermaid.core` pulls raw dayjs.min.js
        // which has no ESM default export and blanks the whole editor when
        // mermaid is left un-optimized; optimizing mermaid.core instead rewrites
        // diagram chunks into flaky `.vite/deps/*` URLs (504).
        { find: 'mermaid', replacement: 'mermaid/dist/mermaid.esm.min.mjs' }
      ]
    },
    plugins: [vue(), vueJsx(), copyExcalidrawFonts()],
    // Local file: packages change often; prebundling freezes an old export map.
    optimizeDeps: {
      exclude: ['@tnotesjs/ui', 'mermaid']
    }
  }
})
