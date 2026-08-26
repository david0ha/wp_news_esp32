import { describe, it, expect } from '@jest/globals'
import { parse, type Block } from './md'

describe('parse — block structure', () => {
  it('reads h1, h2 and h3 by the number of #s', () => {
    const blocks = parse('# One\n## Two\n### Three')
    expect(blocks).toEqual([
      { type: 'heading', level: 1, spans: [{ type: 'text', text: 'One' }] },
      { type: 'heading', level: 2, spans: [{ type: 'text', text: 'Two' }] },
      { type: 'heading', level: 3, spans: [{ type: 'text', text: 'Three' }] },
    ])
  })

  it('joins consecutive lines into one paragraph, split by a blank line', () => {
    const blocks = parse('First line\nsecond line.\n\nA new paragraph.')
    expect(blocks).toEqual([
      { type: 'paragraph', spans: [{ type: 'text', text: 'First line second line.' }] },
      { type: 'paragraph', spans: [{ type: 'text', text: 'A new paragraph.' }] },
    ])
  })

  it('reads a `-` list as unordered', () => {
    const blocks = parse('- one\n- two\n- three')
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          [{ type: 'text', text: 'one' }],
          [{ type: 'text', text: 'two' }],
          [{ type: 'text', text: 'three' }],
        ],
      },
    ])
  })

  it('reads a `1.` list as ordered, and a marker change starts a new list', () => {
    const blocks = parse('1. one\n2. two\n- three')
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: true,
        items: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]],
      },
      { type: 'list', ordered: false, items: [[{ type: 'text', text: 'three' }]] },
    ])
  })

  it('reads `---` alone as a rule', () => {
    expect(parse('above\n\n---\n\nbelow')).toEqual([
      { type: 'paragraph', spans: [{ type: 'text', text: 'above' }] },
      { type: 'hr' },
      { type: 'paragraph', spans: [{ type: 'text', text: 'below' }] },
    ])
  })

  it('reads `>` as a blockquote, joining consecutive quoted lines', () => {
    expect(parse('> First.\n> Second.')).toEqual([
      { type: 'quote', spans: [{ type: 'text', text: 'First. Second.' }] },
    ])
  })

  it('reads a fenced code block, keeping its language and its content verbatim', () => {
    expect(parse('```js\nconst x = 1\nif (x) {}\n```')).toEqual([
      { type: 'code', lang: 'js', text: 'const x = 1\nif (x) {}' },
    ])
  })

  it('reads an unterminated fence as code running to the end of input', () => {
    expect(parse('```\nno closing fence\nsecond line')).toEqual([
      { type: 'code', lang: '', text: 'no closing fence\nsecond line' },
    ])
  })

  it('normalises CRLF input the same as LF', () => {
    expect(parse('# Head\r\n\r\nBody text.')).toEqual([
      { type: 'heading', level: 1, spans: [{ type: 'text', text: 'Head' }] },
      { type: 'paragraph', spans: [{ type: 'text', text: 'Body text.' }] },
    ])
  })

  it('returns [] for empty input', () => {
    expect(parse('')).toEqual([])
    expect(parse('\n\n  \n')).toEqual([])
  })
})

describe('parse — inline spans', () => {
  it('reads **bold** and *italic*', () => {
    const [b] = parse('**bold** and *italic*')
    expect(b).toEqual({
      type: 'paragraph',
      spans: [
        { type: 'bold', spans: [{ type: 'text', text: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'italic', spans: [{ type: 'text', text: 'italic' }] },
      ],
    })
  })

  it('treats a lone, unmatched * as a literal character', () => {
    const [b] = parse('3 * 4 = 12')
    expect(b).toEqual({ type: 'paragraph', spans: [{ type: 'text', text: '3 * 4 = 12' }] })
  })

  it('nests italic inside bold', () => {
    const [b] = parse('**bold *and italic* too**')
    expect(b).toEqual({
      type: 'paragraph',
      spans: [
        {
          type: 'bold',
          spans: [
            { type: 'text', text: 'bold ' },
            { type: 'italic', spans: [{ type: 'text', text: 'and italic' }] },
            { type: 'text', text: ' too' },
          ],
        },
      ],
    })
  })

  it('reads backtick code as a literal span, not parsed for emphasis inside it', () => {
    const [b] = parse('run `*not bold*` now')
    expect(b).toEqual({
      type: 'paragraph',
      spans: [
        { type: 'text', text: 'run ' },
        { type: 'code', text: '*not bold*' },
        { type: 'text', text: ' now' },
      ],
    })
  })

  it('reads a link, including one whose URL itself contains parentheses', () => {
    const [b] = parse('see [the wiki](https://example.com/wiki_(disambiguation)) for more')
    expect(b).toEqual({
      type: 'paragraph',
      spans: [
        { type: 'text', text: 'see ' },
        { type: 'link', text: 'the wiki', href: 'https://example.com/wiki_(disambiguation)' },
        { type: 'text', text: ' for more' },
      ],
    })
  })

  it('leaves an unterminated [ or ( as literal text', () => {
    const [b] = parse('a [bracket that never closes')
    expect(b).toEqual({
      type: 'paragraph',
      spans: [{ type: 'text', text: 'a [bracket that never closes' }],
    })
  })
})

// Exercised via `parse`, but named so a change to the exported type is caught here too.
describe('Block type', () => {
  it('is exported and usable as a type', () => {
    const blocks: Block[] = parse('# x')
    expect(blocks[0].type).toBe('heading')
  })
})
