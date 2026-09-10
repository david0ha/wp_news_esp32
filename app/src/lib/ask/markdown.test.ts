import { describe, it, expect } from '@jest/globals'
import { parseMarkdown } from './markdown'

const plain = (text: string) => ({ text, bold: false, italic: false, code: false })

describe('parseMarkdown', () => {
  it('reads a paragraph as one block of one plain span', () => {
    expect(parseMarkdown('The guide was the story.')).toEqual([
      { kind: 'para', spans: [plain('The guide was the story.')] },
    ])
  })

  it('joins the lines of one paragraph and splits on a blank line', () => {
    // A model writes wrapped prose. Rendering each line as its own paragraph would double every
    // gap on screen and break sentences across them.
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { kind: 'para', spans: [plain('one two')] },
      { kind: 'para', spans: [plain('three')] },
    ])
  })

  it('reads the three heading levels and nothing deeper', () => {
    expect(parseMarkdown('# A\n\n## B\n\n### C')).toEqual([
      { kind: 'heading', level: 1, spans: [plain('A')] },
      { kind: 'heading', level: 2, spans: [plain('B')] },
      { kind: 'heading', level: 3, spans: [plain('C')] },
    ])
    // Four hashes is not a heading this renderer has a size for, so it is prose.
    expect(parseMarkdown('#### D')).toEqual([{ kind: 'para', spans: [plain('#### D')] }])
  })

  it('gathers consecutive bullets into one list, either marker', () => {
    expect(parseMarkdown('- one\n* two')).toEqual([
      { kind: 'bullet', items: [[plain('one')], [plain('two')]] },
    ])
  })

  it('reads a fenced block verbatim, markers and all', () => {
    expect(parseMarkdown('```\n**not bold**\n```')).toEqual([
      { kind: 'code', text: '**not bold**' },
    ])
  })

  it('reads bold, italic and code inside a line', () => {
    expect(parseMarkdown('a **b** c *d* e `f`')).toEqual([
      {
        kind: 'para',
        spans: [
          plain('a '),
          { text: 'b', bold: true, italic: false, code: false },
          plain(' c '),
          { text: 'd', bold: false, italic: true, code: false },
          plain(' e '),
          { text: 'f', bold: false, italic: false, code: true },
        ],
      },
    ])
  })

  it('leaves an unclosed marker as the character it is', () => {
    // An answer is prose from a model, not a document that was linted. A stray asterisk must read
    // as a stray asterisk rather than swallowing the rest of the paragraph.
    expect(parseMarkdown('2 ** 3 is 8')).toEqual([{ kind: 'para', spans: [plain('2 ** 3 is 8')] }])
  })

  it('handles Korean prose, which has no spaces to lean on', () => {
    expect(parseMarkdown('가이던스가 **핵심**입니다.')).toEqual([
      {
        kind: 'para',
        spans: [
          plain('가이던스가 '),
          { text: '핵심', bold: true, italic: false, code: false },
          plain('입니다.'),
        ],
      },
    ])
  })

  it('reads an empty answer as no blocks', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('   \n\n  ')).toEqual([])
  })
})
