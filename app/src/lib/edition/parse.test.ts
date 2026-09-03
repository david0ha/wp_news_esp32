import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseEdition, emptyEdition, isEmptyEdition, STORY_RANK_MAX } from './parse'
import { EDITION_CAPS, STORY_RANK_DEFAULT } from './types'

// The repo fixture, read off disk rather than imported, so this file exercises exactly the bytes
// the firmware's own test_news_mock parses.
const FIXTURE = join(__dirname, '../../../../components/news_core/test/host/fixtures/news.json')
const fixture = (): unknown => JSON.parse(readFileSync(FIXTURE, 'utf8'))

describe('parseEdition — the repo fixture', () => {
  it('round-trips with the counts the fixture actually carries', () => {
    const e = parseEdition(fixture())
    expect(e.edition).toBe('SEMICONDUCTORS')
    expect(e.dateline).toBe('FRIDAY, AUGUST 14, 2026')
    expect(e.session).toBe('U.S. MARKETS CLOSED — AUG 13')
    expect(e.asOf).toBe('AS OF 05:12 KST')
    expect(e.generatedAt).toBe('2026-08-14T05:12:00Z')
    expect({
      stories: e.stories.length,
      figures: e.figures.length,
      briefs: e.briefs.length,
      peers: e.peers.length,
      tables: e.tables.length,
      charts: e.charts.length,
      indices: e.indices.length,
      thumbs: e.thumbs.length,
    }).toEqual({
      stories: 4, figures: 22, briefs: 6, peers: 5,
      tables: 2, charts: 2, indices: 5, thumbs: 2,
    })
  })

  it('reads the subject as decimals, not cents', () => {
    const s = parseEdition(fixture()).subject
    expect(s).toEqual({
      symbol: 'SNDK',
      name: 'Sandisk Corp.',
      exchange: 'NASDAQ',
      sector: 'Semiconductors',
      last: 1631.47,
      changePct: 2.41,
      prevClose: 1593.09,
      open: 1598.2,
      high: 1642.0,
      low: 1590.55,
      wk52High: 1712.4,
      wk52Low: 402.18,
    })
  })

  it('sorts the stories by rank and resolves each one’s chart index', () => {
    const e = parseEdition(fixture())
    expect(e.stories.map((s) => s.rank)).toEqual([0, 1, 2, 3])
    expect(e.stories[0].headline).toBe('Sandisk clears $1,600 as NAND contract prices reset again')
    expect(e.stories[0].kicker).toBe('NAND PRICING')
    expect(e.stories[0].chart).toBe(1)
    expect(e.stories[0].photo).toEqual({
      id: 'sndk_fab',
      w: 1140,
      h: 320,
      caption: 'The Yokkaichi joint-venture fab, where the bit supply is not growing.',
      credit: 'DEMO IMAGE',
    })
    // The second story carries neither key at all — absent must land as null, not as 0.
    expect(e.stories[1].chart).toBeNull()
    expect(e.stories[1].photo).toBeNull()
    expect(e.stories[3].chart).toBe(0)
    expect(e.stories[0].body.length).toBe(3633)
  })

  it('keeps the figures in wire order with their groups intact', () => {
    const e = parseEdition(fixture())
    expect(e.figures[0]).toEqual({
      group: 'VALUATION',
      label: '52-WEEK RANGE',
      value: '$402–$1,712',
      changePct: null,
      emph: true, // the wire writes `1`; news_parse.c accepts both spellings
      bar: 938,
    })
    expect(e.figures[1]).toEqual({
      group: 'VALUATION', label: 'MARKET CAP', value: '$241.6B',
      changePct: null, emph: false, bar: null,
    })
    // Six groups, in first-seen order, with these sizes.
    const groups: Array<[string, number]> = []
    for (const f of e.figures) {
      const last = groups[groups.length - 1]
      if (last !== undefined && last[0] === f.group) last[1] += 1
      else groups.push([f.group, 1])
    }
    expect(groups).toEqual([
      ['VALUATION', 4],
      ['PER SHARE', 3],
      ['PROFITABILITY', 3],
      ['REVENUE MIX', 3],
      ['BALANCE SHEET', 4],
      ['THE STREET', 5],
    ])
  })

  it('reads both statements, their columns and their numeric plane', () => {
    const [a, b] = parseEdition(fixture()).tables
    expect(a.title).toBe('REVENUE, PROFIT AND MARGIN')
    expect(a.render).toBe('bars_line')
    expect(a.columns).toEqual(['1Q25', '2Q25', '3Q25', '4Q25', '1Q26', '2Q26'])
    expect(a.rows.map((r) => r.label)).toEqual(['Revenue', 'Net income', 'Net margin'])
    expect(a.rows[0].values).toEqual(['1,672', '1,952', '2,845', '4,190', '6,720', '9,340'])
    expect(a.rows[0].n).toEqual([1672, 1952, 2845, 4190, 6720, 9340])
    expect(a.rows[2].n).toEqual([-2213, -1158, 2253, 3663, 4699, 5846])
    expect(b.title).toBe('REVENUE BY END MARKET')
    expect(b.render).toBe('stack')
    expect(b.rows.map((r) => r.label)).toEqual(['Client', 'Consumer', 'Cloud'])
  })

  it('reads both charts with parallel series of the close’s length', () => {
    const [price, nand] = parseEdition(fixture()).charts
    expect(price.kind).toBe('line')
    expect(price.label).toBe('PRICE')
    expect(price.span).toBe('6M')
    expect(price.note).toBe('Weekly close, in dollars')
    expect(price.close).toHaveLength(26)
    expect(price.close.slice(0, 3)).toEqual([978.4, 1002.15, 964.8])
    // The wire sends no open/high/low for a line chart; the parallel arrays fall back to the
    // close at the SAME ABSOLUTE index, so a consumer that reaches for high[] gets a flat bar
    // instead of a shifted one.
    expect(price.open).toHaveLength(26)
    expect(price.high[0]).toBe(978.4)
    expect(nand.kind).toBe('bar')
    expect(nand.label).toBe('NAND CONTRACT')
    expect(nand.span).toBe('6Q')
    expect(nand.close).toEqual([2.1, 1.98, 2.24, 2.61, 3.02, 3.56])
  })

  it('reads the peers and the tape', () => {
    const e = parseEdition(fixture())
    expect(e.peers.map((p) => p.symbol)).toEqual(['MU', 'SNDK', 'HXSCL', 'INTC', 'ADI'])
    expect(e.peers[1]).toEqual({
      symbol: 'SNDK', name: 'Sandisk', per: '22.38x', cap: '$241.6B',
      last: 1631.47, changePct: 2.41, isSubject: true,
    })
    expect(e.peers[0].isSubject).toBe(false)
    expect(e.indices.map((i) => i.symbol)).toEqual(['SPX', 'NDX', 'SOX', 'UST10Y', 'VIX'])
    expect(e.indices[0].name).toBe('S&P 500')
    expect(e.indices[0].last).toBe(6412.83)
    expect(e.indices[0].spark).toHaveLength(12)
    expect(e.thumbs.map((t) => t.id)).toEqual(['sndk_wafer', 'sndk_line'])
    expect(e.thumbs[0].w).toBe(364)
    expect(e.thumbs[0].h).toBe(204)
  })

  it('is not empty', () => {
    expect(isEmptyEdition(parseEdition(fixture()))).toBe(false)
  })
})

describe('parseEdition — totality', () => {
  it('never throws on anything', () => {
    for (const junk of [undefined, null, 0, '', 'nope', [], true, { stories: 'no' }]) {
      expect(() => parseEdition(junk)).not.toThrow()
    }
    expect(parseEdition(undefined)).toEqual(emptyEdition())
    expect(isEmptyEdition(parseEdition(undefined))).toBe(true)
  })

  it('turns wrong types into the defaults rather than keeping them', () => {
    const e = parseEdition({
      edition: 42,
      dateline: null,
      subject: 'not an object',
      stories: { nope: true },
      figures: null,
    })
    expect(e.edition).toBe('')
    expect(e.dateline).toBe('')
    expect(e.subject.symbol).toBe('')
    expect(e.subject.last).toBeNull()
    expect(e.stories).toEqual([])
    expect(e.figures).toEqual([])
  })

  it('maps a non-finite number to null', () => {
    // JSON cannot carry NaN, but a cache re-parse can (Task 5 re-parses whatever it read).
    const e = parseEdition({ subject: { last: NaN, changePct: Infinity, open: -Infinity } })
    expect([e.subject.last, e.subject.changePct, e.subject.open]).toEqual([null, null, null])
  })

  it('reads 0 on the 52-week pair as “the wire did not say”', () => {
    const e = parseEdition({ subject: { wk52_high: 0, wk52_low: 0, prev_close: 0 } })
    expect(e.subject.wk52High).toBeNull()
    expect(e.subject.wk52Low).toBeNull()
    // prev_close is NOT in that rule — a real zero close is a real number.
    expect(e.subject.prevClose).toBe(0)
  })

  it('drops a story with no headline, a figure with no label and no value, a peer with no symbol', () => {
    const e = parseEdition({
      stories: [{ headline: 'kept' }, { deck: 'orphan deck' }, { headline: '' }],
      figures: [{ label: 'A', value: '1' }, { group: 'G' }, { value: '2' }],
      peers: [{ symbol: 'MU' }, { name: 'no symbol' }],
    })
    expect(e.stories.map((s) => s.headline)).toEqual(['kept'])
    expect(e.figures.map((f) => f.label)).toEqual(['A', ''])
    expect(e.figures[1].value).toBe('2')
    expect(e.peers.map((p) => p.symbol)).toEqual(['MU'])
  })

  it('gives an unranked story rank 9 and clamps a wild one', () => {
    const e = parseEdition({
      stories: [{ headline: 'unranked' }, { headline: 'wild', rank: 5000 }, { headline: 'neg', rank: -3 }],
    })
    const byHeadline = Object.fromEntries(e.stories.map((s) => [s.headline, s.rank]))
    expect(byHeadline.unranked).toBe(STORY_RANK_DEFAULT)
    expect(byHeadline.wild).toBe(STORY_RANK_MAX)
    expect(byHeadline.neg).toBe(0)
  })

  it('rounds a fractional number to an int the way news_parse.c’s jint does', () => {
    // news_parse.c:65-70 — every JSON number that becomes an int goes through `sround()`, which
    // is round-half-away-from-zero. Truncating here reads one payload two ways: a producer that
    // files a 101.6 px tile gives the board an even 102 (blittable, printed) and the phone an odd
    // 101 (rejected, no picture), and neither side has a symptom that says so.
    const e = parseEdition({
      charts: [{ kind: 'line', close: [1] }, { kind: 'line', close: [2] }],
      stories: [
        { headline: 'up', rank: 2.6 },
        { headline: 'down', rank: 2.4 },
        { headline: 'chart', rank: 1, chart: 0.6 },
        { headline: 'photo', rank: 0, photo: { id: 'p', w: 101.6, h: 100.4 } },
      ],
    })
    const by = Object.fromEntries(e.stories.map((s) => [s.headline, s]))
    expect(by.up.rank).toBe(3)
    expect(by.down.rank).toBe(2)
    // 0.6 rounds to chart 1, which the two-chart payload has. Truncating would name chart 0.
    expect(by.chart.chart).toBe(1)
    // 101.6 rounds to 102: even, so it is blittable and the photo survives.
    expect(by.photo.photo).toEqual({ id: 'p', w: 102, h: 100, caption: '', credit: '' })
  })

  it('sorts by rank stably and cuts to five AFTER sorting', () => {
    // A producer that appends its lead must keep it. Six stories in, the rank-8 straggler goes.
    const e = parseEdition({
      stories: [
        { headline: 'f', rank: 8 },
        { headline: 'b', rank: 2 },
        { headline: 'c', rank: 3 },
        { headline: 'd', rank: 4 },
        { headline: 'e', rank: 5 },
        { headline: 'a', rank: 0 },
      ],
    })
    expect(e.stories).toHaveLength(EDITION_CAPS.stories)
    expect(e.stories.map((s) => s.headline)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('keeps equal ranks in wire order', () => {
    const e = parseEdition({
      stories: [{ headline: 'x', rank: 2 }, { headline: 'y', rank: 2 }, { headline: 'z', rank: 1 }],
    })
    expect(e.stories.map((s) => s.headline)).toEqual(['z', 'x', 'y'])
  })

  it('nulls a chart index that names no chart', () => {
    const withChart = { charts: [{ kind: 'line', close: [1, 2] }] }
    expect(parseEdition({ ...withChart, stories: [{ headline: 'h', chart: 0 }] }).stories[0].chart).toBe(0)
    expect(parseEdition({ ...withChart, stories: [{ headline: 'h', chart: 1 }] }).stories[0].chart).toBeNull()
    expect(parseEdition({ ...withChart, stories: [{ headline: 'h', chart: -1 }] }).stories[0].chart).toBeNull()
    expect(parseEdition({ stories: [{ headline: 'h', chart: 0 }] }).stories[0].chart).toBeNull()
  })

  it('falls an unknown chart kind back to line', () => {
    const e = parseEdition({ charts: [{ kind: 'violin', close: [1] }, { kind: 'candle', close: [1] }] })
    expect(e.charts.map((c) => c.kind)).toEqual(['line', 'candle'])
  })

  it('drops a chart point that has no close, and keeps the series parallel', () => {
    const e = parseEdition({
      charts: [{ kind: 'line', close: [1, null, 3], high: [10, 20, 30], low: ['x', 20, 30] }],
    })
    expect(e.charts[0].close).toEqual([1, 3])
    expect(e.charts[0].high).toEqual([10, 30]) // read at the same ABSOLUTE index, not the same offset
    expect(e.charts[0].low).toEqual([1, 30]) // a non-number falls back to that point's close
  })

  it('clamps a figure bar to 0..1000 and keeps an absent one null', () => {
    const e = parseEdition({
      figures: [
        { label: 'a', value: '1', bar: 2000 },
        { label: 'b', value: '2', bar: -5 },
        { label: 'c', value: '3' },
        { label: 'd', value: '4', bar: 0 },
      ],
    })
    expect(e.figures.map((f) => f.bar)).toEqual([1000, 0, null, 0])
  })

  it('treats emph as two-tier — true or any non-zero number — but is_subject only as strict true', () => {
    // news_parse.c:522-524 — `emph` promotes on JSON true OR a non-zero number.
    const e = parseEdition({
      figures: [
        { label: 'a', value: '1', emph: 2 },
        { label: 'b', value: '2', emph: 0.5 },
        { label: 'c', value: '3', emph: 0 },
        { label: 'd', value: '4', emph: 1 },
        { label: 'e', value: '5', emph: true },
        { label: 'f', value: '6' },
      ],
    })
    expect(e.figures.map((f) => f.emph)).toEqual([true, true, false, true, true, false])

    // news_parse.c:83-85 (`jbool`) — is_subject is `cJSON_IsTrue` only; a numeric 1 is NOT true.
    const p = parseEdition({
      peers: [
        { symbol: 'A', is_subject: 1 },
        { symbol: 'B', is_subject: true },
      ],
    })
    expect(p.peers.map((x) => x.isSubject)).toEqual([false, true])
  })

  it('drops a brief with no text, and it does not count toward the cap', () => {
    // news_parse.c:562-563 — the text is the item; a date/kicker over nothing is furniture.
    const e = parseEdition({
      briefs: [{ date: 'MON', kicker: 'K', text: '' }, { text: 'kept' }],
    })
    expect(e.briefs).toHaveLength(1)
    expect(e.briefs[0].text).toBe('kept')
  })

  it('pads a statement’s numeric plane to the row’s cell count', () => {
    const e = parseEdition({
      tables: [{ title: 'T', columns: ['A', 'B', 'C'], rows: [{ label: 'r', values: ['1', '2', '3'], n: [1] }] }],
    })
    expect(e.tables[0].rows[0].n).toEqual([1, null, null])
  })

  it('applies every cap', () => {
    const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i))
    const e = parseEdition({
      stories: many(9, (i) => ({ headline: `h${i}`, rank: i })),
      figures: many(40, (i) => ({ label: `l${i}`, value: `${i}` })),
      briefs: many(20, (i) => ({ text: `b${i}` })),
      peers: many(20, (i) => ({ symbol: `P${i}` })),
      tables: many(5, (i) => ({ title: `t${i}` })),
      charts: many(5, () => ({ kind: 'line', close: [1] })),
      indices: many(20, (i) => ({ symbol: `I${i}` })),
    })
    expect(e.stories).toHaveLength(EDITION_CAPS.stories)
    expect(e.figures).toHaveLength(EDITION_CAPS.figures)
    expect(e.briefs).toHaveLength(EDITION_CAPS.briefs)
    expect(e.peers).toHaveLength(EDITION_CAPS.peers)
    expect(e.tables).toHaveLength(EDITION_CAPS.tables)
    expect(e.charts).toHaveLength(EDITION_CAPS.charts)
    expect(e.indices).toHaveLength(EDITION_CAPS.indices)
  })

  it('refuses a photo with no id or no usable geometry', () => {
    const e = parseEdition({
      stories: [
        { headline: 'a', photo: { w: 100, h: 100 } },
        { headline: 'b', photo: { id: 'x', w: 0, h: 100 } },
        { headline: 'c', photo: { id: 'y', w: 101, h: 100 } }, // odd width: not blittable
        { headline: 'd', photo: { id: 'z', w: 100, h: 100 } },
      ],
    })
    expect(e.stories.map((s) => s.photo?.id ?? null)).toEqual([null, null, null, 'z'])
  })

  it('ignores unknown keys', () => {
    const e = parseEdition({ schema: 3, nonsense: { deep: [1, 2] }, edition: 'X' })
    expect(e.edition).toBe('X')
    expect(Object.keys(e).sort()).toEqual(Object.keys(emptyEdition()).sort())
  })
})

describe('isEmptyEdition', () => {
  it('is true only with no symbol and no stories', () => {
    expect(isEmptyEdition(emptyEdition())).toBe(true)
    expect(isEmptyEdition(parseEdition({ subject: { symbol: 'X' } }))).toBe(false)
    expect(isEmptyEdition(parseEdition({ stories: [{ headline: 'h' }] }))).toBe(false)
    // Furniture alone is not an edition — a dateline with nothing under it is a blank sheet.
    expect(isEmptyEdition(parseEdition({ dateline: 'FRIDAY', edition: 'SEMIS' }))).toBe(true)
  })
})
