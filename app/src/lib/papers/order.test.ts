import { describe, it, expect, beforeEach } from '@jest/globals'
import {
  clampPaperIndex,
  isPaperRowDisabled,
  orderPapers,
  paperAgeLabel,
  paperKey,
  papersPagerView,
} from './order'
import { setActiveLanguage } from '../../i18n'
import { type Paper, type PapersDoc } from '../desk'

const paper = (over: Partial<Paper> = {}): Paper => ({
  symbol: 'SNDK',
  name: 'SanDisk',
  editionId: 'e-sndk',
  createdAt: 1_757_000_000_000,
  lang: 'en',
  headline: 'The guide, not the buyback',
  onBoard: false,
  stale: false,
  ...over,
})

const doc = (papers: Paper[], board: string | null = null): PapersDoc => ({ papers, board })

beforeEach(() => {
  setActiveLanguage('en')
})

describe('orderPapers', () => {
  it('puts the board’s paper first and leaves watchlist order alone behind it', () => {
    const list = orderPapers(
      doc([
        paper({ symbol: 'MU' }),
        paper({ symbol: 'TSLA' }),
        paper({ symbol: 'SNDK', onBoard: true }),
        paper({ symbol: 'AAPL' }),
      ]),
    )
    expect(list.map((p) => p.symbol)).toEqual(['SNDK', 'MU', 'TSLA', 'AAPL'])
  })

  it('changes nothing when the board’s paper is already first', () => {
    const rows = [paper({ symbol: 'SNDK', onBoard: true }), paper({ symbol: 'MU' })]
    expect(orderPapers(doc(rows)).map((p) => p.symbol)).toEqual(['SNDK', 'MU'])
  })

  it('leaves the desk’s order untouched when nothing is on the board', () => {
    // A desk that has published nothing, or whose current edition is for a company that has since
    // left the watchlist. Watchlist order IS the answer then; there is nothing to promote.
    const rows = [paper({ symbol: 'MU' }), paper({ symbol: 'TSLA' })]
    expect(orderPapers(doc(rows)).map((p) => p.symbol)).toEqual(['MU', 'TSLA'])
  })

  it('moves ONE row even if the desk marked two, and keeps the first of them', () => {
    // Two `on_board` rows cannot happen against a correct desk — `current` is one pointer. If one
    // ever arrives, moving both would reorder the list twice and the pager would jump on a refetch
    // for a reason nobody could see.
    const rows = [
      paper({ symbol: 'MU' }),
      paper({ symbol: 'TSLA', onBoard: true }),
      paper({ symbol: 'SNDK', onBoard: true }),
    ]
    expect(orderPapers(doc(rows)).map((p) => p.symbol)).toEqual(['TSLA', 'MU', 'SNDK'])
  })

  it('answers an empty list for an empty document without inventing a page', () => {
    expect(orderPapers(doc([]))).toEqual([])
  })
})

describe('papersPagerView', () => {
  it('has no pager before storage has answered', () => {
    // The first frame of every cold launch. Saying "no papers" here would flash the single-page
    // reader out and back on a phone that has five.
    expect(papersPagerView({ ready: null, doc: null })).toEqual({ pager: false, papers: [] })
  })

  it('has no pager on a phone with no desk', () => {
    expect(papersPagerView({ ready: false, doc: null })).toEqual({ pager: false, papers: [] })
  })

  it('has no pager when the desk answered and has nothing to page through', () => {
    // An empty watchlist, or every symbol marked `printable: false`. Today stays exactly what it
    // is without a desk: one page, `/news.json`.
    expect(papersPagerView({ ready: true, doc: doc([]) })).toEqual({ pager: false, papers: [] })
  })

  it('has no pager while the desk has been asked and has not answered', () => {
    expect(papersPagerView({ ready: true, doc: null })).toEqual({ pager: false, papers: [] })
  })

  it('pages as soon as there is one paper, in pager order', () => {
    const view = papersPagerView({
      ready: true,
      doc: doc([paper({ symbol: 'MU' }), paper({ symbol: 'SNDK', onBoard: true })]),
    })
    expect(view.pager).toBe(true)
    expect(view.papers.map((p) => p.symbol)).toEqual(['SNDK', 'MU'])
  })

  it('pages over a symbol that has no paper yet — it is a page, not a gap', () => {
    const view = papersPagerView({
      ready: true,
      doc: doc([paper({ symbol: 'MU', editionId: null, createdAt: null })]),
    })
    expect(view.pager).toBe(true)
    expect(view.papers).toHaveLength(1)
  })
})

describe('paperAgeLabel', () => {
  const NOW = 1_757_021_600_000

  it('says how long ago the desk wrote it', () => {
    expect(paperAgeLabel(NOW - 6 * 3600_000, NOW)).toBe('6h ago')
  })

  it('speaks the app’s language, not the edition’s', () => {
    // The header row is the APP talking about a paper. The paper's own language governs the type
    // below it (`typeRamp`), not this line.
    setActiveLanguage('ko')
    expect(paperAgeLabel(NOW - 6 * 3600_000, NOW)).toBe('6시간 전')
  })

  it('says nothing for a symbol with no paper', () => {
    expect(paperAgeLabel(null, NOW)).toBeNull()
  })

  it('says nothing for a stamp in the future rather than counting backwards', () => {
    // A desk whose clock is ahead. "-1h ago" is worse than silence, `freshnessLabel`'s rule.
    expect(paperAgeLabel(NOW + 60_000, NOW)).toBeNull()
  })
})

describe('clampPaperIndex', () => {
  it('keeps a valid index', () => {
    expect(clampPaperIndex(2, 5)).toBe(2)
  })

  it('pulls an index past the end back to the last page', () => {
    // The watchlist shrank between two list fetches and the reader was on the page that went.
    expect(clampPaperIndex(4, 3)).toBe(2)
  })

  it('answers 0 for an empty list and for nonsense', () => {
    expect(clampPaperIndex(3, 0)).toBe(0)
    expect(clampPaperIndex(-1, 3)).toBe(0)
    expect(clampPaperIndex(Number.NaN, 3)).toBe(0)
  })
})

describe('paperKey', () => {
  it('changes when the symbol’s edition changes, so a refreshed paper remounts', () => {
    expect(paperKey(paper({ symbol: 'MU', editionId: 'e1' }))).not.toBe(
      paperKey(paper({ symbol: 'MU', editionId: 'e2' })),
    )
  })

  it('is stable for an unchanged row, so a list refetch does not remount the page', () => {
    expect(paperKey(paper())).toBe(paperKey(paper()))
  })

  it('names a symbol with no edition without colliding with another', () => {
    expect(paperKey(paper({ symbol: 'MU', editionId: null }))).not.toBe(
      paperKey(paper({ symbol: 'TSLA', editionId: null })),
    )
  })
})

describe('isPaperRowDisabled', () => {
  it('is disabled for a symbol with no paper', () => {
    expect(isPaperRowDisabled(paper({ editionId: null }), null)).toBe(true)
  })

  it('is disabled for the paper already on the board', () => {
    expect(isPaperRowDisabled(paper({ onBoard: true }), null)).toBe(true)
  })

  it('is disabled for every row while a publish is in flight, not only the one publishing', () => {
    expect(isPaperRowDisabled(paper({ symbol: 'MU' }), 'SNDK')).toBe(true)
  })

  it('is enabled for an ordinary tappable row', () => {
    expect(isPaperRowDisabled(paper(), null)).toBe(false)
  })
})
