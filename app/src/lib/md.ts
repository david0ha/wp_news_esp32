// A small, dependency-free markdown subset for the desk's own markdown — thesis notes, dossiers,
// notes.md (docs/desk-server.md). Not CommonMark: `react-native-markdown-display` pulls
// `markdown-it` and a fit-image dependency for a subset this small. Pure and total — never throws.

export type Span =
  | { type: 'text'; text: string }
  | { type: 'bold'; spans: Span[] }
  | { type: 'italic'; spans: Span[] }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string }

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { type: 'paragraph'; spans: Span[] }
  | { type: 'list'; ordered: boolean; items: Span[][] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'hr' }
  | { type: 'quote'; spans: Span[] }

const HEADING_RE = /^(#{1,3})\s+(.*)$/
const LIST_RE = /^(-|\d+\.)\s+(.*)$/
const HR_RE = /^-{3,}\s*$/
const FENCE_RE = /^```(.*)$/
const QUOTE_RE = /^>\s?(.*)$/

/** The `)` balancing the `(` just before `start`, allowing nested pairs, or -1 if unterminated. */
function closeParen(text: string, start: number): number {
  let depth = 1
  let j = start
  while (j < text.length && depth > 0) {
    if (text[j] === '(') depth++
    else if (text[j] === ')') depth--
    if (depth > 0) j++
  }
  return depth === 0 ? j : -1
}

/** `` `code` ``, `**bold**`, `*italic*`, `[text](url)` — an unmatched delimiter is literal. */
function parseInline(text: string): Span[] {
  const spans: Span[] = []
  let buf = ''
  const flush = () => {
    if (buf !== '') spans.push({ type: 'text', text: buf })
    buf = ''
  }
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '`' || c === '*') {
      const delim = c === '*' && text[i + 1] === '*' ? '**' : c
      const end = text.indexOf(delim, i + delim.length)
      if (end === -1) {
        buf += delim
        i += delim.length
        continue
      }
      flush()
      const inner = text.slice(i + delim.length, end)
      const span: Span =
        delim === '`' ? { type: 'code', text: inner }
        : delim === '**' ? { type: 'bold', spans: parseInline(inner) }
        : { type: 'italic', spans: parseInline(inner) }
      spans.push(span)
      i = end + delim.length
      continue
    }
    if (c === '[') {
      const close = text.indexOf(']', i + 1)
      const end = close !== -1 && text[close + 1] === '(' ? closeParen(text, close + 2) : -1
      if (end !== -1) {
        flush()
        spans.push({ type: 'link', text: text.slice(i + 1, close), href: text.slice(close + 2, end) })
        i = end + 1
        continue
      }
    }
    buf += c
    i++
  }
  flush()
  return spans
}

const isBoundary = (l: string): boolean =>
  l.trim() === '' || FENCE_RE.test(l) || HR_RE.test(l) || HEADING_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l)

/** The markdown subset this app renders: h1–h3, paragraphs, lists, code, `---`, `>`, links. */
export function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const lang = fence[1].trim()
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i])) body.push(lines[i++])
      if (i < lines.length) i++ // consume the closing fence; unterminated runs to EOF instead
      blocks.push({ type: 'code', lang, text: body.join('\n') })
      continue
    }
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2 | 3, spans: parseInline(heading[2]) })
      i++
      continue
    }
    if (QUOTE_RE.test(line)) {
      const buf: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i])) buf.push(QUOTE_RE.exec(lines[i++])![1])
      blocks.push({ type: 'quote', spans: parseInline(buf.join(' ')) })
      continue
    }
    const list = LIST_RE.exec(line)
    if (list) {
      const ordered = /^\d+\./.test(list[1])
      const items: Span[][] = []
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i])
        if (!m || /^\d+\./.test(m[1]) !== ordered) break
        items.push(parseInline(m[2]))
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    // A paragraph: every plain line up to a blank one or another block's start, reflowed into
    // one string — `ui_fit_text()`'s own reason to write body copy long, mirrored here.
    const buf = [line]
    i++
    while (i < lines.length && !isBoundary(lines[i])) buf.push(lines[i++])
    blocks.push({ type: 'paragraph', spans: parseInline(buf.join(' ')) })
  }

  return blocks
}

/**
 * Spans reduced to plain text — every formatting mark stripped, a link's visible text kept over
 * its `href`. For a caller that wants a summary line rather than a rendering (Task 27's watchlist
 * row: the thesis's first line), not a substitute for `<Markdown>`, which draws the formatting
 * rather than discarding it.
 */
export function flattenSpans(spans: Span[]): string {
  return spans.map(flattenSpan).join('')
}

function flattenSpan(span: Span): string {
  switch (span.type) {
    case 'text':
    case 'code':
      return span.text
    case 'bold':
    case 'italic':
      return flattenSpans(span.spans)
    case 'link':
      return span.text
  }
}
