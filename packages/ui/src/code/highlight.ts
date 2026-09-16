import { createHighlighterCore, type HighlighterCore, type ShikiTransformer } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, bundledLanguagesAlias } from 'shiki/langs'

export {
  CODE_BLOCK_COLLAPSED_CLASS,
  applyCollapseChrome,
  codeBlockFrom,
  codeBlockIn,
  collapseButtonLabel,
  expandCollapsedCodeBlocks,
  isCodeBlockCollapsed,
  setCodeBlockCollapsed,
  toggleCodeBlockCollapsed
} from './collapse'

export interface CodeMeta {
  language: string
  title: string
  lineNumbers: boolean
  startLine: number
  highlightedLines: number[]
}

/**
 * A single cross-repository fixture. Core and Desk both consume this contract in
 * their own test suites, so a parser or DOM change cannot silently diverge.
 */
export const SHARED_CODE_GROUP_CONTRACT = {
  source: [
    '::: code-group',
    '```js:line-numbers=4 {2} [one.js]',
    'console.log(1)',
    'console.log(2)',
    '```',
    '```ts:no-line-numbers [two.ts]',
    'const value: number = 2',
    '```',
    ':::'
  ].join('\n'),
  items: [
    {
      info: 'js:line-numbers=4 {2} [one.js]',
      code: 'console.log(1)\nconsole.log(2)',
      title: 'one.js',
      language: 'js',
      lineNumbers: true,
      startLine: 4,
      highlightedLines: [2]
    },
    {
      info: 'ts:no-line-numbers [two.ts]',
      code: 'const value: number = 2',
      title: 'two.ts',
      language: 'ts',
      lineNumbers: false,
      startLine: 1,
      highlightedLines: []
    }
  ]
} as const

export function parseCodeMeta(info = '', defaultLineNumbers = true): CodeMeta {
  const language =
    info
      .trim()
      .match(/^[^\s{\[]+/)?.[0]
      ?.split(':')[0] || 'text'
  const highlightedLines = new Set<number>()
  const ranges = info.match(/\{([\d,\s-]+)\}/)?.[1] || ''
  for (const range of ranges.split(',')) {
    const match = range.trim().match(/^(\d+)(?:-(\d+))?$/)
    if (!match) continue
    const start = Number(match[1])
    const end = Number(match[2] ?? start)
    if (start < 1 || end < start || end - start > 10000) continue
    for (let line = start; line <= end; line++) highlightedLines.add(line)
  }
  return {
    language,
    title: info.match(/\[([^\]]*)\]/)?.[1]?.trim() || '',
    lineNumbers: /:no-line-numbers\b/.test(info)
      ? false
      : /:line-numbers\b/.test(info) || defaultLineNumbers,
    startLine: Math.max(1, Number(info.match(/:line-numbers=(\d+)/)?.[1] || 1)),
    highlightedLines: [...highlightedLines].sort((a, b) => a - b)
  }
}

let singleton: Promise<HighlighterCore> | undefined
let ready: HighlighterCore | undefined
const loading = new Map<string, Promise<void>>()

export function normalizeCodeLanguage(language: string): string {
  const id = language.toLowerCase()
  if (id === 'plain' || id === 'txt' || id === 'plaintext' || !id) return 'text'
  if (id in bundledLanguages || id in bundledLanguagesAlias) return id
  // Unknown labels retain their caption, but display safely as plain text.
  return 'text'
}

/** One engine and one grammar cache for build-time and browser consumers. */
export async function prepareCodeHighlighter(languages: string[] = []): Promise<HighlighterCore> {
  singleton ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
    langs: []
  }).then((highlighter) => (ready = highlighter))
  const highlighter = await singleton
  await Promise.all(
    languages.map(async (requested) => {
      const language = normalizeCodeLanguage(requested)
      if (language === 'text' || highlighter.getLoadedLanguages().includes(language)) return
      let pending = loading.get(language)
      if (!pending) {
        const loader =
          bundledLanguages[language as keyof typeof bundledLanguages] ??
          bundledLanguagesAlias[language as keyof typeof bundledLanguagesAlias]
        if (!loader) return
        pending = highlighter.loadLanguage(loader).then(() => undefined)
        loading.set(language, pending)
        pending.catch(() => loading.delete(language))
      }
      await pending
    })
  )
  return highlighter
}

/**
 * How many characters the line-number gutter has to hold.
 *
 * Counted from the source up front because the width belongs on the root `<pre>`
 * and has to be set before Shiki visits the lines: sizing each `::before` from
 * its own number would let the code text jump between lines.
 */
function lineNumberDigits(source: string, meta: CodeMeta): number {
  return String(meta.startLine + source.split('\n').length - 1).length
}

function transformers(meta: CodeMeta, gutterDigits: number): ShikiTransformer[] {
  // Fence `{N}` line highlights only — match Desk CodeMirror. No Shiki
  // notation transformers (`[!code ++]` etc.); Desk has no write path for them.
  return [
    {
      name: 'tnotes-code-meta',
      pre(node) {
        this.addClassToHast(node, 'tn-code-highlight')
        node.properties.tabindex = 0
        // Inherited by every line's `::before`, which is what sizes the gutter.
        node.properties.style = `--tn-line-digits: ${gutterDigits}`
      },
      line(node, line) {
        node.properties['data-line'] = String(meta.startLine + line - 1)
        if (meta.highlightedLines.includes(line)) this.addClassToHast(node, 'highlighted')
      }
    }
  ]
}

/** Markdown renderers prewarm document languages before their synchronous render pass. */
export function highlightCodeSync(code: string, info = ''): string {
  if (!ready) throw new Error('Call prepareCodeHighlighter before rendering Markdown')
  const meta = parseCodeMeta(info)
  const source = code.replace(/\n$/, '')
  const normalizedLanguage = normalizeCodeLanguage(meta.language)
  const language = ready.getLoadedLanguages().includes(normalizedLanguage)
    ? normalizedLanguage
    : 'text'
  return ready.codeToHtml(source, {
    lang: language,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
    transformers: transformers(meta, lineNumberDigits(source, meta))
  })
}

export async function highlightCode(code: string, info = ''): Promise<string> {
  await prepareCodeHighlighter([parseCodeMeta(info).language])
  return highlightCodeSync(code, info)
}
