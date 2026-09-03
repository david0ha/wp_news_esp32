// The edition, cut into tiles.
//
// This file is the app's make-up desk, and it is the counterpart of `ui_compose.c` on the board:
// the server decides what is important, and the client decides what fits and where it goes. It
// is pure — an `Edition` in, an ordered list of rectangles out, no clock, no storage, no React.
//
// =============================================================================================
// THE ORDER (the "All" feed)
// =============================================================================================
//   range -> the lead story -> chart[0] -> the remaining stories in rank order
//   -> one `figures` tile per distinct group, in first-seen order
//   -> one `photo` tile per photo -> briefs (one tile) -> peers -> one tile per table
//   -> tape -> the remaining charts
//
// A kind with nothing behind it is ABSENT, never an empty tile. That is the whole difference
// between a feed and a dashboard: a dashboard has slots that can be empty, and an empty slot is
// a promise the edition did not keep.
//
// The lead story comes second and not first because `range` is the only tile that answers "what
// is this company doing today" in one glance, and the lead is a 227 px object the reader will
// scroll to anyway. `chart[0]` follows the lead because the lead usually names it.
//
// =============================================================================================
// THE BAND
// =============================================================================================
// The lead story's photo leaves the grid and becomes a full-width strip above it when its
// aspect is wider than 2:1. The fixture's lead photo is 1140x320 — 3.56:1 — which at a 170 px
// column would be a 48 px smear with a caption under it. A lead photo of ordinary aspect stays
// in the grid and becomes the FIRST photo tile, so the picture the desk chose to lead with leads
// the pictures.
//
// =============================================================================================
// THE HEIGHTS — known BEFORE layout, which is the point
// =============================================================================================
// Every height is computed by `estimateTileHeight` and set as a style, never measured with
// `onLayout`. Measuring would mean a first frame at the wrong size, a reflow, and a scroll
// position that cannot survive a push to the detail and back. The content adapts to the height
// it is given (`numberOfLines`), not the other way round.
//
//   kind            height
//   -------------   -----------------------------------------------------------
//   story (lead)    round(colWidth * 4 / 3)
//   story (other)   colWidth
//   range           max(colWidth, 2P + TILE_HEAD + RANGE_TRACK_H + 2 * RANGE_STAT_ROW_H)
//   chart           round(colWidth * 3 / 4)
//   photo           round(colWidth * clamp(h / w, 2/3, 3/2))
//   figures         2P + 24 + 28 * min(n, 4) + (n > 4 ? 20 : 0)
//   briefs          2P + 24 + 56 * min(n, 3) + (n > 3 ? 20 : 0)
//   peers           2P + 24 + 28 * min(n, 6)
//   table           round(colWidth * 5 / 4)
//   tape            2P + 24 + 32 * min(n, 5)
//
// where P = `TILE_PADDING`, 24 is `TILE_HEAD` (the heading line, equal to `type.headingSm`'s line
// height), 20 is `TILE_MORE` (the "+N more" line), and the per-row constants are `FIGURES_ROW`,
// `BRIEFS_ROW`, `PEERS_ROW` and `TAPE_ROW` with their `*_SHOWN` row counts beside them.
//
// THE RANGE IS THE ONE KIND WITH A FLOOR, because it is the one kind whose body is fixed
// furniture rather than elastic content: a track box and a 2x2 grid of the day's four numbers,
// all of it a constant height. A flat `colWidth` fit exactly at 170 and nowhere below it — at
// the 158 a 360 dp Android phone produces, the grid was handed 62 px for the 74 its two rows
// draw and the second row was sliced by the tile's `overflow: 'hidden'`. So the height is
// content-derived, the way the row-built kinds already are, and `colWidth` only wins once it is
// the larger of the two.
//
// EVERY ONE OF THOSE IS EXPORTED, and the tile bodies in `components/edition/tiles/` import them
// rather than declaring their own. That is deliberate: this arithmetic and the rows a body draws
// have to agree exactly, a disagreement clips the last row silently, and nothing measures
// afterwards to catch it. There is one place to change, not two — so do not re-declare a row
// height beside a `StyleSheet`.
//
// =============================================================================================
// IDS
// =============================================================================================
// `${kind}:${n}`, with n the index among tiles of that kind. The detail route names a tile by
// id, and a re-parse of the same edition has to yield the same ids or a back-navigation lands
// somewhere else.

import {
  type Edition,
  type EditionBrief,
  type EditionChart,
  type EditionFigure,
  type EditionIndex,
  type EditionPeer,
  type EditionPhoto,
  type EditionStory,
  type EditionSubject,
  type EditionTable,
} from './types'

/** The tile's inner padding. Shared with `components/edition/EditionTile.tsx`'s StyleSheet. */
export const TILE_PADDING = 14

export type Chip = 'all' | 'stories' | 'numbers' | 'accounts' | 'photos'

export const CHIPS: ReadonlyArray<{ id: Chip; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'stories', label: 'Stories' },
  { id: 'numbers', label: 'Numbers' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'photos', label: 'Photos' },
]

export type Tile =
  | { kind: 'story'; id: string; story: EditionStory; lead: boolean }
  | { kind: 'range'; id: string; subject: EditionSubject }
  | { kind: 'chart'; id: string; chart: EditionChart }
  | { kind: 'photo'; id: string; photo: EditionPhoto }
  | { kind: 'figures'; id: string; group: string; figures: EditionFigure[] }
  | { kind: 'briefs'; id: string; briefs: EditionBrief[] }
  | { kind: 'peers'; id: string; peers: EditionPeer[] }
  | { kind: 'table'; id: string; table: EditionTable }
  | { kind: 'tape'; id: string; indices: EditionIndex[] }

export interface EditionLayout {
  /** The lead photo when it is too wide for a column — drawn full width above the grid. */
  band: EditionPhoto | null
  tiles: Tile[]
}

/** A photo wider than this belongs across the page rather than inside a column. */
const BAND_ASPECT = 2

function hasAnyNumber(s: EditionSubject): boolean {
  return (
    s.open !== null ||
    s.high !== null ||
    s.low !== null ||
    s.prevClose !== null ||
    s.wk52High !== null ||
    s.wk52Low !== null
  )
}

export function editionToTiles(e: Edition): EditionLayout {
  const tiles: Tile[] = []

  // The lead is the lowest rank, which `parseEdition` has already sorted to index 0.
  const lead = e.stories.length > 0 ? e.stories[0] : null
  const leadPhoto = lead?.photo ?? null
  const band = leadPhoto !== null && leadPhoto.w > leadPhoto.h * BAND_ASPECT ? leadPhoto : null

  // 1. The range. Absent when the subject carries no numbers at all — an empty track with six
  //    em dashes under it says less than nothing.
  if (hasAnyNumber(e.subject)) {
    tiles.push({ kind: 'range', id: 'range:0', subject: e.subject })
  }

  // 2. The lead story.
  if (lead !== null) tiles.push({ kind: 'story', id: 'story:0', story: lead, lead: true })

  // 3. The first chart, right behind the lead that usually names it.
  if (e.charts.length > 0) tiles.push({ kind: 'chart', id: 'chart:0', chart: e.charts[0] })

  // 4. The rest of the stories, in the rank order the parser put them in.
  for (let i = 1; i < e.stories.length; i++) {
    tiles.push({ kind: 'story', id: `story:${i}`, story: e.stories[i], lead: false })
  }

  // 5. One tile per figures group, in FIRST-SEEN order — the producer's grouping is editorial
  //    and re-sorting it would put THE STREET above VALUATION on a whim.
  const groupOrder: string[] = []
  const byGroup = new Map<string, EditionFigure[]>()
  for (const f of e.figures) {
    const bucket = byGroup.get(f.group)
    if (bucket === undefined) {
      groupOrder.push(f.group)
      byGroup.set(f.group, [f])
    } else {
      bucket.push(f)
    }
  }
  groupOrder.forEach((group, i) => {
    tiles.push({ kind: 'figures', id: `figures:${i}`, group, figures: byGroup.get(group) ?? [] })
  })

  // 6. The photos. The lead's own comes first when it did not become the band, so the picture
  //    the desk chose to lead with leads the pictures.
  const photos: EditionPhoto[] = []
  if (leadPhoto !== null && band === null) photos.push(leadPhoto)
  photos.push(...e.thumbs)
  photos.forEach((photo, i) => {
    tiles.push({ kind: 'photo', id: `photo:${i}`, photo })
  })

  // 7-10. One tile each, when there is anything behind them.
  if (e.briefs.length > 0) tiles.push({ kind: 'briefs', id: 'briefs:0', briefs: e.briefs })
  if (e.peers.length > 0) tiles.push({ kind: 'peers', id: 'peers:0', peers: e.peers })
  e.tables.forEach((table, i) => {
    tiles.push({ kind: 'table', id: `table:${i}`, table })
  })
  if (e.indices.length > 0) tiles.push({ kind: 'tape', id: 'tape:0', indices: e.indices })

  // 11. The remaining charts, last. Chart ids are the index in `charts[]` and not the emission
  //     order, so `chart:1` names the same chart wherever it lands.
  for (let i = 1; i < e.charts.length; i++) {
    tiles.push({ kind: 'chart', id: `chart:${i}`, chart: e.charts[i] })
  }

  return { band, tiles }
}

/**
 * Which filter a tile belongs to. Every tile is in exactly one, which is what makes the chip
 * counts add up to the feed and what lets `availableChips` hide an empty one.
 *
 * `briefs` sits under Stories rather than Numbers because a brief is a sentence, and the reader
 * narrowing to "Stories" is asking for prose.
 */
export function tileChip(t: Tile): Exclude<Chip, 'all'> {
  switch (t.kind) {
    case 'story':
    case 'briefs':
      return 'stories'
    case 'range':
    case 'chart':
    case 'figures':
    case 'peers':
    case 'tape':
      return 'numbers'
    case 'table':
      return 'accounts'
    case 'photo':
      return 'photos'
  }
}

/** Feed order is preserved inside a filter — narrowing must not reshuffle. */
export function filterTiles(tiles: Tile[], chip: Chip): Tile[] {
  if (chip === 'all') return tiles
  return tiles.filter((t) => tileChip(t) === chip)
}

/**
 * `all`, plus every chip with at least one tile behind it.
 *
 * A chip that filters to nothing is a control that does nothing, and the reader who taps it
 * learns only that the app has categories it does not have content for.
 */
export function availableChips(tiles: Tile[]): Chip[] {
  const present = new Set<Chip>(tiles.map(tileChip))
  return CHIPS.filter((c) => c.id === 'all' || present.has(c.id)).map((c) => c.id)
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/**
 * The heading line every non-media tile draws, in `type.headingSm`.
 *
 * 24 and not 22 because that IS `type.headingSm`'s line height: a 24 px line in a 22 px box is
 * two pixels of clipped descender on every tile with a heading, which is most of them.
 */
export const TILE_HEAD = 24

/** The "+N more" line, drawn when a tile holds more than it shows. */
export const TILE_MORE = 20

// The row heights and the row counts, per kind. Both halves belong here: a body that draws five
// rows of 28 in a box sized for four is the same silent clipping as a body that draws four rows
// of 30. The tile bodies import these; see the header comment.
export const FIGURES_ROW = 28
export const FIGURES_SHOWN = 4
export const BRIEFS_ROW = 56
export const BRIEFS_SHOWN = 3
export const PEERS_ROW = 28
export const PEERS_SHOWN = 6
export const TAPE_ROW = 32
export const TAPE_SHOWN = 5

// The range tile's two fixed blocks. `RangeTile` imports both — its track box is given this
// exact height and its stat cells this exact row — so the sum below is true by construction
// rather than by a comment that has to be re-checked by hand.
/** The track box: 4 pad + a 14 px track row + a 4 px gap + an 18 px caption + 4 pad. */
export const RANGE_TRACK_H = 44
/** One row of the stat grid: a 16 px label over a 17 px value, in a 37 px cell. */
export const RANGE_STAT_ROW_H = 37
/** The two rows the grid draws — Open/Prev close, then High/Low. */
export const RANGE_STAT_ROWS = 2

export function estimateTileHeight(t: Tile, colWidth: number): number {
  const chrome = 2 * TILE_PADDING + TILE_HEAD
  switch (t.kind) {
    case 'story':
      // The lead is the one tile allowed to be taller than it is wide: its headline at 22/26 is
      // this design's photograph, and four legs of body under it is what makes it read as a lead.
      return t.lead ? Math.round((colWidth * 4) / 3) : colWidth
    case 'range':
      // Never below what the body draws — see the header comment. A square at every width a
      // phone this side of a tablet produces, and a floor below that.
      return Math.max(colWidth, chrome + RANGE_TRACK_H + RANGE_STAT_ROWS * RANGE_STAT_ROW_H)
    case 'chart':
      return Math.round((colWidth * 3) / 4)
    case 'photo': {
      // Clamped both ways: a 3.5:1 strip would be a 48 px smear, and a 1:10 column would be a
      // tower that pushes everything beside it off the screen.
      const aspect = t.photo.w > 0 ? t.photo.h / t.photo.w : 1
      return Math.round(colWidth * clamp(aspect, 2 / 3, 3 / 2))
    }
    case 'figures': {
      const n = t.figures.length
      return (
        chrome +
        FIGURES_ROW * Math.min(n, FIGURES_SHOWN) +
        (n > FIGURES_SHOWN ? TILE_MORE : 0)
      )
    }
    case 'briefs': {
      const n = t.briefs.length
      return (
        chrome +
        BRIEFS_ROW * Math.min(n, BRIEFS_SHOWN) +
        (n > BRIEFS_SHOWN ? TILE_MORE : 0)
      )
    }
    case 'peers':
      return chrome + PEERS_ROW * Math.min(t.peers.length, PEERS_SHOWN)
    case 'table':
      return Math.round((colWidth * 5) / 4)
    case 'tape':
      return chrome + TAPE_ROW * Math.min(t.indices.length, TAPE_SHOWN)
  }
}

export interface PlacedTile {
  tile: Tile
  height: number
}

/**
 * Two column arrays, shortest-column-first.
 *
 * Greedy and in one pass, because the heights are already known: walk the feed in order and drop
 * each tile into whichever column is currently shortest, ties going leftwards. That keeps reading
 * order down each column, keeps the two columns within one tile's height of each other, and is
 * deterministic — the same edition and the same width always produce the same page, which is what
 * lets a return from the detail restore the scroll position.
 *
 * At five to fifteen tiles there is nothing to virtualise, and `FlatList numColumns` cannot
 * stagger — it aligns rows, which is the uniform grid this design is specifically not.
 */
export function splitColumns(tiles: Tile[], colWidth: number, columns = 2): PlacedTile[][] {
  const n = Math.max(1, Math.trunc(columns))
  const out: PlacedTile[][] = Array.from({ length: n }, () => [])
  const totals = new Array<number>(n).fill(0)
  for (const tile of tiles) {
    let shortest = 0
    for (let i = 1; i < n; i++) {
      // Strictly less, so a tie keeps the leftmost column and the first tile of a fresh page
      // always starts at the top left.
      if (totals[i] < totals[shortest]) shortest = i
    }
    const height = estimateTileHeight(tile, colWidth)
    out[shortest].push({ tile, height })
    totals[shortest] += height
  }
  return out
}

export function findTile(layout: EditionLayout, id: string): Tile | null {
  return layout.tiles.find((t) => t.id === id) ?? null
}
