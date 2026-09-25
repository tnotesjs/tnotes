/**
 * 读写笔记 YAML frontmatter 里的简单字段（当前是 `id` / `description`）。
 * 只动 description 字段对应的那一块（单行或多行折叠），其余字节原样保留。
 */

export interface FrontmatterFields {
  id: string
  description: string
}

export interface FrontmatterTextChange {
  from: number
  to: number
  insert: string
}

/** 文档开头成对 `---` / `...` 之间的行范围（不含围栏行本身）。没有则 null。 */
function frontmatterBodyLines(source: string): { start: number; end: number; lines: string[] } | null {
  const lines = source.split('\n')
  if (lines.length < 2 || lines[0].trimEnd() !== '---') return null
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[index])) {
      return { start: 1, end: index, lines }
    }
  }
  return null
}

function lineOffset(lines: string[], lineIndex: number): number {
  let offset = 0
  for (let index = 0; index < lineIndex; index += 1) {
    offset += lines[index].length + 1
  }
  return offset
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function fieldValue(line: string, key: string): string | null {
  const match = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line)
  if (!match) return null
  return unquote(match[1])
}

/** 读 description：支持单行，以及 `>` / `>-` / `|` / `|-` 后的缩进续行。 */
function readDescriptionBlock(
  lines: string[],
  start: number,
  end: number
): { value: string; fromLine: number; toLine: number } | null {
  for (let index = start; index < end; index += 1) {
    const match = /^description\s*:\s*(.*)$/.exec(lines[index])
    if (!match) continue
    const raw = match[1]
    if (/^[>|][-+]?[ \t]*$/.test(raw)) {
      const parts: string[] = []
      let cursor = index + 1
      while (cursor < end && /^[ \t]+/.test(lines[cursor])) {
        parts.push(lines[cursor].replace(/^[ \t]+/, ''))
        cursor += 1
      }
      const folded = raw.startsWith('>')
      return {
        value: folded ? parts.join(' ').replace(/ +/g, ' ').trim() : parts.join('\n'),
        fromLine: index,
        toLine: cursor
      }
    }
    return { value: unquote(raw), fromLine: index, toLine: index + 1 }
  }
  return null
}

/** 从源码读出 frontmatter 里的 id / description（没有 frontmatter 时为空串）。 */
export function readFrontmatterFields(source: string): FrontmatterFields {
  const body = frontmatterBodyLines(source)
  if (!body) return { id: '', description: '' }
  let id = ''
  for (let index = body.start; index < body.end; index += 1) {
    const value = fieldValue(body.lines[index], 'id')
    if (value !== null) {
      id = value
      break
    }
  }
  const description = readDescriptionBlock(body.lines, body.start, body.end)?.value ?? ''
  return { id, description }
}

/**
 * 计算只替换（或插入）description 字段所需的局部改动。
 * 多行折叠块整段替换成单行 `description: …`，避免侧栏编辑拆坏 YAML。
 */
export function frontmatterDescriptionChange(
  source: string,
  description: string
): FrontmatterTextChange | null {
  const body = frontmatterBodyLines(source)
  if (!body) return null
  const { lines, start, end } = body
  const nextValue = description.replace(/\r?\n/g, ' ').replace(/ +/g, ' ').trim()
  const nextLine = `description: ${nextValue}`
  const existing = readDescriptionBlock(lines, start, end)
  if (existing) {
    const from = lineOffset(lines, existing.fromLine)
    const last = existing.toLine - 1
    const lastEnd = lineOffset(lines, last) + lines[last].length
    // toLine 指向块后第一行：把块末换行吃进改动，写回时再补上，避免粘上后面的 ---
    const eatsNewline = existing.toLine < lines.length
    const to = eatsNewline ? lastEnd + 1 : lastEnd
    const insert = eatsNewline ? `${nextLine}\n` : nextLine
    if (source.slice(from, to) === insert) return null
    return { from, to, insert }
  }
  let insertAt = end
  for (let index = start; index < end; index += 1) {
    if (/^id\s*:/.test(lines[index])) {
      insertAt = index + 1
      break
    }
  }
  const from = lineOffset(lines, insertAt)
  return { from, to: from, insert: `${nextLine}\n` }
}

/** 只替换（或插入）description 字段，其它内容字节不动。 */
export function replaceFrontmatterDescription(source: string, description: string): string {
  const change = frontmatterDescriptionChange(source, description)
  if (!change) return source
  return source.slice(0, change.from) + change.insert + source.slice(change.to)
}
