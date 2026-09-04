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

/** `cJSON_IsObject`: a JSON object, and not null and not an array. */
function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function obj(v: unknown): Record<string, unknown> {
  return isObj(v) ? v : {}
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

/**
 * Strict boolean: true ONLY for JSON `true`. Mirrors `jbool()` (`news_parse.c:92-96`), which is
 * `cJSON_IsTrue(v)` and nothing else — a number, even `1`, stays false. Used for `is_subject`,
 * where a stray numeric `1` from a producer must not silently mark a second peer as the subject.
 */
function strictBool(v: unknown): boolean {
  return v === true
}

/**
 * The two-tier `emph` rule (`news_parse.c:522-524`): JSON `true` OR a number that is non-zero
 * ONCE ROUNDED. Deliberately not a general truthiness test — `false`, `0`, `''`, `null` and
 * anything non-numeric all leave the figure at the quiet default, but `2` and `0.5` promote it
 * exactly as `true` does, because a producer sends whichever spelling of "emphasize this" it read.
 *
 * The rounding is the half of this rule that is easy to drop, and it is the half that matters:
 * the C is `sround(value, 1) != 0`, so `0.4` is zero and stays quiet. Emphasis is loud — a hero
 * is set several times larger than the rail around it — and inventing one out of a producer's
 * rounding error is the worse of the two failures.
 */
function emphFlag(v: unknown): boolean {
  if (v === true) return true
  const n = num(v)
  return n !== null && int(n, 0) !== 0
}

/**
 * A JSON number as an int, ROUNDED HALF AWAY FROM ZERO — `news_parse.c`'s `sround()` (:57-63),
 * which every `jint`/`jrange` field on the board goes through.
 *
 * Not `Math.trunc`, and not `Math.round` either: `Math.round(-2.5)` is -2 where the C gives -3.
 * The difference is only ever half a unit, which is exactly why it has to be copied rather than
 * approximated — a producer's 101.6 px tile is an even, blittable 102 on the glass and an odd,
 * rejected 101 here, and one payload read two ways has no symptom on either side.
 */
function int(v: unknown, fallback: number): number {
  const n = num(v)
  if (n === null) return fallback
  return n >= 0 ? Math.floor(n + 0.5) : Math.ceil(n - 0.5)
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/** The 52-week pair only: the contract spells "unknown" as `0` there, so `0` is not a price. */
function nonZeroNum(v: unknown): number | null {
  const n = num(v)
  return n === null || n === 0 ? null : n
}

/**
 * The edition's language tag — `news_model.c`'s `news_lang_normalise()`, mirrored.
 *
 * Lowercase it, then take it only if what is left is two or three ASCII letters; everything else
 * is English. IT NORMALISES AND NEVER REJECTS, which is the rule the whole parser follows: a
 * producer that files `"ko-KR"` or `"Korean"` has written a tag this reader cannot use, and the
 * edition under it is still an edition. Blanking a front page over a language tag would be the one
 * failure a reader actually notices.
 *
 * The device's default is `"en"` and not `""`, so a payload with no tag and one that says `"en"`
 * are the same edition — which matters because `news_hash()` fingerprints this field, and two
 * spellings of English would print the same sheet twice.
 */
export const LANG_DEFAULT = 'en'

function lang(v: unknown): string {
  const tag = str(v).toLowerCase()
  return /^[a-z]{2,3}$/.test(tag) ? tag : LANG_DEFAULT
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

/**
 * `chartSlot` maps the index the PRODUCER wrote — its position in the `charts` array as sent —
 * onto the index that survived parsing, or `null` for a chart that did not survive.
 */
function parseStory(v: unknown, chartSlot: ReadonlyArray<number | null>): EditionStory | null {
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
    chart: chart >= 0 && chart < chartSlot.length ? chartSlot[chart] : null,
    photo: parsePhoto(o.photo),
  }
}

function parseFigure(v: unknown): EditionFigure | null {
  const o = obj(v)
  const label = str(o.label)
  const value = str(o.value)
  // BOTH halves, `news_parse.c:489`. A rail line is a label and a value; either one missing
  // leaves half a row under a standing head, which reads as a rendering fault rather than as a
  // figure the producer did not have — and it makes a group of four that fits the board into a
  // group of five with a "+1 more" under it here.
  if (label === '' || value === '') return null
  const bar = num(o.bar)
  return {
    group: str(o.group),
    label,
    value,
    changePct: num(o.change_pct),
    emph: emphFlag(o.emph),
    // Through `int()` and not a truncation: `news_parse.c:540` is `sround`, so a producer's
    // 999.6 is 1000 on the glass and must be 1000 here.
    // 0 is the far left of the range and a real position; absent is null and draws no track.
    bar: bar === null ? null : clamp(int(bar, 0), 0, 1000),
  }
}

function parseBrief(v: unknown): EditionBrief | null {
  const o = obj(v)
  const text = str(o.text)
  // The text is the item (`news_parse.c:562-563`). A date and a kicker over nothing is
  // furniture with no news under it, so it is dropped like a headline-less story.
  if (text === '') return null
  return { date: str(o.date), kicker: str(o.kicker), text }
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
    isSubject: strictBool(o.is_subject),
  }
}

function parseTable(v: unknown): EditionTable {
  const o = obj(v)
  // Six columns and ten rows, `news_model.h`'s NEWS_TABLE_COLS / NEWS_TABLE_ROWS. Eight quarters
  // is a scroll and six is a page: a phone printing quarters seven and eight would be showing
  // periods that never reach the glass, under a tile whose promise is the LAST of them.
  // A head that is not a string still SPENDS its column (`.map(str)` gives it a blank head),
  // because a row's cells are positional against this header and dropping the third head would
  // slide the fourth quarter's numbers under the third quarter's date.
  const columns = arr(o.columns).slice(0, EDITION_CAPS.tableCols).map(str)
  const rows: EditionTableRow[] = []

  // A table with no columns has nothing to scale a bar against, so the plane starts out
  // incomplete and only the rows can keep it that way (`news_parse.c:664-666`).
  let plane = columns.length > 0

  for (const r of arr(o.rows)) {
    if (rows.length >= EDITION_CAPS.tableRows) break
    // Not an object: a stray string in `rows` is not a row (`news_parse.c:671`).
    if (!isObj(r)) continue
    const label = str(r.label)
    const valuesRaw = arr(r.values)
    const nRaw = arr(r.n)
    // An entry with neither a name nor a number in it is a blank line ruled across the table,
    // which is the one thing a printed statement never has (`news_parse.c:684`). Everything else
    // is kept: a row of figures under no label is a producer bug that is visible, and a visible
    // bug is a fixable one. `n` counts as a number for this test.
    if (label === '' && valuesRaw.length === 0 && nRaw.length === 0) continue

    // The numeric plane is positional against the COLUMNS, not against this row's own cells: a
    // short row still owes a cell per column, and a long one has no seventh column to put a
    // seventh number in.
    const n: (number | null)[] = columns.map((_, i) => num(nRaw[i]))
    // Every row that survives has to carry its own FULL plane, because a stack is only a stack
    // when every segment of every column arrived and a line is only a line when it has a point
    // over every bar. One row short and the whole table prints instead.
    if (n.some((x) => x === null)) plane = false

    rows.push({ label, values: valuesRaw.slice(0, EDITION_CAPS.tableCols).map(str), n })
  }

  // A table with rows but no complete plane is a printed table, and the plane it half-received is
  // erased rather than left lying in the model (`news_parse.c:727-730`). A half-filled plane is
  // the state a later reader is most likely to trust by accident.
  if (!plane || rows.length === 0) {
    for (const r of rows) r.n = r.n.map(() => null)
  }

  return { title: str(o.title), note: str(o.note), render: str(o.render), columns, rows }
}

/**
 * The kind, exactly as `news_chart_kind_from()` reads it (`news_model.c:165-172`): three words,
 * case-insensitively, and `null` — the device's CHART_NONE — for everything else.
 *
 * There is no fallback kind. An unknown word, `"none"` and an absent `kind` are all "no chart",
 * not "a line chart": the producer that typed `Bar` meant bars, and the one that typed nothing
 * meant nothing. Guessing `line` drew a picture nobody asked for on the phone and no picture at
 * all on the glass, out of one payload.
 */
function chartKind(v: unknown): EditionChartKind | null {
  switch (str(v).toLowerCase()) {
    case 'line':
      return 'line'
    case 'candle':
      return 'candle'
    case 'bar':
      return 'bar'
    default:
      return null
  }
}

/** `null` is the device's zeroed CHART_NONE slot: a chart that cannot be drawn. */
function parseChart(v: unknown): EditionChart | null {
  const o = obj(v)
  const kind = chartKind(o.kind)
  if (kind === null) return null

  const closeRaw = arr(o.close)
  const openRaw = arr(o.open)
  const highRaw = arr(o.high)
  const lowRaw = arr(o.low)

  // The LAST `EDITION_CAPS.bars` samples, `news_parse.c:286-288`'s `skip = total - n`: a month of
  // candles, most recent kept. The cut is by ABSOLUTE index across all four planes, so the phone
  // and the board plot the same window — a line coloured from a first point the board never saw
  // can disagree with the sheet about the direction of the same series, and a bar layout floors
  // its bars at 2 px and clips the newest ones off the end of the plot instead of compressing.
  const total = closeRaw.length
  const skip = Math.max(0, total - EDITION_CAPS.bars)

  const close: number[] = []
  const open: number[] = []
  const high: number[] = []
  const low: number[] = []
  for (let i = skip; i < total; i++) {
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

  // A kind with no bars would reserve its slot and draw an empty box (`news_parse.c:305-307`).
  // The page reflows without it instead, and "is there a chart" stays one question.
  if (close.length === 0) return null

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
    lang: LANG_DEFAULT,
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
  // to be resolved against what actually arrived.
  //
  // A chart that cannot be drawn is DROPPED here and its index remapped, where the device keeps
  // the empty slot and trims only the trailing ones (`news_parse.c:319-338`). The two reach the
  // same page from the same payload — a story naming a surviving chart still gets that chart, and
  // one naming a hole gets none, which is what CHART_NONE draws — but the phone's `charts[]` then
  // holds only drawable charts, so no tile and no detail can be built around an empty plot. The
  // slot the producer numbered is preserved in `chartSlot`, and it is the only thing a story's
  // index is ever read through; renumbering without it would hang the price series under a head
  // that says REVENUE, which is the one failure the device's comment is about.
  const chartSlot: (number | null)[] = []
  const charts: EditionChart[] = []
  for (const raw of arr(root.charts).slice(0, EDITION_CAPS.charts)) {
    const chart = parseChart(raw)
    if (chart === null) {
      chartSlot.push(null)
    } else {
      chartSlot.push(charts.length)
      charts.push(chart)
    }
  }

  // Stories: parse everything, sort ascending by rank, THEN cut. The array's order is the
  // producer's, not a ranking, so truncating first would throw away a lead that was appended.
  // Array.prototype.sort is stable (ES2019), which is what keeps equal ranks in wire order.
  const stories: EditionStory[] = []
  for (const e of arr(root.stories)) {
    const s = parseStory(e, chartSlot)
    if (s !== null) stories.push(s)
  }
  stories.sort((a, b) => a.rank - b.rank)

  return {
    edition: str(root.edition),
    dateline: str(root.dateline),
    session: str(root.session),
    asOf: str(root.as_of),
    generatedAt: str(root.generated_at),
    lang: lang(root.lang),
    subject: parseSubject(root.subject),
    stories: stories.slice(0, EDITION_CAPS.stories),
    figures: collect(root.figures, EDITION_CAPS.figures, parseFigure),
    briefs: collect(root.briefs, EDITION_CAPS.briefs, parseBrief),
    peers: collect(root.peers, EDITION_CAPS.peers, parsePeer),
    tables: arr(root.tables).slice(0, EDITION_CAPS.tables).map(parseTable),
    charts,
    indices: collect(root.indices, EDITION_CAPS.indices, parseIndex),
    // Uncapped on the phone: a thumb is not named by index from anywhere, so an extra one costs
    // a tile and nothing else.
    thumbs: collect(root.thumbs, Number.MAX_SAFE_INTEGER, parsePhoto),
  }
}
