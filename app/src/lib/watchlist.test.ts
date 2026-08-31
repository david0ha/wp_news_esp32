import { describe, it, expect } from '@jest/globals'
import { filterByGrade, sortWatchlist, thesisLine, WATCH_GRADE_FILTERS } from './watchlist'
import type { WatchlistItem } from './desk'

function item(overrides: Partial<WatchlistItem>): WatchlistItem {
  return {
    symbol: 'AAA',
    name: 'Company A',
    market: 'NASDAQ',
    grade: 'none',
    reasons: [],
    thesis_status: '',
    note: '',
    printable: true,
    last_printed: null,
    events: [],
    held: false,
    ...overrides,
  }
}

describe('WATCH_GRADE_FILTERS', () => {
  it('is All, Red, Yellow, Green — the SegmentedControl’s own order', () => {
    expect(WATCH_GRADE_FILTERS).toEqual(['all', 'red', 'yellow', 'green'])
  })
})

describe('filterByGrade', () => {
  const items = [
    item({ symbol: 'RED1', grade: 'red' }),
    item({ symbol: 'YEL1', grade: 'yellow' }),
    item({ symbol: 'GRN1', grade: 'green' }),
    item({ symbol: 'NON1', grade: 'none' }),
  ]

  it('“all” keeps every item, including grade “none”', () => {
    expect(filterByGrade(items, 'all')).toEqual(items)
  })

  it('keeps only the matching grade', () => {
    expect(filterByGrade(items, 'red').map((i) => i.symbol)).toEqual(['RED1'])
    expect(filterByGrade(items, 'yellow').map((i) => i.symbol)).toEqual(['YEL1'])
    expect(filterByGrade(items, 'green').map((i) => i.symbol)).toEqual(['GRN1'])
  })

  it('is empty rather than throwing when nothing matches', () => {
    expect(filterByGrade([item({ grade: 'none' })], 'red')).toEqual([])
  })
})

describe('sortWatchlist', () => {
  it('orders worst grade first: red, yellow, green, none', () => {
    const items = [
      item({ symbol: 'A', grade: 'none' }),
      item({ symbol: 'B', grade: 'green' }),
      item({ symbol: 'C', grade: 'red' }),
      item({ symbol: 'D', grade: 'yellow' }),
    ]
    expect(sortWatchlist(items).map((i) => i.grade)).toEqual(['red', 'yellow', 'green', 'none'])
  })

  it('breaks a tie within one grade by symbol, A to Z', () => {
    const items = [
      item({ symbol: 'WDC', grade: 'green' }),
      item({ symbol: 'SNDK', grade: 'green' }),
      item({ symbol: 'ADI', grade: 'green' }),
    ]
    expect(sortWatchlist(items).map((i) => i.symbol)).toEqual(['ADI', 'SNDK', 'WDC'])
  })

  it('does not mutate its argument', () => {
    const items = [item({ symbol: 'B', grade: 'green' }), item({ symbol: 'A', grade: 'red' })]
    const copy = [...items]
    sortWatchlist(items)
    expect(items).toEqual(copy)
  })

  it('matches the mock fixture’s five companies in the row order the Watch tab must show', () => {
    // docs/desk-server.md § The watchlist / scripts/mock-desk.js's fixture: SNDK & WDC green, MU
    // yellow, INTC red, ADI none. Red first, then yellow, then green A→Z, then none.
    const items = [
      item({ symbol: 'SNDK', grade: 'green' }),
      item({ symbol: 'WDC', grade: 'green' }),
      item({ symbol: 'MU', grade: 'yellow' }),
      item({ symbol: 'INTC', grade: 'red' }),
      item({ symbol: 'ADI', grade: 'none' }),
    ]
    expect(sortWatchlist(items).map((i) => i.symbol)).toEqual(['INTC', 'MU', 'SNDK', 'WDC', 'ADI'])
  })
})

describe('thesisLine', () => {
  it('is empty for an empty note — nothing has been argued yet', () => {
    expect(thesisLine('')).toBe('')
  })

  it('takes the first paragraph, skipping a leading heading', () => {
    expect(thesisLine('## Thesis\n\nContract volume is now the majority of the mix.')).toBe(
      'Contract volume is now the majority of the mix.',
    )
  })

  it('takes the first paragraph when there is no heading at all', () => {
    expect(thesisLine('Spin-off overhang cleared.\n\n> A quote below it.')).toBe('Spin-off overhang cleared.')
  })

  it('strips markdown formatting to plain text', () => {
    expect(thesisLine('**Contract volume** is now *the* majority.')).toBe('Contract volume is now the majority.')
  })

  it('falls back to a quote when that is the first prose block', () => {
    expect(thesisLine('# Passed\n\n> The read on the cycle from the other side.')).toBe(
      'The read on the cycle from the other side.',
    )
  })

  it('falls back to the first list item when that is the first prose block', () => {
    expect(thesisLine('# Watching\n\n- Capex guide is the swing factor\n- DRAM softer than NAND')).toBe(
      'Capex guide is the swing factor',
    )
  })

  it('skips a heading-only note down to nothing rather than returning the heading text', () => {
    expect(thesisLine('# Passed')).toBe('')
  })
})
