/**
 * Parse / serialize image slides inside `::: swiper` bodies.
 * Tab labels mirror core: image alt, or `img` when alt is empty.
 * Tab chrome / hydrate live in `@tnotesjs/ui/swiper`.
 *
 * `{w=…}` / `align=` use the same attr block as body images. A missing
 * `align=` stays omitted: the slide is centered, and the source is not rewritten.
 */

import { normalizeImageWidth, parseImageAttrs, type ImageAlign } from '@tnotesjs/ui/image-markdown'

export {
  applySwiperTabsPadding,
  createSwiperTabNav,
  hydrateTnSwipers,
  SWIPER_EMPTY_TEXT,
  wrapSlideIndex
} from '@tnotesjs/ui/swiper'

export interface SwiperSlideEntry {
  alt: string
  src: string
  /** Normalized CSS size. Empty means the image's own width. */
  width: string
  /** Written alignment. Omitted means the swiper default (centered). */
  align?: ImageAlign
}

export interface SwiperSlideChange {
  width?: string
  /** `null` removes a written `align=`. */
  align?: ImageAlign | null
}

const IMAGE_LINE =
  /^([ \t]{0,3})(!\[[^\]]*\]\(\s*<?[^)\s>]+>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\))(.*)$/

const EXPLICIT_ALIGN = /(?:^|[\s,{])(?:align|a)\s*=/i

interface SwiperImageLine {
  entry: SwiperSlideEntry
  /** `![alt](src)` including an optional title, without the attr block. */
  head: string
}

function parseImageLine(line: string): SwiperImageLine | null {
  const match = IMAGE_LINE.exec(line)
  if (!match) return null
  const head = `${match[1] ?? ''}${match[2] ?? ''}`
  const image = /^[ \t]{0,3}!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?/.exec(head)
  if (!image) return null
  const rest = match[3] ?? ''
  if (rest.trim() === '') {
    return { head, entry: { alt: image[1] ?? '', src: image[2] ?? '', width: '' } }
  }
  const parsed = parseImageAttrs(rest)
  if (parsed.rest !== '') return null
  const entry: SwiperSlideEntry = {
    alt: image[1] ?? '',
    src: image[2] ?? '',
    width: parsed.width
  }
  if (EXPLICIT_ALIGN.test(rest)) entry.align = parsed.align
  return { head, entry }
}

function formatSwiperAttrs(entry: SwiperSlideEntry): string {
  const width = normalizeImageWidth(entry.width)
  const parts: string[] = []
  if (width) parts.push(`w=${width}`)
  if (entry.align) parts.push(`align=${entry.align}`)
  return parts.length > 0 ? `{${parts.join(' ')}}` : ''
}

function applySlideChange(entry: SwiperSlideEntry, next: SwiperSlideChange): SwiperSlideEntry {
  const updated: SwiperSlideEntry = {
    ...entry,
    width: next.width !== undefined ? normalizeImageWidth(next.width) : entry.width
  }
  if (next.align === null) delete updated.align
  else if (next.align) updated.align = next.align
  return updated
}

export function parseSwiperSlides(body: string): SwiperSlideEntry[] {
  const slides: SwiperSlideEntry[] = []
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const parsed = parseImageLine(line)
    if (parsed) slides.push(parsed.entry)
  }
  return slides
}

/** 只改第 `index` 张幻灯片的宽度或对齐，其它行（包括非图片文字）原样保留。 */
export function updateSwiperSlideAttrs(
  fence: string,
  index: number,
  next: SwiperSlideChange
): string {
  const newline = fence.includes('\r\n') ? '\r\n' : '\n'
  let seen = -1
  const lines = fence
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const parsed = parseImageLine(line)
      if (!parsed) return line
      seen += 1
      if (seen !== index) return line
      const entry = applySlideChange(parsed.entry, next)
      const attrs = formatSwiperAttrs(entry)
      return `${parsed.head}${attrs ? ` ${attrs}` : ''}`
    })
  return lines.join(newline)
}

export function swiperSlideTabTitle(entry: SwiperSlideEntry): string {
  const alt = entry.alt.trim()
  return alt || 'img'
}

export function withSwiperSlideTitle(entry: SwiperSlideEntry, title: string): SwiperSlideEntry {
  return { ...entry, alt: title.trim() }
}

export function serializeSwiperSlides(entries: SwiperSlideEntry[]): string {
  return entries
    .map((entry) => {
      const attrs = formatSwiperAttrs(entry)
      return `![${entry.alt}](${entry.src})${attrs ? ` ${attrs}` : ''}`
    })
    .join('\n\n')
}
