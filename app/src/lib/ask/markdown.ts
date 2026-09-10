// The worker's `answer.md`, turned into something a React Native tree can draw.
//
// A PARSER AND NOT A LIBRARY, deliberately. `package.json` carries no markdown renderer and this
// app's release lane is fragile enough that a new dependency is a real cost; what an answer written
// to the spec's "keep it to what was asked" actually contains is paragraphs, the odd bullet list, a
// bold run and sometimes a heading. Seventy lines with a test cover that. Anything outside it —
// tables, images, links, nested lists — falls through as its own literal text, which is legible
// rather than wrong, and is the failure direction to want from a renderer fed prose from a model.
//
// THE TYPE RAMP IS THE APP'S OWN, NOT THE EDITION'S. `Answer.tsx` draws with `theme.ts`'s tokens
// and Inter, because this is a message between the owner and their desk rather than a page of the
// paper — the edition's face belongs to the edition. See the spec's §4.

export interface Span {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
}

export type Block =
  | { kind: 'para'; spans: Span[] }
  | { kind: 'bullet'; items: Span[][] }
  | { kind: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { kind: 'code'; text: string }

const HEADING = /^(#{1,3})\s+(.*)$/
const BULLET = /^\s*[-*]\s+(.*)$/
const FENCE = /^\s*```/

/**
 * Inline markers, and the rule that keeps a stray one harmless.
 *
 * Each marker is taken only when its CLOSER is found on the same line. An unclosed `**` is two
 * asterisks of prose, which is what "2 ** 3" is, and swallowing the rest of a paragraph over one
 * is the failure a greedy reader has.
 */
function spansOf(line: string): Span[] {
  const out: Span[] = []
  let plain = ''
  let i = 0
  const flush = () => {
    if (plain !== '') out.push({ text: plain, bold: false, italic: false, code: false })
    plain = ''
  }
  while (i < line.length) {
    const marker =
      line.startsWith('**', i) ? '**' : line[i] === '*' ? '*' : line[i] === '`' ? '`' : null
    if (marker === null) {
      plain += line[i]
      i += 1
      continue
    }
    const close = line.indexOf(marker, i + marker.length)
    // No closer, or an empty run (`****`): the marker is text.
    if (close === -1 || close === i + marker.length) {
      plain += line.slice(i, i + marker.length)
      i += marker.length
      continue
    }
    flush()
    out.push({
      text: line.slice(i + marker.length, close),
      bold: marker === '**',
      italic: marker === '*',
      code: marker === '`',
    })
    i = close + marker.length
  }
  flush()
  return out
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.split('\n')
  const blocks: Block[] = []
  // The paragraph being gathered. Lines join with a space: a model writes wrapped prose, and one
  // block per line would double every gap and break sentences across them.
  let para: string[] = []
  const closePara = () => {
    const text = para.join(' ').trim()
    para = []
    if (text !== '') blocks.push({ kind: 'para', spans: spansOf(text) })
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (FENCE.test(line)) {
      closePara()
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1 // the closing fence, or the end of the string
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      closePara()
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        spans: spansOf(heading[2].trim()),
      })
      i += 1
      continue
    }

    if (BULLET.test(line)) {
      closePara()
      const items: Span[][] = []
      while (i < lines.length) {
        const item = BULLET.exec(lines[i])
        if (item === null) break
        items.push(spansOf(item[1].trim()))
        i += 1
      }
      blocks.push({ kind: 'bullet', items })
      continue
    }

    if (line.trim() === '') {
      closePara()
      i += 1
      continue
    }

    para.push(line.trim())
    i += 1
  }
  closePara()
  return blocks
}
