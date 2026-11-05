import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { SchemaReady, inputRulesCtx, schemaCtx } from '@milkdown/kit/core'
import { markRule, nodeRule } from '@milkdown/kit/prose'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  emphasisStarInputRule,
  emphasisUnderscoreInputRule,
  inlineCodeInputRule,
  strongInputRule
} from '@milkdown/kit/preset/commonmark'
import { strikethroughInputRule } from '@milkdown/kit/preset/gfm'
import { $prose } from '@milkdown/kit/utils'

import { TN_NOTES_SLASH_ITEMS } from './slashMenu'
import type { SlashMenuItem } from './slashMenu'
import { parseContainerSource } from '../editor/markdown/containerBody'
import { createDeskCalloutNode, slashCalloutType } from '../editor/markdown/deskCallout'

const OPEN_RAW_SOURCE_META = 'tnotes-open-raw-source'
const blockShortcutKey = new PluginKey('tnotes-block-shortcuts')

const itemsById = new Map(TN_NOTES_SLASH_ITEMS.map((item) => [item.id, item]))

export interface MarkdownBlockShortcut {
  id: string
  label: string
  syntax: string
  aliases: string[]
  trigger: 'Enter' | 'Space' | 'Enter or Space'
}

const blockShortcutDefinitions = [
  { id: 'tip', syntax: ':::tip', aliases: [], trigger: 'Enter' },
  { id: 'info', syntax: ':::info', aliases: [], trigger: 'Enter' },
  { id: 'warning', syntax: ':::warning', aliases: [], trigger: 'Enter' },
  { id: 'danger', syntax: ':::error', aliases: [':::danger'], trigger: 'Enter' },
  { id: 'details', syntax: ':::details', aliases: [], trigger: 'Enter' },
  { id: 'code-group', syntax: ':::code-group', aliases: [], trigger: 'Enter' },
  { id: 'swiper', syntax: ':::swiper', aliases: [], trigger: 'Enter' },
  { id: 'code', syntax: ':::code', aliases: [], trigger: 'Enter' },
  {
    id: 'mermaid',
    syntax: '```mermaid',
    aliases: ['```mmd'],
    trigger: 'Enter or Space'
  },
  {
    id: 'mindmap',
    syntax: '```mindmap',
    aliases: ['```mmp'],
    trigger: 'Enter or Space'
  }
] as const

export const MARKDOWN_BLOCK_SHORTCUTS: MarkdownBlockShortcut[] = blockShortcutDefinitions.map(
  (definition) => ({
    ...definition,
    label: requireItem(definition.id).label,
    aliases: [...definition.aliases],
    trigger: definition.trigger
  })
)

export interface MarkdownInlineShortcut {
  label: string
  syntax: string
  trigger: 'Space'
}

export const MARKDOWN_INLINE_SHORTCUTS: MarkdownInlineShortcut[] = [
  { label: '斜体', syntax: '*文本* 或 _文本_', trigger: 'Space' },
  { label: '粗体', syntax: '**文本** 或 __文本__', trigger: 'Space' },
  { label: '删除线', syntax: '~~文本~~', trigger: 'Space' },
  { label: '行内代码', syntax: '`代码`', trigger: 'Space' },
  { label: '行内公式', syntax: '$公式$', trigger: 'Space' }
]

const enterShortcuts = new Map<string, SlashMenuItem>()
for (const definition of blockShortcutDefinitions) {
  const item = requireItem(definition.id)
  for (const syntax of [definition.syntax, ...definition.aliases]) {
    enterShortcuts.set(syntax, item)
  }
}

function requireItem(id: string): SlashMenuItem {
  const item = itemsById.get(id)
  if (!item) throw new Error(`Missing TNotes insert item: ${id}`)
  return item
}

export function findEnterBlockShortcut(text: string): SlashMenuItem | null {
  return enterShortcuts.get(text.toLowerCase()) ?? null
}

function canReplaceParagraphWith(
  state: EditorState,
  position: number,
  nodeType: NonNullable<EditorState['schema']['nodes'][string]>
): { from: number; to: number } | null {
  const $position = state.doc.resolve(position)
  if ($position.parent.type.name !== 'paragraph') return null
  if (!$position.node(-1).canReplaceWith($position.index(-1), $position.indexAfter(-1), nodeType)) {
    return null
  }
  return { from: $position.before($position.depth), to: $position.after($position.depth) }
}

function rawKindFor(item: SlashMenuItem): 'raw-container' | 'raw-component' | 'raw-diagram' | null {
  if (item.kind === 'mermaid' || item.kind === 'mindmap') return 'raw-diagram'
  if (item.kind === 'component') return 'raw-component'
  if (item.kind === 'container' || item.kind === 'code-group' || item.kind === 'swiper') {
    return 'raw-container'
  }
  return null
}

/**
 * Replace the current root paragraph with the exact insert owned by 0005.
 * This is shared by Enter shortcuts and diagram-space InputRules, so 0006
 * cannot drift from the slash-menu snippets.
 */
export function replaceCurrentParagraphWithItem(
  state: EditorState,
  item: SlashMenuItem,
  position: number
): Transaction | null {
  const calloutType = slashCalloutType(item.id)
  if (calloutType) {
    const parsed = parseContainerSource(item.insert)
    const node = createDeskCalloutNode(state.schema, {
      calloutType,
      title: parsed.title
    })
    if (!node) return null
    const range = canReplaceParagraphWith(state, position, node.type)
    if (!range) return null
    const tr = state.tr.replaceWith(range.from, range.to, node)
    return tr.setSelection(TextSelection.near(tr.doc.resolve(range.from + 1)))
  }

  const codeBlock = state.schema.nodes.code_block

  if (item.kind === 'code') {
    if (!codeBlock) return null
    const range = canReplaceParagraphWith(state, position, codeBlock)
    if (!range) return null
    const node = codeBlock.create({ language: 'js' })
    const tr = state.tr.replaceWith(range.from, range.to, node)
    return tr.setSelection(TextSelection.near(tr.doc.resolve(range.from + 1)))
  }

  const rawKind = rawKindFor(item)
  const rawBlock = state.schema.nodes.deskRawBlock
  if (!rawKind || !rawBlock) return null
  const range = canReplaceParagraphWith(state, position, rawBlock)
  if (!range) return null

  const node = rawBlock.create({ kind: rawKind, source: item.insert, hidden: false })
  return state.tr.replaceWith(range.from, range.to, node).setMeta(OPEN_RAW_SOURCE_META, {
    pos: range.from
  })
}

function makeDiagramSpaceRule(pattern: RegExp, item: SlashMenuItem): InputRule {
  return new InputRule(pattern, (state, _match, start) =>
    replaceCurrentParagraphWithItem(state, item, start)
  )
}

function makeMiddleDotCodeFenceRule(): InputRule {
  const rule = new InputRule(/^···$/, (state, _match, start, end) => {
    const $start = state.doc.resolve(start)
    const codeBlock = state.schema.nodes.code_block
    // Only a paragraph consisting entirely of the trigger may become code.
    // This also handles IMEs committing all three dots in one input event.
    if (
      !codeBlock ||
      !state.selection.empty ||
      $start.parent.type.name !== 'paragraph' ||
      $start.parentOffset !== 0 ||
      end !== $start.end() ||
      !$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), codeBlock)
    ) {
      return null
    }
    // Use the same node type/default attributes as the native backtick rule.
    const tr = state.tr.delete(start, end).setBlockType(start, start, codeBlock)
    // A batched IME input starts in an empty paragraph (start === end). Force
    // selection sync even though its numeric position did not change, so the
    // new CodeMirror NodeView receives focus instead of leaving a stale caret.
    return tr.setSelection(TextSelection.create(tr.doc, start)).scrollIntoView()
  })
  rule.inCodeMark = false
  return rule
}

function makeNonUndoable<T extends InputRule>(rule: T): T {
  ;(rule as unknown as { undoable: boolean }).undoable = false
  return rule
}

function inputRulePattern(rule: InputRule): string {
  // ProseMirror exposes this at runtime but omits it from Milkdown's re-exported type.
  return (rule as InputRule & { match: RegExp }).match.source
}

function replacedDefaultInlineRules(): Set<InputRule> {
  return new Set(
    [
      emphasisStarInputRule.inputRule,
      emphasisUnderscoreInputRule.inputRule,
      inlineCodeInputRule.inputRule,
      strongInputRule.inputRule,
      strikethroughInputRule.inputRule
    ].filter((rule): rule is InputRule => Boolean(rule))
  )
}

function isDefaultInlineMathRule(rule: InputRule): boolean {
  // Crepe's LaTeX input rule is not exported from its public entry point.
  // Match its stable Milkdown 7.22.1 regexp rather than importing a private path.
  return inputRulePattern(rule) === '(?:\\$)([^$]+)(?:\\$)$'
}

function isDefaultCodeFenceRule(rule: InputRule): boolean {
  return inputRulePattern(rule) === '^```(?<language>[a-z]*)?[\\s\\n]$'
}

function buildSpaceTriggeredInlineRules(stateSchema: EditorState['schema']): InputRule[] {
  const emphasis = stateSchema.marks.emphasis
  const strong = stateSchema.marks.strong
  const inlineCode = stateSchema.marks.inlineCode
  const strike = stateSchema.marks.strike_through
  const mathInline = stateSchema.nodes.math_inline
  const rules: InputRule[] = []

  if (strong) {
    rules.push(
      makeNonUndoable(
        markRule(/(?<![\w:/*])\*\*([^*\n]+)\*\* $/, strong, {
          getAttr: () => ({ marker: '*' })
        })
      ),
      makeNonUndoable(
        markRule(/(?<![\w:/_])__([^_\n]+)__ $/, strong, {
          getAttr: () => ({ marker: '_' })
        })
      )
    )
  }

  if (emphasis) {
    rules.push(
      makeNonUndoable(
        markRule(/(?<!\*)\*([^*\n]+)\* $/, emphasis, {
          getAttr: () => ({ marker: '*' })
        })
      ),
      makeNonUndoable(
        markRule(/(?<![\w_])_([^_\n]+)_ $/, emphasis, {
          getAttr: () => ({ marker: '_' })
        })
      )
    )
  }

  if (strike) {
    rules.push(makeNonUndoable(markRule(/(?<![\w:/~])~~([^~\n]+)~~ $/, strike)))
  }

  if (inlineCode) {
    const rule = makeNonUndoable(markRule(/(?<!`)`([^`\n]+)` $/, inlineCode))
    rule.inCodeMark = false
    rules.push(rule)
  }

  if (mathInline) {
    const rule = makeNonUndoable(
      nodeRule(/(?<!\$)\$([^$\n]+)\$ $/, mathInline, {
        getAttr: (match) => ({ value: match[1] ?? '' })
      })
    )
    rule.inCodeMark = false
    rules.push(rule)
  }

  return rules
}

/**
 * 0006 + 0007 input-rule layer.
 *
 * It runs after Crepe registers its presets but before EditorState is built:
 * diagram rules are placed before the generic code-fence rule, while default
 * inline mark/math rules are replaced with space-triggered, non-undoable ones.
 */
export function createMarkdownShortcutInputRules(): MilkdownPlugin {
  return (ctx) => async () => {
    await ctx.wait(SchemaReady)

    const schema = ctx.get(schemaCtx)
    const blockRules = [
      makeMiddleDotCodeFenceRule(),
      makeDiagramSpaceRule(/^```(?:mermaid|mmd) $/i, requireItem('mermaid')),
      makeDiagramSpaceRule(/^```(?:mindmap|mmp) $/i, requireItem('mindmap'))
    ]
    const inlineRules = buildSpaceTriggeredInlineRules(schema)
    const replacedRules = replacedDefaultInlineRules()

    ctx.update(inputRulesCtx, (current) => {
      const retained = current.filter(
        (rule) => !replacedRules.has(rule) && !isDefaultInlineMathRule(rule)
      )
      const codeFenceIndex = retained.findIndex(isDefaultCodeFenceRule)
      if (codeFenceIndex < 0) return [...blockRules, ...retained, ...inlineRules]
      return [
        ...retained.slice(0, codeFenceIndex),
        ...blockRules,
        ...retained.slice(codeFenceIndex),
        ...inlineRules
      ]
    })

    return () => {
      ctx.update(inputRulesCtx, (current) =>
        current.filter((rule) => !blockRules.includes(rule) && !inlineRules.includes(rule))
      )
    }
  }
}

export interface BlockShortcutOptions {
  onRawBlockInserted: (position: number) => void
}

/** Enter-triggered half of 0006 plus the post-transaction source-editor hook. */
export function createBlockShortcutPlugin(options: BlockShortcutOptions): MilkdownPlugin {
  return $prose(() => {
    let editorView: EditorView | null = null

    return new Plugin({
      key: blockShortcutKey,
      view: (view) => {
        editorView = view
        return {
          update: (nextView) => {
            editorView = nextView
          },
          destroy: () => {
            editorView = null
          }
        }
      },
      appendTransaction: (transactions) => {
        const request = transactions
          .map((transaction) => transaction.getMeta(OPEN_RAW_SOURCE_META) as { pos: number } | null)
          .find(Boolean)
        if (request && editorView) {
          window.setTimeout(() => options.onRawBlockInserted(request.pos), 0)
        }
        return null
      },
      props: {
        handleKeyDown: (view, event) => {
          if (
            event.key !== 'Enter' ||
            event.shiftKey ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.isComposing
          ) {
            return false
          }

          const { selection } = view.state
          if (!(selection instanceof TextSelection) || !selection.empty) return false
          const { $from } = selection
          if ($from.parent.type.name !== 'paragraph') return false

          const item = findEnterBlockShortcut($from.parent.textContent)
          if (!item) return false
          const transaction = replaceCurrentParagraphWithItem(view.state, item, $from.pos)
          if (!transaction) return false
          view.dispatch(transaction)
          return true
        }
      }
    })
  })
}
