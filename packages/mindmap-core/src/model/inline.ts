/**
 * 轻量 Markdown 行内模型。
 * raw 是唯一持久化数据；segments 只用于渲染、选区格式化与链接编辑。
 * 支持 Markdown 原生标记以及项目方言 ==高亮==、<u>下划线</u>。
 */

export interface ImageInfo {
  src: string
  alt: string
  /** 显示宽度 px；null 表示使用默认宽度 */
  width: number | null
}

export interface NodeContent {
  /** 展示用纯文本（已去除行内标记） */
  text: string
  /** 行内 Markdown 源码 */
  raw: string
  /** 整个节点是单一链接时提供，兼容既有 Canvas 命中逻辑。 */
  link: string | null
  image: ImageInfo | null
  /** null = 非任务节点 */
  checked: boolean | null
}

export type InlineFormat = 'bold' | 'italic' | 'underline' | 'strike' | 'highlight' | 'code'

export interface InlineMarks {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  highlight: boolean
  code: boolean
}

/**
 * 引用式链接的原始写法：`[文字][id]`（id 非空）、`[文字][]`（id 为空串）、`[文字]`（id 为 null）。
 * 序列化时据此写回引用语法，不把定义里的地址内联进 raw。
 */
export interface InlineLinkReference {
  id: string | null
  /** 原文里的标签源码（方括号内），用于 `[文字][]` / `[文字]` 改字后仍指向同一条定义。 */
  label: string
}

export interface InlineLink {
  url: string
  /** 链接在原始 raw 中的范围，用于 hover 浮层精确更新这一处链接。 */
  rawStart: number
  rawEnd: number
  /** 来自引用定义的链接；行内链接 `[文字](url)` 没有该字段。 */
  reference?: InlineLinkReference
}

/**
 * 链接引用定义（`[id]: url`），key 为 `normalizeLinkLabel` 规范化后的标签。
 * 导图围栏只含 H1 + 列表，定义通常在围栏外，由宿主传入；没有定义时引用式写法按普通文本处理。
 */
export type LinkDefinitions = ReadonlyMap<string, string>

export interface InlineParseOptions {
  definitions?: LinkDefinitions | null
}

/** CommonMark 标签匹配：去首尾空白、连续空白折成一个空格、大小写不敏感。 */
export function normalizeLinkLabel(label: string): string {
  return label
    .trim()
    .replace(/[ \t\r\n]+/g, ' ')
    .toLowerCase()
}

/** 把宿主给的定义（Map / 普通对象 / 键值对）整理成规范化 key 的 Map；同名标签以第一次出现为准。 */
export function createLinkDefinitions(
  input?: Iterable<readonly [string, string]> | Record<string, string> | null
): Map<string, string> {
  const out = new Map<string, string>()
  if (!input) return out
  const entries: Iterable<readonly [string, string]> =
    Symbol.iterator in Object(input)
      ? (input as Iterable<readonly [string, string]>)
      : Object.entries(input as Record<string, string>)
  for (const [label, url] of entries) {
    const key = normalizeLinkLabel(label)
    if (key && url && !out.has(key)) out.set(key, url)
  }
  return out
}

export interface InlineSegment {
  text: string
  marks: InlineMarks
  link: InlineLink | null
  /** 文字在 raw 中的实际范围；语法标记不包含在内。 */
  rawStart: number
  rawEnd: number
}

export interface InlineAttributes {
  marks: InlineMarks
  linkUrl: string | null
  /** 继承的是引用式链接时带上引用写法，插入的文字并入后仍写回 `[文字][id]`。 */
  linkReference?: InlineLinkReference
}

const EMPTY_MARKS: InlineMarks = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  highlight: false,
  code: false
}

const IMAGE_RE = /^!\[([^\]]*)\]\(([^()\s]+)\)$/
const WHOLE_LINK_RE = /^\[([^\]]+)\]\(([^()\s]+)\)$/
const LINK_AT_START_RE = /^\[([^\]]+)\]\(([^()\s]+)\)/
/** CommonMark 链接标签：方括号内不能有未转义的方括号。 */
const LINK_LABEL_AT_START_RE = /^\[((?:\\.|[^[\]\\])*)\]/
const ALT_WIDTH_RE = /^(.*)\|(\d+)$/

interface FormatDelimiter {
  open: string
  close: string
  formats: InlineFormat[]
}

/** 较长标记必须先于 * / _。 */
const FORMAT_DELIMITERS: FormatDelimiter[] = [
  { open: '***', close: '***', formats: ['bold', 'italic'] },
  { open: '___', close: '___', formats: ['bold', 'italic'] },
  { open: '**', close: '**', formats: ['bold'] },
  { open: '__', close: '__', formats: ['bold'] },
  { open: '~~', close: '~~', formats: ['strike'] },
  { open: '==', close: '==', formats: ['highlight'] },
  { open: '<u>', close: '</u>', formats: ['underline'] },
  { open: '`', close: '`', formats: ['code'] },
  { open: '*', close: '*', formats: ['italic'] },
  { open: '_', close: '_', formats: ['italic'] }
]

function copyMarks(marks: InlineMarks): InlineMarks {
  return { ...marks }
}

function sameMarks(a: InlineMarks, b: InlineMarks): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.highlight === b.highlight &&
    a.code === b.code
  )
}

function sameLink(a: InlineLink | null, b: InlineLink | null): boolean {
  return (
    a === b || (!!a && !!b && a.url === b.url && a.rawStart === b.rawStart && a.rawEnd === b.rawEnd)
  )
}

function pushSegment(out: InlineSegment[], segment: InlineSegment): void {
  if (!segment.text) return
  const previous = out[out.length - 1]
  if (
    previous &&
    previous.rawEnd === segment.rawStart &&
    sameMarks(previous.marks, segment.marks) &&
    sameLink(previous.link, segment.link)
  ) {
    previous.text += segment.text
    previous.rawEnd = segment.rawEnd
    return
  }
  out.push(segment)
}

function parseRange(
  raw: string,
  start: number,
  end: number,
  marks: InlineMarks,
  inheritedLink: InlineLink | null,
  out: InlineSegment[],
  definitions: LinkDefinitions | null
): void {
  let index = start
  while (index < end) {
    if (raw[index] === '\\' && index + 1 < end) {
      pushSegment(out, {
        text: raw[index + 1],
        marks: copyMarks(marks),
        link: inheritedLink,
        rawStart: index,
        rawEnd: index + 2
      })
      index += 2
      continue
    }

    if (!marks.code && raw[index] === '[') {
      const match = LINK_AT_START_RE.exec(raw.slice(index, end))
      if (match) {
        const labelStart = index + 1
        const labelEnd = labelStart + match[1].length
        const link: InlineLink = { url: match[2], rawStart: index, rawEnd: index + match[0].length }
        parseRange(raw, labelStart, labelEnd, marks, link, out, definitions)
        index += match[0].length
        continue
      }
      // `![图][1]` 是引用式图片，不是链接；导图节点图片只支持 `![alt](src)`，整段按字面量保留
      const isImage = raw[index - 1] === '!' && raw[index - 2] !== '\\'
      const reference = inheritedLink ? null : referenceLinkAt(raw, index, end, definitions)
      if (reference && isImage) {
        pushSegment(out, {
          text: raw.slice(index, reference.link.rawEnd),
          marks: copyMarks(marks),
          link: null,
          rawStart: index,
          rawEnd: reference.link.rawEnd
        })
        index = reference.link.rawEnd
        continue
      }
      if (reference) {
        parseRange(
          raw,
          index + 1,
          index + 1 + reference.link.reference!.label.length,
          marks,
          reference.link,
          out,
          definitions
        )
        index = reference.link.rawEnd
        continue
      }
    }

    let parsedFormat = false
    for (const delimiter of FORMAT_DELIMITERS) {
      if (!raw.startsWith(delimiter.open, index)) continue
      const contentStart = index + delimiter.open.length
      const closeIndex = raw.indexOf(delimiter.close, contentStart)
      if (closeIndex < 0 || closeIndex >= end) continue
      const nextMarks = copyMarks(marks)
      delimiter.formats.forEach((format) => (nextMarks[format] = true))
      if (delimiter.formats.includes('code')) {
        pushSegment(out, {
          text: raw.slice(contentStart, closeIndex),
          marks: nextMarks,
          link: inheritedLink,
          rawStart: contentStart,
          rawEnd: closeIndex
        })
      } else {
        parseRange(raw, contentStart, closeIndex, nextMarks, inheritedLink, out, definitions)
      }
      index = closeIndex + delimiter.close.length
      parsedFormat = true
      break
    }
    if (parsedFormat) continue

    pushSegment(out, {
      text: raw[index],
      marks: copyMarks(marks),
      link: inheritedLink,
      rawStart: index,
      rawEnd: index + 1
    })
    index++
  }
}

/**
 * `index` 处若是可解析的引用式链接，返回链接信息（rawEnd 为整个引用写法的结束位置）。
 * 规则同 CommonMark：`[文字][id]` 按 id 查定义，`[文字][]` / `[文字]` 按文字查定义；
 * 查不到就不是链接，按普通文本处理。`[文字][未定义]` 中的 `[文字]` 也不再当 shortcut。
 */
function referenceLinkAt(
  raw: string,
  index: number,
  end: number,
  definitions: LinkDefinitions | null
): { link: InlineLink } | null {
  if (!definitions || definitions.size === 0) return null
  const slice = raw.slice(index, end)
  const labelMatch = LINK_LABEL_AT_START_RE.exec(slice)
  if (!labelMatch) return null
  const label = labelMatch[1]
  const labelKey = normalizeLinkLabel(label)
  if (!labelKey) return null
  let after = labelMatch[0].length
  let id: string | null = null
  if (slice[after] === '[') {
    const idMatch = LINK_LABEL_AT_START_RE.exec(slice.slice(after))
    if (idMatch) {
      id = idMatch[1]
      after += idMatch[0].length
    }
  }
  const key = id === null || id.trim() === '' ? labelKey : normalizeLinkLabel(id)
  // `[文字][  ]` 这类只有空白的 id 不合法，CommonMark 也不当 collapsed 处理
  if (id !== null && id !== '' && id.trim() === '') return null
  const url = definitions.get(key)
  if (!url) return null
  return {
    link: { url, rawStart: index, rawEnd: index + after, reference: { id, label } }
  }
}

export function parseInlineSegments(raw: string, options?: InlineParseOptions): InlineSegment[] {
  const out: InlineSegment[] = []
  parseRange(raw, 0, raw.length, EMPTY_MARKS, null, out, options?.definitions ?? null)
  return out
}

export function plainContent(text: string): NodeContent {
  return { text, raw: text, link: null, image: null, checked: null }
}

export function stripInline(md: string, options?: InlineParseOptions): string {
  return parseInlineSegments(md, options)
    .map((segment) => segment.text)
    .join('')
}

/** 整个节点就是一个链接（行内或引用式）时返回地址。 */
function wholeLinkUrl(raw: string, segments: InlineSegment[]): string | null {
  const first = segments[0]?.link
  if (!first || first.rawStart !== 0 || first.rawEnd !== raw.length) return null
  return segments.every((segment) => segment.link === first) ? first.url : null
}

export function parseInline(raw: string, options?: InlineParseOptions): NodeContent {
  const trimmed = raw.trim()
  const img = IMAGE_RE.exec(trimmed)
  if (img) {
    let alt = img[1]
    let width: number | null = null
    const w = ALT_WIDTH_RE.exec(alt)
    if (w) {
      alt = w[1]
      width = parseInt(w[2], 10)
    }
    return {
      text: alt || '图片',
      raw: trimmed,
      link: null,
      image: { src: img[2], alt, width },
      checked: null
    }
  }

  const wholeLink = WHOLE_LINK_RE.exec(trimmed)
  const segments = parseInlineSegments(trimmed, options)
  return {
    text: segments.map((segment) => segment.text).join(''),
    raw: trimmed,
    link: wholeLink?.[2] ?? wholeLinkUrl(trimmed, segments),
    image: null,
    checked: null
  }
}

function escapeInlineText(text: string): string {
  return text.replace(/([\\`*_[\]~=<>])/g, '\\$1')
}

function safeLinkUrl(url: string): string {
  return url.trim().replace(/\s/g, '%20').replace(/\)/g, '%29')
}

function mergeCanonicalSegments(segments: InlineSegment[]): InlineSegment[] {
  const out: InlineSegment[] = []
  for (const segment of segments) {
    if (!segment.text) continue
    const previous = out[out.length - 1]
    const sameCanonicalLink =
      previous?.link?.url === segment.link?.url && !!previous?.link === !!segment.link
    if (previous && sameMarks(previous.marks, segment.marks) && sameCanonicalLink) {
      previous.text += segment.text
      // 在引用式链接开头插入文字：新片段只继承了地址，引用写法以已有片段为准
      if (previous.link && !previous.link.reference && segment.link?.reference) {
        previous.link = { ...previous.link, reference: segment.link.reference }
      }
      continue
    }
    out.push({
      ...segment,
      marks: copyMarks(segment.marks),
      link: segment.link ? { ...segment.link } : null
    })
  }
  return out
}

interface SerializedMark {
  format: InlineFormat
  open: string
  close: string
}

/**
 * 固定使用「粗体在外、斜体在内」的嵌套顺序。
 * 除了能稳定生成 ***粗斜体***，也与上面的轻量解析器的优先级一致。
 */
const SERIALIZED_MARKS: SerializedMark[] = [
  { format: 'bold', open: '**', close: '**' },
  { format: 'italic', open: '*', close: '*' },
  { format: 'underline', open: '<u>', close: '</u>' },
  { format: 'strike', open: '~~', close: '~~' },
  { format: 'highlight', open: '==', close: '==' },
  { format: 'code', open: '`', close: '`' }
]

/**
 * 按连续区间递归序列化，而不是给每一个 segment 独立包标记。
 * 例如整段加粗后的「粗斜体 + 普通 + 删除线」会输出
 * `***粗斜体* 普通 ~~删除线~~**`，避免产生相邻的 `*****` 标记汤。
 */
function serializeMarkedSegments(segments: InlineSegment[], markIndex = 0): string {
  if (markIndex >= SERIALIZED_MARKS.length) {
    return segments.map((segment) => escapeInlineText(segment.text)).join('')
  }

  const mark = SERIALIZED_MARKS[markIndex]
  let result = ''
  let start = 0
  while (start < segments.length) {
    const enabled = segments[start].marks[mark.format]
    let end = start + 1
    while (end < segments.length && segments[end].marks[mark.format] === enabled) end++

    const run = segments.slice(start, end)
    if (enabled && mark.format === 'code') {
      // 行内代码是最内层语义，只转义自身分隔符，内容中的 Markdown 保持字面量。
      const code = run
        .map((segment) => segment.text)
        .join('')
        .replace(/`/g, '\\`')
      result += `${mark.open}${code}${mark.close}`
    } else {
      const body = serializeMarkedSegments(run, markIndex + 1)
      result += enabled ? `${mark.open}${body}${mark.close}` : body
    }
    start = end
  }
  return result
}

/**
 * 引用式链接写回引用语法：`[文字][id]` 原样；`[文字][]` / `[文字]` 若文字改了、
 * 已不能再按文字查到定义，就补上原标签写成 `[新文字][原标签]`，仍指向同一条定义。
 */
function serializeReferenceLink(
  body: string,
  reference: InlineLinkReference,
  nextChar: string | undefined
): string {
  if (reference.id) return `[${body}][${reference.id}]`
  if (normalizeLinkLabel(body) !== normalizeLinkLabel(reference.label)) {
    return `[${body}][${reference.label}]`
  }
  // shortcut 后面紧跟 `(` / `[` 会被读成别的链接，改写成等价的 collapsed 形式
  if (reference.id === null && nextChar !== '(' && nextChar !== '[') return `[${body}]`
  return `[${body}][]`
}

export function serializeInlineSegments(segments: InlineSegment[]): string {
  const canonical = mergeCanonicalSegments(segments)
  const runs: Array<{ body: string; url: string | null; reference?: InlineLinkReference }> = []
  let start = 0
  while (start < canonical.length) {
    const linkUrl = canonical[start].link?.url ?? null
    let end = start + 1
    while (end < canonical.length && (canonical[end].link?.url ?? null) === linkUrl) end++

    const run = canonical.slice(start, end)
    runs.push({
      body: serializeMarkedSegments(run),
      url: linkUrl,
      reference: run.find((segment) => segment.link?.reference)?.link?.reference
    })
    start = end
  }
  return runs
    .map((run, index) => {
      if (!run.url) return run.body
      if (run.reference)
        return serializeReferenceLink(run.body, run.reference, runs[index + 1]?.body[0])
      return `[${run.body}](${safeLinkUrl(run.url)})`
    })
    .join('')
}

interface PlainRawMap {
  text: string
  startBoundaries: number[]
  endBoundaries: number[]
}

function plainRawMap(raw: string, options?: InlineParseOptions): PlainRawMap {
  const segments = parseInlineSegments(raw, options)
  const text = segments.map((segment) => segment.text).join('')
  const startBoundaries = new Array<number>(text.length + 1).fill(raw.length)
  const endBoundaries = new Array<number>(text.length + 1).fill(0)
  let plainOffset = 0
  for (const segment of segments) {
    const rawLength = segment.rawEnd - segment.rawStart
    for (let i = 0; i < segment.text.length; i++) {
      const relativeStart = Math.floor((i * rawLength) / segment.text.length)
      const relativeEnd = Math.ceil(((i + 1) * rawLength) / segment.text.length)
      startBoundaries[plainOffset + i] = segment.rawStart + relativeStart
      endBoundaries[plainOffset + i + 1] = segment.rawStart + relativeEnd
    }
    plainOffset += segment.text.length
  }
  if (text.length === 0) {
    startBoundaries[0] = 0
    endBoundaries[0] = 0
  } else {
    endBoundaries[0] = startBoundaries[0]
    startBoundaries[text.length] = endBoundaries[text.length]
  }
  return { text, startBoundaries, endBoundaries }
}

/** 保留既有标记和链接地址，只替换用户看到的文字差异。 */
export function replaceInlineDisplayText(
  raw: string,
  nextText: string,
  options?: InlineParseOptions
): string {
  const map = plainRawMap(raw, options)
  if (map.text === nextText) return raw
  if (!nextText) return ''

  let prefix = 0
  while (
    prefix < map.text.length &&
    prefix < nextText.length &&
    map.text[prefix] === nextText[prefix]
  )
    prefix++
  let suffix = 0
  while (
    suffix < map.text.length - prefix &&
    suffix < nextText.length - prefix &&
    map.text[map.text.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  )
    suffix++

  const oldEnd = map.text.length - suffix
  const replacement = nextText.slice(prefix, nextText.length - suffix)
  return replaceInlineRange(raw, prefix, oldEnd, replacement, undefined, options)
}

function splitSegmentsAtPlainRange(
  raw: string,
  start: number,
  end: number,
  options?: InlineParseOptions
): {
  before: InlineSegment[]
  selected: InlineSegment[]
  after: InlineSegment[]
} {
  const before: InlineSegment[] = []
  const selected: InlineSegment[] = []
  const after: InlineSegment[] = []
  let offset = 0
  for (const segment of parseInlineSegments(raw, options)) {
    const segmentStart = offset
    const segmentEnd = offset + segment.text.length
    const pieces = [
      { from: segmentStart, to: Math.min(segmentEnd, start), target: before },
      { from: Math.max(segmentStart, start), to: Math.min(segmentEnd, end), target: selected },
      { from: Math.max(segmentStart, end), to: segmentEnd, target: after }
    ]
    for (const piece of pieces) {
      if (piece.to <= piece.from) continue
      const localStart = piece.from - segmentStart
      const localEnd = piece.to - segmentStart
      piece.target.push({
        ...segment,
        text: segment.text.slice(localStart, localEnd),
        marks: copyMarks(segment.marks),
        link: segment.link ? { ...segment.link } : null
      })
    }
    offset = segmentEnd
  }
  return { before, selected, after }
}

function segmentAttributes(segment: InlineSegment): InlineAttributes {
  const attributes: InlineAttributes = {
    marks: copyMarks(segment.marks),
    linkUrl: segment.link?.url ?? null
  }
  if (segment.link?.reference) attributes.linkReference = segment.link.reference
  return attributes
}

/** 获取纯文本 offset 处输入应继承的行内属性。边界默认继承左侧 run。 */
export function inlineAttributesAt(
  raw: string,
  offset: number,
  affinity: 'backward' | 'forward' = 'backward',
  options?: InlineParseOptions
): InlineAttributes {
  const segments = parseInlineSegments(raw, options)
  const textLength = segments.reduce((total, segment) => total + segment.text.length, 0)
  const target = Math.max(0, Math.min(textLength, offset))
  let plainStart = 0
  let previous: InlineSegment | null = null

  for (const segment of segments) {
    const plainEnd = plainStart + segment.text.length
    if (target > plainStart && target < plainEnd) {
      return segmentAttributes(segment)
    }
    if (target === plainStart) {
      return segmentAttributes(affinity === 'backward' && previous ? previous : segment)
    }
    if (target === plainEnd && affinity === 'backward') {
      return segmentAttributes(segment)
    }
    previous = segment
    plainStart = plainEnd
  }

  return previous ? segmentAttributes(previous) : { marks: copyMarks(EMPTY_MARKS), linkUrl: null }
}

/**
 * 按纯文本范围安全替换行内内容。
 * 删除与插入都先在 segments 层完成，再统一序列化，绝不会留下半个 Markdown 标记。
 */
export function replaceInlineRange(
  raw: string,
  start: number,
  end: number,
  text: string,
  attributes?: InlineAttributes,
  options?: InlineParseOptions
): string {
  const textLength = stripInline(raw, options).length
  const from = Math.max(0, Math.min(textLength, Math.min(start, end)))
  const to = Math.max(from, Math.min(textLength, Math.max(start, end)))
  const parts = splitSegmentsAtPlainRange(raw, from, to, options)

  const inherited =
    attributes ??
    (() => {
      const firstSelected = parts.selected[0]
      if (firstSelected) return segmentAttributes(firstSelected)
      return inlineAttributesAt(raw, from, from === 0 ? 'forward' : 'backward', options)
    })()

  const inserted: InlineSegment[] = text
    ? [
        {
          text,
          marks: copyMarks(inherited.marks),
          link: inherited.linkUrl
            ? {
                url: inherited.linkUrl,
                rawStart: 0,
                rawEnd: 0,
                ...(inherited.linkReference ? { reference: inherited.linkReference } : {})
              }
            : null,
          rawStart: 0,
          rawEnd: 0
        }
      ]
    : []
  return serializeInlineSegments([...parts.before, ...inserted, ...parts.after])
}

export function inlineFormatActive(
  raw: string,
  start: number,
  end: number,
  format: InlineFormat,
  options?: InlineParseOptions
): boolean {
  const textLength = stripInline(raw, options).length
  const from = Math.max(0, Math.min(textLength, start))
  const to = Math.max(from, Math.min(textLength, end))
  if (from === to) return false
  const { selected } = splitSegmentsAtPlainRange(raw, from, to, options)
  return selected.length > 0 && selected.every((segment) => segment.marks[format])
}

export function toggleInlineFormat(
  raw: string,
  start: number,
  end: number,
  format: InlineFormat,
  options?: InlineParseOptions
): string {
  return setInlineFormat(
    raw,
    start,
    end,
    format,
    !inlineFormatActive(raw, start, end, format, options),
    options
  )
}

export function setInlineFormat(
  raw: string,
  start: number,
  end: number,
  format: InlineFormat,
  enabled: boolean,
  options?: InlineParseOptions
): string {
  const textLength = stripInline(raw, options).length
  const from = Math.max(0, Math.min(textLength, start))
  const to = Math.max(from, Math.min(textLength, end))
  if (from === to) return raw
  const parts = splitSegmentsAtPlainRange(raw, from, to, options)
  parts.selected.forEach((segment) => {
    segment.marks[format] = enabled
    // 幕布口径：高亮笔与行内代码是两个入口，但同一段文字不能叠加。
    if (enabled && format === 'code') segment.marks.highlight = false
    if (enabled && format === 'highlight') segment.marks.code = false
  })
  return serializeInlineSegments([...parts.before, ...parts.selected, ...parts.after])
}

/** 清除选区的行内样式，保留文字和链接地址。 */
export function clearInlineFormats(
  raw: string,
  start: number,
  end: number,
  options?: InlineParseOptions
): string {
  const textLength = stripInline(raw, options).length
  const from = Math.max(0, Math.min(textLength, start))
  const to = Math.max(from, Math.min(textLength, end))
  if (from === to) return raw
  const parts = splitSegmentsAtPlainRange(raw, from, to, options)
  parts.selected.forEach((segment) => {
    segment.marks = copyMarks(EMPTY_MARKS)
  })
  return serializeInlineSegments([...parts.before, ...parts.selected, ...parts.after])
}

export function setInlineLink(
  raw: string,
  start: number,
  end: number,
  url: string | null,
  options?: InlineParseOptions
): string {
  const textLength = stripInline(raw, options).length
  const from = Math.max(0, Math.min(textLength, start))
  const to = Math.max(from, Math.min(textLength, end))
  if (from === to) return raw
  const parts = splitSegmentsAtPlainRange(raw, from, to, options)
  const normalized = url?.trim() || null
  parts.selected.forEach((segment) => {
    segment.link = normalized ? { url: normalized, rawStart: 0, rawEnd: 0 } : null
  })
  return serializeInlineSegments([...parts.before, ...parts.selected, ...parts.after])
}

/** 根据 hover 段携带的原始范围更新或移除同一处链接。 */
export function updateInlineLink(
  raw: string,
  rawStart: number,
  rawEnd: number,
  url: string | null,
  options?: InlineParseOptions
): string {
  const segments = parseInlineSegments(raw, options)
  const normalized = url?.trim() || null
  for (const segment of segments) {
    if (segment.link?.rawStart !== rawStart || segment.link.rawEnd !== rawEnd) continue
    // 改了地址就不再是引用定义里的那条链接，写成行内链接；地址没变则保留引用写法
    if (!normalized) segment.link = null
    else if (normalized !== segment.link.url)
      segment.link = {
        url: normalized,
        rawStart: segment.link.rawStart,
        rawEnd: segment.link.rawEnd
      }
  }
  return serializeInlineSegments(segments)
}

export function refreshRaw(content: NodeContent): void {
  if (content.image) {
    const { alt, src, width } = content.image
    content.raw = `![${alt}${width !== null ? `|${width}` : ''}](${src})`
    content.text = alt || '图片'
    content.link = null
  } else if (content.link) {
    content.raw = `[${escapeInlineText(content.text)}](${safeLinkUrl(content.link)})`
  }
}
