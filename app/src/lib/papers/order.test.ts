import { describe, it, expect, beforeEach } from '@jest/globals'
import {
  clampPaperIndex,
  isPaperRowDisabled,
  orderPapers,
  paperAgeLabel,
  paperHeaderChips,
  paperKey,
  paperStatusLine,
  papersPagerView,
} from './order'
import { setActiveLanguage } from '../../i18n'
import { en } from '../../i18n/en'
import { ko } from '../../i18n/ko'
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

describe('paperStatusLine', () => {
  const NOW = 1_757_021_600_000

  it('names a real paper as name and age, joined', () => {
    expect(paperStatusLine(paper({ createdAt: NOW - 6 * 3600_000 }), NOW, en)).toEqual({
      text: 'SanDisk · 6h ago',
      a11y: 'SanDisk, paper written 6h ago',
    })
  })

  // D1 / D1b / D1c — a symbol with no paper yet is a real, expected state (§5), and it must say
  // the SAME thing the Board tab already says for it: `papers.board.noPaper`, in both the pager
  // header's text AND the Board row's accessibility sentence. Before this helper existed the
  // header said "Written at an unknown time" — which claims a paper exists and its date was
  // lost — and the Board row's a11y label filled `{age}` with an empty string, reading as an
  // unfinished sentence to VoiceOver.
  it('says exactly "Not written yet" for a paper-less row — no name prefix, matching the Board tab', () => {
    const row = paper({ editionId: null, createdAt: null })
    expect(paperStatusLine(row, NOW, en).text).toBe(en.papers.board.noPaper)
    expect(paperStatusLine(row, NOW, en).text).not.toMatch(/unknown/i)
  })

  it('finishes the accessibility sentence for a paper-less row instead of trailing off', () => {
    const row = paper({ editionId: null, createdAt: null })
    expect(paperStatusLine(row, NOW, en).a11y).toBe('SanDisk, Not written yet')
    expect(paperStatusLine(row, NOW, en).a11y.endsWith(' ')).toBe(false)
  })

  it('reuses the exact Korean noPaper phrase, not a second translation', () => {
    const row = paper({ editionId: null, createdAt: null })
    expect(paperStatusLine(row, NOW, ko).text).toBe(ko.papers.board.noPaper)
    expect(paperStatusLine(row, NOW, ko).a11y).toBe(`SanDisk, ${ko.papers.board.noPaper}`)
  })

  it('falls back to the symbol when the desk sent no name, for a paper-less row too', () => {
    const row = paper({ name: '', editionId: null, createdAt: null })
    expect(paperStatusLine(row, NOW, en).a11y).toBe('SNDK, Not written yet')
  })

  it('still says "written at an unknown time" for a paper that exists but carries no timestamp', () => {
    // Different from a paper-less row: this company HAS a paper, the desk just sent no
    // `created_at` for it. That is `paperAgeLabel`'s existing `noAge` case and stays as it was.
    const row = paper({ createdAt: null })
    expect(paperStatusLine(row, NOW, en).text).toBe('SanDisk · Written at an unknown time')
  })

  // The a11y sentence for that same row used to be built by pouring `page.noAge` into `{age}`,
  // which welded two phrases together: "SanDisk, paper written Written at an unknown time".
  // One state, one phrasing — so this case gets its own key rather than a concatenation.
  it('speaks one finished sentence for a paper whose timestamp is missing, not two glued together', () => {
    const row = paper({ createdAt: null })
    const spoken = paperStatusLine(row, NOW, en).a11y
    expect(spoken).toBe('SanDisk, paper written at an unknown time')
    // The welded form contained `page.noAge` verbatim, capital and all, mid-sentence.
    expect(spoken).not.toContain(en.papers.page.noAge)
    expect(spoken.match(/written/gi)).toHaveLength(1)
  })

  it('speaks that same state in Korean, through the catalogue and not a second translation', () => {
    const row = paper({ createdAt: null })
    expect(paperStatusLine(row, NOW, ko).a11y).toBe(
      ko.papers.board.a11y.rowNoAge.replace('{name}', 'SanDisk'),
    )
    expect(paperStatusLine(row, NOW, ko).a11y).not.toBe(paperStatusLine(row, NOW, en).a11y)
  })

  it('falls back to the symbol in that state too', () => {
    const row = paper({ name: '', createdAt: null })
    expect(paperStatusLine(row, NOW, en).a11y).toBe('SNDK, paper written at an unknown time')
    // `text` has no name to join, so it is the age phrase alone rather than a leading separator.
    expect(paperStatusLine(row, NOW, en).text).toBe('Written at an unknown time')
  })

  it('keeps the three states distinct from one another', () => {
    // No paper / paper with no timestamp / paper with an age: three different spoken sentences.
    const spoken = [
      paper({ editionId: null, createdAt: null }),
      paper({ createdAt: null }),
      paper({ createdAt: NOW - 6 * 3600_000 }),
    ].map((row) => paperStatusLine(row, NOW, en).a11y)
    expect(new Set(spoken).size).toBe(3)
  })
})

describe('paperHeaderChips', () => {
  it('shows on-board alone for a fresh paper that is on the board', () => {
    expect(paperHeaderChips(paper({ onBoard: true, stale: false }))).toEqual({
      onBoard: true,
      stale: false,
    })
  })

  // D3 — on_board and stale are independent facts (spec §5) and a paper can be both the one on
  // the glass AND overdue for a rewrite. The header used to hide the stale chip whenever on-board
  // was true, which meant the one page actually on the panel could never tell you it was stale.
  it('shows BOTH chips when a paper is on the board and also stale', () => {
    expect(paperHeaderChips(paper({ onBoard: true, stale: true }))).toEqual({
      onBoard: true,
      stale: true,
    })
  })

  it('shows stale alone for an overdue paper that is not on the board', () => {
    expect(paperHeaderChips(paper({ onBoard: false, stale: true }))).toEqual({
      onBoard: false,
      stale: true,
    })
  })

  // D1c — "due a refresh" is a claim about a paper that exists. A row with no edition must never
  // show it, whatever the desk happened to send in `stale` for that row.
  it('never shows the stale chip for a symbol with no paper, even if the desk marked it stale', () => {
    expect(paperHeaderChips(paper({ editionId: null, stale: true }))).toEqual({
      onBoard: false,
      stale: false,
    })
  })
})
