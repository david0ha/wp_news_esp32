import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseEdition } from './parse'
import { emptyEdition } from './parse'
import {
  availableChips,
  CHIPS,
  editionToTiles,
  estimateTileHeight,
  filterTiles,
  findTile,
  splitColumns,
  TILE_HEAD,
  TILE_MORE,
  TILE_PADDING,
  TILE_ROW_BRIEFS,
  TILE_ROW_FIGURES,
  TILE_ROW_PEERS,
  TILE_ROW_TAPE,
  TILE_SHOWN_BRIEFS,
  TILE_SHOWN_PEERS,
  type Tile,
} from './tiles'
import { type Edition, type EditionFigure } from './types'

const FIXTURE = join(__dirname, '../../../../components/news_core/test/host/fixtures/news.json')
const demo = (): Edition => parseEdition(JSON.parse(readFileSync(FIXTURE, 'utf8')))

const W = 170 // a realistic column: (375 - 2*16 - 12) / 2 is 165.5; 170 keeps the arithmetic honest

describe('editionToTiles — the order rule, on the repo fixture', () => {
  it('lays the edition out in exactly the documented order', () => {
    const { tiles } = editionToTiles(demo())
    expect(tiles.map((t) => t.id)).toEqual([
      'range:0',
      'story:0',
      'chart:0',
      'story:1',
      'story:2',
      'story:3',
      'figures:0',
      'figures:1',
      'figures:2',
      'figures:3',
      'figures:4',
      'figures:5',
      'photo:0',
      'photo:1',
      'briefs:0',
      'peers:0',
      'table:0',
      'table:1',
      'tape:0',
      'chart:1',
    ])
    expect(tiles).toHaveLength(20)
  })

  it('marks only the lowest-ranked story as the lead', () => {
    const { tiles } = editionToTiles(demo())
    const stories = tiles.filter((t): t is Extract<Tile, { kind: 'story' }> => t.kind === 'story')
    expect(stories.map((t) => t.lead)).toEqual([true, false, false, false])
    expect(stories[0].story.rank).toBe(0)
    expect(stories[0].story.headline).toBe('Sandisk clears $1,600 as NAND contract prices reset again')
  })

  it('cuts one figures tile per group, in first-seen order, with the group’s own figures', () => {
    const { tiles } = editionToTiles(demo())
    const groups = tiles.filter((t): t is Extract<Tile, { kind: 'figures' }> => t.kind === 'figures')
    expect(groups.map((t) => [t.group, t.figures.length])).toEqual([
      ['VALUATION', 4],
      ['PER SHARE', 3],
      ['PROFITABILITY', 3],
      ['REVENUE MIX', 3],
      ['BALANCE SHEET', 4],
      ['THE STREET', 5],
    ])
    expect(groups[0].figures[0].label).toBe('52-WEEK RANGE')
    // Every figure lands in exactly one tile.
    expect(groups.reduce((n, t) => n + t.figures.length, 0)).toBe(22)
  })

  it('puts the briefs, the peers and the tape in one tile each', () => {
    const { tiles } = editionToTiles(demo())
    const briefs = tiles.find((t) => t.kind === 'briefs')
    const peers = tiles.find((t) => t.kind === 'peers')
    const tape = tiles.find((t) => t.kind === 'tape')
    expect(briefs?.kind === 'briefs' && briefs.briefs).toHaveLength(6)
    expect(peers?.kind === 'peers' && peers.peers).toHaveLength(5)
    expect(tape?.kind === 'tape' && tape.indices).toHaveLength(5)
  })

  it('keeps both statements as separate tiles, in wire order', () => {
    const { tiles } = editionToTiles(demo())
    const tables = tiles.filter((t): t is Extract<Tile, { kind: 'table' }> => t.kind === 'table')
    expect(tables.map((t) => t.table.title)).toEqual([
      'REVENUE, PROFIT AND MARGIN',
      'REVENUE BY END MARKET',
    ])
  })
})

describe('editionToTiles — the band rule', () => {
  it('promotes a wide lead photo to the band, out of the grid', () => {
    const { band, tiles } = editionToTiles(demo())
    // 1140 x 320 is 3.56:1 — at a 170 px column it would be 48 px tall.
    expect(band?.id).toBe('sndk_fab')
    const photos = tiles.filter((t): t is Extract<Tile, { kind: 'photo' }> => t.kind === 'photo')
    expect(photos.map((t) => t.photo.id)).toEqual(['sndk_wafer', 'sndk_line'])
  })

  it('leaves a lead photo of ordinary aspect in the grid, as the FIRST photo tile', () => {
    const e = demo()
    const ordinary = { ...e, stories: [...e.stories] }
    ordinary.stories[0] = {
      ...ordinary.stories[0],
      photo: { id: 'square', w: 400, h: 300, caption: 'c', credit: 'k' },
    }
    const { band, tiles } = editionToTiles(ordinary)
    expect(band).toBeNull()
    const photos = tiles.filter((t): t is Extract<Tile, { kind: 'photo' }> => t.kind === 'photo')
    expect(photos.map((t) => t.photo.id)).toEqual(['square', 'sndk_wafer', 'sndk_line'])
    expect(photos.map((t) => t.id)).toEqual(['photo:0', 'photo:1', 'photo:2'])
  })

  it('is exactly 2:1 that stays in the grid — the rule is strictly greater', () => {
    const e = demo()
    const two = { ...e, stories: [...e.stories] }
    two.stories[0] = {
      ...two.stories[0],
      photo: { id: 'twice', w: 400, h: 200, caption: '', credit: '' },
    }
    expect(editionToTiles(two).band).toBeNull()
  })
})

describe('editionToTiles — a kind with nothing behind it is absent', () => {
  it('gives an empty edition no tiles and no band', () => {
    expect(editionToTiles(emptyEdition())).toEqual({ band: null, tiles: [] })
  })

  it('omits the range tile when the subject carries no numbers at all', () => {
    const e = parseEdition({ subject: { symbol: 'X', name: 'X Co' }, stories: [{ headline: 'h' }] })
    expect(editionToTiles(e).tiles.map((t) => t.id)).toEqual(['story:0'])
  })

  it('keeps the range tile on a single number', () => {
    const e = parseEdition({ subject: { symbol: 'X', prev_close: 10 } })
    expect(editionToTiles(e).tiles.map((t) => t.id)).toEqual(['range:0'])
  })

  it('drops a figures group whose name is empty into one unnamed tile rather than none', () => {
    // A producer that files figures with no group still gets them on screen; the tile shows no
    // heading rather than being silently discarded.
    const e = parseEdition({ figures: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }] })
    const groups = editionToTiles(e).tiles.filter((t) => t.kind === 'figures')
    expect(groups).toHaveLength(1)
    expect(groups[0].kind === 'figures' && groups[0].group).toBe('')
    expect(groups[0].kind === 'figures' && groups[0].figures).toHaveLength(2)
  })
})

describe('chips', () => {
  it('names five, in the order the row draws them', () => {
    expect(CHIPS.map((c) => c.id)).toEqual(['all', 'stories', 'numbers', 'accounts', 'photos'])
    expect(CHIPS.map((c) => c.label)).toEqual(['All', 'Stories', 'Numbers', 'Accounts', 'Photos'])
  })

  it('splits the fixture’s twenty tiles into the four buckets', () => {
    const { tiles } = editionToTiles(demo())
    expect(filterTiles(tiles, 'all')).toHaveLength(20)
    expect(filterTiles(tiles, 'stories').map((t) => t.id)).toEqual([
      'story:0', 'story:1', 'story:2', 'story:3', 'briefs:0',
    ])
    expect(filterTiles(tiles, 'numbers').map((t) => t.id)).toEqual([
      'range:0', 'chart:0', 'figures:0', 'figures:1', 'figures:2',
      'figures:3', 'figures:4', 'figures:5', 'peers:0', 'tape:0', 'chart:1',
    ])
    expect(filterTiles(tiles, 'accounts').map((t) => t.id)).toEqual(['table:0', 'table:1'])
    expect(filterTiles(tiles, 'photos').map((t) => t.id)).toEqual(['photo:0', 'photo:1'])
    // Every tile is in exactly one bucket.
    const counted =
      filterTiles(tiles, 'stories').length +
      filterTiles(tiles, 'numbers').length +
      filterTiles(tiles, 'accounts').length +
      filterTiles(tiles, 'photos').length
    expect(counted).toBe(tiles.length)
  })

  it('keeps feed order inside a filter', () => {
    const { tiles } = editionToTiles(demo())
    const ids = tiles.map((t) => t.id)
    const filtered = filterTiles(tiles, 'numbers').map((t) => t.id)
    expect(filtered).toEqual(ids.filter((id) => filtered.includes(id)))
  })

  it('hides a chip with nothing behind it', () => {
    const { tiles } = editionToTiles(demo())
    expect(availableChips(tiles)).toEqual(['all', 'stories', 'numbers', 'accounts', 'photos'])
    const storiesOnly = filterTiles(tiles, 'stories')
    expect(availableChips(storiesOnly)).toEqual(['all', 'stories'])
    expect(availableChips([])).toEqual(['all'])
  })
})

describe('estimateTileHeight — the table, at a 170px column', () => {
  const { tiles } = editionToTiles(demo())
  const by = (id: string): Tile => {
    const hit = tiles.find((t) => t.id === id)
    if (hit === undefined) throw new Error(`no tile ${id}`)
    return hit
  }

  it('sizes each kind exactly as the table says', () => {
    // The chrome the four row-built kinds share: 2 * 14 of padding + a 24 px heading line.
    expect(TILE_PADDING).toBe(14)
    expect(TILE_HEAD).toBe(24)
    expect(TILE_MORE).toBe(20)
    expect(estimateTileHeight(by('story:0'), W)).toBe(227) // lead: round(170 * 4/3)
    expect(estimateTileHeight(by('story:1'), W)).toBe(170) // other: the column, square
    expect(estimateTileHeight(by('range:0'), W)).toBe(170)
    expect(estimateTileHeight(by('chart:0'), W)).toBe(128) // round(170 * 3/4) = round(127.5)
    expect(estimateTileHeight(by('table:0'), W)).toBe(213) // round(170 * 5/4) = round(212.5)
    expect(estimateTileHeight(by('photo:0'), W)).toBe(113) // 364x204 is flatter than 2:3, clamped
    expect(estimateTileHeight(by('figures:0'), W)).toBe(164) // VALUATION, 4 rows: 52 + 4*28
    expect(estimateTileHeight(by('figures:1'), W)).toBe(136) // PER SHARE, 3 rows: 52 + 3*28
    expect(estimateTileHeight(by('figures:5'), W)).toBe(184) // THE STREET, 5 rows -> 4 + "more"
    expect(estimateTileHeight(by('briefs:0'), W)).toBe(240) // 6 briefs -> 3 + "more": 52 + 3*56 + 20
    expect(estimateTileHeight(by('peers:0'), W)).toBe(192) // 5 peers: 52 + 5*28
    expect(estimateTileHeight(by('tape:0'), W)).toBe(212) // 5 indices: 52 + 5*32
  })

  it('builds each row-led height from the exported constants and nothing else', () => {
    // The tile bodies import these same constants, so this is the whole two-place invariant the
    // header comment used to police by hand: a body cannot draw a row height the estimator does
    // not know about, because there is only one number.
    const chrome = 2 * TILE_PADDING + TILE_HEAD
    expect(estimateTileHeight(by('peers:0'), W)).toBe(chrome + TILE_ROW_PEERS * 5)
    expect(estimateTileHeight(by('tape:0'), W)).toBe(chrome + TILE_ROW_TAPE * 5)
    expect(estimateTileHeight(by('figures:0'), W)).toBe(chrome + TILE_ROW_FIGURES * 4)
    expect(estimateTileHeight(by('briefs:0'), W)).toBe(
      chrome + TILE_ROW_BRIEFS * TILE_SHOWN_BRIEFS + TILE_MORE,
    )
  })

  it('caps a row-led tile at the rows its body actually draws', () => {
    // One more than the cap must add the "+N more" line and NOT another row — the body shows
    // `TILE_SHOWN_*` and no more, so a height that kept growing would be white paper.
    const chrome = 2 * TILE_PADDING + TILE_HEAD
    const many: Tile = {
      kind: 'peers',
      id: 'peers:9',
      peers: new Array(TILE_SHOWN_PEERS + 3).fill(null).map((_, i) => ({
        symbol: `S${i}`,
        name: '',
        per: '',
        cap: '',
        last: null,
        changePct: null,
        isSubject: false,
      })),
    }
    expect(estimateTileHeight(many, W)).toBe(chrome + TILE_ROW_PEERS * TILE_SHOWN_PEERS)
  })

  it('clamps a photo’s aspect at both ends, so no tile is a smear or a tower', () => {
    const wide: Tile = { kind: 'photo', id: 'photo:9', photo: { id: 'w', w: 1000, h: 100, caption: '', credit: '' } }
    const tall: Tile = { kind: 'photo', id: 'photo:8', photo: { id: 't', w: 100, h: 1000, caption: '', credit: '' } }
    expect(estimateTileHeight(wide, W)).toBe(Math.round((W * 2) / 3)) // 113
    expect(estimateTileHeight(tall, W)).toBe(Math.round((W * 3) / 2)) // 255
  })

  it('is a positive integer for every tile in the fixture, at every plausible column', () => {
    for (const colWidth of [140, 155, 165, 170, 200, 260]) {
      for (const t of tiles) {
        const h = estimateTileHeight(t, colWidth)
        expect(Number.isInteger(h)).toBe(true)
        expect(h).toBeGreaterThan(0)
      }
    }
  })
})

describe('splitColumns', () => {
  const figuresTile = (id: string, n: number): Tile => ({
    kind: 'figures',
    id,
    group: 'G',
    figures: Array.from({ length: n }, (_, i): EditionFigure => ({
      group: 'G', label: `l${i}`, value: `${i}`, changePct: null, emph: false, bar: null,
    })),
  })

  it('appends to the shortest column, breaking a tie leftwards', () => {
    // Heights at W=170: one figure is 80 (52 + 28), four figures are 164 (52 + 4*28).
    // A(80) -> col0 (tie).  B(80) -> col1.  C(164) -> col0 (tie at 80).  D(80) -> col1 (80 < 244).
    const tiles = [figuresTile('a', 1), figuresTile('b', 1), figuresTile('c', 4), figuresTile('d', 1)]
    const cols = splitColumns(tiles, W, 2)
    expect(cols.map((c) => c.map((p) => p.tile.id))).toEqual([['a', 'c'], ['b', 'd']])
    expect(cols[0].map((p) => p.height)).toEqual([80, 164])
  })

  it('places every tile exactly once, keeping feed order inside each column', () => {
    const { tiles } = editionToTiles(demo())
    const cols = splitColumns(tiles, W, 2)
    const placed = cols.flat().map((p) => p.tile.id)
    expect(placed.slice().sort()).toEqual(tiles.map((t) => t.id).slice().sort())
    expect(placed).toHaveLength(tiles.length)
    const order = new Map(tiles.map((t, i) => [t.id, i]))
    for (const col of cols) {
      const idx = col.map((p) => order.get(p.tile.id) as number)
      expect(idx).toEqual(idx.slice().sort((a, b) => a - b))
    }
  })

  it('never lets the columns diverge by more than the tallest single tile', () => {
    const { tiles } = editionToTiles(demo())
    for (const feed of [tiles, filterTiles(tiles, 'numbers'), filterTiles(tiles, 'photos')]) {
      const cols = splitColumns(feed, W, 2)
      const totals = cols.map((c) => c.reduce((n, p) => n + p.height, 0))
      const tallest = Math.max(0, ...feed.map((t) => estimateTileHeight(t, W)))
      expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(tallest)
    }
  })

  it('holds the same properties on a synthetic forty-tile feed', () => {
    const feed = Array.from({ length: 40 }, (_, i) => figuresTile(`f${i}`, (i % 7) + 1))
    const cols = splitColumns(feed, W, 2)
    expect(cols.flat()).toHaveLength(40)
    const totals = cols.map((c) => c.reduce((n, p) => n + p.height, 0))
    const tallest = Math.max(...feed.map((t) => estimateTileHeight(t, W)))
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(tallest)
  })

  it('returns the right number of columns even when there is nothing to place', () => {
    expect(splitColumns([], W, 2)).toEqual([[], []])
    expect(splitColumns([], W)).toHaveLength(2) // two by default
    expect(splitColumns([figuresTile('a', 1)], W, 3)).toHaveLength(3)
  })
})

describe('findTile', () => {
  it('finds by id and answers null for a name that is not in the edition', () => {
    const layout = editionToTiles(demo())
    expect(findTile(layout, 'story:0')?.kind).toBe('story')
    expect(findTile(layout, 'tape:0')?.kind).toBe('tape')
    expect(findTile(layout, 'story:9')).toBeNull()
    expect(findTile(layout, '')).toBeNull()
    expect(findTile(layout, 'nonsense')).toBeNull()
  })
})
