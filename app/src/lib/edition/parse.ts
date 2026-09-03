// The edition wire JSON -> the model in `types.ts`.
//
// This is the only place the wire's snake_case and the app's camelCase meet, and it is the
// TypeScript mirror of `components/news_core/news_parse.c`: same defaults, same clamps, same
// drops, same cap-after-sort rule. The two must agree, because a phone and a board looking at
// one payload and disagreeing about what arrived is a bug with no symptom on either side.
//
// TOTAL, AND NEVER THROWING. Every field on the wire is optional; absent, `null` and
// wrong-typed all land on the same default (`''`, `null`, `[]`). The caller decides whether
// what came back is worth showing — `isEmptyEdition` is that question, asked in one place.
// The alternative, a parser that throws, puts a try/catch on every screen and turns a desk
// mid-publish into a crash on a phone.

import {
  EDITION_CAPS,
  STORY_RANK_DEFAULT,
  type Edition,
  type EditionBrief,
  type EditionChart,
  type EditionChartKind,
  type EditionFigure,
  type EditionIndex,
  type EditionPeer,
  type EditionPhoto,
  type EditionStory,
  type EditionSubject,
  type EditionTable,
  type EditionTableRow,
} from './types'

/** `news_parse.c`'s RANK_MAX. A rank is an ordering, not a magnitude; clamping the top keeps
 *  "unranked sinks to the bottom" meaningful against a producer that files rank 100000. */
export const STORY_RANK_MAX = 99

// --- coercers ---------------------------------------------------------------
// The same shape as `lib/market/types.ts`'s num/str: one door per type, and everything that is
// not exactly that type goes to the default. A numeric string is a field we misread, not a
// number, so it does not get in.

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** `news_parse.c` accepts both spellings of `emph` because producers have filed both. */
function bool(v: unknown): boolean {
  return v === true || v === 1
}

function int(v: unknown, fallback: number): number {
  const n = num(v)
  return n === null ? fallback : Math.trunc(n)
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/** The 52-week pair only: the contract spells "unknown" as `0` there, so `0` is not a price. */
function nonZeroNum(v: unknown): number | null {
  const n = num(v)
  return n === null || n === 0 ? null : n
}

function numArray(v: unknown): number[] {
  const out: number[] = []
  for (const e of arr(v)) {
    const n = num(e)
    if (n !== null) out.push(n)
  }
  return out
}

// --- pieces -----------------------------------------------------------------

function parseSubject(v: unknown): EditionSubject {
  const o = obj(v)
  return {
    symbol: str(o.symbol),
    name: str(o.name),
    exchange: str(o.exchange),
    sector: str(o.sector),
    last: num(o.last),
    changePct: num(o.change_pct),
    prevClose: num(o.prev_close),
    open: num(o.open),
    high: num(o.high),
    low: num(o.low),
    wk52High: nonZeroNum(o.wk52_high),
    wk52Low: nonZeroNum(o.wk52_low),
  }
}

/**
 * A photo is a *blit target*, not a caption: the device copies `w*h/2` bytes with no resize, so
 * a tile with no id, no area, or an odd width could never be fetched or drawn. Returning null
 * rather than a half-photo keeps every consumer from having to re-check the geometry.
 */
function parsePhoto(v: unknown): EditionPhoto | null {
  const o = obj(v)
  const id = str(o.id)
  const w = int(o.w, 0)
  const h = int(o.h, 0)
  if (id === '' || w <= 0 || h <= 0 || w % 2 !== 0) return null
  return { id, w, h, caption: str(o.caption), credit: str(o.credit) }
}

function parseStory(v: unknown, chartCount: number): EditionStory | null {
  const o = obj(v)
  const headline = str(o.headline)
  // A story is its headline. A deck with nothing over it is a fragment, and a tile built from
  // one would be a blank card the reader can tap.
  if (headline === '') return null
  const chart = int(o.chart, -1)
  return {
    rank: clamp(int(o.rank, STORY_RANK_DEFAULT), 0, STORY_RANK_MAX),
    kicker: str(o.kicker),
    headline,
    deck: str(o.deck),
    byline: str(o.byline),
    body: str(o.body),
    // An index into charts[] or nothing. A story that reflows without its chart is an ordinary
    // page; one that draws chart 3 of 2 is a caption over the wrong picture.
    chart: chart >= 0 && chart < chartCount ? chart : null,
    photo: parsePhoto(o.photo),
  }
}

function parseFigure(v: unknown): EditionFigure | null {
  const o = obj(v)
  const label = str(o.label)
  const value = str(o.value)
  // A figure with neither half says nothing; one with either half still reads.
  if (label === '' && value === '') return null
  const bar = num(o.bar)
  return {
    group: str(o.group),
    label,
    value,
    changePct: num(o.change_pct),
    emph: bool(o.emph),
    // 0 is the far left of the range and a real position; absent is null and draws no track.
    bar: bar === null ? null : clamp(Math.trunc(bar), 0, 1000),
  }
}

function parseBrief(v: unknown): EditionBrief {
  const o = obj(v)
  return { date: str(o.date), kicker: str(o.kicker), text: str(o.text) }
}

function parsePeer(v: unknown): EditionPeer | null {
  const o = obj(v)
  const symbol = str(o.symbol)
  if (symbol === '') return null
  return {
    symbol,
    name: str(o.name),
    per: str(o.per),
    cap: str(o.cap),
    last: num(o.last),
    changePct: num(o.change_pct),
    isSubject: bool(o.is_subject),
  }
}

function parseTable(v: unknown): EditionTable {
  const o = obj(v)
  const columns = arr(o.columns).map(str)
  const rows: EditionTableRow[] = []
  for (const r of arr(o.rows)) {
    const ro = obj(r)
    const values = arr(ro.values).map(str)
    const nRaw = arr(ro.n)
    // The numeric plane is positional against `values`, so it is padded and cut to the same
    // length rather than filtered: an `n[]` one element short would put every number under the
    // wrong quarter.
    const n: (number | null)[] = values.map((_, i) => num(nRaw[i]))
    rows.push({ label: str(ro.label), values, n })
  }
  return { title: str(o.title), note: str(o.note), render: str(o.render), columns, rows }
}

function parseChart(v: unknown): EditionChart {
  const o = obj(v)
  const kindRaw = str(o.kind)
  const kind: EditionChartKind =
    kindRaw === 'candle' || kindRaw === 'bar' || kindRaw === 'sparkline' ? kindRaw : 'line'

  const closeRaw = arr(o.close)
  const openRaw = arr(o.open)
  const highRaw = arr(o.high)
  const lowRaw = arr(o.low)

  const close: number[] = []
  const open: number[] = []
  const high: number[] = []
  const low: number[] = []
  for (let i = 0; i < closeRaw.length; i++) {
    const c = num(closeRaw[i])
    // `close` sets the length and is the only array a chart has to send. A point with no close
    // is not a point.
    if (c === null) continue
    close.push(c)
    // The four arrays are PARALLEL: read at the same absolute index, never at the same offset
    // from the end. An open[] that arrived one element short would otherwise shift every open
    // by a session and draw plausible candles that are all subtly wrong.
    open.push(num(openRaw[i]) ?? c)
    high.push(num(highRaw[i]) ?? c)
    low.push(num(lowRaw[i]) ?? c)
  }

  return { kind, label: str(o.label), span: str(o.span), note: str(o.note), open, high, low, close }
}

function parseIndex(v: unknown): EditionIndex | null {
  const o = obj(v)
  const symbol = str(o.symbol)
  // Same rule as a peer: a tape cell with no symbol is a blank cell in a row of five.
  if (symbol === '') return null
  return {
    symbol,
    name: str(o.name),
    last: num(o.last),
    changePct: num(o.change_pct),
    spark: numArray(o.spark),
  }
}

/** Map, drop the nulls, cut to the cap. */
function collect<T>(v: unknown, cap: number, one: (e: unknown) => T | null): T[] {
  const out: T[] = []
  for (const e of arr(v)) {
    if (out.length >= cap) break
    const parsed = one(e)
    if (parsed !== null) out.push(parsed)
  }
  return out
}

// --- the whole thing --------------------------------------------------------

export function emptyEdition(): Edition {
  return {
    edition: '',
    dateline: '',
    session: '',
    asOf: '',
    generatedAt: '',
    subject: {
      symbol: '', name: '', exchange: '', sector: '',
      last: null, changePct: null, prevClose: null,
      open: null, high: null, low: null, wk52High: null, wk52Low: null,
    },
    stories: [], figures: [], briefs: [], peers: [],
    tables: [], charts: [], indices: [], thumbs: [],
  }
}

/**
 * Is there anything here worth putting on screen?
 *
 * A symbol or a story. Furniture on its own — a dateline, an edition name — is a blank sheet
 * with a header, which is exactly what a desk mid-publish serves. `client.ts` treats a 200 that
 * parses to this as `bad_json` so the previous cache stays up instead.
 */
export function isEmptyEdition(e: Edition): boolean {
  return e.subject.symbol === '' && e.stories.length === 0
}

export function parseEdition(json: unknown): Edition {
  const root = obj(json)

  // Charts are parsed BEFORE the stories, because a story names one by index and the index has
  // to be checked against what actually arrived.
  const charts = arr(root.charts)
    .slice(0, EDITION_CAPS.charts)
    .map(parseChart)

  // Stories: parse everything, sort ascending by rank, THEN cut. The array's order is the
  // producer's, not a ranking, so truncating first would throw away a lead that was appended.
  // Array.prototype.sort is stable (ES2019), which is what keeps equal ranks in wire order.
  const stories: EditionStory[] = []
  for (const e of arr(root.stories)) {
    const s = parseStory(e, charts.length)
    if (s !== null) stories.push(s)
  }
  stories.sort((a, b) => a.rank - b.rank)

  return {
    edition: str(root.edition),
    dateline: str(root.dateline),
    session: str(root.session),
    asOf: str(root.as_of),
    generatedAt: str(root.generated_at),
    subject: parseSubject(root.subject),
    stories: stories.slice(0, EDITION_CAPS.stories),
    figures: collect(root.figures, EDITION_CAPS.figures, parseFigure),
    briefs: collect(root.briefs, EDITION_CAPS.briefs, (e) => parseBrief(e)),
    peers: collect(root.peers, EDITION_CAPS.peers, parsePeer),
    tables: arr(root.tables).slice(0, EDITION_CAPS.tables).map(parseTable),
    charts,
    indices: collect(root.indices, EDITION_CAPS.indices, parseIndex),
    // Uncapped on the phone: a thumb is not named by index from anywhere, so an extra one costs
    // a tile and nothing else.
    thumbs: collect(root.thumbs, Number.MAX_SAFE_INTEGER, parsePhoto),
  }
}
