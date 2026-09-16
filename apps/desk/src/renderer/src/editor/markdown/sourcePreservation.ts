import {
  applyFenceLevel,
  applyFenceTitle,
  isMindmapFenceOpening,
  parseFenceLevelFromMeta,
  parseFenceTitleFromMeta
} from './fenceInfo'

export type MarkdownSourceBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'blockquote'
  | 'table'
  | 'thematic-break'
  | 'html'
  | 'math'
  | 'indented-code'
  | 'raw-frontmatter'
  | 'raw-container'
  | 'raw-component'
  | 'raw-reference-definition'
  | 'raw-generated-title'
  | 'raw-generated-toc'
  | 'raw-fence'

export interface MarkdownSourceBlock {
  /** Stable only for the lifetime of this parsed source snapshot. */
  id: string
  kind: MarkdownSourceBlockKind
  /** Raw blocks must be represented by an atom/node that retains their source. */
  raw: boolean
  /** Start and end offsets of `source`; leading whitespace is deliberately excluded. */
  from: number
  to: number
  /** Exact line endings and blank lines between the previous block and this block. */
  leading: string
  /** Exact source for this block, excluding the line ending after its final line. */
  source: string
}

export interface MarkdownSourceDocument {
  source: string
  blocks: MarkdownSourceBlock[]
  /** Everything after the final block, including its final line ending. */
  trailing: string
}

interface SourceLine {
  start: number
  contentEnd: number
  end: number
  text: string
}

interface BlockBoundary {
  endLine: number
  kind: MarkdownSourceBlockKind
  raw: boolean
}

interface CanonicalMatch {
  baselineIndex: number
  relation: 'unchanged' | 'moved' | 'changed'
}

interface FencedBlockParts {
  opening: string
  openingLineEnding: string
  body: string
  closing: string
  language: string
  lineEnding: string
}

const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/
const BLOCKQUOTE = /^ {0,3}>/
const LIST_ITEM = /^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/
/** GFM 表格分隔行里的一个单元格：`---` / `:---` / `---:` / `:---:`。 */
const TABLE_DELIMITER_CELL = /^:?-{3,}:?$/
const COMPONENT_OPEN = /^ {0,3}<([A-Z][\w.-]*)(?=[\s/>])/
const REFERENCE_DEFINITION = /^ {0,3}\[(?:\\.|[^\]\\])+\]:[ \t]*(?:\S.*)?$/
const REFERENCE_TITLE_CONTINUATION =
  /^(?: {1,3}|\t)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))[ \t]*$/
const GENERATED_TOC_REGION_OPEN = /^ {0,3}<!--\s*region\s*:\s*toc\s*-->[ \t]*$/i
const GENERATED_TOC_REGION_CLOSE = /^ {0,3}<!--\s*endregion\s*:\s*toc\s*-->[ \t]*$/i

function readLines(source: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0

  while (start < source.length) {
    let cursor = start
    while (cursor < source.length && source[cursor] !== '\n' && source[cursor] !== '\r') {
      cursor += 1
    }

    const contentEnd = cursor
    if (source[cursor] === '\r' && source[cursor + 1] === '\n') cursor += 2
    else if (cursor < source.length) cursor += 1

    lines.push({
      start,
      contentEnd,
      end: cursor,
      text: source.slice(start, contentEnd)
    })
    start = cursor
  }

  return lines
}

function isBlank(line: SourceLine | undefined): boolean {
  return !line || line.text.trim().length === 0
}

function containerOpening(line: string): string | null {
  const match = line.match(/^ {0,3}(:{3,})(.*)$/)
  return match && match[2].trim() ? match[1] : null
}

function fenceOpening(line: string): { marker: '`' | '~'; length: number } | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
  if (!match) return null
  return { marker: match[1][0] as '`' | '~', length: match[1].length }
}

function findRawContainerEnd(lines: SourceLine[], start: number, opening: string): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const closing = lines[index].text.trim()
    if (/^:{3,}$/.test(closing) && closing.length >= opening.length) return index
  }
  return lines.length - 1
}

function findRawFenceEnd(
  lines: SourceLine[],
  start: number,
  opening: { marker: '`' | '~'; length: number }
): number {
  const escapedMarker = opening.marker === '`' ? '`' : '~'
  const closing = new RegExp(`^ {0,3}${escapedMarker}{${opening.length},}[ \\t]*$`)
  for (let index = start + 1; index < lines.length; index += 1) {
    if (closing.test(lines[index].text)) return index
  }
  return lines.length - 1
}

function findTagEnd(source: string, from: number): number {
  let quote = ''
  for (let cursor = from; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (quote) {
      if (character === quote && source[cursor - 1] !== '\\') quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return cursor
    }
  }
  return source.length - 1
}

function lineContainingOffset(lines: SourceLine[], offset: number, fallback: number): number {
  for (let index = fallback; index < lines.length; index += 1) {
    if (offset < lines[index].end || index === lines.length - 1) return index
  }
  return lines.length - 1
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findRawComponentEnd(
  source: string,
  lines: SourceLine[],
  start: number,
  name: string
): number {
  const openingEnd = findTagEnd(source, lines[start].start)
  const openingSource = source.slice(lines[start].start, openingEnd + 1)
  if (/\/\s*>\s*$/.test(openingSource)) {
    return lineContainingOffset(lines, openingEnd, start)
  }

  const component = escapeRegExp(name)
  const tag = new RegExp(`<(/?)${component}(?=[\\s/>])[^>]*>`, 'g')
  tag.lastIndex = openingEnd + 1
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = tag.exec(source))) {
    if (match[1]) depth -= 1
    else if (!/\/\s*>$/.test(match[0])) depth += 1
    if (depth === 0) {
      return lineContainingOffset(lines, match.index + match[0].length - 1, start)
    }
  }
  return lines.length - 1
}

function findFrontmatterEnd(lines: SourceLine[], start: number): number | null {
  if (!/^\uFEFF?---[ \t]*$/.test(lines[start].text)) return null
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {0,3}(?:---|\.\.\.)[ \t]*$/.test(lines[index].text)) return index
  }
  return null
}

function findGeneratedTocRegionEnd(lines: SourceLine[], start: number): number | null {
  if (!GENERATED_TOC_REGION_OPEN.test(lines[start].text)) return null

  let depth = 0
  for (let index = start; index < lines.length; index += 1) {
    if (GENERATED_TOC_REGION_OPEN.test(lines[index].text)) depth += 1
    if (!GENERATED_TOC_REGION_CLOSE.test(lines[index].text)) continue
    depth -= 1
    if (depth === 0) return index
  }
  return null
}

/** 按 GFM 规则数一行有几个单元格（去掉首尾管道后按 `|` 切分）。 */
function countTableCells(text: string): number {
  return text.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length
}

function isTableDelimiter(text: string): boolean {
  const inner = text.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').every((cell) => TABLE_DELIMITER_CELL.test(cell.trim()))
}

/**
 * GFM 表格起始判定：表头含 `|`，下一行是分隔行，且**两者单元格数一致**。
 * 旧实现用一个要求「至少两个单元格」的正则，于是单列表格（`| a |` + `| --- |`、
 * 或 `| a |` + `---`）识别不出来 → 这类块不会被当作 table 处理，含 HTML 时也就
 * 不会被隔离，内联 HTML 会被静默丢弃。单元格数一致这条同时排除了
 * 「段落里带管道 + 分隔线」（如 `some | text` + `---`）。
 */
function isTableStart(lines: SourceLine[], index: number): boolean {
  const header = lines[index]?.text ?? ''
  if (!header.includes('|')) return false
  const delimiter = lines[index + 1]?.text ?? ''
  if (!isTableDelimiter(delimiter)) return false
  return countTableCells(header) === countTableCells(delimiter)
}

function isSetextStart(lines: SourceLine[], index: number): boolean {
  return !isBlank(lines[index]) && SETEXT_UNDERLINE.test(lines[index + 1]?.text ?? '')
}

function indentation(line: string): number {
  const prefix = line.match(/^[ \t]*/)?.[0] ?? ''
  return [...prefix].reduce((width, character) => width + (character === '\t' ? 4 : 1), 0)
}

function isTopLevelStart(lines: SourceLine[], index: number): boolean {
  const line = lines[index]?.text ?? ''
  return (
    Boolean(containerOpening(line)) ||
    Boolean(fenceOpening(line)) ||
    COMPONENT_OPEN.test(line) ||
    REFERENCE_DEFINITION.test(line) ||
    /^ {0,3}\$\$/.test(line) ||
    ATX_HEADING.test(line) ||
    BLOCKQUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    THEMATIC_BREAK.test(line) ||
    isTableStart(lines, index) ||
    /^ {4}|^\t/.test(line) ||
    /^ {0,3}<(?:!--|\/?[a-z][\w.-]*(?=[\s/>]))/.test(line)
  )
}

function findReferenceDefinitionEnd(lines: SourceLine[], start: number): number {
  let end = start
  while (end + 1 < lines.length) {
    const next = lines[end + 1].text
    if (REFERENCE_DEFINITION.test(next) || REFERENCE_TITLE_CONTINUATION.test(next)) {
      end += 1
      continue
    }
    break
  }
  return end
}

function findListEnd(lines: SourceLine[], start: number): number {
  let end = start
  while (end + 1 < lines.length) {
    const next = lines[end + 1]
    if (!isBlank(next)) {
      if (LIST_ITEM.test(next.text) || indentation(next.text) >= 2) {
        end += 1
        continue
      }
      break
    }

    let lookahead = end + 1
    while (lookahead < lines.length && isBlank(lines[lookahead])) lookahead += 1
    if (
      lookahead < lines.length &&
      (LIST_ITEM.test(lines[lookahead].text) || indentation(lines[lookahead].text) >= 2)
    ) {
      end = lookahead - 1
      continue
    }
    break
  }
  return end
}

function blockBoundary(
  source: string,
  lines: SourceLine[],
  start: number,
  firstBlock: boolean
): BlockBoundary {
  const line = lines[start].text

  if (firstBlock) {
    const frontmatterEnd = findFrontmatterEnd(lines, start)
    if (frontmatterEnd !== null) {
      return { endLine: frontmatterEnd, kind: 'raw-frontmatter', raw: true }
    }
  }

  const generatedTocEnd = findGeneratedTocRegionEnd(lines, start)
  if (generatedTocEnd !== null) {
    return { endLine: generatedTocEnd, kind: 'raw-generated-toc', raw: true }
  }

  const container = containerOpening(line)
  if (container) {
    return {
      endLine: findRawContainerEnd(lines, start, container),
      kind: 'raw-container',
      raw: true
    }
  }

  const fence = fenceOpening(line)
  if (fence) {
    return { endLine: findRawFenceEnd(lines, start, fence), kind: 'raw-fence', raw: true }
  }

  if (REFERENCE_DEFINITION.test(line)) {
    return {
      endLine: findReferenceDefinitionEnd(lines, start),
      kind: 'raw-reference-definition',
      raw: true
    }
  }

  const component = line.match(COMPONENT_OPEN)
  if (component) {
    return {
      endLine: findRawComponentEnd(source, lines, start, component[1]),
      kind: 'raw-component',
      raw: true
    }
  }

  if (/^ {0,3}\$\$/.test(line)) {
    if (/^ {0,3}\$\$[\s\S]+\$\$[ \t]*$/.test(line)) {
      return { endLine: start, kind: 'math', raw: false }
    }
    let end = start + 1
    while (end < lines.length && !/\$\$[ \t]*$/.test(lines[end].text)) end += 1
    return { endLine: Math.min(end, lines.length - 1), kind: 'math', raw: false }
  }

  if (ATX_HEADING.test(line)) return { endLine: start, kind: 'heading', raw: false }
  if (isSetextStart(lines, start)) return { endLine: start + 1, kind: 'heading', raw: false }

  if (isTableStart(lines, start)) {
    let end = start + 1
    while (
      end + 1 < lines.length &&
      !isBlank(lines[end + 1]) &&
      lines[end + 1].text.includes('|')
    ) {
      end += 1
    }
    return { endLine: end, kind: 'table', raw: false }
  }

  if (LIST_ITEM.test(line)) {
    return { endLine: findListEnd(lines, start), kind: 'list', raw: false }
  }

  if (BLOCKQUOTE.test(line)) {
    let end = start
    while (
      end + 1 < lines.length &&
      (BLOCKQUOTE.test(lines[end + 1].text) || isBlank(lines[end + 1]))
    ) {
      if (isBlank(lines[end + 1]) && !BLOCKQUOTE.test(lines[end + 2]?.text ?? '')) break
      end += 1
    }
    return { endLine: end, kind: 'blockquote', raw: false }
  }

  if (THEMATIC_BREAK.test(line)) {
    return { endLine: start, kind: 'thematic-break', raw: false }
  }

  if (/^ {4}|^\t/.test(line)) {
    let end = start
    while (
      end + 1 < lines.length &&
      (/^ {4}|^\t/.test(lines[end + 1].text) || isBlank(lines[end + 1]))
    ) {
      end += 1
    }
    return { endLine: end, kind: 'indented-code', raw: false }
  }

  if (/^ {0,3}<!--/.test(line)) {
    let end = start
    while (end < lines.length && !lines[end].text.includes('-->')) end += 1
    return { endLine: Math.min(end, lines.length - 1), kind: 'html', raw: false }
  }

  if (/^ {0,3}<\/?[a-z][\w.-]*(?=[\s/>])/.test(line)) {
    let end = start
    while (end + 1 < lines.length && !isBlank(lines[end + 1])) end += 1
    return { endLine: end, kind: 'html', raw: false }
  }

  let end = start
  while (end + 1 < lines.length && !isBlank(lines[end + 1])) {
    if (isTopLevelStart(lines, end + 1)) break
    end += 1
  }
  return { endLine: end, kind: 'paragraph', raw: false }
}

/**
 * Splits Markdown into top-level blocks without parsing and reprinting their contents.
 * The returned block/trivia slices always form an exact partition of `source`.
 */
export function parseMarkdownSource(source: string): MarkdownSourceDocument {
  const lines = readLines(source)
  const blocks: MarkdownSourceBlock[] = []
  let lineIndex = 0
  let previousEnd = 0

  while (lineIndex < lines.length) {
    while (lineIndex < lines.length && isBlank(lines[lineIndex])) lineIndex += 1
    if (lineIndex >= lines.length) break

    const boundary = blockBoundary(source, lines, lineIndex, blocks.length === 0)
    const from = lines[lineIndex].start
    const to = lines[boundary.endLine].contentEnd
    blocks.push({
      id: `source-block:${blocks.length}:${from}`,
      kind: boundary.kind,
      raw: boundary.raw,
      from,
      to,
      leading: source.slice(previousEnd, from),
      source: source.slice(from, to)
    })
    previousEnd = to
    lineIndex = boundary.endLine + 1
  }

  return { source, blocks, trailing: source.slice(previousEnd) }
}

/** Replaces only explicitly changed blocks; every other byte comes from the source snapshot. */
export function serializeMarkdownSource(
  document: MarkdownSourceDocument,
  replacements: ReadonlyMap<string, string> = new Map()
): string {
  const knownIds = new Set(document.blocks.map((block) => block.id))
  for (const id of replacements.keys()) {
    if (!knownIds.has(id)) throw new Error(`Unknown Markdown source block: ${id}`)
  }

  return (
    document.blocks
      .map((block) => block.leading + (replacements.get(block.id) ?? block.source))
      .join('') + document.trailing
  )
}

function fingerprint(block: MarkdownSourceBlock): string {
  return `${block.kind}\u0000${block.source}`
}

function exactLcsMatches(
  baseline: MarkdownSourceBlock[],
  current: MarkdownSourceBlock[]
): Array<[number, number]> {
  const rows = baseline.length + 1
  const columns = current.length + 1
  const lengths = Array.from({ length: rows }, () => new Uint32Array(columns))

  for (let baselineIndex = baseline.length - 1; baselineIndex >= 0; baselineIndex -= 1) {
    for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex -= 1) {
      lengths[baselineIndex][currentIndex] =
        fingerprint(baseline[baselineIndex]) === fingerprint(current[currentIndex])
          ? lengths[baselineIndex + 1][currentIndex + 1] + 1
          : Math.max(
              lengths[baselineIndex + 1][currentIndex],
              lengths[baselineIndex][currentIndex + 1]
            )
    }
  }

  const matches: Array<[number, number]> = []
  let baselineIndex = 0
  let currentIndex = 0
  while (baselineIndex < baseline.length && currentIndex < current.length) {
    if (
      fingerprint(baseline[baselineIndex]) === fingerprint(current[currentIndex]) &&
      lengths[baselineIndex][currentIndex] === lengths[baselineIndex + 1][currentIndex + 1] + 1
    ) {
      matches.push([baselineIndex, currentIndex])
      baselineIndex += 1
      currentIndex += 1
    } else if (
      lengths[baselineIndex + 1][currentIndex] >= lengths[baselineIndex][currentIndex + 1]
    ) {
      baselineIndex += 1
    } else {
      currentIndex += 1
    }
  }
  return matches
}

function pairRemainingChanges(
  baseline: MarkdownSourceBlock[],
  current: MarkdownSourceBlock[],
  baselineIndices: number[],
  currentIndices: number[]
): Array<[number, number]> {
  const rows = baselineIndices.length + 1
  const columns = currentIndices.length + 1
  const cost = Array.from({ length: rows }, () => new Uint32Array(columns))

  for (let row = 0; row < rows; row += 1) cost[row][columns - 1] = (rows - 1 - row) * 2
  for (let column = 0; column < columns; column += 1) {
    cost[rows - 1][column] = (columns - 1 - column) * 2
  }

  for (let row = rows - 2; row >= 0; row -= 1) {
    for (let column = columns - 2; column >= 0; column -= 1) {
      const substitution =
        cost[row + 1][column + 1] +
        (baseline[baselineIndices[row]].kind === current[currentIndices[column]].kind ? 1 : 3)
      cost[row][column] = Math.min(
        substitution,
        cost[row + 1][column] + 2,
        cost[row][column + 1] + 2
      )
    }
  }

  const pairs: Array<[number, number]> = []
  let row = 0
  let column = 0
  while (row < rows - 1 && column < columns - 1) {
    const substitution =
      cost[row + 1][column + 1] +
      (baseline[baselineIndices[row]].kind === current[currentIndices[column]].kind ? 1 : 3)
    if (cost[row][column] === substitution) {
      pairs.push([baselineIndices[row], currentIndices[column]])
      row += 1
      column += 1
    } else if (cost[row][column] === cost[row + 1][column] + 2) {
      row += 1
    } else {
      column += 1
    }
  }
  return pairs
}

function matchCanonicalBlocks(
  baseline: MarkdownSourceBlock[],
  current: MarkdownSourceBlock[]
): Array<CanonicalMatch | undefined> {
  const matches: Array<CanonicalMatch | undefined> = Array(current.length)
  const usedBaseline = new Set<number>()
  const exactMatches = exactLcsMatches(baseline, current)

  for (const [baselineIndex, currentIndex] of exactMatches) {
    matches[currentIndex] = { baselineIndex, relation: 'unchanged' }
    usedBaseline.add(baselineIndex)
  }

  const remainingExact = new Map<string, number[]>()
  baseline.forEach((block, index) => {
    if (usedBaseline.has(index)) return
    const key = fingerprint(block)
    remainingExact.set(key, [...(remainingExact.get(key) ?? []), index])
  })

  current.forEach((block, currentIndex) => {
    if (matches[currentIndex]) return
    const candidates = remainingExact.get(fingerprint(block))
    if (!candidates?.length) return
    let candidateOffset = 0
    for (let offset = 1; offset < candidates.length; offset += 1) {
      if (
        Math.abs(candidates[offset] - currentIndex) <
        Math.abs(candidates[candidateOffset] - currentIndex)
      ) {
        candidateOffset = offset
      }
    }
    const [baselineIndex] = candidates.splice(candidateOffset, 1)
    matches[currentIndex] = { baselineIndex, relation: 'moved' }
    usedBaseline.add(baselineIndex)
  })

  const remainingBaseline = baseline
    .map((_block, index) => index)
    .filter((index) => !usedBaseline.has(index))
  const remainingCurrent = current.map((_block, index) => index).filter((index) => !matches[index])
  for (const [baselineIndex, currentIndex] of pairRemainingChanges(
    baseline,
    current,
    remainingBaseline,
    remainingCurrent
  )) {
    matches[currentIndex] = { baselineIndex, relation: 'changed' }
    usedBaseline.add(baselineIndex)
  }

  return matches
}

function mapBaselineToOriginal(
  original: MarkdownSourceBlock[],
  baseline: MarkdownSourceBlock[]
): Array<number | undefined> {
  if (original.length === baseline.length) return baseline.map((_block, index) => index)

  const mapping: Array<number | undefined> = Array(baseline.length)
  const originalIndices = original.map((_block, index) => index)
  const baselineIndices = baseline.map((_block, index) => index)
  for (const [originalIndex, baselineIndex] of pairRemainingChanges(
    original,
    baseline,
    originalIndices,
    baselineIndices
  )) {
    mapping[baselineIndex] = originalIndex
  }
  return mapping
}

function canReuseLeading(
  currentIndex: number,
  match: CanonicalMatch,
  matches: Array<CanonicalMatch | undefined>
): boolean {
  if (match.relation === 'moved') return false
  if (currentIndex === 0) return match.baselineIndex === 0
  return matches[currentIndex - 1]?.baselineIndex === match.baselineIndex - 1
}

function firstInfoToken(info: string): string {
  return info.trim().match(/^\S+/)?.[0] ?? ''
}

function fenceOpeningInfo(openingLine: string): string {
  return openingLine.match(/^ {0,3}(?:`{3,}|~{3,})(.*)$/)?.[1] ?? ''
}

function splitFencedBlock(source: string): FencedBlockParts | null {
  const lines = readLines(source)
  if (lines.length < 2) return null
  const opening = fenceOpening(lines[0].text)
  if (!opening) return null
  const last = lines[lines.length - 1]
  const closing = new RegExp(`^ {0,3}${opening.marker}{${opening.length},}[ \\t]*$`)
  if (!closing.test(last.text)) return null
  const openingMatch = lines[0].text.match(/^ {0,3}(?:`{3,}|~{3,})(.*)$/)
  const firstLineEnding = source.slice(lines[0].contentEnd, lines[0].end)
  const anyLineEnding = source.match(/\r\n|\r|\n/)?.[0] ?? '\n'

  return {
    opening: lines[0].text,
    openingLineEnding: firstLineEnding,
    body: source.slice(lines[0].end, last.start),
    closing: source.slice(last.start),
    language: firstInfoToken(openingMatch?.[1] ?? ''),
    lineEnding: firstLineEnding || anyLineEnding
  }
}

function splitMathBlockBody(source: string): string | null {
  const lines = readLines(source)
  if (lines.length === 0) return null
  if (lines.length === 1) {
    return lines[0].text.match(/^ {0,3}\$\$([\s\S]*?)\$\$[ \t]*$/)?.[1] ?? null
  }
  if (!/^ {0,3}\$\$[ \t]*$/.test(lines[0].text)) return null
  const last = lines[lines.length - 1]
  if (!/^ {0,3}\$\$[ \t]*$/.test(last.text)) return null
  return source.slice(lines[0].end, last.start)
}

function replaceFenceLanguage(opening: string, language: string): string {
  const match = opening.match(/^( {0,3}(?:`{3,}|~{3,}))([ \t]*)(\S+)?([\s\S]*)$/)
  if (!match) return opening
  const [, fence, whitespace, , remaining] = match
  return `${fence}${whitespace}${language}${remaining}`
}

function normalizeBodyLineEndings(body: string, originalBody: string, lineEnding: string): string {
  let normalized = body.replace(/\r\n|\r|\n/g, lineEnding)
  const originalEndsWithLineEnding = /(?:\r\n|\r|\n)$/.test(originalBody)
  const currentEndsWithLineEnding = /(?:\r\n|\r|\n)$/.test(normalized)
  if (originalEndsWithLineEnding && !currentEndsWithLineEnding) normalized += lineEnding
  else if (!originalEndsWithLineEnding && currentEndsWithLineEnding) {
    normalized = normalized.slice(0, -lineEnding.length)
  }
  return normalized
}

function reconcileChangedFence(
  original: MarkdownSourceBlock,
  baseline: MarkdownSourceBlock,
  current: MarkdownSourceBlock
): string | null {
  if (original.kind !== 'raw-fence') return null
  const originalFence = splitFencedBlock(original.source)
  if (!originalFence) return null

  const baselineFence = splitFencedBlock(baseline.source)
  const currentFence = splitFencedBlock(current.source)
  let currentBody: string | null = currentFence?.body ?? null
  let currentLanguage = currentFence?.language ?? originalFence.language
  let baselineLanguage = baselineFence?.language ?? originalFence.language

  if (
    !currentFence &&
    current.kind === 'math' &&
    /^(?:latex|tex|math)$/i.test(originalFence.language)
  ) {
    currentBody = splitMathBlockBody(current.source)
    currentLanguage = originalFence.language
    baselineLanguage = originalFence.language
  }
  if (currentBody === null) return null

  let opening =
    currentLanguage === baselineLanguage
      ? originalFence.opening
      : replaceFenceLanguage(originalFence.opening, currentLanguage)

  if (currentFence) {
    const baselineTitle = parseFenceTitleFromMeta(fenceOpeningInfo(baselineFence?.opening ?? ''))
    const currentTitle = parseFenceTitleFromMeta(fenceOpeningInfo(currentFence.opening))
    const originalTitle = parseFenceTitleFromMeta(fenceOpeningInfo(originalFence.opening))
    // Only sync titles when Milkdown's canonical dump is participating in the
    // title channel (baseline/current carry a `[title]`). Legacy dumps without
    // meta must not strip titles preserved on the original opening line.
    if ((baselineTitle || currentTitle) && currentTitle !== originalTitle) {
      opening = applyFenceTitle(opening, currentTitle)
    }
    /*
     * The mindmap expand level is a channel of its own, for the same reason the
     * title is: Desk's 「层」 control edits it, so reconciliation has to carry the
     * editor's value onto the opening line it rebuilt from the original bytes.
     * Guarded the same way — when neither the baseline nor the current dump
     * participates in the channel the original line stays authoritative, and a
     * level that did not change is left byte-identical.
     */
    if (isMindmapFenceOpening(opening)) {
      const baselineLevel = parseFenceLevelFromMeta(fenceOpeningInfo(baselineFence?.opening ?? ''))
      const currentLevel = parseFenceLevelFromMeta(fenceOpeningInfo(currentFence.opening))
      const originalLevel = parseFenceLevelFromMeta(fenceOpeningInfo(originalFence.opening))
      if ((baselineLevel !== null || currentLevel !== null) && currentLevel !== originalLevel) {
        opening = applyFenceLevel(opening, currentLevel)
      }
    }
  }

  const body = normalizeBodyLineEndings(currentBody, originalFence.body, originalFence.lineEnding)
  return opening + originalFence.openingLineEnding + body + originalFence.closing
}

/**
 * Reconciles Milkdown's current Markdown with the source that was initially loaded.
 *
 * `baselineCanonical` must be captured from `getMarkdown()` immediately after loading
 * `originalSource`. Exact baseline/current block matches reuse the original bytes. Only
 * changed or inserted blocks are emitted from `currentCanonical`.
 */
const PARSE_CACHE_LIMIT = 12
const parseCache = new Map<string, MarkdownSourceDocument>()

function cachedParseMarkdownSource(source: string): MarkdownSourceDocument {
  const hit = parseCache.get(source)
  if (hit) {
    // Refresh insertion order for a simple LRU-ish eviction.
    parseCache.delete(source)
    parseCache.set(source, hit)
    return hit
  }
  const parsed = parseMarkdownSource(source)
  parseCache.set(source, parsed)
  if (parseCache.size > PARSE_CACHE_LIMIT) {
    const oldest = parseCache.keys().next().value
    if (oldest !== undefined) parseCache.delete(oldest)
  }
  return parsed
}

/**
 * When block counts match and only one block's fingerprint changed, pair linearly
 * and skip the O(B²) LCS. Returns null when the fast path does not apply.
 */
function tryLinearSingleChangeMatch(
  baseline: MarkdownSourceBlock[],
  current: MarkdownSourceBlock[]
): Array<CanonicalMatch | undefined> | null {
  if (baseline.length !== current.length || baseline.length === 0) return null
  let changedIndex = -1
  for (let index = 0; index < baseline.length; index += 1) {
    if (fingerprint(baseline[index]!) === fingerprint(current[index]!)) continue
    if (changedIndex >= 0) return null
    changedIndex = index
  }
  if (changedIndex < 0) {
    return current.map((_block, index) => ({ baselineIndex: index, relation: 'unchanged' }))
  }
  return current.map((_block, index) =>
    index === changedIndex
      ? { baselineIndex: index, relation: 'changed' }
      : { baselineIndex: index, relation: 'unchanged' }
  )
}

/**
 * 「按原文暴露」的区域（渲染忠实性降级）在写盘时的特殊处理。
 *
 * 这些区域在文档里是普通正文（可编辑），但通用 markdown 序列化器会把它们写成自己的
 * 形态：行内硬换行变成 `\` + 换行、我们注入的转义（`\:::`）被吃掉 —— 重新加载时
 * 又会变回容器。所以：**未被编辑 → 逐字复用原块字节；被编辑过 → 用 render 给出的
 * 「转义逐行原文」形态写**，由我们而不是序列化器决定这段长什么样。
 */
export interface ReconcileLiteralRegions {
  /** 基线里哪些顶层块下标是「按原文暴露」的区域（降级后块数守恒，下标与源码一致） */
  baselineIndexes: ReadonlySet<number>
  /** 给定当前文档里的块下标（与 currentCanonical 的顶层块一一对应），返回要写的原文形态 */
  render: (currentIndex: number) => string | null
}

export interface ReconcileOptions {
  literalRegions?: ReconcileLiteralRegions
}

export function reconcileMarkdownSource(
  originalSource: string,
  baselineCanonical: string,
  currentCanonical: string,
  options: ReconcileOptions = {}
): string {
  if (baselineCanonical === currentCanonical) return originalSource

  const original = cachedParseMarkdownSource(originalSource)
  const baseline = cachedParseMarkdownSource(baselineCanonical)
  const current = parseMarkdownSource(currentCanonical)
  if (current.blocks.length === 0) return currentCanonical

  const baselineToOriginal = mapBaselineToOriginal(original.blocks, baseline.blocks)
  const matches =
    tryLinearSingleChangeMatch(baseline.blocks, current.blocks) ??
    matchCanonicalBlocks(baseline.blocks, current.blocks)
  let result = ''

  current.blocks.forEach((currentBlock, currentIndex) => {
    const match = matches[currentIndex]
    const originalIndex = match ? baselineToOriginal[match.baselineIndex] : undefined
    const originalBlock = originalIndex === undefined ? undefined : original.blocks[originalIndex]
    const leading =
      originalBlock && match && canReuseLeading(currentIndex, match, matches)
        ? originalBlock.leading
        : currentBlock.leading
    let source =
      originalBlock && match?.relation !== 'changed'
        ? originalBlock.source
        : originalBlock && match
          ? (reconcileChangedFence(
              originalBlock,
              baseline.blocks[match.baselineIndex],
              currentBlock
            ) ?? currentBlock.source)
          : currentBlock.source
    // 被编辑过的「按原文暴露」区域：形态由我们定（转义逐行原文），不交给序列化器
    const regions = options.literalRegions
    if (regions && match && match.relation === 'changed') {
      if (regions.baselineIndexes.has(match.baselineIndex)) {
        const rendered = regions.render(currentIndex)
        if (rendered != null) source = rendered
      }
    }
    result += leading + source
  })

  const lastCurrentIndex = current.blocks.length - 1
  const lastMatch = matches[lastCurrentIndex]
  const canReuseTrailing =
    lastMatch &&
    lastMatch.relation !== 'moved' &&
    lastMatch.baselineIndex === baseline.blocks.length - 1
  result += canReuseTrailing ? original.trailing : current.trailing
  return result
}
