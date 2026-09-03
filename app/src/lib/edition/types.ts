/**
 * The edition — the TypeScript mirror of `docs/news-contract.md`.
 *
 * This is the only file in the app that knows a wire field name of the edition JSON, the way
 * `lib/esp32.ts` is the only one that knows a device-API field name. `parse.ts` is the one place
 * the two spellings meet (`change_pct` on the wire, `changePct` here); every screen and every tile
 * reads these interfaces and nothing else.
 *
 * Two facts about the numbers that decide how this differs from `esp32.ts`:
 *
 *  - The wire carries **decimals** (`last: 1631.47`, `change_pct: 4.21`). The board turns them
 *    into cents and basis points for its own integer arithmetic; the phone has no reason to, and
 *    `lib/format.ts`'s `formatCents` / `formatChange` must not be pointed at these. `edition/format.ts`
 *    owns their formatting.
 *  - A figure's `value`, a peer's `per`/`cap`, and every statement cell arrive **already
 *    formatted** by the producer (`"$241.6B"`, `"22.4x"`). They render verbatim. The statement's
 *    numeric plane `n[]` is beside the strings for anything that wants to draw, and is nullable
 *    per cell.
 *
 * `null` means "the wire did not say" throughout. It is distinct from `0`, which on
 * `wk52High`/`wk52Low` the contract defines as unknown and the parser therefore maps to `null`
 * too, and on `figures[].bar` means the far left of the range — an absent bar is `null`, never `0`.
 */

export interface EditionSubject {
  symbol: string
  name: string
  exchange: string
  sector: string
  last: number | null
  changePct: number | null
  prevClose: number | null
  open: number | null
  high: number | null
  low: number | null
  /** `null` when absent or `0` — the contract's spelling of "unknown". */
  wk52High: number | null
  wk52Low: number | null
}

export interface EditionPhoto {
  /** Resolves to `<news URL's directory>/tiles/<id>.bin` — see `client.ts`'s `tileUrl`. */
  id: string
  w: number
  h: number
  caption: string
  credit: string
}

export interface EditionStory {
  /** 0..99, lower is more important; the lead is the lowest rank in the edition. */
  rank: number
  kicker: string
  headline: string
  deck: string
  byline: string
  body: string
  /** Index into `Edition.charts`, or `null` when absent or out of range. */
  chart: number | null
  photo: EditionPhoto | null
}

export interface EditionFigure {
  group: string
  label: string
  /** Preformatted by the producer; render verbatim. */
  value: string
  changePct: number | null
  emph: boolean
  /** 0..1000 position inside a producer-chosen range; `null` when absent (absent is NOT 0). */
  bar: number | null
}

export interface EditionBrief {
  date: string
  kicker: string
  text: string
}

export interface EditionPeer {
  symbol: string
  name: string
  /** Preformatted. */
  per: string
  /** Preformatted. */
  cap: string
  last: number | null
  changePct: number | null
  isSubject: boolean
}

export interface EditionTableRow {
  label: string
  /** One preformatted cell per column. */
  values: string[]
  /** The numeric plane beside the cells, one per column, `null` where the wire had none. */
  n: (number | null)[]
}

export interface EditionTable {
  title: string
  note: string
  /** The producer's rendering hint (`"bars_line"`, `"stack"`, …); informational on the phone. */
  render: string
  columns: string[]
  rows: EditionTableRow[]
}

export type EditionChartKind = 'line' | 'candle' | 'bar' | 'sparkline'

export interface EditionChart {
  kind: EditionChartKind
  label: string
  /** `"6M"`, `"6Q"` — a caption, not something the phone computes with. */
  span: string
  /** Names the unit (`"Weekly close, in dollars"`). The series is in whatever unit this says. */
  note: string
  open: number[]
  high: number[]
  low: number[]
  close: number[]
}

export interface EditionIndex {
  symbol: string
  name: string
  last: number | null
  changePct: number | null
  spark: number[]
}

export interface Edition {
  /** The desk's name for the run (`"SEMICONDUCTORS"`), not a slogan. */
  edition: string
  /** The paper's own date line, as the producer wrote it. */
  dateline: string
  session: string
  asOf: string
  /** ISO-8601 when present; fingerprinted by the board, shown nowhere. */
  generatedAt: string
  subject: EditionSubject
  /** ≤ 5, ascending `rank` — the five lowest ranks survive the cap, not the first five. */
  stories: EditionStory[]
  /** ≤ 28, wire order. */
  figures: EditionFigure[]
  /** ≤ 8. */
  briefs: EditionBrief[]
  /** ≤ 6. */
  peers: EditionPeer[]
  /** ≤ 2. */
  tables: EditionTable[]
  /** ≤ 2. */
  charts: EditionChart[]
  /** ≤ 5. */
  indices: EditionIndex[]
  /** Wire order, uncapped on the phone. */
  thumbs: EditionPhoto[]
}

/**
 * The device's display capacities (`news_model.h`), applied here too so the phone's edition and
 * the sheet's never disagree about what arrived. They are deliberately larger than one page can
 * hold — the producer files a generous dossier and each client edits it down.
 */
export const EDITION_CAPS = {
  stories: 5,
  figures: 28,
  briefs: 8,
  peers: 6,
  tables: 2,
  charts: 2,
  indices: 5,
} as const

/** The default rank a story gets when the wire carries none (`news_parse.c`). */
export const STORY_RANK_DEFAULT = 9
