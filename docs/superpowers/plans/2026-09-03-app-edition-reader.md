# The Edition in the App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the companion app a **Today** tab that fetches the edition JSON straight from the URL the phone already stores, renders it as a two-column masonry of tiles, keeps the last good edition on disk so it reads offline, and opens each tile into a detail page — with a bundled demo edition for a phone that has no URL and no board.

**Architecture:** A new `app/src/lib/edition/` layer that owns the wire (`types.ts` already written, `parse.ts`, `client.ts`, `store.ts`), the pure display logic (`format.ts`, `freshness.ts`, `tiles.ts`, `photo.ts`) and one screen hook whose decision logic is a pure reducer (`useEdition.ts`). Above it, `app/src/components/edition/` renders tiles whose **heights are computed before layout** by a pure estimator, so nothing reflows and a return from the detail restores the same page. Nothing under `components/`, `sim/`, `server/` or `agent/` changes.

**Tech Stack:** React Native 0.85 / Expo SDK 56, expo-router, TypeScript 6 (`strict`), jest + jest-expo, `pako` (already a dependency, for the PNG IDAT), `react-native-svg` (already a dependency, for chart strokes), `@react-native-async-storage/async-storage`. **No new dependencies.**

**Spec:** [`docs/superpowers/specs/2026-09-03-app-edition-reader-design.md`](../specs/2026-09-03-app-edition-reader-design.md)
**UX research it argues from:** [`docs/superpowers/specs/2026-09-03-app-edition-reader-ux-research.md`](../specs/2026-09-03-app-edition-reader-ux-research.md)

## Global Constraints

Copied from the spec and from `app/README.md`'s existing rules. Every task's requirements include these.

- **No new dependencies.** Not reanimated, not expo-image, not FlashList, not a styling library. The masonry is hand-rolled; the detail opens with the native stack push; press feedback uses RN core `Animated`.
- **`app/src/lib/edition/types.ts` is already written and must not be changed.** It is the only file in the app that knows an edition wire field name. Every task builds against it.
- **Every style goes through `StyleSheet.create` with theme tokens** from `app/src/theme.ts` — `colors`, `type`, `space`, `radius`, `layout`, `fonts`, `tabular`. No literal hex, no literal font family, no magic spacing that a token already names.
- **Never set `fontWeight` beside an Inter `fontFamily`.** The weight is baked into the face; a `fontWeight` next to it makes Android drop to the system font (`theme.ts` header).
- **Every changing numeral gets `tabular`** — prices, percentages, counts, dates that tick.
- **Colour means direction or series identity, never decoration.** Green/red only on a change; `colors.up`/`colors.down` for text duty, `colors.upBright`/`colors.downBright` for graphics duty (strokes, fills). A zero or absent change is `colors.textDim` and unsigned. **Transport failures take `colors.warn` / `colors.warnBg`, never direction red.**
- **`hasDevice === null` is checked before `hasDevice === false`.** Half-known is unknown; `!hasDevice` folds the two together and says "no board" to a board owner for the first frame of a cold launch.
- **Tiles have no border and no shadow and no gradient.** `colors.surface` on `radius.lg`, padding 14. The canvas is `colors.bg`; the separation is the canvas, not a stroke.
- **No all-caps eyebrow on a tile.** `type.label` is banned inside a tile. A tile's *kicker* is content and renders in `type.caption` exactly as the producer wrote it.
- **No dot-separated meta lines.** Never join two facts with `·` in app chrome. (A byline the producer wrote containing `·` is content and renders verbatim.)
- **Comments are English and explain decisions and invariants**, not what the next line does. The repo's house style: say why a branch exists and what breaks without it.
- **The edition's numbers are decimals**, not the device API's cents and basis points. Nothing from `app/src/lib/format.ts` may be pointed at them; `edition/format.ts` owns their formatting.
- **Strings the producer preformatted render verbatim** — `figures[].value`, `peers[].per`, `peers[].cap`, every table cell.
- Commit messages end with the session's configured `Co-Authored-By:` trailer.

**Verification command (run after every task that touches `app/`):**

```bash
cd app && npm test && npm run typecheck
```

**Full suite (Task 11):**

```bash
cd app && npm test && npm run typecheck
sh server/test/run.sh
cmake -S components/news_core/test/host -B /tmp/vt && cmake --build /tmp/vt && /tmp/vt/test_news_mock
```

---

## Parallel Waves

Tasks are drawn so that a whole wave can be dispatched at once. A wave starts only when the one before it is reviewed and merged.

| wave | tasks | why they are independent |
|---|---|---|
| **A** | 1, 2, 3, 6, 10 | 1 (parse/demo), 2 (format/freshness) and 3 (photo/PNG) touch disjoint files; 6 (tiles) depends only on `types.ts`, which is already written; 10 (Settings + docs) touches neither the library nor the screens |
| **B** | 4, 5 | both depend on Task 1's `parseEdition` / `isEmptyEdition` and on nothing else |
| **C** | 7, 8 | 7 (the hook) depends on 4 and 5; 8 (components) depends on 6, plus 2's formatters and 3's tile decoder |
| **D** | 9 | the screens depend on 7 and 8 |
| **E** | 11 | full verification |

---

## File Structure

| file | responsibility |
|---|---|
| `app/src/lib/edition/types.ts` | **already written — do not change.** The TS mirror of `docs/news-contract.md` |
| `app/src/lib/edition/demo.json` | **already copied** from `components/news_core/test/host/fixtures/news.json` |
| `app/src/lib/edition/parse.ts` | `parseEdition(unknown) -> Edition`: total, clamping, rank-sorting, never throws |
| `app/src/lib/edition/demo.ts` | `demoEdition(): Edition` — the bundled payload, parsed once |
| `app/src/lib/edition/format.ts` | `formatPrice`, `formatPct`, `changeTone`, `changeArrow` — decimals, not cents |
| `app/src/lib/edition/freshness.ts` | `freshnessLabel(fetchedAt, now)` — the four tiers |
| `app/src/lib/edition/photo.ts` | `decodeTile(bytes, w, h)` + the in-memory PNG cache |
| `app/src/lib/edition/client.ts` | `createEditionClient`, `EditionError`, `humanEditionError`, `tileUrl` |
| `app/src/lib/edition/store.ts` | the last-good edition on disk + the in-memory current edition |
| `app/src/lib/edition/tiles.ts` | the `Tile` union, the order rule, the height table, the placement |
| `app/src/lib/edition/useEdition.ts` | the screen hook + `nextEditionState`, its pure reducer |
| `app/src/lib/screen.ts` | **modified**: the PNG encoder becomes width/height-parameterised; `decode()`'s public behaviour is unchanged |
| `app/src/components/edition/Masthead.tsx` | company, dateline, price, freshness, demo chip, failure banner |
| `app/src/components/edition/ChipRow.tsx` | the horizontal pill filter |
| `app/src/components/edition/Masonry.tsx` | two columns from `splitColumns` |
| `app/src/components/edition/EditionTile.tsx` | the chrome and the press feedback; switches on `tile.kind` |
| `app/src/components/edition/tone.ts` | tone → colour, for both text and graphics duty |
| `app/src/components/edition/tiles/*.tsx` | the nine tile bodies |
| `app/src/components/edition/detail/TileDetail.tsx` | the full content of one tile, by kind |
| `app/src/app/(tabs)/edition.tsx` | the Today tab |
| `app/src/app/edition/[tile].tsx` | the detail route (root stack, deep-linkable) |
| `app/src/theme.ts` | **modified**: `+ type.pinHeadline`, `+ type.pinDeck` |
| `app/src/app/(tabs)/_layout.tsx` | **modified**: Today registered first |
| `app/src/app/_layout.tsx` | **modified**: the detail route on the root stack |
| `app/src/app/(tabs)/settings.tsx` | **modified**: the News source editor shows without a board |
| `app/README.md` | **modified**: a "Reading the edition" section |
| `docs/app-control.md` | **modified**: one sentence under the desk's device plane |

---

### Task 1: The parser and the demo edition

**Files:**
- Create: `app/src/lib/edition/parse.ts`
- Create: `app/src/lib/edition/parse.test.ts`
- Create: `app/src/lib/edition/demo.ts`
- Create: `app/src/lib/edition/demo.test.ts`

**Interfaces:**

- Consumes (already written, `app/src/lib/edition/types.ts` — do not change it):

```ts
export interface EditionSubject {
  symbol: string; name: string; exchange: string; sector: string
  last: number | null; changePct: number | null; prevClose: number | null
  open: number | null; high: number | null; low: number | null
  wk52High: number | null; wk52Low: number | null
}
export interface EditionPhoto { id: string; w: number; h: number; caption: string; credit: string }
export interface EditionStory {
  rank: number; kicker: string; headline: string; deck: string; byline: string; body: string
  chart: number | null; photo: EditionPhoto | null
}
export interface EditionFigure {
  group: string; label: string; value: string; changePct: number | null; emph: boolean
  bar: number | null
}
export interface EditionBrief { date: string; kicker: string; text: string }
export interface EditionPeer {
  symbol: string; name: string; per: string; cap: string
  last: number | null; changePct: number | null; isSubject: boolean
}
export interface EditionTableRow { label: string; values: string[]; n: (number | null)[] }
export interface EditionTable {
  title: string; note: string; render: string; columns: string[]; rows: EditionTableRow[]
}
export type EditionChartKind = 'line' | 'candle' | 'bar' | 'sparkline'
export interface EditionChart {
  kind: EditionChartKind; label: string; span: string; note: string
  open: number[]; high: number[]; low: number[]; close: number[]
}
export interface EditionIndex {
  symbol: string; name: string; last: number | null; changePct: number | null; spark: number[]
}
export interface Edition {
  edition: string; dateline: string; session: string; asOf: string; generatedAt: string
  subject: EditionSubject
  stories: EditionStory[]; figures: EditionFigure[]; briefs: EditionBrief[]; peers: EditionPeer[]
  tables: EditionTable[]; charts: EditionChart[]; indices: EditionIndex[]; thumbs: EditionPhoto[]
}
export const EDITION_CAPS = {
  stories: 5, figures: 28, briefs: 8, peers: 6, tables: 2, charts: 2, indices: 5,
} as const
export const STORY_RANK_DEFAULT = 9
```

- Produces (Tasks 4, 5, 6, 7, 8, 9 rely on these exact names):

```ts
// parse.ts
export function parseEdition(json: unknown): Edition
export function emptyEdition(): Edition
export function isEmptyEdition(e: Edition): boolean
export const STORY_RANK_MAX = 99
// demo.ts
export function demoEdition(): Edition
```

**Context an engineer needs before starting:**

The wire spelling is snake_case (`change_pct`, `wk52_high`, `is_subject`, `as_of`, `generated_at`, `prev_close`); the TypeScript is camelCase. `parse.ts` is the one place the two meet. The firmware's `components/news_core/news_parse.c` is the reference behaviour and the rules below are transcribed from it — read it if a case is unclear, but do **not** import anything from `components/`; this is a self-contained TypeScript mirror.

- [ ] **Step 1: Write the failing tests for the parser**

Create `app/src/lib/edition/parse.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx jest src/lib/edition/parse.test.ts`
Expected: FAIL — `Cannot find module './parse'`.

- [ ] **Step 3: Write `parse.ts`**

Create `app/src/lib/edition/parse.ts`:

```ts
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
```

- [ ] **Step 4: Run the parser tests to verify they pass**

Run: `cd app && npx jest src/lib/edition/parse.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Write the failing demo tests**

Create `app/src/lib/edition/demo.test.ts`:

```ts
import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { demoEdition } from './demo'
import { isEmptyEdition } from './parse'

// The two files that must never drift, and the assertion that holds them together — the app's
// half of what `test_news_mock` does for the firmware. `demo.json` is not "a sample": it is the
// payload an unconfigured board prints, so a phone with no URL and a board with no URL must be
// showing the same edition or the demo is lying about what the hardware does.
const APP_COPY = join(__dirname, 'demo.json')
const REPO_FIXTURE = join(__dirname, '../../../../components/news_core/test/host/fixtures/news.json')

describe('the bundled demo edition', () => {
  it('is byte-identical to the repo fixture', () => {
    const app = readFileSync(APP_COPY)
    const repo = readFileSync(REPO_FIXTURE)
    // Compare the length first: a mismatch report of two 20 KB buffers is unreadable, and the
    // length alone already says "somebody edited one of them".
    expect(app.length).toBe(repo.length)
    expect(app.equals(repo)).toBe(true)
  })

  it('parses to a complete front page', () => {
    const e = demoEdition()
    expect(isEmptyEdition(e)).toBe(false)
    expect(e.subject.symbol).toBe('SNDK')
    expect(e.stories).toHaveLength(4)
    expect(e.figures).toHaveLength(22)
    expect(e.charts).toHaveLength(2)
  })

  it('returns the same object every call — it is parsed once', () => {
    expect(demoEdition()).toBe(demoEdition())
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd app && npx jest src/lib/edition/demo.test.ts`
Expected: FAIL — `Cannot find module './demo'`.

- [ ] **Step 7: Write `demo.ts`**

Create `app/src/lib/edition/demo.ts`:

```ts
// The edition a phone shows when it has no URL — the same payload `news_mock.c` prints on an
// unconfigured board, so "what the app shows with nothing set up" and "what the board shows with
// nothing set up" are one edition rather than two impressions of one.
//
// `demo.test.ts` holds `demo.json` byte-identical to
// `components/news_core/test/host/fixtures/news.json`, the way `test_news_mock` holds the
// firmware to it. To change the demo: change the fixture, run
// `python3 tools/mock_news_server.py --write-fixture`, then copy it here.
//
// Its photo tiles live in `sim/tiles/`, not in the app, and are not served from anywhere the
// phone can reach — so the demo's photo tiles show their captions on a plain ground. That is
// the honest result and not a bug to fix: a demo that shipped two hundred kilobytes of
// base64 to look complete would be paying for a picture nobody asked for.

import raw from './demo.json'
import { parseEdition } from './parse'
import { type Edition } from './types'

let cached: Edition | null = null

/** The bundled demo, parsed once. The result is shared, so treat it as read-only. */
export function demoEdition(): Edition {
  if (cached === null) cached = parseEdition(raw)
  return cached
}
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `cd app && npx jest src/lib/edition/`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `cd app && npm run typecheck`
Expected: no errors. (`resolveJsonModule` is already on via `expo/tsconfig.base`, so the `demo.json` import types cleanly.)

- [ ] **Step 10: Commit**

```bash
git add app/src/lib/edition/parse.ts app/src/lib/edition/parse.test.ts \
        app/src/lib/edition/demo.ts app/src/lib/edition/demo.test.ts
git commit -m "feat(app): parse the edition wire format, and bundle the demo edition"
```

---

### Task 2: The formatters and the freshness tiers

**Files:**
- Create: `app/src/lib/edition/format.ts`
- Create: `app/src/lib/edition/format.test.ts`
- Create: `app/src/lib/edition/freshness.ts`
- Create: `app/src/lib/edition/freshness.test.ts`

**Interfaces:**

- Consumes: nothing. Both files are self-contained pure functions over `number | null`.
- Produces (Tasks 8 and 9 render every number through these):

```ts
// format.ts
export type ChangeTone = 'up' | 'down' | 'flat'
export function formatPrice(n: number | null | undefined): string
export function formatPct(n: number | null | undefined): string
export function changeTone(n: number | null | undefined): ChangeTone
export function changeArrow(n: number | null | undefined): '▲' | '▼' | ''
export const DASH = '—'
// freshness.ts
export function freshnessLabel(fetchedAt: number, now: number): string | null
```

**Why a fourth export.** The spec names three functions. `changeArrow` is the fourth because the
Masthead, `PeersTile` and `TapeTile` all draw the same ▲▼ mark, and three hand-written copies of
"which glyph for which sign, and none at zero" is three places for it to disagree.

**Deviation from the spec's freshness table, and why.** The spec's second tier ends at 30 minutes
and the third is "< 24 h → `Updated 3h ago`". Taken literally, an edition fetched 35 minutes ago
renders `Updated 0h ago`. The minute tier therefore runs to **60** minutes. Every label the spec's
table actually shows is unchanged.

- [ ] **Step 1: Write the failing formatter tests**

Create `app/src/lib/edition/format.test.ts`:

```ts
import { describe, it, expect } from '@jest/globals'
import { changeArrow, changeTone, DASH, formatPct, formatPrice } from './format'

describe('formatPrice', () => {
  it('gives two decimals with thousands separators', () => {
    expect(formatPrice(1631.47)).toBe('1,631.47')
    expect(formatPrice(1593.09)).toBe('1,593.09')
    expect(formatPrice(41.28)).toBe('41.28')
    expect(formatPrice(1642)).toBe('1,642.00')
    expect(formatPrice(0)).toBe('0.00')
  })

  it('keeps four decimals under 1, where two would round a real price to nothing', () => {
    expect(formatPrice(0.0842)).toBe('0.0842')
    expect(formatPrice(0.5)).toBe('0.5000')
  })

  it('keeps the sign of a negative', () => {
    expect(formatPrice(-370)).toBe('-370.00')
  })

  it('is the em dash for anything that is not a finite number', () => {
    expect(formatPrice(null)).toBe(DASH)
    expect(formatPrice(undefined)).toBe(DASH)
    expect(formatPrice(NaN)).toBe(DASH)
    expect(formatPrice(Infinity)).toBe(DASH)
    expect(DASH).toBe('—')
  })
})

describe('formatPct', () => {
  it('takes the number ALREADY scaled to percent and does not multiply', () => {
    expect(formatPct(2.41)).toBe('2.41%')
    expect(formatPct(0.62)).toBe('0.62%')
  })

  it('is unsigned — the arrow and the colour carry the direction', () => {
    expect(formatPct(-0.74)).toBe('0.74%')
  })

  it('collapses a magnitude under a hundredth to a flat zero', () => {
    expect(formatPct(0)).toBe('0.00%')
    expect(formatPct(0.00004)).toBe('0.00%')
    expect(formatPct(-0.00004)).toBe('0.00%')
  })

  it('is the em dash for anything that is not a finite number', () => {
    expect(formatPct(null)).toBe(DASH)
    expect(formatPct(NaN)).toBe(DASH)
  })
})

describe('changeTone and changeArrow', () => {
  it('reads the sign', () => {
    expect(changeTone(2.41)).toBe('up')
    expect(changeTone(-0.74)).toBe('down')
    expect(changeArrow(2.41)).toBe('▲')
    expect(changeArrow(-0.74)).toBe('▼')
  })

  it('gives zero and absence the same neutral treatment, with no mark', () => {
    // A colour reserved for movement has no business standing in for its absence.
    for (const v of [0, null, undefined, NaN]) {
      expect(changeTone(v)).toBe('flat')
      expect(changeArrow(v)).toBe('')
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx jest src/lib/edition/format.test.ts`
Expected: FAIL — `Cannot find module './format'`.

- [ ] **Step 3: Write `format.ts`**

Create `app/src/lib/edition/format.ts`:

```ts
// Display formatting for the edition's numbers.
//
// A THIRD formatter module, and deliberately so. `lib/format.ts` renders the device API's
// integer cents and basis points; `lib/market/format.ts` renders Yahoo's floats. The edition's
// wire carries decimals (`last: 1631.47`, `change_pct: 4.21`), so pointing `formatCents` at one
// divides a real price by a hundred and shows it, which is the kind of wrong that looks right.
//
// Every '—' below is the same em dash, so an absent value looks identical on every surface.

export const DASH = '—'

export type ChangeTone = 'up' | 'down' | 'flat'

function isFiniteNumber(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * `1,631.47`. Two decimals with thousands separators at or above 1; four below, because a
 * sub-dollar price rounded to two decimals is a price the reader cannot act on.
 */
export function formatPrice(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return DASH
  if (Math.abs(n) >= 1) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return n.toFixed(4)
}

/**
 * `2.41%`, from a number ALREADY scaled to percent — no ×100 in here. Unsigned, because the
 * arrow and the direction colour beside it already say which way, and a `▼ -0.74%` says it
 * twice with two different marks.
 */
export function formatPct(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return DASH
  const a = Math.abs(n)
  if (a < 0.0001) return '0.00%'
  return `${a.toFixed(2)}%`
}

/**
 * The direction a change carries, as a token rather than a colour — `lib/` holds no colours and
 * the theme holds no market semantics. `components/edition/tone.ts` is the one place the two
 * meet, and it maps this to the text pair or the graphics pair depending on the duty.
 *
 * Zero is `flat`, not `up`. Green on an unchanged price spends the colour reserved for movement
 * on its absence, which is the firmware's rule (`ui_chg_colour()`) carried into the app.
 */
export function changeTone(n: number | null | undefined): ChangeTone {
  if (!isFiniteNumber(n) || n === 0) return 'flat'
  return n > 0 ? 'up' : 'down'
}

/** The mark beside a change. Empty at zero and at absence — see `changeTone`. */
export function changeArrow(n: number | null | undefined): '▲' | '▼' | '' {
  if (!isFiniteNumber(n) || n === 0) return ''
  return n > 0 ? '▲' : '▼'
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd app && npx jest src/lib/edition/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing freshness tests**

Create `app/src/lib/edition/freshness.test.ts`:

```ts
import { describe, it, expect } from '@jest/globals'
import { freshnessLabel } from './freshness'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// A fixed instant, so the "day and short month" tier asserts a real date rather than today's.
// 2026-08-30 14:00 local — the local clock is what the tiers are about (see freshness.ts).
const NOW = new Date(2026, 7, 30, 14, 0, 0).getTime()
const ago = (ms: number) => freshnessLabel(NOW - ms, NOW)

describe('freshnessLabel — the tiers', () => {
  it('says nothing at all under five minutes', () => {
    expect(ago(0)).toBeNull()
    expect(ago(30_000)).toBeNull()
    expect(ago(5 * MIN - 1)).toBeNull()
  })

  it('counts minutes from five to sixty', () => {
    expect(ago(5 * MIN)).toBe('Updated 5m ago')
    expect(ago(12 * MIN)).toBe('Updated 12m ago')
    expect(ago(12 * MIN + 59_000)).toBe('Updated 12m ago')
    expect(ago(59 * MIN)).toBe('Updated 59m ago')
  })

  it('counts hours from one to twenty-four', () => {
    expect(ago(HOUR)).toBe('Updated 1h ago')
    expect(ago(3 * HOUR)).toBe('Updated 3h ago')
    expect(ago(23 * HOUR + 59 * MIN)).toBe('Updated 23h ago')
  })

  it('says yesterday between one day and two', () => {
    expect(ago(DAY)).toBe('Last updated yesterday')
    expect(ago(2 * DAY - 1)).toBe('Last updated yesterday')
  })

  it('gives a day and a short month beyond two days, with no year', () => {
    // 2026-08-30 14:00 minus two days is 2026-08-28.
    expect(ago(2 * DAY)).toBe('Last updated 28 Aug')
    expect(ago(30 * DAY)).toBe('Last updated 31 Jul')
  })

  it('treats a fetch stamped in the future as fresh rather than as a negative age', () => {
    // A phone whose clock moved backwards, or a cache written by a device an hour ahead. The
    // honest answer is "nothing to report", not "Updated -60m ago".
    expect(ago(-HOUR)).toBeNull()
  })

  it('says nothing for a fetch that never happened', () => {
    // `fetchedAt: 0` is the demo edition's stamp: no server ever confirmed it.
    expect(freshnessLabel(0, NOW)).toBeNull()
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd app && npx jest src/lib/edition/freshness.test.ts`
Expected: FAIL — `Cannot find module './freshness'`.

- [ ] **Step 7: Write `freshness.ts`**

Create `app/src/lib/edition/freshness.ts`:

```ts
// How old the thing on screen is, said in tiers rather than to the second.
//
// The point of the tiers is that an edition changes about once a day, so a live-ticking "23
// seconds ago" is precision about a quantity nobody is watching, and it makes a page that is
// perfectly current look like it is being monitored. Under five minutes there is nothing worth
// saying at all, and saying nothing is the design: an unlabelled page reads as current.
//
// `fetchedAt` is the last time the SERVER CONFIRMED THE CONTENT — a 200 or a 304 — not the last
// time it changed. That is the question the line answers: "is what I am reading still what the
// desk is serving?"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `null` under five minutes, then `Updated 12m ago`, `Updated 3h ago`, `Last updated yesterday`,
 * and finally `Last updated 30 Aug`.
 *
 * The minute tier runs to sixty and not to the thirty the design table names: at thirty-five
 * minutes the hour tier would render `Updated 0h ago`, which reads as a bug. Every label the
 * table actually shows is unchanged.
 *
 * Local time, not UTC. This is a phone telling its owner how long ago something happened on
 * their own clock; a date rendered in UTC would name yesterday to anyone east of Greenwich in
 * the evening.
 *
 * `fetchedAt` of 0 (the demo edition — no server ever confirmed it) and a stamp in the future
 * (a clock that moved backwards) both answer null. There is nothing true to say in either case,
 * and "Updated -60m ago" is worse than silence.
 */
export function freshnessLabel(fetchedAt: number, now: number): string | null {
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return null
  const age = now - fetchedAt
  if (age < 5 * MINUTE) return null
  if (age < HOUR) return `Updated ${Math.floor(age / MINUTE)}m ago`
  if (age < DAY) return `Updated ${Math.floor(age / HOUR)}h ago`
  if (age < 2 * DAY) return 'Last updated yesterday'
  const d = new Date(fetchedAt)
  return `Last updated ${d.getDate()} ${MONTHS[d.getMonth()]}`
}
```

- [ ] **Step 8: Run both files to verify they pass**

Run: `cd app && npx jest src/lib/edition/format.test.ts src/lib/edition/freshness.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

Run: `cd app && npm run typecheck`
Expected: no errors.

```bash
git add app/src/lib/edition/format.ts app/src/lib/edition/format.test.ts \
        app/src/lib/edition/freshness.ts app/src/lib/edition/freshness.test.ts
git commit -m "feat(app): edition formatters and the freshness tiers"
```

---

### Task 3: The photo tile decoder, and the PNG encoder it generalises

**Files:**
- Modify: `app/src/lib/screen.ts` (extract two exported functions out of `decode()`; the public `decode()` keeps its behaviour byte-for-byte)
- Create: `app/src/lib/edition/photo.ts`
- Create: `app/src/lib/edition/photo.test.ts`
- Do **not** change `app/src/lib/screen.test.ts` — it must pass unchanged, and that is the proof the refactor was a refactor.

**Interfaces:**

- Consumes (existing, `app/src/lib/screen.ts`, unchanged public surface):

```ts
export const SCREEN_W = 1200
export const SCREEN_H = 1600
export const SCREEN_STRIDE = 600
export const FB_SIZE = 960000
export const MISSING_RGB: readonly [number, number, number]
export const INK_RGB: ReadonlyArray<readonly [number, number, number]>   // 16 entries
export interface DecodedScreen { pngBase64: string; width: number; height: number }
export function decode(fbBytes: Uint8Array): DecodedScreen
```

- Produces:

```ts
// screen.ts — new exports
export function unpackNibbles(bytes: Uint8Array, w: number, h: number): Uint8Array
export function encodeIndexedPng(indices: Uint8Array, w: number, h: number): string  // base64
// edition/photo.ts
export interface DecodedTile { pngBase64: string; width: number; height: number }
export function tileByteLength(w: number, h: number): number
export function decodeTile(bytes: Uint8Array, w: number, h: number): DecodedTile
export function getCachedTilePng(url: string): string | null
export function putCachedTilePng(url: string, pngBase64: string): void
export function clearTilePngCache(): void
```

**The format, for an engineer who has not read `screen.ts`.** A tile is the same thing as the
framebuffer, smaller: row-major, 4 bits per pixel, two pixels per byte, **even x in the HIGH
nibble**, stride `w / 2`, total `w * h / 2` bytes. A nibble is the Spectra 6 wire code the panel
takes — BLACK `0x00`, WHITE `0x01`, YELLOW `0x02`, RED `0x03`, BLUE `0x05`, GREEN `0x06`; `0x04`
and `0x07`–`0x0F` are values the panel cannot make and render magenta so a drift is visible. The
PNG is colour type 3 (indexed) with a 16-entry palette, so the pixel byte written **is** the
nibble read.

- [ ] **Step 1: Write the failing photo tests**

Create `app/src/lib/edition/photo.test.ts`:

```ts
import { describe, it, expect } from '@jest/globals'
import { inflate } from 'pako'
import {
  clearTilePngCache,
  decodeTile,
  getCachedTilePng,
  putCachedTilePng,
  tileByteLength,
} from './photo'
import { INK_RGB, MISSING_RGB } from '../screen'

// An independent PNG reader, the same one `screen.test.ts` uses and for the same reason: a CRC
// checked with the table that wrote it proves only that the table agrees with itself.
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
}

interface Chunk { type: string; data: Uint8Array; crcOk: boolean }

function readPng(b64: string): Chunk[] {
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
  expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const chunks: Chunk[] = []
  let p = 8
  while (p + 12 <= bytes.length) {
    const len = u32(bytes, p)
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8))
    const data = bytes.subarray(p + 8, p + 8 + len)
    const crc = u32(bytes, p + 8 + len)
    chunks.push({ type, data, crcOk: crc32(bytes.subarray(p + 4, p + 8 + len)) === crc })
    p += 12 + len
  }
  expect(p).toBe(bytes.length)
  return chunks
}

function chunk(chunks: Chunk[], type: string): Uint8Array {
  const hit = chunks.find((c) => c.type === type)
  if (!hit) throw new Error(`no ${type} chunk`)
  return hit.data
}

function scanlines(chunks: Chunk[]): Uint8Array {
  const parts = chunks.filter((c) => c.type === 'IDAT')
  const total = parts.reduce((n, c) => n + c.data.length, 0)
  const joined = new Uint8Array(total)
  let at = 0
  for (const c of parts) {
    joined.set(c.data, at)
    at += c.data.length
  }
  return inflate(joined)
}

const CODE = { black: 0x00, white: 0x01, yellow: 0x02, red: 0x03, blue: 0x05, green: 0x06 } as const

describe('tileByteLength', () => {
  it('is w * h / 2 — two pixels to a byte', () => {
    expect(tileByteLength(2, 2)).toBe(2)
    expect(tileByteLength(364, 204)).toBe(37128)
    expect(tileByteLength(1140, 320)).toBe(182400)
  })
})

describe('decodeTile', () => {
  it('turns a 2x2 tile into a 2x2 indexed PNG with the ink palette', () => {
    // Row 0: RED at x=0 (high nibble), BLUE at x=1. Row 1: BLACK, WHITE.
    const bytes = new Uint8Array([(CODE.red << 4) | CODE.blue, (CODE.black << 4) | CODE.white])
    const { pngBase64, width, height } = decodeTile(bytes, 2, 2)
    expect([width, height]).toEqual([2, 2])

    const chunks = readPng(pngBase64)
    for (const c of chunks) expect(c.crcOk).toBe(true)
    expect(chunks[0].type).toBe('IHDR')
    expect(chunks[chunks.length - 1].type).toBe('IEND')

    const ihdr = chunk(chunks, 'IHDR')
    expect(u32(ihdr, 0)).toBe(2)
    expect(u32(ihdr, 4)).toBe(2)
    expect(ihdr[8]).toBe(8) // one whole byte per pixel, so a nibble indexes the palette directly
    expect(ihdr[9]).toBe(3) // colour type 3 — indexed
    expect(ihdr[10]).toBe(0)
    expect(ihdr[11]).toBe(0)
    expect(ihdr[12]).toBe(0)

    // The palette is the measured "as paper" ink table, sixteen entries so the wire code indexes
    // it directly, with the impossible values in a colour the panel cannot make.
    const plte = chunk(chunks, 'PLTE')
    expect(plte.length).toBe(16 * 3)
    const at = (code: number) => Array.from(plte.subarray(code * 3, code * 3 + 3))
    expect(at(CODE.black)).toEqual(INK_RGB[CODE.black])
    expect(at(CODE.red)).toEqual(INK_RGB[CODE.red])
    expect(at(0x04)).toEqual(MISSING_RGB)

    // One unfiltered scanline per row, one byte per pixel, even x first.
    const raw = scanlines(chunks)
    expect(Array.from(raw)).toEqual([0, CODE.red, CODE.blue, 0, CODE.black, CODE.white])
  })

  it('handles a wide, short strip — the lead photo’s shape', () => {
    const { pngBase64, width, height } = decodeTile(new Uint8Array(tileByteLength(1140, 320)), 1140, 320)
    expect([width, height]).toEqual([1140, 320])
    const ihdr = chunk(readPng(pngBase64), 'IHDR')
    expect([u32(ihdr, 0), u32(ihdr, 4)]).toEqual([1140, 320])
  })

  it('throws rather than guessing on a body of the wrong length', () => {
    // A short body is what a socket closed mid-download looks like. Half a picture drawn as a
    // whole one is an image the reader cannot tell from the real thing.
    expect(() => decodeTile(new Uint8Array(1), 2, 2)).toThrow(/2 bytes/)
    expect(() => decodeTile(new Uint8Array(3), 2, 2)).toThrow(/2 bytes/)
    expect(() => decodeTile(new Uint8Array(0), 2, 2)).toThrow(/2 bytes/)
  })

  it('refuses a geometry that cannot be a tile', () => {
    expect(() => decodeTile(new Uint8Array(2), 3, 1)).toThrow(/even/)
    expect(() => decodeTile(new Uint8Array(0), 0, 2)).toThrow()
    expect(() => decodeTile(new Uint8Array(0), 2, 0)).toThrow()
  })
})

describe('the in-memory tile cache', () => {
  it('round-trips by URL and forgets on clear', () => {
    clearTilePngCache()
    expect(getCachedTilePng('http://d/tiles/a.bin')).toBeNull()
    putCachedTilePng('http://d/tiles/a.bin', 'AAAA')
    expect(getCachedTilePng('http://d/tiles/a.bin')).toBe('AAAA')
    expect(getCachedTilePng('http://d/tiles/b.bin')).toBeNull()
    clearTilePngCache()
    expect(getCachedTilePng('http://d/tiles/a.bin')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx jest src/lib/edition/photo.test.ts`
Expected: FAIL — `Cannot find module './photo'`.

- [ ] **Step 3: Extract the encoder in `screen.ts`**

In `app/src/lib/screen.ts`, replace the body of `decode()` (the block that starts `// One byte per
pixel, each row prefixed with its filter type.` and runs to the `return` at the end of the file)
with two new exported functions plus a three-line `decode()`. **Everything above `decode()` —
the geometry constants, `INK_RGB`, `MISSING_RGB`, the CRC table, `chunk()`, `toBase64()` — stays
exactly as it is.** Add this in its place:

```ts
/**
 * `w*h/2` packed bytes -> one byte per pixel, row-major.
 *
 * The walk is `sim/main_sim.c`'s: y outer, x inner, and within a byte the EVEN x first, because
 * `epd6_fb_get()` (`epd6_transpose.h:142-146`) puts it in the HIGH nibble. Swapping the two
 * mirrors every pair of pixels — invisible in a headline, and it destroys every hairline.
 *
 * Parameterised by geometry because a photo tile is the same format at a different size: the
 * board's framebuffer is one 1200x1600 tile, and `edition/photo.ts` hands this 364x204 ones.
 */
export function unpackNibbles(bytes: Uint8Array, w: number, h: number): Uint8Array {
  // Odd widths cannot exist in this format at all: the last byte of a row would carry one pixel
  // of that row and one of the next, and there is no partial byte to end on.
  if (w <= 0 || h <= 0 || w % 2 !== 0) {
    throw new Error(`screen: ${w}x${h} is not a 4bpp image (width must be even and positive)`)
  }
  const stride = w / 2
  if (bytes.length !== stride * h) {
    throw new Error(`screen: expected ${stride * h} bytes for ${w}x${h}, got ${bytes.length}`)
  }
  const out = new Uint8Array(w * h)
  let o = 0
  for (let y = 0; y < h; y++) {
    const rowStart = y * stride
    for (let b = 0; b < stride; b++) {
      const byte = bytes[rowStart + b]
      out[o++] = byte >>> 4
      out[o++] = byte & 0x0f
    }
  }
  return out
}

/**
 * One byte per pixel -> a base64 indexed PNG in the measured Spectra 6 inks.
 *
 * Colour type 3 with a 16-entry PLTE means the pixel byte written IS the nibble read, and the
 * palette is the only place a colour is decided: no mapping step to get backwards, a quarter the
 * size of RGB, and a page of mostly one value that deflate is very good at.
 *
 * Filter 0 (None) on every row. Any other filter costs a per-pixel reconstruction pass on the
 * phone, and this content is flat colour — the run-length matching in deflate already has
 * everything it needs from an unfiltered row.
 */
export function encodeIndexedPng(indices: Uint8Array, w: number, h: number): string {
  if (indices.length !== w * h) {
    throw new Error(`screen: expected ${w * h} indices for ${w}x${h}, got ${indices.length}`)
  }

  const rowBytes = 1 + w
  const raw = new Uint8Array(h * rowBytes)
  for (let y = 0; y < h; y++) {
    raw[y * rowBytes] = 0
    raw.set(indices.subarray(y * w, (y + 1) * w), y * rowBytes + 1)
  }

  const ihdr = new Uint8Array(13)
  writeU32(ihdr, 0, w)
  writeU32(ihdr, 4, h)
  ihdr[8] = 8 // bit depth: one whole byte per pixel, so a nibble indexes the palette directly
  ihdr[9] = 3 // colour type 3 — indexed
  ihdr[10] = 0 // compression: deflate, the only one PNG defines
  ihdr[11] = 0 // filter method 0
  ihdr[12] = 0 // no interlacing

  const plte = new Uint8Array(INK_RGB.length * 3)
  for (let i = 0; i < INK_RGB.length; i++) {
    plte[i * 3] = INK_RGB[i][0]
    plte[i * 3 + 1] = INK_RGB[i][1]
    plte[i * 3 + 2] = INK_RGB[i][2]
  }

  const parts = [
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]

  const total = parts.reduce((n, p) => n + p.length, 0)
  const png = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    png.set(p, at)
    at += p.length
  }
  return toBase64(png)
}

/**
 * One framebuffer -> one indexed PNG, in the measured inks.
 *
 * Throws rather than guessing on anything that is not exactly `FB_SIZE` bytes. A short body is
 * what a socket closed mid-download looks like, and half a page rendered as a whole one is a
 * picture the user has no way to tell from the real thing. The size check stays HERE, ahead of
 * `unpackNibbles`, so the message still names 960,000 — that number is the contract, and the
 * generic one below it would say "expected 960000 bytes for 1200x1600", which is true and less
 * useful.
 */
export function decode(fbBytes: Uint8Array): DecodedScreen {
  if (fbBytes.length !== FB_SIZE) {
    throw new Error(`screen: expected ${FB_SIZE} bytes of framebuffer, got ${fbBytes.length}`)
  }
  return {
    pngBase64: encodeIndexedPng(unpackNibbles(fbBytes, SCREEN_W, SCREEN_H), SCREEN_W, SCREEN_H),
    width: SCREEN_W,
    height: SCREEN_H,
  }
}
```

- [ ] **Step 4: Prove the refactor changed nothing**

Run: `cd app && npx jest src/lib/screen.test.ts`
Expected: PASS, unchanged, all cases — including `throws on a short buffer` matching `/960000/`.
If any case fails, the extraction is wrong; fix `screen.ts`, never the test.

- [ ] **Step 5: Write `photo.ts`**

Create `app/src/lib/edition/photo.ts`:

```ts
// A photo tile, decoded on the phone.
//
// `GET <news URL's directory>/tiles/<id>.bin` answers with exactly what the board blits: `w*h/2`
// bytes, no header, no codec, the same 4bpp nibble layout and the same six wire codes as the
// framebuffer. So this is not a second decoder — it is `lib/screen.ts`'s, called with the tile's
// geometry instead of the panel's.
//
// The photographs are halftoned to black and white before they ever reach the wire
// (`tools/make_tile.py`); the phone does no tone mapping, no resizing and no dithering, exactly
// as the device does none. What it shows is what the paper shows.
//
// CACHING IS IN MEMORY ONLY, on purpose. The text is the material. A decoded 364x204 tile is
// about a hundred kilobytes of base64, and an edition can carry several — putting those in
// AsyncStorage would spend hundreds of kilobytes of a phone's storage per day on pictures that
// re-fetch in a second over the same connection that just delivered the JSON.

import { encodeIndexedPng, unpackNibbles } from '../screen'

export interface DecodedTile {
  /** Ready for `<Image source={{ uri: 'data:image/png;base64,' + this }} />`. */
  pngBase64: string
  width: number
  height: number
}

/** What the body of `tiles/<id>.bin` must weigh: two pixels to a byte. */
export function tileByteLength(w: number, h: number): number {
  return (w * h) / 2
}

/**
 * One tile body -> one indexed PNG in the measured inks.
 *
 * Throws on a body that is not exactly `w*h/2` bytes and on a geometry that cannot be a tile.
 * The caller (`PhotoTile`) catches and keeps the tile's height with the caption on a plain
 * ground, which is the spec's failure row: the layout must not move because a picture did not
 * arrive.
 */
export function decodeTile(bytes: Uint8Array, w: number, h: number): DecodedTile {
  const want = tileByteLength(w, h)
  if (w > 0 && h > 0 && w % 2 === 0 && bytes.length !== want) {
    throw new Error(`photo: expected ${want} bytes for ${w}x${h}, got ${bytes.length}`)
  }
  return { pngBase64: encodeIndexedPng(unpackNibbles(bytes, w, h), w, h), width: w, height: h }
}

// --- the session cache ------------------------------------------------------

const pngByUrl = new Map<string, string>()

export function getCachedTilePng(url: string): string | null {
  return pngByUrl.get(url) ?? null
}

export function putCachedTilePng(url: string, pngBase64: string): void {
  pngByUrl.set(url, pngBase64)
}

/**
 * Called when the edition changes. Tile ids are the producer's and are not guaranteed unique
 * across days, so a cache that outlived its edition could hand tomorrow's page yesterday's
 * picture under the same name.
 */
export function clearTilePngCache(): void {
  pngByUrl.clear()
}
```

Note the guard order in `decodeTile`: the length check runs only once the geometry is known
sane, so a `3x1` tile reports the geometry problem (from `unpackNibbles`) rather than a byte
count derived from a nonsense width.

- [ ] **Step 6: Run the photo tests and the screen tests together**

Run: `cd app && npx jest src/lib/screen.test.ts src/lib/edition/photo.test.ts`
Expected: PASS, both files.

- [ ] **Step 7: Typecheck and commit**

Run: `cd app && npm run typecheck`
Expected: no errors.

```bash
git add app/src/lib/screen.ts app/src/lib/edition/photo.ts app/src/lib/edition/photo.test.ts
git commit -m "refactor(app): parameterise the PNG encoder by geometry, and decode photo tiles"
```

---

### Task 4: The edition client

**Files:**
- Create: `app/src/lib/edition/client.ts`
- Create: `app/src/lib/edition/client.test.ts`

**Interfaces:**

- Consumes (Task 1):

```ts
export function parseEdition(json: unknown): Edition
export function isEmptyEdition(e: Edition): boolean
```

- Produces (Tasks 7, 8, 9 use these exact names):

```ts
export type EditionErrorCode = 'no_url' | 'transport' | 'http' | 'too_large' | 'bad_json'
export class EditionError extends Error {
  readonly code: EditionErrorCode
  readonly status?: number
  constructor(code: EditionErrorCode, message: string, status?: number)
}
export function humanEditionError(e: unknown): string
export type EditionFetch =
  | { status: 'ok'; edition: Edition; etag: string | null }
  | { status: 'not_modified' }
export interface EditionClientOptions { fetchFn?: typeof fetch; timeoutMs?: number }
export interface EditionClient {
  fetch(url: string, etag: string | null): Promise<EditionFetch>
  fetchTile(url: string, w: number, h: number): Promise<Uint8Array>
}
export function createEditionClient(opts?: EditionClientOptions): EditionClient
export function tileUrl(newsUrl: string, id: string): string
export const EDITION_MAX_BYTES: number      // 320 * 1024
export const EDITION_TIMEOUT_MS: number     // 15_000
export const editionClient: EditionClient   // the app-wide singleton, like `yahoo`
```

**Deviation from the spec, stated once.** The spec's `EditionClientOptions` also lists
`now?: () => number`. Nothing in the client reads a clock — the deadline is an `AbortController`
plus `setTimeout` — so the option is omitted rather than accepted and ignored. Timestamps belong
to the caller: `useEdition` stamps `fetchedAt` itself (Task 7).

- [ ] **Step 1: Write the failing client tests**

Create `app/src/lib/edition/client.test.ts`:

```ts
import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createEditionClient,
  EditionError,
  EDITION_MAX_BYTES,
  humanEditionError,
  tileUrl,
} from './client'

const FIXTURE = join(__dirname, '../../../../components/news_core/test/host/fixtures/news.json')
const fixtureText = (): string => readFileSync(FIXTURE, 'utf8')

const URL = 'http://desk.local:8123/news.json'

// A fake `fetch` that replays a queue of responses, or throws a queued Error to simulate the
// network refusing. Records every call so the request itself can be asserted — the point of this
// client is that it sends what the BOARD sends, and only the calls prove that.
type Reply =
  | { status?: number; text?: string; bytes?: Uint8Array; headers?: Record<string, string> }
  | Error

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = replies[Math.min(i, replies.length - 1)]
    i++
    if (r instanceof Error) throw r
    const headers = r.headers ?? {}
    const body = r.bytes ?? new TextEncoder().encode(r.text ?? '')
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k: string) => {
          const hit = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase())
          return hit === undefined ? null : headers[hit]
        },
      },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function client(replies: Reply[]) {
  const f = fakeFetch(replies)
  return { ...f, client: createEditionClient({ fetchFn: f.fetchImpl }) }
}

const header = (init: RequestInit | undefined, name: string): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.[name]

describe('editionClient.fetch — the happy path', () => {
  it('parses a 200 and carries the ETag back', async () => {
    const { client: c } = client([{ text: fixtureText(), headers: { ETag: 'W/"abc123"' } }])
    const r = await c.fetch(URL, null)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') throw new Error('unreachable')
    expect(r.etag).toBe('W/"abc123"')
    expect(r.edition.subject.symbol).toBe('SNDK')
    expect(r.edition.stories).toHaveLength(4)
  })

  it('reports a missing ETag as null rather than as an empty string', async () => {
    const { client: c } = client([{ text: fixtureText() }])
    const r = await c.fetch(URL, null)
    expect(r.status === 'ok' && r.etag).toBeNull()
  })

  it('sends a plain GET with no If-None-Match when it holds no ETag', async () => {
    const { client: c, calls } = client([{ text: fixtureText() }])
    await c.fetch(URL, null)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(URL)
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
    expect(header(calls[0].init, 'If-None-Match')).toBeUndefined()
  })

  it('sends If-None-Match when it holds one — the request the board sends', async () => {
    const { client: c, calls } = client([{ status: 304 }])
    await c.fetch(URL, 'W/"abc123"')
    expect(header(calls[0].init, 'If-None-Match')).toBe('W/"abc123"')
  })
})

describe('editionClient.fetch — the failures', () => {
  it('reads a 304 as not_modified', async () => {
    const { client: c } = client([{ status: 304 }])
    expect(await c.fetch(URL, 'W/"abc"')).toEqual({ status: 'not_modified' })
  })

  it('refuses an empty URL without touching the network', async () => {
    const { client: c, calls } = client([{ text: fixtureText() }])
    await expect(c.fetch('', null)).rejects.toMatchObject({ code: 'no_url' })
    await expect(c.fetch('   ', null)).rejects.toMatchObject({ code: 'no_url' })
    expect(calls).toHaveLength(0)
  })

  it('carries the status on a non-2xx', async () => {
    const { client: c } = client([{ status: 500, text: 'boom' }])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'http', status: 500 })
    const { client: d } = client([{ status: 404, text: '' }])
    await expect(d.fetch(URL, null)).rejects.toMatchObject({ code: 'http', status: 404 })
  })

  it('reads a body that is not JSON as bad_json', async () => {
    const { client: c } = client([{ text: '<html>the tunnel is down</html>' }])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('reads a 200 that parses to an empty edition as bad_json', async () => {
    // A desk mid-publish serves furniture with nothing under it. Treating that as success would
    // overwrite a real cached edition with a blank sheet.
    const { client: c } = client([{ text: JSON.stringify({ dateline: 'FRIDAY', stories: [] }) }])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('refuses a body over the device’s own cap', async () => {
    const big = 'x'.repeat(EDITION_MAX_BYTES + 1)
    const { client: c } = client([{ text: big }])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'too_large' })
    expect(EDITION_MAX_BYTES).toBe(320 * 1024)
  })

  it('refuses on Content-Length alone, before reading the body', async () => {
    const { client: c } = client([
      { text: '{}', headers: { 'Content-Length': String(EDITION_MAX_BYTES + 1) } },
    ])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'too_large' })
  })

  it('reads a thrown fetch as transport', async () => {
    const { client: c } = client([new TypeError('Network request failed')])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'transport' })
  })

  it('reads its own deadline as transport, and aborts the request', async () => {
    // The fetch never settles; only the AbortController ends it. `timeoutMs: 1` keeps the test
    // instant, and the assertion is on the signal actually firing, not on elapsed time.
    let signal: AbortSignal | undefined
    const fetchFn = ((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')))
      })
    }) as unknown as typeof fetch
    const c = createEditionClient({ fetchFn, timeoutMs: 1 })
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'transport' })
    expect(signal?.aborted).toBe(true)
  })
})

describe('humanEditionError', () => {
  it('writes one sentence per failure, in the interface’s voice', () => {
    expect(humanEditionError(new EditionError('no_url', 'x'))).toBe(
      'No edition URL yet. Add one in Settings.',
    )
    expect(humanEditionError(new EditionError('transport', 'x'))).toBe(
      "Couldn't reach the edition server. Check the connection, then pull to refresh.",
    )
    expect(humanEditionError(new EditionError('http', 'x', 503))).toBe(
      'The edition server answered 503.',
    )
    expect(humanEditionError(new EditionError('too_large', 'x'))).toBe(
      'The edition is too large to read here.',
    )
    expect(humanEditionError(new EditionError('bad_json', 'x'))).toBe(
      "The edition didn't parse. The desk may be mid-publish; pull to refresh in a minute.",
    )
  })

  it('says something true about a status it does not have', () => {
    expect(humanEditionError(new EditionError('http', 'x'))).toBe(
      'The edition server answered with an error.',
    )
  })

  it('has a sentence for something that is not an EditionError at all', () => {
    expect(humanEditionError(new Error('nope'))).toBe('Something went wrong reading the edition.')
    expect(humanEditionError(undefined)).toBe('Something went wrong reading the edition.')
  })
})

describe('tileUrl', () => {
  it('resolves beside the payload', () => {
    expect(tileUrl('http://desk.local:8123/news.json', 'sndk_fab')).toBe(
      'http://desk.local:8123/tiles/sndk_fab.bin',
    )
    expect(tileUrl('https://claudepost.example.dev/edition/news.json', 'x')).toBe(
      'https://claudepost.example.dev/edition/tiles/x.bin',
    )
  })

  it('drops the query and the fragment', () => {
    expect(tileUrl('http://d/news.json?v=2#top', 'a')).toBe('http://d/tiles/a.bin')
    expect(tileUrl('http://d/sub/news.json#frag', 'a')).toBe('http://d/sub/tiles/a.bin')
  })

  it('percent-encodes an id that would otherwise change the path', () => {
    expect(tileUrl('http://d/news.json', '../secret')).toBe('http://d/tiles/..%2Fsecret.bin')
  })

  it('answers the empty string for a URL it cannot resolve beside', () => {
    expect(tileUrl('', 'a')).toBe('')
    expect(tileUrl('news.json', 'a')).toBe('')
  })
})

describe('editionClient.fetchTile', () => {
  it('returns the body when it weighs exactly w*h/2', async () => {
    const bytes = new Uint8Array((2 * 2) / 2).fill(0x11)
    const { client: c, calls } = client([{ bytes }])
    const got = await c.fetchTile('http://d/tiles/a.bin', 2, 2)
    expect(Array.from(got)).toEqual([0x11, 0x11])
    expect(calls[0].url).toBe('http://d/tiles/a.bin')
  })

  it('rejects a body of the wrong length rather than drawing half a picture', async () => {
    const { client: c } = client([{ bytes: new Uint8Array(1) }])
    await expect(c.fetchTile('http://d/tiles/a.bin', 4, 2)).rejects.toMatchObject({
      code: 'bad_json',
    })
  })

  it('carries the status on a non-2xx and the code on a thrown fetch', async () => {
    const { client: a } = client([{ status: 404 }])
    await expect(a.fetchTile('http://d/tiles/a.bin', 2, 2)).rejects.toMatchObject({
      code: 'http',
      status: 404,
    })
    const { client: b } = client([new TypeError('Network request failed')])
    await expect(b.fetchTile('http://d/tiles/a.bin', 2, 2)).rejects.toMatchObject({
      code: 'transport',
    })
  })

  it('refuses an empty URL without touching the network', async () => {
    const { client: c, calls } = client([{ bytes: new Uint8Array(2) }])
    await expect(c.fetchTile('', 2, 2)).rejects.toMatchObject({ code: 'no_url' })
    expect(calls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx jest src/lib/edition/client.test.ts`
Expected: FAIL — `Cannot find module './client'`.

- [ ] **Step 3: Write `client.ts`**

Create `app/src/lib/edition/client.ts`:

```ts
// The edition, fetched by the phone.
//
// The desk serves `GET /news.json` unauthenticated on its device plane — the same URL, the same
// bytes, the same conditional request the board makes (docs/desk-server.md, "The two planes").
// So this client sends what the board sends and applies the board's own limits: a 15-second
// deadline, a 320 KB cap, an `If-None-Match` whenever it holds an ETag. A payload this refuses
// is a payload the board would refuse too, which keeps the phone from showing an edition the
// glass could never print.
//
// The five error codes are the whole failure vocabulary and each one has exactly one sentence
// (`humanEditionError`). They are separate codes rather than one string because the SCREEN acts
// differently on them: `no_url` is a settings problem, `transport` is a pull-to-refresh problem,
// and `bad_json` is somebody else's problem that fixes itself in a minute.

import { isEmptyEdition, parseEdition } from './parse'
import { type Edition } from './types'

/** The device's own body cap (`news_service.c`). A payload over it is one the board rejects. */
export const EDITION_MAX_BYTES = 320 * 1024

/** The device's own deadline. Long enough for a cold tunnel, short enough to be a refresh. */
export const EDITION_TIMEOUT_MS = 15_000

export type EditionErrorCode = 'no_url' | 'transport' | 'http' | 'too_large' | 'bad_json'

export class EditionError extends Error {
  constructor(
    public readonly code: EditionErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'EditionError'
  }
}

/**
 * One sentence per failure, written for a reader rather than for a log.
 *
 * Every one of them says what the reader can do next, or says plainly that there is nothing to
 * do. "The desk may be mid-publish" is the honest reading of a 200 that will not parse: the
 * common cause is a file being written while it is being served, and it resolves itself.
 */
export function humanEditionError(e: unknown): string {
  if (e instanceof EditionError) {
    switch (e.code) {
      case 'no_url':
        return 'No edition URL yet. Add one in Settings.'
      case 'transport':
        return "Couldn't reach the edition server. Check the connection, then pull to refresh."
      case 'http':
        return e.status === undefined
          ? 'The edition server answered with an error.'
          : `The edition server answered ${e.status}.`
      case 'too_large':
        return 'The edition is too large to read here.'
      case 'bad_json':
        return "The edition didn't parse. The desk may be mid-publish; pull to refresh in a minute."
    }
  }
  return 'Something went wrong reading the edition.'
}

export type EditionFetch =
  | { status: 'ok'; edition: Edition; etag: string | null }
  | { status: 'not_modified' }

export interface EditionClientOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export interface EditionClient {
  fetch(url: string, etag: string | null): Promise<EditionFetch>
  fetchTile(url: string, w: number, h: number): Promise<Uint8Array>
}

/**
 * Where a photo tile lives: the news URL's DIRECTORY plus `tiles/<id>.bin`.
 *
 * The directory is everything up to and including the last `/`, with the query and the fragment
 * removed first — a `?v=2` on the payload does not belong on a picture, and a URL that carried
 * one would 404 on every tile. The id is percent-encoded because it is the producer's string and
 * a `../` in it would resolve to a path this app never meant to ask for.
 *
 * Returns `''` for anything with no directory to resolve beside; the caller treats that as "no
 * picture", which is the same outcome as a failed fetch and needs no second branch.
 */
export function tileUrl(newsUrl: string, id: string): string {
  const path = newsUrl.split('#')[0].split('?')[0]
  const cut = path.lastIndexOf('/')
  // A bare `news.json` with no slash at all, or an empty string: nothing to resolve against.
  if (cut < 0) return ''
  return `${path.slice(0, cut + 1)}tiles/${encodeURIComponent(id)}.bin`
}

export function createEditionClient(opts: EditionClientOptions = {}): EditionClient {
  const fetchFn = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? EDITION_TIMEOUT_MS

  // GET with the deadline attached. Our own abort and the network refusing both read transport —
  // the sentence ("check the connection, then pull to refresh") is right for either.
  async function get(url: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetchFn(url, { method: 'GET', headers, signal: controller.signal })
    } catch (e) {
      throw new EditionError('transport', e instanceof Error ? e.message : 'network error')
    } finally {
      clearTimeout(timer)
    }
  }

  async function bodyBytes(res: Response, cap: number): Promise<Uint8Array> {
    // Content-Length first, so an oversize payload is refused before it is downloaded. It is
    // advisory (a chunked response carries none), which is why the length is checked again below.
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > cap) {
      throw new EditionError('too_large', `content-length ${declared} over the ${cap}-byte cap`)
    }
    let buf: ArrayBuffer
    try {
      buf = await res.arrayBuffer()
    } catch (e) {
      throw new EditionError('transport', e instanceof Error ? e.message : 'body read failed')
    }
    if (buf.byteLength > cap) {
      throw new EditionError('too_large', `${buf.byteLength} bytes over the ${cap}-byte cap`)
    }
    return new Uint8Array(buf)
  }

  async function fetchEdition(url: string, etag: string | null): Promise<EditionFetch> {
    if (url.trim() === '') throw new EditionError('no_url', 'no edition URL configured')

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (etag !== null && etag !== '') headers['If-None-Match'] = etag

    const res = await get(url, headers)

    // 304 before the ok check: `res.ok` is false for a 304, and reading it as an HTTP failure
    // would turn the most common answer a healthy desk gives into an error banner.
    if (res.status === 304) return { status: 'not_modified' }
    if (!res.ok) throw new EditionError('http', `edition server answered ${res.status}`, res.status)

    const bytes = await bodyBytes(res, EDITION_MAX_BYTES)

    let json: unknown
    try {
      json = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new EditionError('bad_json', 'the body is not JSON')
    }

    const edition = parseEdition(json)
    // The parser is total, so "it parsed" is not the same question as "there is an edition here".
    // A desk writing the file while serving it answers 200 with furniture and no content; taking
    // that as success would replace a real cached edition with a blank sheet.
    if (isEmptyEdition(edition)) {
      throw new EditionError('bad_json', 'the payload carries no subject and no stories')
    }

    return { status: 'ok', edition, etag: res.headers.get('etag') }
  }

  async function fetchTile(url: string, w: number, h: number): Promise<Uint8Array> {
    if (url.trim() === '') throw new EditionError('no_url', 'no tile URL')
    const res = await get(url, {})
    if (!res.ok) throw new EditionError('http', `tile server answered ${res.status}`, res.status)
    const want = (w * h) / 2
    // A tile has no header and no length of its own, so the geometry from the payload is the
    // only thing that can check it. A short body drawn as a whole picture is an image the reader
    // cannot tell from the real one.
    const bytes = await bodyBytes(res, Math.max(want, 1))
    if (bytes.length !== want) {
      throw new EditionError(
        'bad_json',
        `tile: expected ${want} bytes for ${w}x${h}, got ${bytes.length}`,
      )
    }
    return bytes
  }

  return { fetch: fetchEdition, fetchTile }
}

/**
 * The app-wide client, the same singleton idiom as `lib/market/yahoo.ts`'s `yahoo`. Screens and
 * tiles take this; tests build their own with an injected `fetchFn`.
 */
export const editionClient: EditionClient = createEditionClient()
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd app && npx jest src/lib/edition/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `cd app && npm run typecheck`
Expected: no errors.

```bash
git add app/src/lib/edition/client.ts app/src/lib/edition/client.test.ts
git commit -m "feat(app): fetch the edition the way the board fetches it"
```

---

### Task 5: The edition cache

**Files:**
- Create: `app/src/lib/edition/store.ts`
- Create: `app/src/lib/edition/store.test.ts`

**Interfaces:**

- Consumes (Task 1):

```ts
export function parseEdition(json: unknown): Edition
export function isEmptyEdition(e: Edition): boolean
export function demoEdition(): Edition          // from ./demo, used by the test only
```

- Produces (Tasks 7 and 9 use these exact names):

```ts
export const EDITION_CACHE_KEY = 'claudepost.edition'
export interface CachedEdition { url: string; etag: string | null; fetchedAt: number; edition: Edition }
export function readCachedEdition(): Promise<CachedEdition | null>
export function writeCachedEdition(c: CachedEdition): Promise<void>
export function touchCachedEdition(fetchedAt: number): Promise<void>
export function clearCachedEdition(): Promise<void>
export function getCurrentEdition(): CachedEdition | null
export function setCurrentEdition(c: CachedEdition | null): void
export function __resetEditionStoreForTests(): void
```

**House rules this file follows** (from `app/src/lib/store.ts` and `app/src/lib/market/watchlist.ts`):
one namespaced `claudepost.*` key, an in-memory mirror, **every write absorbs its own storage
failure**, and a `__reset…ForTests` hook so a fresh read hits the mocked store. The AsyncStorage
mock is already installed globally by `app/jest.setup.js`; no per-file mocking is needed.

- [ ] **Step 1: Write the failing store tests**

Create `app/src/lib/edition/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  __resetEditionStoreForTests,
  clearCachedEdition,
  EDITION_CACHE_KEY,
  getCurrentEdition,
  readCachedEdition,
  setCurrentEdition,
  touchCachedEdition,
  writeCachedEdition,
  type CachedEdition,
} from './store'
import { parseEdition } from './parse'
import { demoEdition } from './demo'

beforeEach(async () => {
  await AsyncStorage.clear()
  __resetEditionStoreForTests()
})

afterEach(() => {
  jest.restoreAllMocks()
})

const URL = 'http://desk.local:8123/news.json'
const entry = (over: Partial<CachedEdition> = {}): CachedEdition => ({
  url: URL,
  etag: 'W/"abc"',
  fetchedAt: 1_700_000_000_000,
  edition: demoEdition(),
  ...over,
})

describe('the on-disk edition cache', () => {
  it('uses the one key every shipped install already namespaces', () => {
    // The literal is load-bearing the way store.ts's five are: renaming it is a silent cache
    // wipe on every phone that has one.
    expect(EDITION_CACHE_KEY).toBe('claudepost.edition')
  })

  it('round-trips', async () => {
    await writeCachedEdition(entry())
    __resetEditionStoreForTests()
    const got = await readCachedEdition()
    expect(got?.url).toBe(URL)
    expect(got?.etag).toBe('W/"abc"')
    expect(got?.fetchedAt).toBe(1_700_000_000_000)
    expect(got?.edition.subject.symbol).toBe('SNDK')
    expect(got?.edition.stories).toHaveLength(4)
  })

  it('answers null when nothing is stored', async () => {
    expect(await readCachedEdition()).toBeNull()
  })

  it('re-parses on read, so a shape written by another version degrades instead of crashing', async () => {
    await AsyncStorage.setItem(
      EDITION_CACHE_KEY,
      JSON.stringify({
        url: URL,
        etag: null,
        fetchedAt: 5,
        edition: { subject: { symbol: 'SNDK' }, stories: 'not an array', extra: 'ignored' },
      }),
    )
    const got = await readCachedEdition()
    expect(got?.edition.subject.symbol).toBe('SNDK')
    expect(got?.edition.stories).toEqual([])
    expect(got?.etag).toBeNull()
  })

  it('reads a corrupt value as nothing cached', async () => {
    for (const junk of ['not json at all', '[]', 'null', '{"url":42}', '{"url":"u"}']) {
      await AsyncStorage.setItem(EDITION_CACHE_KEY, junk)
      __resetEditionStoreForTests()
      expect(await readCachedEdition()).toBeNull()
    }
  })

  it('reads an entry whose edition is empty as nothing cached', async () => {
    // There is nothing to show, so "no cache" is the honest answer — the screen then loads rather
    // than rendering a blank sheet it would have to explain.
    await AsyncStorage.setItem(
      EDITION_CACHE_KEY,
      JSON.stringify({ url: URL, etag: null, fetchedAt: 5, edition: { dateline: 'FRIDAY' } }),
    )
    expect(await readCachedEdition()).toBeNull()
  })

  it('touch moves only fetchedAt', async () => {
    await writeCachedEdition(entry())
    await touchCachedEdition(1_700_000_999_000)
    __resetEditionStoreForTests()
    const got = await readCachedEdition()
    expect(got?.fetchedAt).toBe(1_700_000_999_000)
    expect(got?.etag).toBe('W/"abc"')
    expect(got?.url).toBe(URL)
    expect(got?.edition.subject.symbol).toBe('SNDK')
  })

  it('touch on an empty store writes nothing', async () => {
    await touchCachedEdition(123)
    expect(await AsyncStorage.getItem(EDITION_CACHE_KEY)).toBeNull()
  })

  it('clear removes it', async () => {
    await writeCachedEdition(entry())
    await clearCachedEdition()
    __resetEditionStoreForTests()
    expect(await readCachedEdition()).toBeNull()
  })

  it('absorbs a storage failure on every write', async () => {
    // Swapped by hand rather than with jest.spyOn: AsyncStorage's mock is itself made of jest.fn
    // objects with real implementations, and restoreAllMocks() strips the implementation from a
    // spied one — which turns setItem into a silent no-op for every later test in the file.
    const boom = async () => {
      throw new Error('disk is full')
    }
    const setItem = AsyncStorage.setItem
    const removeItem = AsyncStorage.removeItem
    AsyncStorage.setItem = boom as typeof AsyncStorage.setItem
    AsyncStorage.removeItem = boom as typeof AsyncStorage.removeItem
    try {
      await expect(writeCachedEdition(entry())).resolves.toBeUndefined()
      await expect(touchCachedEdition(1)).resolves.toBeUndefined()
      await expect(clearCachedEdition()).resolves.toBeUndefined()
    } finally {
      AsyncStorage.setItem = setItem
      AsyncStorage.removeItem = removeItem
    }
  })

  it('absorbs a storage failure on read', async () => {
    const getItem = AsyncStorage.getItem
    AsyncStorage.getItem = (async () => {
      throw new Error('unreadable')
    }) as typeof AsyncStorage.getItem
    try {
      expect(await readCachedEdition()).toBeNull()
    } finally {
      AsyncStorage.getItem = getItem
    }
  })
})

describe('the in-memory current edition', () => {
  it('starts empty, holds what it is given, and clears', () => {
    expect(getCurrentEdition()).toBeNull()
    const e = entry()
    setCurrentEdition(e)
    expect(getCurrentEdition()).toBe(e)
    setCurrentEdition(null)
    expect(getCurrentEdition()).toBeNull()
  })

  it('is filled by a write, so the detail route can read it without touching disk', async () => {
    await writeCachedEdition(entry())
    expect(getCurrentEdition()?.url).toBe(URL)
  })

  it('is filled by a read', async () => {
    await writeCachedEdition(entry())
    __resetEditionStoreForTests()
    expect(getCurrentEdition()).toBeNull()
    await readCachedEdition()
    expect(getCurrentEdition()?.edition.subject.symbol).toBe('SNDK')
  })

  it('is dropped by clear', async () => {
    await writeCachedEdition(entry())
    await clearCachedEdition()
    expect(getCurrentEdition()).toBeNull()
  })

  it('holds an edition parsed anywhere, not only one off disk', () => {
    setCurrentEdition({
      url: '',
      etag: null,
      fetchedAt: 0,
      edition: parseEdition({ subject: { symbol: 'X' } }),
    })
    expect(getCurrentEdition()?.edition.subject.symbol).toBe('X')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx jest src/lib/edition/store.test.ts`
Expected: FAIL — `Cannot find module './store'`.

- [ ] **Step 3: Write `store.ts`**

Create `app/src/lib/edition/store.ts`:

```ts
// The last good edition, kept so the Today tab reads on a train.
//
// One AsyncStorage key holding one JSON object: the URL it came from, the ETag to send next
// time, when the server last CONFIRMED it, and the parsed edition. Four fields and no schema
// version, because the read re-parses through `parseEdition` — a cache written by a newer build
// degrades to defaults instead of crashing a launch, which is the only version handling a shape
// this small needs.
//
// `fetchedAt` is a confirmation, not a change: a 304 moves it (`touchCachedEdition`) without
// touching a byte of content. That is exactly the question the freshness line answers.
//
// The URL travels WITH the entry because it is what makes the cache safe. A phone that changes
// desks must not be handed the old desk's edition as "today"; `useEdition` compares this field
// against the stored news URL and ignores a mismatch. Deciding that here would need this file to
// know about `lib/store.ts`, which is a dependency the cache does not need to have.
//
// Photo tiles are NOT in here — see `photo.ts` for why they are memory-only.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { isEmptyEdition, parseEdition } from './parse'
import { type Edition } from './types'

/** Namespaced like every other key this app owns. The literal is load-bearing. */
export const EDITION_CACHE_KEY = 'claudepost.edition'

export interface CachedEdition {
  url: string
  etag: string | null
  /** When the server last confirmed this content — a 200 or a 304. */
  fetchedAt: number
  edition: Edition
}

/**
 * The edition on screen right now, in memory.
 *
 * The detail route needs the whole edition and is reached by a push, not by a prop: reading it
 * from here costs nothing, and falling back to disk covers the one case this misses — a cold
 * deep link straight into `/edition/<id>`.
 */
let current: CachedEdition | null = null

export function getCurrentEdition(): CachedEdition | null {
  return current
}

export function setCurrentEdition(c: CachedEdition | null): void {
  current = c
}

/** Everything a stored entry has to be before it is worth returning. */
function sanitize(raw: unknown): CachedEdition | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.url !== 'string') return null
  if (typeof o.fetchedAt !== 'number' || !Number.isFinite(o.fetchedAt)) return null
  const edition = parseEdition(o.edition)
  // An entry with nothing showable in it is worse than no entry: it would put a blank sheet on
  // screen and suppress the load that would have replaced it.
  if (isEmptyEdition(edition)) return null
  return {
    url: o.url,
    etag: typeof o.etag === 'string' ? o.etag : null,
    fetchedAt: o.fetchedAt,
    edition,
  }
}

export async function readCachedEdition(): Promise<CachedEdition | null> {
  let raw: string | null
  try {
    raw = await AsyncStorage.getItem(EDITION_CACHE_KEY)
  } catch {
    // A read that threw is not an answer. Nothing is remembered from it, so the next call tries
    // the disk again instead of inheriting a wrong "no cache" for the session.
    return null
  }
  if (raw === null || raw === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Not something this file wrote. Reading it as "nothing cached" costs one fetch; reading it
    // as an edition would put unknown content on screen.
    return null
  }
  const entry = sanitize(parsed)
  if (entry !== null) current = entry
  return entry
}

export async function writeCachedEdition(c: CachedEdition): Promise<void> {
  // The in-memory copy is set BEFORE the disk write is awaited, the same order `store.ts`'s
  // `saveNewsUrl` uses: the caller's next act is to render, and a detail route opened while the
  // write is in flight must see what was just fetched.
  current = c
  try {
    await AsyncStorage.setItem(EDITION_CACHE_KEY, JSON.stringify(c))
  } catch {
    // best-effort: the cost is re-fetching one edition on the next cold launch
  }
}

/** After a 304 — the content did not move, but the server just confirmed it. */
export async function touchCachedEdition(fetchedAt: number): Promise<void> {
  const entry = current ?? (await readCachedEdition())
  if (entry === null) return
  await writeCachedEdition({ ...entry, fetchedAt })
}

export async function clearCachedEdition(): Promise<void> {
  current = null
  try {
    await AsyncStorage.removeItem(EDITION_CACHE_KEY)
  } catch {
    // best-effort: a stale entry that survives is ignored on read anyway once its URL no longer
    // matches, and overwritten by the next success
  }
}

/** Test hook: drop the in-memory copy so a fresh read hits the (mocked) store. */
export function __resetEditionStoreForTests(): void {
  current = null
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd app && npx jest src/lib/edition/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole edition suite and typecheck**

Run: `cd app && npx jest src/lib/edition/ && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/edition/store.ts app/src/lib/edition/store.test.ts
git commit -m "feat(app): keep the last good edition on disk"
```

---

### Task 6: The tile model — order, chips, heights, placement

**Files:**
- Create: `app/src/lib/edition/tiles.ts`
- Create: `app/src/lib/edition/tiles.test.ts`

**Interfaces:**

- Consumes: only `app/src/lib/edition/types.ts` (already written — see Task 1's Interfaces block
  for the full set of interfaces; this task uses `Edition`, `EditionSubject`, `EditionStory`,
  `EditionFigure`, `EditionBrief`, `EditionPeer`, `EditionTable`, `EditionChart`, `EditionIndex`,
  `EditionPhoto`). The test also uses Task 1's `parseEdition`, but the module itself does not — it
  is a pure function of an `Edition`.
- Produces (Tasks 8 and 9 build the whole UI on these):

```ts
export type Chip = 'all' | 'stories' | 'numbers' | 'accounts' | 'photos'
export const CHIPS: ReadonlyArray<{ id: Chip; label: string }>
export type Tile =
  | { kind: 'story';   id: string; story: EditionStory; lead: boolean }
  | { kind: 'range';   id: string; subject: EditionSubject }
  | { kind: 'chart';   id: string; chart: EditionChart }
  | { kind: 'photo';   id: string; photo: EditionPhoto }
  | { kind: 'figures'; id: string; group: string; figures: EditionFigure[] }
  | { kind: 'briefs';  id: string; briefs: EditionBrief[] }
  | { kind: 'peers';   id: string; peers: EditionPeer[] }
  | { kind: 'table';   id: string; table: EditionTable }
  | { kind: 'tape';    id: string; indices: EditionIndex[] }
export interface EditionLayout { band: EditionPhoto | null; tiles: Tile[] }
export function editionToTiles(e: Edition): EditionLayout
export function tileChip(t: Tile): Exclude<Chip, 'all'>
export function filterTiles(tiles: Tile[], chip: Chip): Tile[]
export function availableChips(tiles: Tile[]): Chip[]
export function estimateTileHeight(t: Tile, colWidth: number): number
export interface PlacedTile { tile: Tile; height: number }
export function splitColumns(tiles: Tile[], colWidth: number, columns?: number): PlacedTile[][]
export function findTile(layout: EditionLayout, id: string): Tile | null
export const TILE_PADDING: number   // 14
```

**The three rules this file owns, restated for an engineer who has not read the spec:**

1. **Order** (the "All" feed): `range` → the lead `story` → `chart[0]` → the remaining stories in
   rank order → one `figures` tile per distinct `group` in first-seen order → one `photo` tile per
   photo → `briefs` (one tile) → `peers` → one `table` per table → `tape` → the remaining charts.
   A kind with nothing behind it is **absent**, never an empty tile.
2. **The band.** The lead story's photo becomes a full-width strip above the grid when its
   `w / h > 2` — a 1140×320 photo at a 170 px column would be 47 px tall, which is a smear.
   A lead photo of ordinary aspect becomes the **first** photo tile instead.
3. **Ids** are `${kind}:${n}` with `n` the tile's index among its own kind, so a detail route can
   name a tile and a re-parse of the same edition yields the same ids.

**Heights**, all in px, `P = TILE_PADDING = 14`:

| kind | height |
|---|---|
| story (lead) | `round(colWidth * 4 / 3)` |
| story (other) | `colWidth` |
| range | `colWidth` |
| chart | `round(colWidth * 3 / 4)` |
| photo | `round(colWidth * clamp(h / w, 2/3, 3/2))` |
| figures | `2P + 22 + 28 * min(n, 4) + (n > 4 ? 20 : 0)` |
| briefs | `2P + 22 + 56 * min(n, 3) + (n > 3 ? 20 : 0)` |
| peers | `2P + 22 + 28 * min(n, 6)` |
| table | `round(colWidth * 5 / 4)` |
| tape | `2P + 22 + 32 * min(n, 5)` |

- [ ] **Step 1: Write the failing tile tests**

Create `app/src/lib/edition/tiles.test.ts`:

```ts
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
  TILE_PADDING,
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
    expect(TILE_PADDING).toBe(14)
    expect(estimateTileHeight(by('story:0'), W)).toBe(227) // lead: round(170 * 4/3)
    expect(estimateTileHeight(by('story:1'), W)).toBe(170) // other: the column, square
    expect(estimateTileHeight(by('range:0'), W)).toBe(170)
    expect(estimateTileHeight(by('chart:0'), W)).toBe(128) // round(170 * 3/4) = round(127.5)
    expect(estimateTileHeight(by('table:0'), W)).toBe(213) // round(170 * 5/4) = round(212.5)
    expect(estimateTileHeight(by('photo:0'), W)).toBe(113) // 364x204 is flatter than 2:3, clamped
    expect(estimateTileHeight(by('figures:0'), W)).toBe(162) // VALUATION, 4 rows
    expect(estimateTileHeight(by('figures:1'), W)).toBe(134) // PER SHARE, 3 rows
    expect(estimateTileHeight(by('figures:5'), W)).toBe(182) // THE STREET, 5 rows -> 4 + "more"
    expect(estimateTileHeight(by('briefs:0'), W)).toBe(238) // 6 briefs -> 3 + "more"
    expect(estimateTileHeight(by('peers:0'), W)).toBe(190) // 5 peers
    expect(estimateTileHeight(by('tape:0'), W)).toBe(210) // 5 indices
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
    // Heights at W=170: one figure is 78, four figures are 162.
    // A(78) -> col0 (tie).  B(78) -> col1.  C(162) -> col0 (tie at 78).  D(78) -> col1 (78 < 240).
    const tiles = [figuresTile('a', 1), figuresTile('b', 1), figuresTile('c', 4), figuresTile('d', 1)]
    const cols = splitColumns(tiles, W, 2)
    expect(cols.map((c) => c.map((p) => p.tile.id))).toEqual([['a', 'c'], ['b', 'd']])
    expect(cols[0].map((p) => p.height)).toEqual([78, 162])
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx jest src/lib/edition/tiles.test.ts`
Expected: FAIL — `Cannot find module './tiles'`.

- [ ] **Step 3: Write `tiles.ts`**

Create `app/src/lib/edition/tiles.ts`:

```ts
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
// in the grid and becomes the FIRST photo tile, so the picture the desk chose leads the pictures.
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
//   range           colWidth
//   chart           round(colWidth * 3 / 4)
//   photo           round(colWidth * clamp(h / w, 2/3, 3/2))
//   figures         2P + 22 + 28 * min(n, 4) + (n > 4 ? 20 : 0)
//   briefs          2P + 22 + 56 * min(n, 3) + (n > 3 ? 20 : 0)
//   peers           2P + 22 + 28 * min(n, 6)
//   table           round(colWidth * 5 / 4)
//   tape            2P + 22 + 32 * min(n, 5)
//
// where P = TILE_PADDING. The 22 is the tile's heading line; the per-row constants are the row
// heights the bodies in `components/edition/tiles/` actually draw, and the trailing 20 is the
// "+N more" line. CHANGE A ROW HEIGHT IN A TILE BODY AND CHANGE IT HERE IN THE SAME COMMIT, or
// the tile clips its own last row.
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

/** The heading line every non-media tile draws. */
const HEAD = 22
/** The "+N more" line, drawn when a tile holds more than it shows. */
const MORE = 20

export function estimateTileHeight(t: Tile, colWidth: number): number {
  const chrome = 2 * TILE_PADDING + HEAD
  switch (t.kind) {
    case 'story':
      // The lead is the one tile allowed to be taller than it is wide: its headline at 22/26 is
      // this design's photograph, and four legs of body under it is what makes it read as a lead.
      return t.lead ? Math.round((colWidth * 4) / 3) : colWidth
    case 'range':
      return colWidth
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
      return chrome + 28 * Math.min(n, 4) + (n > 4 ? MORE : 0)
    }
    case 'briefs': {
      const n = t.briefs.length
      return chrome + 56 * Math.min(n, 3) + (n > 3 ? MORE : 0)
    }
    case 'peers':
      return chrome + 28 * Math.min(t.peers.length, 6)
    case 'table':
      return Math.round((colWidth * 5) / 4)
    case 'tape':
      return chrome + 32 * Math.min(t.indices.length, 5)
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd app && npx jest src/lib/edition/tiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `cd app && npm run typecheck`
Expected: no errors.

```bash
git add app/src/lib/edition/tiles.ts app/src/lib/edition/tiles.test.ts
git commit -m "feat(app): cut the edition into tiles with heights known before layout"
```

---

### Task 7: The screen hook and its pure reducer

**Files:**
- Create: `app/src/lib/edition/useEdition.ts`
- Create: `app/src/lib/edition/useEdition.test.ts` (the **reducer** only — there is no component test runner in this app and the spec does not add one)

**Interfaces:**

- Consumes (Tasks 1, 4, 5, and the existing `app/src/lib/store.ts`):

```ts
// ./parse
export function parseEdition(json: unknown): Edition
// ./demo
export function demoEdition(): Edition
// ./client
export class EditionError extends Error { readonly code: EditionErrorCode; readonly status?: number }
export function humanEditionError(e: unknown): string
export type EditionFetch =
  | { status: 'ok'; edition: Edition; etag: string | null }
  | { status: 'not_modified' }
export const editionClient: {
  fetch(url: string, etag: string | null): Promise<EditionFetch>
  fetchTile(url: string, w: number, h: number): Promise<Uint8Array>
}
// ./store
export interface CachedEdition { url: string; etag: string | null; fetchedAt: number; edition: Edition }
export function readCachedEdition(): Promise<CachedEdition | null>
export function writeCachedEdition(c: CachedEdition): Promise<void>
export function touchCachedEdition(fetchedAt: number): Promise<void>
export function setCurrentEdition(c: CachedEdition | null): void
// ./photo
export function clearTilePngCache(): void
// ../store  (the app's existing AsyncStorage wrapper — already shipped, do not change it)
export function getNewsUrl(): Promise<string | null>
```

- Produces (Task 9 uses these exact names):

```ts
export type EditionState =
  | { status: 'loading' }
  | { status: 'ready'; cached: CachedEdition; demo: boolean; refreshing: boolean; error: string | null }
  | { status: 'error'; error: string }
export interface EditionMachine { url: string | null; state: EditionState }
export type EditionEvent =
  | { type: 'url'; url: string }
  | { type: 'cache'; cached: CachedEdition | null }
  | { type: 'fetched'; result: EditionFetch; url: string; fetchedAt: number }
  | { type: 'failed'; error: string }
  | { type: 'refreshing' }
export const INITIAL_EDITION_MACHINE: EditionMachine
export const FOCUS_REFRESH_AFTER_MS: number   // 5 * 60_000
export function demoCache(): CachedEdition
export function nextEditionState(prev: EditionMachine, event: EditionEvent): EditionMachine
export function useEdition(): {
  state: EditionState
  refresh: (opts?: { fresh?: boolean }) => Promise<void>
}
```

**Why the machine carries the URL.** The spec's `EditionState` has no URL in its `loading` and
`error` shapes, but "is this response still the one I asked for?" and "does this cache belong to
this desk?" are both questions about the URL. Keeping it in a wrapper (`EditionMachine`) rather
than duplicating it into three state shapes gives the reducer one place to answer both, and the
hook returns only `machine.state` so the screen sees exactly the union the spec names.

- [ ] **Step 1: Write the failing reducer tests**

Create `app/src/lib/edition/useEdition.test.ts`:

```ts
import { describe, it, expect } from '@jest/globals'
import {
  demoCache,
  INITIAL_EDITION_MACHINE,
  nextEditionState,
  type EditionEvent,
  type EditionMachine,
} from './useEdition'
import { parseEdition } from './parse'
import { type CachedEdition } from './store'
import { type EditionFetch } from './client'

const URL = 'http://desk.local:8123/news.json'
const OTHER = 'http://other.desk/news.json'

const edition = (symbol: string) => parseEdition({ subject: { symbol }, stories: [{ headline: 'h' }] })

const cache = (over: Partial<CachedEdition> = {}): CachedEdition => ({
  url: URL,
  etag: 'W/"one"',
  fetchedAt: 1000,
  edition: edition('SNDK'),
  ...over,
})

const ok = (symbol: string, etag: string | null): EditionFetch => ({
  status: 'ok',
  edition: edition(symbol),
  etag,
})

/** Feed a machine a list of events, in order. */
const run = (start: EditionMachine, ...events: EditionEvent[]): EditionMachine =>
  events.reduce(nextEditionState, start)

describe('nextEditionState — the starting point', () => {
  it('begins loading, with no URL read yet', () => {
    expect(INITIAL_EDITION_MACHINE).toEqual({ url: null, state: { status: 'loading' } })
  })
})

describe('nextEditionState — the URL', () => {
  it('shows the demo at once for an empty URL, with no network behind it', () => {
    const m = nextEditionState(INITIAL_EDITION_MACHINE, { type: 'url', url: '' })
    expect(m.url).toBe('')
    expect(m.state.status).toBe('ready')
    if (m.state.status !== 'ready') throw new Error('unreachable')
    expect(m.state.demo).toBe(true)
    expect(m.state.refreshing).toBe(false)
    expect(m.state.error).toBeNull()
    expect(m.state.cached.edition.subject.symbol).toBe('SNDK') // the bundled demo
    expect(m.state.cached.fetchedAt).toBe(0) // no server ever confirmed it: no freshness line
  })

  it('stays loading for a real URL until something arrives', () => {
    const m = nextEditionState(INITIAL_EDITION_MACHINE, { type: 'url', url: URL })
    expect(m).toEqual({ url: URL, state: { status: 'loading' } })
  })

  it('is a no-op when the URL has not actually changed', () => {
    const ready = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: cache() })
    expect(nextEditionState(ready, { type: 'url', url: URL })).toBe(ready)
  })

  it('drops everything on screen when the URL changes', () => {
    // The old desk's edition is not "today" for the new one, and showing it while the new one
    // loads would label another desk's paper with this one's name.
    const ready = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: cache() })
    expect(nextEditionState(ready, { type: 'url', url: OTHER })).toEqual({
      url: OTHER,
      state: { status: 'loading' },
    })
  })

  it('switches from a real URL to the demo when the URL is cleared', () => {
    const ready = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: cache() })
    const m = nextEditionState(ready, { type: 'url', url: '' })
    expect(m.state.status === 'ready' && m.state.demo).toBe(true)
  })
})

describe('nextEditionState — the cache', () => {
  it('shows a matching cache immediately, and says it is refreshing behind it', () => {
    const m = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: cache() })
    expect(m.state.status).toBe('ready')
    if (m.state.status !== 'ready') throw new Error('unreachable')
    expect(m.state.demo).toBe(false)
    expect(m.state.refreshing).toBe(true)
    expect(m.state.error).toBeNull()
    expect(m.state.cached.fetchedAt).toBe(1000)
  })

  it('stays loading when there is no cache', () => {
    const m = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: null })
    expect(m.state).toEqual({ status: 'loading' })
  })

  it('ignores a cache belonging to another desk', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache({ url: OTHER }) },
    )
    expect(m.state).toEqual({ status: 'loading' })
  })

  it('ignores a cache that lands after something is already on screen', () => {
    const ready = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'fetched', result: ok('SNDK', 'W/"two"'), url: URL, fetchedAt: 2000 },
    )
    expect(nextEditionState(ready, { type: 'cache', cached: cache({ fetchedAt: 1 }) })).toBe(ready)
  })
})

describe('nextEditionState — a fetch that succeeded', () => {
  it('replaces the edition, records the ETag, and stops refreshing', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache() },
      { type: 'fetched', result: ok('MU', 'W/"two"'), url: URL, fetchedAt: 5000 },
    )
    if (m.state.status !== 'ready') throw new Error('unreachable')
    expect(m.state.cached).toEqual({
      url: URL,
      etag: 'W/"two"',
      fetchedAt: 5000,
      edition: edition('MU'),
    })
    expect(m.state.refreshing).toBe(false)
    expect(m.state.error).toBeNull()
    expect(m.state.demo).toBe(false)
  })

  it('clears a banner left by an earlier failure', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache() },
      { type: 'failed', error: 'the network went away' },
      { type: 'refreshing' },
      { type: 'fetched', result: ok('SNDK', null), url: URL, fetchedAt: 6000 },
    )
    expect(m.state.status === 'ready' && m.state.error).toBeNull()
  })

  it('lands a first edition with no cache behind it', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: null },
      { type: 'fetched', result: ok('SNDK', 'W/"one"'), url: URL, fetchedAt: 900 },
    )
    expect(m.state.status).toBe('ready')
  })

  it('leaves the demo behind when a URL is set and the fetch lands', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: '' },
      { type: 'url', url: URL },
      { type: 'fetched', result: ok('SNDK', null), url: URL, fetchedAt: 10 },
    )
    expect(m.state.status === 'ready' && m.state.demo).toBe(false)
  })

  it('discards a response for a URL that is no longer the one on screen', () => {
    // A save in Settings while a fetch is in flight. The sequence counter in the hook stops most
    // of these; the reducer refusing them is what makes it impossible rather than unlikely.
    const loading = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'url', url: OTHER })
    expect(nextEditionState(loading, {
      type: 'fetched', result: ok('SNDK', null), url: URL, fetchedAt: 1,
    })).toBe(loading)
  })
})

describe('nextEditionState — a 304', () => {
  it('moves only the timestamp', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache() },
      { type: 'refreshing' },
      { type: 'fetched', result: { status: 'not_modified' }, url: URL, fetchedAt: 7000 },
    )
    if (m.state.status !== 'ready') throw new Error('unreachable')
    expect(m.state.cached.fetchedAt).toBe(7000)
    expect(m.state.cached.etag).toBe('W/"one"')
    expect(m.state.cached.edition).toEqual(edition('SNDK'))
    expect(m.state.refreshing).toBe(false)
    expect(m.state.error).toBeNull()
  })

  it('does nothing when there is nothing on screen for it to confirm', () => {
    const loading = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: null })
    expect(nextEditionState(loading, {
      type: 'fetched', result: { status: 'not_modified' }, url: URL, fetchedAt: 3,
    })).toBe(loading)
  })
})

describe('nextEditionState — a fetch that failed', () => {
  it('keeps the cached edition and raises a banner', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache() },
      { type: 'failed', error: "Couldn't reach the edition server." },
    )
    if (m.state.status !== 'ready') throw new Error('unreachable')
    expect(m.state.cached.edition).toEqual(edition('SNDK'))
    expect(m.state.error).toBe("Couldn't reach the edition server.")
    expect(m.state.refreshing).toBe(false)
  })

  it('is a whole-screen error only when there is nothing to show', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: null },
      { type: 'failed', error: 'nope' },
    )
    expect(m.state).toEqual({ status: 'error', error: 'nope' })
  })

  it('replaces the sentence on a second failure from the error screen', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'failed', error: 'first' },
      { type: 'failed', error: 'second' },
    )
    expect(m.state).toEqual({ status: 'error', error: 'second' })
  })

  it('recovers from the error screen when a retry lands', () => {
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'failed', error: 'first' },
      { type: 'fetched', result: ok('SNDK', null), url: URL, fetchedAt: 8000 },
    )
    expect(m.state.status).toBe('ready')
  })
})

describe('nextEditionState — refreshing', () => {
  it('marks a ready screen as refreshing without disturbing anything else', () => {
    const ready = run(INITIAL_EDITION_MACHINE, { type: 'url', url: URL }, { type: 'cache', cached: cache() })
    const spinning = nextEditionState(
      nextEditionState(ready, { type: 'fetched', result: { status: 'not_modified' }, url: URL, fetchedAt: 2 }),
      { type: 'refreshing' },
    )
    if (spinning.state.status !== 'ready') throw new Error('unreachable')
    expect(spinning.state.refreshing).toBe(true)
    expect(spinning.state.cached.edition).toEqual(edition('SNDK'))
  })

  it('leaves a standing banner up while the retry runs', () => {
    // Clearing it here would blink the banner out and back in on a retry that fails again.
    const m = run(
      INITIAL_EDITION_MACHINE,
      { type: 'url', url: URL },
      { type: 'cache', cached: cache() },
      { type: 'failed', error: 'gone' },
      { type: 'refreshing' },
    )
    expect(m.state.status === 'ready' && m.state.error).toBe('gone')
  })

  it('does nothing to a loading or an error screen', () => {
    const loading = nextEditionState(INITIAL_EDITION_MACHINE, { type: 'url', url: URL })
    expect(nextEditionState(loading, { type: 'refreshing' })).toBe(loading)
    const failed = nextEditionState(loading, { type: 'failed', error: 'x' })
    expect(nextEditionState(failed, { type: 'refreshing' })).toBe(failed)
  })
})

describe('demoCache', () => {
  it('is the bundled edition, stamped as never confirmed', () => {
    const c = demoCache()
    expect(c.url).toBe('')
    expect(c.etag).toBeNull()
    expect(c.fetchedAt).toBe(0)
    expect(c.edition.stories).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx jest src/lib/edition/useEdition.test.ts`
Expected: FAIL — `Cannot find module './useEdition'`.

- [ ] **Step 3: Write `useEdition.ts`**

Create `app/src/lib/edition/useEdition.ts`:

```ts
// The Today tab's data, and the rule that decides what is on screen.
//
// THE DECISION IS A PURE FUNCTION. `nextEditionState(prev, event)` takes the whole question —
// URL, cache, fetch outcome — and answers it with no clock, no storage and no React, so it has a
// test. There is no component test runner in this app, so anything left inside the component is
// untested by construction; the effects below are therefore deliberately dull, and every branch
// worth arguing about lives in the reducer.
//
// THE LOAD ORDER: read the stored news URL and the cache in parallel -> if the cache belongs to
// that URL, put it on screen at once and mark it refreshing -> fetch with the cached ETag. A
// success replaces the edition, a 304 moves only the timestamp, a failure keeps what is on
// screen and raises a banner. With no cache the screen is `loading` until the fetch settles.
// With no URL at all the demo goes up and no request is made.
//
// THERE IS NO INTERVAL. The edition changes about once a day and the desk answers a conditional
// GET with a 304 for the rest of it, so a poll loop here would be a request every thirty seconds
// to be told nothing for twenty-three hours. A focus refresh older than five minutes, plus
// pull-to-refresh, is the whole cadence.

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useFocusEffect } from 'expo-router'
import { getNewsUrl } from '../store'
import { editionClient, humanEditionError, type EditionFetch } from './client'
import { demoEdition } from './demo'
import { clearTilePngCache } from './photo'
import {
  readCachedEdition,
  setCurrentEdition,
  touchCachedEdition,
  writeCachedEdition,
  type CachedEdition,
} from './store'

/** How stale the thing on screen has to be before a return to the tab quietly re-checks it. */
export const FOCUS_REFRESH_AFTER_MS = 5 * 60_000

export type EditionState =
  | { status: 'loading' }
  | {
      status: 'ready'
      cached: CachedEdition
      /** The bundled edition is on screen because this phone has no URL. */
      demo: boolean
      refreshing: boolean
      /** A failed refresh, with content still showing. The banner, never the whole screen. */
      error: string | null
    }
  | { status: 'error'; error: string }

/**
 * The state plus the URL it is about.
 *
 * The URL is not part of `EditionState` because the screen never renders it, but both of the
 * reducer's guards are questions about it — "is this cache this desk's?" and "is this response
 * still the one we asked for?" — and answering them anywhere else means answering them twice.
 */
export interface EditionMachine {
  /** `null` = the disk has not answered yet. `''` = there is no URL, which means the demo. */
  url: string | null
  state: EditionState
}

export type EditionEvent =
  | { type: 'url'; url: string }
  | { type: 'cache'; cached: CachedEdition | null }
  | { type: 'fetched'; result: EditionFetch; url: string; fetchedAt: number }
  | { type: 'failed'; error: string }
  | { type: 'refreshing' }

export const INITIAL_EDITION_MACHINE: EditionMachine = { url: null, state: { status: 'loading' } }

/**
 * The demo, dressed as a cache entry so every consumer sees one shape.
 *
 * `fetchedAt: 0` is load-bearing: `freshnessLabel` answers null for it, so the demo carries no
 * "Updated 3h ago" line about a fetch that never happened.
 */
export function demoCache(): CachedEdition {
  return { url: '', etag: null, fetchedAt: 0, edition: demoEdition() }
}

export function nextEditionState(prev: EditionMachine, event: EditionEvent): EditionMachine {
  switch (event.type) {
    case 'url': {
      if (event.url === prev.url) return prev
      // No URL means the demo, at once and with no request. An unconfigured phone is a complete
      // configuration, exactly as an unconfigured board is.
      if (event.url === '') {
        return {
          url: '',
          state: { status: 'ready', cached: demoCache(), demo: true, refreshing: false, error: null },
        }
      }
      // A different desk. Whatever is on screen belongs to the old one and is not today's paper
      // for the new one.
      return { url: event.url, state: { status: 'loading' } }
    }

    case 'cache': {
      // Only ever fills an empty screen. A cache that lands after a fetch already did would put
      // older content over newer.
      if (prev.state.status !== 'loading') return prev
      if (event.cached === null || prev.url === null || event.cached.url !== prev.url) return prev
      return {
        ...prev,
        state: {
          status: 'ready',
          cached: event.cached,
          demo: false,
          refreshing: true,
          error: null,
        },
      }
    }

    case 'fetched': {
      // The URL moved while this was in flight.
      if (event.url !== prev.url) return prev
      if (event.result.status === 'ok') {
        return {
          ...prev,
          state: {
            status: 'ready',
            cached: {
              url: event.url,
              etag: event.result.etag,
              fetchedAt: event.fetchedAt,
              edition: event.result.edition,
            },
            demo: false,
            refreshing: false,
            error: null,
          },
        }
      }
      // A 304 confirms content. With nothing on screen there is nothing to confirm — and this
      // cannot happen anyway, because no ETag is sent without a cache behind it.
      if (prev.state.status !== 'ready') return prev
      return {
        ...prev,
        state: {
          ...prev.state,
          cached: { ...prev.state.cached, fetchedAt: event.fetchedAt },
          refreshing: false,
          error: null,
        },
      }
    }

    case 'failed': {
      // Content beats an error card: a stale front page is still the company's day, and the
      // banner says the refresh failed. Only a first load with nothing behind it takes the screen.
      if (prev.state.status === 'ready') {
        return { ...prev, state: { ...prev.state, refreshing: false, error: event.error } }
      }
      return { ...prev, state: { status: 'error', error: event.error } }
    }

    case 'refreshing': {
      if (prev.state.status !== 'ready') return prev
      // A standing banner stays up while the retry runs. Clearing it here would blink it out and
      // straight back in on a retry that fails the same way.
      return { ...prev, state: { ...prev.state, refreshing: true } }
    }
  }
}

export function useEdition(): {
  state: EditionState
  refresh: (opts?: { fresh?: boolean }) => Promise<void>
} {
  const [machine, dispatch] = useReducer(nextEditionState, INITIAL_EDITION_MACHINE)

  // A synchronous mirror, because the async passes below have to read the current URL and ETag
  // and a closed-over `machine` would be the one from the render that started them.
  const machineRef = useRef(machine)
  machineRef.current = machine

  // Discards a response that lands after the URL changed. The reducer refuses it too; this stops
  // the write to disk, which the reducer cannot.
  const seqRef = useRef(0)

  const runFetch = useCallback(async (url: string, etag: string | null) => {
    const seq = ++seqRef.current
    try {
      const result = await editionClient.fetch(url, etag)
      if (seqRef.current !== seq) return
      const fetchedAt = Date.now()
      if (result.status === 'ok') {
        const before = machineRef.current.state
        const previous = before.status === 'ready' ? before.cached.edition : null
        // Tile ids are the producer's and are not unique across days, so a picture cache that
        // outlived its edition could hand today's page yesterday's photograph under the same id.
        if (previous === null || previous.generatedAt !== result.edition.generatedAt) {
          clearTilePngCache()
        }
        await writeCachedEdition({ url, etag: result.etag, fetchedAt, edition: result.edition })
      } else {
        await touchCachedEdition(fetchedAt)
      }
      if (seqRef.current !== seq) return
      dispatch({ type: 'fetched', result, url, fetchedAt })
    } catch (e) {
      if (seqRef.current !== seq) return
      dispatch({ type: 'failed', error: humanEditionError(e) })
    }
  }, [])

  /** Adopt a URL: put the demo up, or show any matching cache and go and check it. */
  const adopt = useCallback(
    async (url: string) => {
      dispatch({ type: 'url', url })
      if (url === '') {
        // The detail route reads the current edition out of the store rather than off a prop, so
        // the demo has to be published there too or a tap opens nothing.
        setCurrentEdition(demoCache())
        return
      }
      const cached = await readCachedEdition()
      dispatch({ type: 'cache', cached })
      await runFetch(url, cached !== null && cached.url === url ? cached.etag : null)
    },
    [runFetch],
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      const url = await getNewsUrl()
      if (!alive) return
      await adopt(url ?? '')
    })()
    return () => {
      alive = false
    }
  }, [adopt])

  // On return to the tab: pick up a URL changed in Settings, and quietly re-check anything older
  // than five minutes. Silent — no spinner — because nothing was asked for.
  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const url = (await getNewsUrl()) ?? ''
        const current = machineRef.current
        if (url !== current.url) {
          await adopt(url)
          return
        }
        if (url === '') return
        const state = current.state
        if (state.status !== 'ready') return
        if (Date.now() - state.cached.fetchedAt < FOCUS_REFRESH_AFTER_MS) return
        await runFetch(url, state.cached.etag)
      })()
    }, [adopt, runFetch]),
  )

  const refresh = useCallback(
    async (opts: { fresh?: boolean } = {}) => {
      const current = machineRef.current
      const url = current.url
      // Nothing to refresh against the demo; the bundled edition is the whole of it.
      if (url === null || url === '') return
      dispatch({ type: 'refreshing' })
      const state = current.state
      // The ETag goes even on an explicit pull-to-refresh: a 304 is the honest answer to "is this
      // still current", and it is the answer that costs one round trip instead of twenty KB.
      // `fresh` is accepted for the caller's clarity and changes nothing about the request.
      void opts.fresh
      await runFetch(url, state.status === 'ready' ? state.cached.etag : null)
    },
    [runFetch],
  )

  return { state: machine.state, refresh }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd app && npx jest src/lib/edition/useEdition.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole library and typecheck**

Run: `cd app && npx jest src/lib/ && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/edition/useEdition.ts app/src/lib/edition/useEdition.test.ts
git commit -m "feat(app): cache-first edition loading, with the decision as a pure reducer"
```

---

### Task 8: The tile components

**Files:**
- Modify: `app/src/theme.ts` (add two entries to the `type` ramp — nothing else changes)
- Create: `app/src/components/edition/tone.ts`
- Create: `app/src/components/edition/Masthead.tsx`
- Create: `app/src/components/edition/ChipRow.tsx`
- Create: `app/src/components/edition/Masonry.tsx`
- Create: `app/src/components/edition/EditionTile.tsx`
- Create: `app/src/components/edition/tiles/StoryTile.tsx`
- Create: `app/src/components/edition/tiles/RangeTile.tsx`
- Create: `app/src/components/edition/tiles/ChartTile.tsx`
- Create: `app/src/components/edition/tiles/PhotoTile.tsx`
- Create: `app/src/components/edition/tiles/FiguresTile.tsx`
- Create: `app/src/components/edition/tiles/BriefsTile.tsx`
- Create: `app/src/components/edition/tiles/PeersTile.tsx`
- Create: `app/src/components/edition/tiles/TableTile.tsx`
- Create: `app/src/components/edition/tiles/TapeTile.tsx`
- Test: **none.** There is no component test runner in this app and the spec does not add one.
  `npm run typecheck` is the gate for this task, and every decision worth testing is already a
  pure function in Tasks 1–7.

**Interfaces:**

- Consumes (Tasks 2, 3, 4, 6, and the existing theme):

```ts
// lib/edition/tiles
export const TILE_PADDING: number   // 14
export type Chip = 'all' | 'stories' | 'numbers' | 'accounts' | 'photos'
export const CHIPS: ReadonlyArray<{ id: Chip; label: string }>
export type Tile =
  | { kind: 'story';   id: string; story: EditionStory; lead: boolean }
  | { kind: 'range';   id: string; subject: EditionSubject }
  | { kind: 'chart';   id: string; chart: EditionChart }
  | { kind: 'photo';   id: string; photo: EditionPhoto }
  | { kind: 'figures'; id: string; group: string; figures: EditionFigure[] }
  | { kind: 'briefs';  id: string; briefs: EditionBrief[] }
  | { kind: 'peers';   id: string; peers: EditionPeer[] }
  | { kind: 'table';   id: string; table: EditionTable }
  | { kind: 'tape';    id: string; indices: EditionIndex[] }
export interface PlacedTile { tile: Tile; height: number }
export function splitColumns(tiles: Tile[], colWidth: number, columns?: number): PlacedTile[][]
// lib/edition/format
export type ChangeTone = 'up' | 'down' | 'flat'
export function formatPrice(n: number | null | undefined): string
export function formatPct(n: number | null | undefined): string
export function changeTone(n: number | null | undefined): ChangeTone
export function changeArrow(n: number | null | undefined): '▲' | '▼' | ''
export const DASH: string   // '—'
// lib/edition/client
export const editionClient: { fetchTile(url: string, w: number, h: number): Promise<Uint8Array> }
export function tileUrl(newsUrl: string, id: string): string
// lib/edition/photo
export function decodeTile(bytes: Uint8Array, w: number, h: number): { pngBase64: string; width: number; height: number }
export function getCachedTilePng(url: string): string | null
export function putCachedTilePng(url: string, pngBase64: string): void
// lib/edition/types — the interfaces listed in Task 1's Interfaces block
// theme.ts — colors, fonts, layout, radius, space, tabular, type
```

- Produces (Task 9 mounts all of these):

```ts
// components/edition/tone.ts
export function toneTextColor(t: ChangeTone): string
export function toneGraphicsColor(t: ChangeTone): string
// components/edition/Masthead.tsx
export function Masthead(props: {
  edition: Edition
  demo: boolean
  freshness: string | null
  error: string | null
  onRetry: () => void
  onPressSymbol: () => void
}): JSX.Element
// components/edition/ChipRow.tsx
export function ChipRow(props: { chips: Chip[]; selected: Chip; onSelect: (c: Chip) => void }): JSX.Element
// components/edition/Masonry.tsx
export function Masonry(props: {
  tiles: Tile[]
  colWidth: number
  newsUrl: string
  gutter?: number
  columns?: number
  onPress: (t: Tile) => void
}): JSX.Element
// components/edition/EditionTile.tsx
export function EditionTile(props: {
  tile: Tile
  width: number
  height: number
  newsUrl: string
  onPress: () => void
}): JSX.Element
export function tileLabel(t: Tile): string      // the accessibility label
// each tiles/*.tsx exports one component taking { tile, width, height } (PhotoTile also newsUrl)
```

**Why `tone.ts` exists.** `theme.ts` holds four direction colours in two duties — `up`/`down` for
text, `upBright`/`downBright` for strokes and fills — and five components need the mapping from a
`ChangeTone`. Two hand-written copies of it is two places for a chart stroke and its label to end
up different greens. It lives under `components/` and not `lib/` because a colour is a theme fact,
and `lib/edition` holds no colours by design.

- [ ] **Step 1: Add the two type tokens**

In `app/src/theme.ts`, inside the `export const type = { … } as const` object, add these two
entries after `label`:

```ts
  /**
   * The tile headline. This design has no photograph on a story tile, so the headline at 22/26
   * is what carries the visual weight a picture would — which is why it is a token of its own
   * rather than `heading` reused a size down.
   */
  pinHeadline: {
    fontFamily: fonts.extrabold,
    fontSize: 22,
    lineHeight: 26,
    letterSpacing: -0.4,
    color: colors.text,
  } as TextStyle,
  /** The deck under a tile headline: the sentence that says why the headline matters. */
  pinDeck: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 19,
    letterSpacing: 0,
    color: colors.textDim,
  } as TextStyle,
```

Nothing else in `theme.ts` changes. Note that neither token sets `fontWeight` — the weight is in
the face, and a `fontWeight` beside an Inter `fontFamily` drops Android to the system font.

- [ ] **Step 2: Write `tone.ts`**

Create `app/src/components/edition/tone.ts`:

```ts
// A direction, turned into the right colour for the job.
//
// theme.ts keeps two greens and two reds on purpose: the TEXT pair (`up`/`down`) is darkened to
// clear 4.5:1 on white and on the canvas, and the GRAPHICS pair (`upBright`/`downBright`) is the
// saturated one, which only has to clear 3:1 because it is a stroke and not a sentence. Picking
// the wrong one is not a style slip — the text pair on a 1.5 px sparkline is muddy, and the
// graphics pair on a 13 px label fails contrast.
//
// `flat` is deliberately grey in both duties. Zero is not a small rise.

import { colors } from '../../theme'
import { type ChangeTone } from '../../lib/edition/format'

/** For anything the reader reads: a percentage, a delta, an arrow beside one. */
export function toneTextColor(t: ChangeTone): string {
  return t === 'up' ? colors.up : t === 'down' ? colors.down : colors.textDim
}

/** For anything drawn: a sparkline, a bar, a rule, a fill. */
export function toneGraphicsColor(t: ChangeTone): string {
  return t === 'up' ? colors.upBright : t === 'down' ? colors.downBright : colors.textDim
}
```

- [ ] **Step 3: Write `EditionTile.tsx` — the chrome and the press feedback**

Create `app/src/components/edition/EditionTile.tsx`:

```tsx
import { useRef } from 'react'
import { Animated, Pressable, StyleSheet } from 'react-native'
import { colors, radius } from '../../theme'
import { TILE_PADDING, type Tile } from '../../lib/edition/tiles'
import { StoryTile } from './tiles/StoryTile'
import { RangeTile } from './tiles/RangeTile'
import { ChartTile } from './tiles/ChartTile'
import { PhotoTile } from './tiles/PhotoTile'
import { FiguresTile } from './tiles/FiguresTile'
import { BriefsTile } from './tiles/BriefsTile'
import { PeersTile } from './tiles/PeersTile'
import { TableTile } from './tiles/TableTile'
import { TapeTile } from './tiles/TapeTile'

/**
 * One tile: the surface, the radius, the press feedback, and a switch to the body for its kind.
 *
 * NO BORDER, NO SHADOW, NO GRADIENT. The separation is the lavender canvas behind the white
 * surface, which is already a clear edge; a stroke or a lift on top of it is the "card" reflex
 * this design is specifically not, and at two columns of five to fifteen tiles it turns a page
 * into a pile of receipts.
 *
 * The height comes in as a prop and is never measured. `estimateTileHeight` decided it before
 * anything rendered, which is what stops the page reflowing and what lets a return from the
 * detail land on the same scroll position.
 */
export function EditionTile({
  tile,
  width,
  height,
  newsUrl,
  onPress,
}: {
  tile: Tile
  width: number
  height: number
  /** For PhotoTile, which resolves its own bytes beside the payload. */
  newsUrl: string
  onPress: () => void
}) {
  // RN core Animated on the native driver — the spec forbids reanimated, and a transform-only
  // scale is exactly what the native driver does well.
  const scale = useRef(new Animated.Value(1)).current
  const to = (toValue: number) =>
    Animated.timing(scale, { toValue, duration: 150, useNativeDriver: true }).start()

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tileLabel(tile)}
      onPressIn={() => to(0.97)}
      onPressOut={() => to(1)}
      onPress={onPress}
    >
      <Animated.View style={[styles.tile, { width, height, transform: [{ scale }] }]}>
        {body(tile, width, height, newsUrl)}
      </Animated.View>
    </Pressable>
  )
}

function body(tile: Tile, width: number, height: number, newsUrl: string) {
  switch (tile.kind) {
    case 'story':
      return <StoryTile tile={tile} width={width} height={height} />
    case 'range':
      return <RangeTile tile={tile} width={width} height={height} />
    case 'chart':
      return <ChartTile tile={tile} width={width} height={height} />
    case 'photo':
      return <PhotoTile tile={tile} width={width} height={height} newsUrl={newsUrl} />
    case 'figures':
      return <FiguresTile tile={tile} width={width} height={height} />
    case 'briefs':
      return <BriefsTile tile={tile} width={width} height={height} />
    case 'peers':
      return <PeersTile tile={tile} width={width} height={height} />
    case 'table':
      return <TableTile tile={tile} width={width} height={height} />
    case 'tape':
      return <TapeTile tile={tile} width={width} height={height} />
  }
}

/**
 * What a screen reader says for a tile. It names the content, not the shape: "Chart, PRICE, 6M"
 * rather than "chart tile", because the reader is choosing between tiles and the kind alone does
 * not distinguish two of them.
 */
export function tileLabel(t: Tile): string {
  switch (t.kind) {
    case 'story':
      return t.story.headline
    case 'range':
      return `Range for ${t.subject.symbol}`
    case 'chart':
      return `Chart, ${t.chart.label}, ${t.chart.span}`
    case 'photo':
      return t.photo.caption !== '' ? `Photograph. ${t.photo.caption}` : 'Photograph'
    case 'figures':
      return `${t.group === '' ? 'Figures' : t.group}, ${t.figures.length} figures`
    case 'briefs':
      return `${t.briefs.length} briefs`
    case 'peers':
      return `${t.peers.length} peers`
    case 'table':
      return t.table.title
    case 'tape':
      return 'The tape'
  }
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: TILE_PADDING,
    // Clips a photo and a long body to the radius; also stops a mis-estimated height from
    // spilling one tile's last line over the tile below it.
    overflow: 'hidden',
  },
})
```

- [ ] **Step 4: Write `Masonry.tsx`**

Create `app/src/components/edition/Masonry.tsx`:

```tsx
import { StyleSheet, View } from 'react-native'
import { EditionTile } from './EditionTile'
import { splitColumns, type Tile } from '../../lib/edition/tiles'

/**
 * Two columns inside one ScrollView, filled shortest-first.
 *
 * Hand-rolled, because `FlatList numColumns` aligns rows — it cannot stagger, which is the whole
 * point — and FlashList is a dependency this app does not take. There is nothing to virtualise:
 * an edition is five to fifteen tiles, and every height is known before the first frame, so the
 * whole page can be laid out in one pass with no measurement and no reflow.
 */
export function Masonry({
  tiles,
  colWidth,
  newsUrl,
  gutter = 12,
  columns = 2,
  onPress,
}: {
  tiles: Tile[]
  colWidth: number
  newsUrl: string
  gutter?: number
  columns?: number
  onPress: (t: Tile) => void
}) {
  const placed = splitColumns(tiles, colWidth, columns)
  return (
    <View style={[styles.row, { gap: gutter }]}>
      {placed.map((column, i) => (
        <View key={i} style={[styles.column, { width: colWidth, gap: gutter }]}>
          {column.map((p) => (
            <EditionTile
              key={p.tile.id}
              tile={p.tile}
              width={colWidth}
              height={p.height}
              newsUrl={newsUrl}
              onPress={() => onPress(p.tile)}
            />
          ))}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  column: {
    flexDirection: 'column',
  },
})
```

- [ ] **Step 5: Write `ChipRow.tsx`**

Create `app/src/components/edition/ChipRow.tsx`:

```tsx
import { ScrollView, StyleSheet } from 'react-native'
import { Chip as Pill } from '../Chip'
import { CHIPS, type Chip } from '../../lib/edition/tiles'
import { layout, space } from '../../theme'

/**
 * The filter row, borrowed from YouTube's: it narrows a heterogeneous feed IN PLACE rather than
 * sending the reader to another screen. Only chips with tiles behind them are passed in, so a
 * control here always does something.
 *
 * It reuses the app's existing `Chip`, which already owns the selection idiom (the accentDim
 * wash) that `SectionTabs` and `TimeframePills` use. A second pill style would make selection
 * mean two things in one app.
 */
export function ChipRow({
  chips,
  selected,
  onSelect,
}: {
  chips: Chip[]
  selected: Chip
  onSelect: (c: Chip) => void
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {CHIPS.filter((c) => chips.includes(c.id)).map((c) => (
        <Pill key={c.id} label={c.label} active={c.id === selected} onPress={() => onSelect(c.id)} />
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: layout.gutter,
    paddingVertical: space.sm,
  },
})
```

- [ ] **Step 6: Write `Masthead.tsx`**

Create `app/src/components/edition/Masthead.tsx`:

```tsx
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, fonts, layout, radius, space, tabular, type } from '../../theme'
import { changeArrow, changeTone, formatPct, formatPrice } from '../../lib/edition/format'
import { toneTextColor } from './tone'
import { type Edition } from '../../lib/edition/types'

/**
 * The top of the page: who this edition is about, what the price did, how fresh it is, and — only
 * when something actually failed — what failed.
 *
 * The company name is the headline of the whole tab, because every edition is about exactly one
 * listed company. Tapping the symbol pushes the Markets detail for it, which is the one place in
 * this app where the edition and the watchlist meet.
 *
 * The failure banner takes `warn`, never direction red. Red on this screen means a price fell;
 * spending it on "the server did not answer" would put a market signal on a network problem.
 */
export function Masthead({
  edition,
  demo,
  freshness,
  error,
  onRetry,
  onPressSymbol,
}: {
  edition: Edition
  demo: boolean
  freshness: string | null
  /** A failed refresh with content still on screen. Null when nothing failed. */
  error: string | null
  onRetry: () => void
  onPressSymbol: () => void
}) {
  const s = edition.subject
  const tone = changeTone(s.changePct)
  const arrow = changeArrow(s.changePct)

  return (
    <View style={styles.root}>
      <Text style={type.headingLg} numberOfLines={2}>
        {s.name !== '' ? s.name : s.symbol}
      </Text>

      <Pressable accessibilityRole="button" onPress={onPressSymbol} hitSlop={6} style={styles.symbolRow}>
        <Text style={styles.symbol}>{s.symbol}</Text>
        {s.exchange !== '' ? <Text style={type.caption}>{s.exchange}</Text> : null}
      </Pressable>

      <View style={styles.priceRow}>
        <Text style={[styles.price, tabular]} numberOfLines={1}>
          {formatPrice(s.last)}
        </Text>
        <Text style={[styles.change, tabular, { color: toneTextColor(tone) }]} numberOfLines={1}>
          {arrow !== '' ? `${arrow} ` : ''}
          {formatPct(s.changePct)}
        </Text>
      </View>

      {edition.dateline !== '' ? (
        <Text style={type.caption} numberOfLines={1}>
          {edition.dateline}
        </Text>
      ) : null}
      {edition.session !== '' ? (
        <Text style={type.caption} numberOfLines={1}>
          {edition.session}
        </Text>
      ) : null}

      {/* The demo chip and the freshness line are mutually exclusive by construction: the demo's
          fetchedAt is 0, so freshnessLabel answers null for it. */}
      {demo ? (
        <View style={styles.demoChip}>
          <Text style={styles.demoText}>Demo edition</Text>
        </View>
      ) : null}
      {freshness !== null ? <Text style={styles.freshness}>{freshness}</Text> : null}

      {error !== null ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={8}>
            <Text style={styles.retry}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.sm,
    gap: space.xs,
  },
  symbolRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
  },
  symbol: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.accent,
    letterSpacing: 0.4,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.md,
    paddingTop: space.xs,
  },
  price: {
    ...type.display,
    fontSize: 38,
    lineHeight: 44,
  },
  change: {
    fontFamily: fonts.semibold,
    fontSize: 17,
  },
  freshness: {
    ...type.caption,
    paddingTop: space.xs,
  },
  demoChip: {
    alignSelf: 'flex-start',
    marginTop: space.xs,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.accentDim,
  },
  demoText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.accent,
  },
  banner: {
    marginTop: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    backgroundColor: colors.warnBg,
    borderRadius: radius.md,
    padding: space.md,
  },
  bannerText: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 18,
    color: colors.warn,
  },
  retry: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.warn,
  },
})
```

- [ ] **Step 7: Write the four text-led tile bodies**

Create `app/src/components/edition/tiles/StoryTile.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { colors, space, type } from '../../../theme'
import { type Tile } from '../../../lib/edition/tiles'

/**
 * A story, with no picture — TYPE IS THE IMAGE here. The lead's headline at 22/26 is what carries
 * the weight a photograph would on a page that had one, which is why the lead tile is the only
 * one taller than it is wide.
 *
 * The kicker renders exactly as the producer wrote it, in `type.caption` and in sentence case —
 * it is CONTENT. It is not `type.label`: an all-caps eyebrow on every tile is one of the five
 * anti-patterns this design names, and it makes a feed look like a settings screen.
 *
 * Everything clamps with `numberOfLines` rather than resizing the tile. The height was decided
 * before this rendered and the body adapts to it; a tile that grew to fit its text would reflow
 * the column beside it.
 */
export function StoryTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'story' }>
  width: number
  height: number
}) {
  const { story, lead } = tile
  return (
    <View style={styles.root}>
      {story.kicker !== '' ? (
        <Text style={type.caption} numberOfLines={1}>
          {story.kicker}
        </Text>
      ) : null}
      <Text style={lead ? type.pinHeadline : styles.headlineSm} numberOfLines={lead ? 4 : 3}>
        {story.headline}
      </Text>
      {story.deck !== '' ? (
        <Text style={type.pinDeck} numberOfLines={2}>
          {story.deck}
        </Text>
      ) : null}
      {/* Only the lead has room for body copy, and `flex: 1` lets it take exactly whatever the
          estimator left over — the copy fills the tile instead of the tile shrinking to the copy. */}
      {lead && story.body !== '' ? (
        <Text style={styles.body} numberOfLines={6}>
          {story.body}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: space.xs,
  },
  headlineSm: {
    ...type.pinHeadline,
    fontSize: 17,
    lineHeight: 21,
    letterSpacing: -0.2,
  },
  body: {
    ...type.caption,
    flex: 1,
    color: colors.textDim,
  },
})
```

Create `app/src/components/edition/tiles/BriefsTile.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, space, type } from '../../../theme'
import { type Tile } from '../../../lib/edition/tiles'

const SHOWN = 3
/** Must match `estimateTileHeight`'s 56 for a briefs row. Change both or the last one clips. */
const ROW = 56

/**
 * Up to three briefs, then a count of the rest.
 *
 * The date and the kicker sit at opposite ends of one row rather than being joined with a middle
 * dot: "AUG 13 · GUIDANCE" is the dot-separated meta line this design bans, and two facts pushed
 * apart read faster than two facts glued together.
 */
export function BriefsTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'briefs' }>
  width: number
  height: number
}) {
  const rest = tile.briefs.length - SHOWN
  return (
    <View style={styles.root}>
      <Text style={styles.head}>Briefs</Text>
      {tile.briefs.slice(0, SHOWN).map((b, i) => (
        <View key={`${b.date}:${i}`} style={styles.row}>
          <View style={styles.meta}>
            {b.date !== '' ? <Text style={type.caption}>{b.date}</Text> : null}
            {b.kicker !== '' ? (
              <Text style={type.caption} numberOfLines={1}>
                {b.kicker}
              </Text>
            ) : null}
          </View>
          <Text style={styles.text} numberOfLines={2}>
            {b.text}
          </Text>
        </View>
      ))}
      {rest > 0 ? <Text style={styles.more}>{`+${rest} more`}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
    ...type.headingSm,
    height: 22,
  },
  row: {
    height: ROW,
    justifyContent: 'center',
  },
  meta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  text: {
    ...type.caption,
    color: colors.text,
  },
  more: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    lineHeight: 20,
    color: colors.accent,
  },
})
```

Create `app/src/components/edition/tiles/FiguresTile.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, space, tabular, type } from '../../../theme'
import { type Tile } from '../../../lib/edition/tiles'
import { changeArrow, changeTone, formatPct } from '../../../lib/edition/format'
import { toneTextColor } from '../tone'

const SHOWN = 4
/** Must match `estimateTileHeight`'s 28 for a figures row. */
const ROW = 28

/**
 * One group of figures — VALUATION, PER SHARE, THE STREET — as label/value rows.
 *
 * The value is rendered VERBATIM. The producer already formatted it ("$241.6B", "22.38x"), and
 * re-deriving it here would give the phone and the sheet two different-looking answers to the
 * same question. It still gets `tabular`, because a figure that changes tomorrow should not
 * shift the column it sits in.
 */
export function FiguresTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'figures' }>
  width: number
  height: number
}) {
  const rest = tile.figures.length - SHOWN
  return (
    <View style={styles.root}>
      <Text style={styles.head} numberOfLines={1}>
        {tile.group !== '' ? tile.group : 'Figures'}
      </Text>
      {tile.figures.slice(0, SHOWN).map((f, i) => {
        const tone = changeTone(f.changePct)
        const arrow = changeArrow(f.changePct)
        return (
          <View key={`${f.label}:${i}`} style={styles.row}>
            <Text style={styles.label} numberOfLines={1}>
              {f.label}
            </Text>
            <View style={styles.valueBox}>
              <Text style={[f.emph ? styles.valueEmph : styles.value, tabular]} numberOfLines={1}>
                {f.value}
              </Text>
              {f.changePct !== null ? (
                <Text style={[styles.change, tabular, { color: toneTextColor(tone) }]} numberOfLines={1}>
                  {arrow !== '' ? `${arrow} ` : ''}
                  {formatPct(f.changePct)}
                </Text>
              ) : null}
            </View>
          </View>
        )
      })}
      {rest > 0 ? <Text style={styles.more}>{`+${rest} more`}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
    ...type.headingSm,
    height: 22,
  },
  row: {
    height: ROW,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  label: {
    ...type.caption,
    flexShrink: 1,
  },
  valueBox: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  value: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  valueEmph: {
    fontFamily: fonts.extrabold,
    fontSize: 15,
    color: colors.text,
  },
  change: {
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
  more: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    lineHeight: 20,
    color: colors.accent,
  },
})
```

Create `app/src/components/edition/tiles/PeersTile.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, space, tabular, type } from '../../../theme'
import { type Tile } from '../../../lib/edition/tiles'
import { changeArrow, changeTone, formatPct, formatPrice } from '../../../lib/edition/format'
import { toneTextColor } from '../tone'

const SHOWN = 6
/** Must match `estimateTileHeight`'s 28 for a peers row. */
const ROW = 28

/**
 * The company against its peers. The subject's own row is set in the semibold face — it is the
 * one the reader is here for, and finding it by reading five symbols is work the tile can do.
 * That emphasis is weight, not colour: colour on this row would have to mean direction, and the
 * subject being the subject is not a direction.
 */
export function PeersTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'peers' }>
  width: number
  height: number
}) {
  return (
    <View style={styles.root}>
      <Text style={styles.head}>Peers</Text>
      {tile.peers.slice(0, SHOWN).map((p) => {
        const tone = changeTone(p.changePct)
        const arrow = changeArrow(p.changePct)
        return (
          <View key={p.symbol} style={styles.row}>
            <Text style={p.isSubject ? styles.symbolSubject : styles.symbol} numberOfLines={1}>
              {p.symbol}
            </Text>
            <Text style={[styles.last, tabular]} numberOfLines={1}>
              {formatPrice(p.last)}
            </Text>
            <Text style={[styles.change, tabular, { color: toneTextColor(tone) }]} numberOfLines={1}>
              {arrow !== '' ? `${arrow} ` : ''}
              {formatPct(p.changePct)}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
    ...type.headingSm,
    height: 22,
  },
  row: {
    height: ROW,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  symbol: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textDim,
    width: 56,
  },
  symbolSubject: {
    fontFamily: fonts.extrabold,
    fontSize: 13,
    color: colors.text,
    width: 56,
  },
  last: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text,
    textAlign: 'right',
  },
  change: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    width: 62,
    textAlign: 'right',
  },
})
```

- [ ] **Step 8: Write the four number-led tile bodies**

Create `app/src/components/edition/tiles/RangeTile.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, radius, space, tabular, type } from '../../../theme'
import { type Tile } from '../../../lib/edition/tiles'
import { DASH, formatPrice } from '../../../lib/edition/format'

/**
 * Where today's price sits in today's range, and in the year's.
 *
 * The position mark is `colors.text` on a `surfaceAlt` track — INK, not green or red. A position
 * inside a range is neither a direction nor a series, so it takes neither colour; that is the
 * firmware's rule for a hero figure's range bar, carried over unchanged.
 */
export function RangeTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'range' }>
  width: number
  height: number
}) {
  const s = tile.subject
  return (
    <View style={styles.root}>
      <Text style={styles.head}>Range</Text>

      <Track low={s.wk52Low} high={s.wk52High} at={s.last} caption="52 weeks" />

      <View style={styles.grid}>
        <Stat label="Open" value={s.open} />
        <Stat label="Prev close" value={s.prevClose} />
        <Stat label="High" value={s.high} />
        <Stat label="Low" value={s.low} />
      </View>
    </View>
  )
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <View style={styles.stat}>
      <Text style={type.caption} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.statValue, tabular]} numberOfLines={1}>
        {formatPrice(value)}
      </Text>
    </View>
  )
}

function Track({
  low,
  high,
  at,
  caption,
}: {
  low: number | null
  high: number | null
  at: number | null
  caption: string
}) {
  // Without both ends and a position there is no track to draw — the row keeps its height and
  // says what is missing, so the tile does not change shape when a field is absent.
  const drawable = low !== null && high !== null && at !== null && high > low
  const pct = drawable ? Math.min(1, Math.max(0, (at - low) / (high - low))) : 0
  return (
    <View style={styles.trackBox}>
      <View style={styles.trackRow}>
        <Text style={[styles.end, tabular]} numberOfLines={1}>
          {formatPrice(low)}
        </Text>
        <View style={styles.track}>
          {drawable ? <View style={[styles.mark, { left: `${pct * 100}%` }]} /> : null}
        </View>
        <Text style={[styles.end, tabular]} numberOfLines={1}>
          {formatPrice(high)}
        </Text>
      </View>
      <Text style={type.caption}>{drawable ? caption : `${caption} ${DASH}`}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
    ...type.headingSm,
    height: 22,
  },
  trackBox: {
    gap: 4,
    paddingVertical: space.xs,
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  track: {
    flex: 1,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    justifyContent: 'center',
  },
  mark: {
    position: 'absolute',
    width: 3,
    height: 12,
    marginLeft: -1.5,
    borderRadius: 2,
    backgroundColor: colors.text,
  },
  end: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textDim,
  },
  grid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'flex-end',
  },
  stat: {
    width: '50%',
    paddingVertical: 4,
  },
  statValue: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
})
```

Create `app/src/components/edition/tiles/ChartTile.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { Sparkline } from '../../Sparkline'
import { colors, space, type } from '../../../theme'
import { TILE_PADDING, type Tile } from '../../../lib/edition/tiles'
import { changeTone } from '../../../lib/edition/format'
import { toneGraphicsColor } from '../tone'

/**
 * One chart, small.
 *
 * The stroke colour comes from the SERIES' OWN DIRECTION — its last close against its first —
 * and takes the graphics pair (`upBright`/`downBright`), not the text pair. That is the only
 * colour on this tile: a chart's axis, its label and its span are ink.
 *
 * A `bar` chart draws bars in `colors.navy`; everything else draws a polyline. One series is
 * ink-or-a-filled-control, so there is no series identity to encode here and nothing to look up
 * in `ui_series_t`'s app equivalent — that question only arises with two series in one graphic,
 * which the phone does not draw in v1. A `candle` renders as its closes for the same reason:
 * four series in a 128 px box is a smudge, and the detail page shows the same line larger.
 */
export function ChartTile({
  tile,
  width,
  height,
}: {
  tile: Extract<Tile, { kind: 'chart' }>
  width: number
  height: number
}) {
  const { chart } = tile
  const series = chart.close
  const first = series.length > 0 ? series[0] : null
  const last = series.length > 0 ? series[series.length - 1] : null
  const stroke = toneGraphicsColor(
    changeTone(first !== null && last !== null ? last - first : null),
  )

  const plotW = Math.max(1, width - 2 * TILE_PADDING)
  const plotH = Math.max(1, height - 2 * TILE_PADDING - 22 - 18)

  return (
    <View style={styles.root}>
      <Text style={styles.head} numberOfLines={1}>
        {chart.label !== '' ? chart.label : 'Chart'}
      </Text>
      {chart.kind === 'bar' ? (
        <Bars values={series} width={plotW} height={plotH} />
      ) : (
        <Sparkline data={series} width={plotW} height={plotH} stroke={stroke} strokeWidth={2} />
      )}
      {chart.span !== '' ? (
        <Text style={type.caption} numberOfLines={1}>
          {chart.span}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * Bars, from plain Views rather than SVG. They are axis-aligned rectangles; a `<Svg>` for them
 * would be a second drawing system on the same tile for no gain.
 *
 * Scaled from zero, not from the minimum: a bar chart whose baseline is its own smallest value
 * makes a 5% move look like a doubling, which is the one thing a bar is supposed not to do.
 */
function Bars({ values, width, height }: { values: number[]; width: number; height: number }) {
  const usable = values.filter((v) => Number.isFinite(v))
  if (usable.length === 0) return <View style={{ width, height }} />
  const max = Math.max(...usable, 0)
  const gap = 3
  const barW = Math.max(2, (width - gap * (usable.length - 1)) / usable.length)
  return (
    <View style={[styles.bars, { width, height, gap }]}>
      {usable.map((v, i) => (
        <View
          key={i}
          style={{
            width: barW,
            height: max > 0 ? Math.max(1, Math.round((v / max) * height)) : 1,
            backgroundColor: colors.navy,
            borderRadius: 2,
          }}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: space.xs,
  },
  head: {
    ...type.headingSm,
    height: 22,
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
})
```

Create `app/src/components/edition/tiles/TableTile.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, space, tabular, type } from '../../../theme'
import { type Tile } from '../../../lib/edition/tiles'

/** How many of the trailing columns the tile shows. The detail page shows every one. */
const COLS = 2
const ROWS = 3

/**
 * A statement, cut down to what fits a column: the row labels and the LAST two periods.
 *
 * The last two and not the first two, because the newest quarter is the one being read and a
 * tile that showed 1Q25 and 2Q25 of a six-quarter run would be showing history with the news cut
 * off. Every cell renders verbatim — the producer wrote "(22.1%)" and "9,340", and re-formatting
 * a preformatted cell is how a phone and a sheet come to disagree about a number.
 */
export function TableTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'table' }>
  width: number
  height: number
}) {
  const { table } = tile
  const from = Math.max(0, table.columns.length - COLS)
  const columns = table.columns.slice(from)
  return (
    <View style={styles.root}>
      <Text style={styles.head} numberOfLines={2}>
        {table.title !== '' ? table.title : 'Statement'}
      </Text>
      <View style={styles.headRow}>
        <View style={styles.labelCell} />
        {columns.map((c) => (
          <Text key={c} style={[styles.colHead, tabular]} numberOfLines={1}>
            {c}
          </Text>
        ))}
      </View>
      {table.rows.slice(0, ROWS).map((r, i) => (
        <View key={`${r.label}:${i}`} style={styles.row}>
          <Text style={[type.caption, styles.labelCell]} numberOfLines={1}>
            {r.label}
          </Text>
          {columns.map((c, j) => (
            <Text key={c} style={[styles.cell, tabular]} numberOfLines={1}>
              {r.values[from + j] ?? ''}
            </Text>
          ))}
        </View>
      ))}
      {table.note !== '' ? (
        <Text style={styles.note} numberOfLines={2}>
          {table.note}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: 2,
  },
  head: {
    ...type.headingSm,
    fontSize: 15,
    lineHeight: 19,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingBottom: 3,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  labelCell: {
    flex: 1.2,
  },
  colHead: {
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 11,
    color: colors.textDim,
    textAlign: 'right',
  },
  cell: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.text,
    textAlign: 'right',
  },
  note: {
    ...type.caption,
    fontSize: 11,
    marginTop: 'auto',
  },
})
```

Create `app/src/components/edition/tiles/TapeTile.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { Sparkline } from '../../Sparkline'
import { colors, fonts, space, tabular, type } from '../../../theme'
import { type Tile } from '../../../lib/edition/tiles'
import { changeArrow, changeTone, formatPct } from '../../../lib/edition/format'
import { toneGraphicsColor, toneTextColor } from '../tone'

const SHOWN = 5
/** Must match `estimateTileHeight`'s 32 for a tape row. */
const ROW = 32

/**
 * The tape: up to five indices, each with its own direction.
 *
 * The sparkline takes the graphics pair and the percentage takes the text pair, from the same
 * `changeTone` — so a row's stroke and its number can never disagree about which way the market
 * went.
 */
export function TapeTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'tape' }>
  width: number
  height: number
}) {
  return (
    <View style={styles.root}>
      <Text style={styles.head}>The tape</Text>
      {tile.indices.slice(0, SHOWN).map((ix) => {
        const tone = changeTone(ix.changePct)
        const arrow = changeArrow(ix.changePct)
        return (
          <View key={ix.symbol} style={styles.row}>
            <Text style={styles.symbol} numberOfLines={1}>
              {ix.symbol}
            </Text>
            <Sparkline data={ix.spark} width={42} height={18} stroke={toneGraphicsColor(tone)} />
            <Text style={[styles.change, tabular, { color: toneTextColor(tone) }]} numberOfLines={1}>
              {arrow !== '' ? `${arrow} ` : ''}
              {formatPct(ix.changePct)}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
    ...type.headingSm,
    height: 22,
  },
  row: {
    height: ROW,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  symbol: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textDim,
  },
  change: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    width: 62,
    textAlign: 'right',
  },
})
```

- [ ] **Step 9: Write `PhotoTile.tsx`**

Create `app/src/components/edition/tiles/PhotoTile.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { colors, radius, type } from '../../../theme'
import { TILE_PADDING, type Tile } from '../../../lib/edition/tiles'
import { editionClient, tileUrl } from '../../../lib/edition/client'
import { decodeTile, getCachedTilePng, putCachedTilePng } from '../../../lib/edition/photo'

/**
 * A photograph, fetched beside the payload and decoded on the phone.
 *
 * `tiles/<id>.bin` is `w*h/2` raw bytes with no header and no codec — the same thing the board
 * blits — so this goes through `lib/screen.ts`'s encoder with the tile's geometry. The picture is
 * already halftoned to black and white by `tools/make_tile.py`; nothing here resizes or tones it,
 * exactly as nothing on the device does.
 *
 * WHEN IT DOES NOT ARRIVE THE TILE KEEPS ITS HEIGHT. The layout was computed before the fetch
 * started, so a missing picture must not move the page — the caption goes on a plain ground and
 * the column beside it does not shift. That is also what the demo edition looks like, whose tiles
 * live in `sim/tiles/` and are on no server the phone can reach.
 */
export function PhotoTile({
  tile,
  newsUrl,
}: {
  tile: Extract<Tile, { kind: 'photo' }>
  width: number
  height: number
  newsUrl: string
}) {
  const { photo } = tile
  const url = tileUrl(newsUrl, photo.id)
  const [png, setPng] = useState<string | null>(() => (url === '' ? null : getCachedTilePng(url)))

  useEffect(() => {
    if (url === '' || png !== null) return
    let alive = true
    void (async () => {
      try {
        const bytes = await editionClient.fetchTile(url, photo.w, photo.h)
        const decoded = decodeTile(bytes, photo.w, photo.h)
        putCachedTilePng(url, decoded.pngBase64)
        if (alive) setPng(decoded.pngBase64)
      } catch {
        // No banner and no retry. A picture is the one thing on this page whose absence explains
        // itself, and an error card where a photograph should be is louder than the photograph.
      }
    })()
    return () => {
      alive = false
    }
  }, [url, png, photo.w, photo.h])

  return (
    <View style={styles.root}>
      {png !== null ? (
        <Image
          accessibilityLabel={photo.caption !== '' ? photo.caption : 'Photograph'}
          source={{ uri: `data:image/png;base64,${png}` }}
          style={styles.image}
          resizeMode="cover"
        />
      ) : (
        <View style={styles.placeholder} />
      )}
      {photo.caption !== '' ? (
        <Text style={styles.caption} numberOfLines={2}>
          {photo.caption}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    // Negative margins so the picture bleeds to the tile's own rounded edge: a photograph inset
    // by 14 px inside a white card is a stamp, not a picture.
    margin: -TILE_PADDING,
    flex: 1,
    justifyContent: 'flex-end',
  },
  image: {
    ...StyleSheet.absoluteFillObject,
  },
  placeholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.surfaceAlt,
  },
  caption: {
    ...type.caption,
    color: colors.text,
    backgroundColor: colors.surface,
    paddingHorizontal: TILE_PADDING,
    paddingVertical: 8,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
})
```

- [ ] **Step 10: Typecheck**

Run: `cd app && npm run typecheck`
Expected: no errors. Fix any that appear — a mismatch here is almost always a prop name that
drifted from Task 6's `Tile` union or from Task 2's formatter signatures.

- [ ] **Step 11: Run the full test suite (nothing should have moved)**

Run: `cd app && npm test`
Expected: PASS — this task adds no tests and must break none.

- [ ] **Step 12: Commit**

```bash
git add app/src/theme.ts app/src/components/edition
git commit -m "feat(app): the edition's masthead, chip row, masonry and nine tile bodies"
```

---

### Task 9: The Today tab and the detail route

**Files:**
- Create: `app/src/app/(tabs)/edition.tsx`
- Create: `app/src/app/edition/[tile].tsx`
- Create: `app/src/components/edition/detail/TileDetail.tsx`
- Modify: `app/src/app/(tabs)/_layout.tsx` (register `edition` **first**, before `board`)
- Modify: `app/src/app/_layout.tsx` (register `edition/[tile]` on the root stack)

**Interfaces:**

- Consumes (Tasks 2, 3, 4, 5, 6, 7, 8, and the app's existing components):

```ts
// lib/edition/useEdition
export type EditionState =
  | { status: 'loading' }
  | { status: 'ready'; cached: CachedEdition; demo: boolean; refreshing: boolean; error: string | null }
  | { status: 'error'; error: string }
export function useEdition(): { state: EditionState; refresh: (opts?: { fresh?: boolean }) => Promise<void> }
// lib/edition/store
export interface CachedEdition { url: string; etag: string | null; fetchedAt: number; edition: Edition }
export function readCachedEdition(): Promise<CachedEdition | null>
export function getCurrentEdition(): CachedEdition | null
// lib/edition/tiles
export function editionToTiles(e: Edition): { band: EditionPhoto | null; tiles: Tile[] }
export function filterTiles(tiles: Tile[], chip: Chip): Tile[]
export function availableChips(tiles: Tile[]): Chip[]
export function findTile(layout: EditionLayout, id: string): Tile | null
export type Chip = 'all' | 'stories' | 'numbers' | 'accounts' | 'photos'
export type Tile = /* the nine-member union in Task 6 */
export const TILE_PADDING: number
// lib/edition/freshness
export function freshnessLabel(fetchedAt: number, now: number): string | null
// lib/edition/format
export function formatPrice(n: number | null | undefined): string
export function formatPct(n: number | null | undefined): string
export function changeTone(n: number | null | undefined): 'up' | 'down' | 'flat'
export function changeArrow(n: number | null | undefined): '▲' | '▼' | ''
// lib/edition/client
export const editionClient: { fetchTile(url: string, w: number, h: number): Promise<Uint8Array> }
export function tileUrl(newsUrl: string, id: string): string
// components/edition
export function Masthead(props: { edition; demo; freshness; error; onRetry; onPressSymbol }): JSX.Element
export function ChipRow(props: { chips: Chip[]; selected: Chip; onSelect: (c: Chip) => void }): JSX.Element
export function Masonry(props: { tiles; colWidth; newsUrl; gutter?; columns?; onPress }): JSX.Element
export function tileLabel(t: Tile): string
export function toneTextColor(t: 'up' | 'down' | 'flat'): string
export function toneGraphicsColor(t: 'up' | 'down' | 'flat'): string
// existing app components
export function Screen(props: { children; edges?; style?; aurora? }): JSX.Element
export function BackButton(props: { onPress: () => void }): JSX.Element
export function ScreenMessage(props: { loading?; error?; message?; onRetry? }): JSX.Element
export function Sparkline(props: { data: number[]; width?; height?; stroke: string; strokeWidth? }): JSX.Element
```

- Produces: two routes (`/edition` in the tab group, `/edition/<id>` on the root stack) and
  `TileDetail`. Nothing else imports them.

**A routing note.** `app/src/app/(tabs)/edition.tsx` gives the path `/edition`; the directory
`app/src/app/edition/` with `[tile].tsx` in it gives `/edition/<id>`. They do not collide — one
has a second segment — and the detail is deliberately on the **root** stack so it pushes over the
tab bar and is deep-linkable, the same arrangement `market/[symbol].tsx` already uses.

- [ ] **Step 1: Register the Today tab first**

In `app/src/app/(tabs)/_layout.tsx`, add this `<Tabs.Screen>` as the **first** child of `<Tabs>`,
above the existing `board` screen, and update the file's leading comment:

```tsx
      <Tabs.Screen
        name="edition"
        options={{
          title: 'Today',
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons name={focused ? 'today' : 'today-outline'} size={size} color={color} />
          ),
        }}
      />
```

Change the file's doc comment from "The app's three standing surfaces" to:

```tsx
/**
 * The app's four standing surfaces: today's edition, the board on the wall, the markets
 * watchlist, and settings.
 *
 * Today is registered FIRST because it is the only tab that has something to show on every
 * phone, board or no board — a phone with no URL still gets the demo edition. The entry gate
 * (`entryRouteFor`) is unchanged and still lands on Board or Markets; Today is one tap away
 * from both, which is the right cost for a surface nobody has been told about yet.
 */
```

- [ ] **Step 2: Register the detail route on the root stack**

In `app/src/app/_layout.tsx`, inside the `<Stack>`, add one line after `<Stack.Screen name="market/[symbol]" />`:

```tsx
            <Stack.Screen name="edition/[tile]" />
```

- [ ] **Step 3: Write the Today tab**

Create `app/src/app/(tabs)/edition.tsx`:

```tsx
import { useCallback, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { ScreenMessage } from '../../components/ScreenMessage'
import { Masthead } from '../../components/edition/Masthead'
import { ChipRow } from '../../components/edition/ChipRow'
import { Masonry } from '../../components/edition/Masonry'
import { PhotoTile } from '../../components/edition/tiles/PhotoTile'
import { useEdition } from '../../lib/edition/useEdition'
import { freshnessLabel } from '../../lib/edition/freshness'
import {
  availableChips,
  editionToTiles,
  filterTiles,
  type Chip,
  type Tile,
} from '../../lib/edition/tiles'
import { colors, layout, radius, space } from '../../theme'

/** The space between the two columns. The outer margin is `layout.gutter` on both sides. */
const COLUMN_GAP = 12

/**
 * Today — the edition itself, read on the phone.
 *
 * The material is not on the board. It is at the edition URL, which this phone already stores as
 * its own setting, and which the desk serves unauthenticated on its device plane. So this screen
 * needs no board, no token and no LAN: a phone that has never been near the hardware still reads
 * the paper, and one with no URL at all reads the demo.
 *
 * Everything about what to show is decided in `useEdition`'s reducer. What is left here is
 * layout: measure the column, cut the tiles, and hand them to the masonry.
 */
export default function EditionScreen() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const { state, refresh } = useEdition()
  const [chip, setChip] = useState<Chip>('all')

  const cached = state.status === 'ready' ? state.cached : null
  const layoutOf = useMemo(
    () => (cached === null ? null : editionToTiles(cached.edition)),
    [cached],
  )

  const chips = layoutOf === null ? ['all' as Chip] : availableChips(layoutOf.tiles)
  // A chip that survived a re-lay-out with nothing behind it would be a filter showing an empty
  // page with no way to tell why. Falling back to `all` is the only recovery that shows content.
  const active = chips.includes(chip) ? chip : 'all'
  const tiles: Tile[] = layoutOf === null ? [] : filterTiles(layoutOf.tiles, active)

  const colWidth = Math.floor((width - 2 * layout.gutter - COLUMN_GAP) / 2)

  const onRefresh = useCallback(() => {
    void refresh({ fresh: true })
  }, [refresh])

  const openTile = useCallback(
    (t: Tile) => router.push(`/edition/${encodeURIComponent(t.id)}`),
    [router],
  )

  if (state.status === 'loading') {
    return (
      <Screen edges={['top']}>
        <ScreenMessage loading />
      </Screen>
    )
  }

  if (state.status === 'error') {
    return (
      <Screen edges={['top']}>
        <ScreenMessage error={state.error} onRetry={onRefresh} />
      </Screen>
    )
  }

  const band = layoutOf?.band ?? null

  return (
    <Screen edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={state.refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
      >
        <Masthead
          edition={state.cached.edition}
          demo={state.demo}
          freshness={freshnessLabel(state.cached.fetchedAt, Date.now())}
          error={state.error}
          onRetry={onRefresh}
          onPressSymbol={() =>
            router.push(`/market/${encodeURIComponent(state.cached.edition.subject.symbol)}`)
          }
        />

        {/* The band: the lead photograph, too wide for a column, run across the page instead.
            It is a PhotoTile at full width — same fetch, same decode, same failure behaviour. */}
        {band !== null ? (
          <View style={styles.band}>
            <PhotoTile
              tile={{ kind: 'photo', id: 'band', photo: band }}
              width={width - 2 * layout.gutter}
              height={Math.round(((width - 2 * layout.gutter) * band.h) / band.w)}
              newsUrl={state.cached.url}
            />
          </View>
        ) : null}

        <ChipRow chips={chips} selected={active} onSelect={setChip} />

        <View style={styles.grid}>
          <Masonry
            tiles={tiles}
            colWidth={colWidth}
            newsUrl={state.cached.url}
            gutter={COLUMN_GAP}
            columns={2}
            onPress={openTile}
          />
        </View>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: {
    paddingBottom: space.xxl,
  },
  band: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  grid: {
    paddingHorizontal: layout.gutter,
  },
})
```

- [ ] **Step 4: Write `TileDetail.tsx`**

Create `app/src/components/edition/detail/TileDetail.tsx`:

```tsx
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Sparkline } from '../../Sparkline'
import { PhotoTile } from '../tiles/PhotoTile'
import { toneGraphicsColor, toneTextColor } from '../tone'
import { changeArrow, changeTone, formatPct, formatPrice } from '../../../lib/edition/format'
import { type Tile } from '../../../lib/edition/tiles'
import { type Edition } from '../../../lib/edition/types'
import { colors, fonts, layout, radius, space, tabular, type } from '../../../theme'

/**
 * One tile, opened.
 *
 * Progressive disclosure, borrowed from YouTube's description and Pinterest's closeup: the tile
 * showed a clamped body, four figures of nine, the last two quarters. This shows all of it. The
 * *shape* stays the same so the reader recognises what they tapped — same heading, same order,
 * more of it.
 */
export function TileDetail({
  tile,
  edition,
  newsUrl,
  width,
}: {
  tile: Tile
  edition: Edition
  newsUrl: string
  /** The screen's width, for the media that has to be sized rather than flexed. */
  width: number
}) {
  const contentWidth = width - 2 * layout.gutter

  switch (tile.kind) {
    case 'story': {
      const { story } = tile
      const chart = story.chart !== null ? edition.charts[story.chart] : undefined
      return (
        <View style={styles.root}>
          {story.kicker !== '' ? <Text style={type.caption}>{story.kicker}</Text> : null}
          <Text style={type.heading}>{story.headline}</Text>
          {story.deck !== '' ? <Text style={styles.deck}>{story.deck}</Text> : null}
          {story.byline !== '' ? <Text style={type.caption}>{story.byline}</Text> : null}
          {story.photo !== null ? (
            <PhotoTile
              tile={{ kind: 'photo', id: 'detail', photo: story.photo }}
              width={contentWidth}
              height={Math.round((contentWidth * story.photo.h) / story.photo.w)}
              newsUrl={newsUrl}
            />
          ) : null}
          {chart !== undefined ? <ChartBlock chart={chart} width={contentWidth} /> : null}
          {story.body !== '' ? <Text style={type.body}>{story.body}</Text> : null}
        </View>
      )
    }

    case 'range': {
      const s = tile.subject
      return (
        <View style={styles.root}>
          <Text style={type.heading}>Range</Text>
          <Row label="Last" value={formatPrice(s.last)} />
          <Row label="Open" value={formatPrice(s.open)} />
          <Row label="Day high" value={formatPrice(s.high)} />
          <Row label="Day low" value={formatPrice(s.low)} />
          <Row label="Previous close" value={formatPrice(s.prevClose)} />
          <Row label="52-week high" value={formatPrice(s.wk52High)} />
          <Row label="52-week low" value={formatPrice(s.wk52Low)} />
        </View>
      )
    }

    case 'chart':
      return (
        <View style={styles.root}>
          <Text style={type.heading}>{tile.chart.label !== '' ? tile.chart.label : 'Chart'}</Text>
          <ChartBlock chart={tile.chart} width={contentWidth} />
        </View>
      )

    case 'photo':
      return (
        <View style={styles.root}>
          <PhotoTile
            tile={tile}
            width={contentWidth}
            height={Math.round((contentWidth * tile.photo.h) / tile.photo.w)}
            newsUrl={newsUrl}
          />
          {tile.photo.caption !== '' ? <Text style={type.body}>{tile.photo.caption}</Text> : null}
          {tile.photo.credit !== '' ? <Text style={type.caption}>{tile.photo.credit}</Text> : null}
        </View>
      )

    case 'figures':
      return (
        <View style={styles.root}>
          <Text style={type.heading}>{tile.group !== '' ? tile.group : 'Figures'}</Text>
          {tile.figures.map((f, i) => (
            <Row
              key={`${f.label}:${i}`}
              label={f.label}
              value={f.value}
              changePct={f.changePct}
              emph={f.emph}
            />
          ))}
        </View>
      )

    case 'briefs':
      return (
        <View style={styles.root}>
          <Text style={type.heading}>Briefs</Text>
          {tile.briefs.map((b, i) => (
            <View key={`${b.date}:${i}`} style={styles.brief}>
              <View style={styles.briefMeta}>
                {b.date !== '' ? <Text style={type.caption}>{b.date}</Text> : null}
                {b.kicker !== '' ? <Text style={type.caption}>{b.kicker}</Text> : null}
              </View>
              <Text style={type.body}>{b.text}</Text>
            </View>
          ))}
        </View>
      )

    case 'peers':
      return (
        <View style={styles.root}>
          <Text style={type.heading}>Peers</Text>
          {tile.peers.map((p) => (
            <View key={p.symbol} style={styles.peer}>
              <View style={styles.peerName}>
                <Text style={p.isSubject ? styles.peerSymbolSubject : styles.peerSymbol}>
                  {p.symbol}
                </Text>
                {p.name !== '' ? <Text style={type.caption}>{p.name}</Text> : null}
              </View>
              <View style={styles.peerNums}>
                <Text style={[styles.value, tabular]}>{formatPrice(p.last)}</Text>
                <Change pct={p.changePct} />
              </View>
              <View style={styles.peerNums}>
                <Text style={[type.caption, tabular]}>{p.per}</Text>
                <Text style={[type.caption, tabular]}>{p.cap}</Text>
              </View>
            </View>
          ))}
        </View>
      )

    case 'table': {
      const { table } = tile
      return (
        <View style={styles.root}>
          <Text style={type.heading}>{table.title !== '' ? table.title : 'Statement'}</Text>
          {table.note !== '' ? <Text style={type.caption}>{table.note}</Text> : null}
          {/* The whole grid, scrolled sideways rather than cut down. A statement that does not
              fit the screen is the one thing on this page that must never lose a column: the
              periods are the argument. */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              <View style={styles.gridHead}>
                <Text style={[styles.gridLabel, type.caption]} />
                {table.columns.map((c) => (
                  <Text key={c} style={[styles.gridCellHead, tabular]}>
                    {c}
                  </Text>
                ))}
              </View>
              {table.rows.map((r, i) => (
                <View key={`${r.label}:${i}`} style={styles.gridRow}>
                  <Text style={[styles.gridLabel, type.caption]} numberOfLines={1}>
                    {r.label}
                  </Text>
                  {table.columns.map((c, j) => (
                    <Text key={c} style={[styles.gridCell, tabular]}>
                      {r.values[j] ?? ''}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      )
    }

    case 'tape':
      return (
        <View style={styles.root}>
          <Text style={type.heading}>The tape</Text>
          {tile.indices.map((ix) => (
            <View key={ix.symbol} style={styles.tapeRow}>
              <View style={styles.peerName}>
                <Text style={styles.peerSymbol}>{ix.symbol}</Text>
                {ix.name !== '' ? <Text style={type.caption}>{ix.name}</Text> : null}
              </View>
              <Sparkline
                data={ix.spark}
                width={64}
                height={26}
                stroke={toneGraphicsColor(changeTone(ix.changePct))}
              />
              <View style={styles.peerNums}>
                <Text style={[styles.value, tabular]}>{formatPrice(ix.last)}</Text>
                <Change pct={ix.changePct} />
              </View>
            </View>
          ))}
        </View>
      )
  }
}

function Change({ pct }: { pct: number | null }) {
  const tone = changeTone(pct)
  const arrow = changeArrow(pct)
  return (
    <Text style={[styles.change, tabular, { color: toneTextColor(tone) }]}>
      {arrow !== '' ? `${arrow} ` : ''}
      {formatPct(pct)}
    </Text>
  )
}

function Row({
  label,
  value,
  changePct,
  emph = false,
}: {
  label: string
  value: string
  changePct?: number | null
  emph?: boolean
}) {
  return (
    <View style={styles.row}>
      <Text style={[type.caption, styles.rowLabel]}>{label}</Text>
      <Text style={[emph ? styles.valueEmph : styles.value, tabular]}>{value}</Text>
      {changePct !== undefined && changePct !== null ? <Change pct={changePct} /> : null}
    </View>
  )
}

/** A chart at full width, with its note. The stroke follows the series' own direction. */
function ChartBlock({
  chart,
  width,
}: {
  chart: Edition['charts'][number]
  width: number
}) {
  const series = chart.close
  const delta =
    series.length > 1 ? series[series.length - 1] - series[0] : null
  return (
    <View style={styles.chartBlock}>
      <Sparkline
        data={series}
        width={width}
        height={Math.round(width * 0.45)}
        stroke={toneGraphicsColor(changeTone(delta))}
        strokeWidth={2}
      />
      <View style={styles.chartMeta}>
        {chart.span !== '' ? <Text style={type.caption}>{chart.span}</Text> : null}
        {chart.note !== '' ? <Text style={type.caption}>{chart.note}</Text> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: layout.gutter,
    gap: space.md,
  },
  deck: {
    ...type.body,
    color: colors.textDim,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.md,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLabel: {
    flex: 1,
  },
  value: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
  valueEmph: {
    fontFamily: fonts.extrabold,
    fontSize: 17,
    color: colors.text,
  },
  change: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    minWidth: 68,
    textAlign: 'right',
  },
  brief: {
    gap: 4,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  briefMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  peer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  peerName: {
    flex: 1,
  },
  peerSymbol: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
  },
  peerSymbolSubject: {
    fontFamily: fonts.extrabold,
    fontSize: 14,
    color: colors.text,
  },
  peerNums: {
    alignItems: 'flex-end',
  },
  tapeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  chartBlock: {
    gap: space.xs,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.md,
  },
  chartMeta: {
    gap: 2,
  },
  gridHead: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingBottom: 4,
  },
  gridRow: {
    flexDirection: 'row',
    paddingVertical: 6,
  },
  gridLabel: {
    width: 120,
  },
  gridCellHead: {
    width: 68,
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.textDim,
    textAlign: 'right',
  },
  gridCell: {
    width: 68,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text,
    textAlign: 'right',
  },
})
```

- [ ] **Step 5: Write the detail route**

Create `app/src/app/edition/[tile].tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { BackButton } from '../../components/BackButton'
import { ScreenMessage } from '../../components/ScreenMessage'
import { Masonry } from '../../components/edition/Masonry'
import { TileDetail } from '../../components/edition/detail/TileDetail'
import { getCurrentEdition, readCachedEdition, type CachedEdition } from '../../lib/edition/store'
import { editionToTiles, findTile, type Tile } from '../../lib/edition/tiles'
import { colors, fonts, layout, space } from '../../theme'

const COLUMN_GAP = 12

/**
 * One tile, opened — and the rest of the edition continuing underneath it.
 *
 * That continuation is Pinterest's closeup and it is the whole reason this is a page rather than
 * a modal: a reader who taps a figure has not stopped browsing, and a dead end here sends them
 * back to the top of the feed to find their place again.
 *
 * The edition comes from the in-memory copy the Today tab published, with the disk as the
 * fallback for the one case that misses — a cold `claudepost://edition/story:0` into a process
 * that has never rendered the tab.
 */
export default function TileDetailRoute() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const params = useLocalSearchParams<{ tile: string }>()
  const id = String(params.tile ?? '')

  // `undefined` = the disk has not answered yet, which is not the same as "there is nothing".
  const [cached, setCached] = useState<CachedEdition | null | undefined>(() => getCurrentEdition())

  useEffect(() => {
    if (cached !== undefined) return
    let alive = true
    void (async () => {
      const fromDisk = await readCachedEdition()
      if (alive) setCached(fromDisk)
    })()
    return () => {
      alive = false
    }
  }, [cached])

  // Nothing in memory and nothing on disk: there is no edition to be inside. Go to the tab,
  // which will load one.
  useEffect(() => {
    if (cached === null) router.replace('/edition')
  }, [cached, router])

  const layoutOf = useMemo(
    () => (cached === undefined || cached === null ? null : editionToTiles(cached.edition)),
    [cached],
  )
  const tile = layoutOf === null ? null : findTile(layoutOf, id)
  const rest: Tile[] = layoutOf === null ? [] : layoutOf.tiles.filter((t) => t.id !== id)
  const colWidth = Math.floor((width - 2 * layout.gutter - COLUMN_GAP) / 2)

  const openTile = useCallback(
    // `replace`, not `push`: tapping through five tiles from a closeup would otherwise build a
    // five-deep stack and make Back a five-tap journey out of a two-tap one.
    (t: Tile) => router.replace(`/edition/${encodeURIComponent(t.id)}`),
    [router],
  )

  const header = (
    <View style={styles.titleRow}>
      {/* Back falls back to a destination rather than to silence: this is a root-stack route, so
          a cold deep link builds a stack of just [tile] and `canGoBack()` is false — the same
          trap `preview.tsx` documents. */}
      <BackButton onPress={() => (router.canGoBack() ? router.back() : router.replace('/edition'))} />
      <Text style={styles.title}>Today</Text>
      <View style={styles.backSpacer} />
    </View>
  )

  if (cached === undefined) {
    return (
      <Screen>
        {header}
        <ScreenMessage loading />
      </Screen>
    )
  }

  if (cached === null) {
    // The redirect above is already in flight; a spinner is the honest frame in between.
    return (
      <Screen>
        {header}
        <ScreenMessage loading />
      </Screen>
    )
  }

  if (tile === null) {
    return (
      <Screen>
        {header}
        <ScreenMessage message="This item isn’t in today’s edition." />
      </Screen>
    )
  }

  return (
    <Screen>
      {header}
      <ScrollView contentContainerStyle={styles.scroll}>
        <TileDetail tile={tile} edition={cached.edition} newsUrl={cached.url} width={width} />
        {rest.length > 0 ? (
          <View style={styles.more}>
            <Text style={styles.moreHead}>More from this edition</Text>
            <Masonry
              tiles={rest}
              colWidth={colWidth}
              newsUrl={cached.url}
              gutter={COLUMN_GAP}
              columns={2}
              onPress={openTile}
            />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.gutter,
    height: 56,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.text,
  },
  backSpacer: {
    width: 42,
  },
  scroll: {
    paddingBottom: space.xxl,
  },
  more: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.xl,
    gap: space.md,
  },
  moreHead: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.text,
  },
})
```

- [ ] **Step 6: Typecheck**

Run: `cd app && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Run the full suite**

Run: `cd app && npm test`
Expected: PASS — the screens add no tests and must break none.

- [ ] **Step 8: Commit**

```bash
git add app/src/app/\(tabs\)/edition.tsx app/src/app/\(tabs\)/_layout.tsx \
        app/src/app/edition app/src/app/_layout.tsx \
        app/src/components/edition/detail
git commit -m "feat(app): the Today tab and the tile detail page"
```

---

### Task 10: Settings without a board, and the documentation

**Files:**
- Modify: `app/src/app/(tabs)/settings.tsx` (the **News source** section: show the editor without a
  board; gate only the poll rows on a client)
- Modify: `app/README.md` (a "Reading the edition" section)
- Modify: `docs/app-control.md` (one sentence under the desk's device plane)

**Interfaces:** none produced, none consumed from other tasks. This task is independent of every
other one and can run in Wave A.

- [ ] **Step 1: Show the News source editor without a board**

In `app/src/app/(tabs)/settings.tsx`, the News source section is currently wrapped in
`{hasDevice === false ? null : ( <Section title="News source"> … </Section> )}`. Two changes,
both inside that block:

1. Delete the `hasDevice === false ? null :` wrapper so the `<Section>` always renders. Keep the
   `hasDevice === false` guard on the **Board** card above it — that one is about a board and is
   correct as it is.
2. Gate only the three poll rows on `client`, which is already how the code reads them: the
   `{source ? ( <Card> … </Card> ) : null}` block is already conditional on `source`, and `source`
   is only ever set from a board's `getState()`. So that block needs no change — it simply never
   appears without a board.

Replace the section's leading comment and its opening line with:

```tsx
          {/*
            The news snapshot URL — the one setting that decides what the phone and the board
            show. It is the PHONE's setting (`store.ts`, `newsurlsync.ts`), with the board as a
            subscriber that catches up when it is awake, and since the Today tab reads the same
            address directly it is now a setting that does something with no board at all. So the
            section no longer hides itself without one: hiding it used to be right when the URL
            was only ever a thing to POST at hardware, and it is wrong now that the phone is a
            reader too.

            What stays gated is everything that describes a BOARD's polling — Last poll, Last
            success, Polls. Those come from `source`, which is only ever set from a board's
            getState(), so they are absent without one for free rather than by a second branch.

            What the editor shows is whichever copy is the truth right now. The board echoes its
            URL back, and whenever nothing is pending that is the address in force. While a save
            is waiting for the board, the phone's copy is what the user asked for and the board's
            is what they asked to change, so the phone's wins and the note underneath says why.
          */}
          <Section title="News source">
```

and close it with a plain `</Section>` (dropping the `)}` that closed the ternary). Update the
section's help text so it reads for a phone with no board:

```tsx
              <Text style={styles.help}>
                The address today’s edition is fetched from — by this phone on the Today tab, and
                by the board when it has one. Clear it and save to fall back to the built-in demo
                edition.
              </Text>
```

Nothing else in the file changes. In particular the `onSave` handler is already correct for a
phone with no board: it takes the `{ noClient: true }` path through `decideNewsUrlSave`, which
persists the address and leaves it marked pending for whenever a board appears.

- [ ] **Step 2: Verify the Settings change typechecks and breaks nothing**

Run: `cd app && npm run typecheck && npm test`
Expected: no type errors; PASS. (`newsurl.test.ts` and `newsurlsync.test.ts` cover the save rule
and must be untouched by this edit — if either fails, the edit went further than the JSX.)

- [ ] **Step 3: Add the README section**

In `app/README.md`, insert a new section immediately **after** "## What the dashboard shows" and
before "## Seeing the page on the glass":

```markdown
## Reading the edition

The **Today** tab shows the edition itself, and it needs no board. The material is not on the
board — it is at the edition URL, which this phone already stores as its own setting
(`claudepost.newsUrl`) and which the desk serves unauthenticated on its device plane
(`GET /news.json`, `GET /tiles/<id>.bin` — see [`../docs/desk-server.md`](../docs/desk-server.md)).
The board fetches it; so does the phone, with the same conditional request, the same 15-second
deadline and the same 320 KB cap. A payload the app refuses is one the board would refuse too.

- **What it shows.** A masthead — the company, the price, the dateline — then a two-column
  masonry of tiles cut from the payload: the day's range, the stories, the charts, one tile per
  group of figures, the photographs, the briefs, the peers, each statement, and the tape. Tapping
  one opens it in full, with the rest of the edition continuing underneath.
- **Where the heights come from.** Every tile's height is computed by a pure estimator
  (`src/lib/edition/tiles.ts`) *before* anything renders, never measured with `onLayout`. That is
  what stops the page reflowing and what lets a return from a detail land on the same scroll
  position. The content adapts to its height with `numberOfLines`; the tile never grows to fit.
- **The demo.** A phone with no URL shows `src/lib/edition/demo.json`, which is byte-identical to
  `components/news_core/test/host/fixtures/news.json` — the payload an unconfigured *board*
  prints. A jest test holds the two files identical, the way `test_news_mock` holds the firmware
  to the same fixture. Its photo tiles live in `sim/tiles/` and are on no server the phone can
  reach, so they show their captions on a plain ground.
- **The cache.** One AsyncStorage key, `claudepost.edition`, holding the URL, the ETag, when the
  server last *confirmed* the content and the parsed edition. It is re-parsed on read, so a cache
  written by a newer build degrades to defaults instead of crashing a launch. A cache whose URL is
  no longer the stored one is ignored — another desk's paper is not today's.
- **Why photographs are memory-only.** A decoded tile is about a hundred kilobytes of base64 and
  an edition carries several. The text is the material; a picture that has to be re-fetched after
  a cold launch costs a second on the same connection that just delivered the JSON, and the
  alternative is hundreds of kilobytes of a phone's storage per day.
- **The cadence.** No interval. The edition changes about once a day and the desk answers a
  conditional GET with a 304 for the rest of it, so there is a refresh on return to the tab when
  what is on screen is over five minutes old, and pull-to-refresh. A failed refresh keeps the
  cached edition and raises a banner in `warn`, never in direction red.
```

Also update the "Project layout" tree's `lib/` block, adding these lines after the `screen.test.ts`
line:

```
   │  ├─ edition/          the edition layer: types, parse, client, cache, tiles, hook
   │  │                    (types.ts is the ONLY file that knows an edition wire field name)
```

- [ ] **Step 4: Add the sentence to `docs/app-control.md`**

In `docs/app-control.md`, find the paragraph under the scope tables that reads:

```
Unauthenticated, and not under `/api/*` at all — the device plane, open to
anything that can reach the desk: `GET /news.json`, the same edition the
board polls, fetchable by the app exactly as the board fetches it.
```

Append one sentence to it:

```
The companion app is now a client of it: the Today tab fetches `/news.json`
and `/tiles/<id>.bin` straight from the address the phone stores, with the
board's own conditional request and body cap, so an edition is readable on a
phone whose board is asleep or was never set up.
```

- [ ] **Step 5: Commit**

```bash
git add app/src/app/\(tabs\)/settings.tsx app/README.md docs/app-control.md
git commit -m "docs(app): the edition URL is a setting with no board, and Today reads it"
```

---

### Task 11: Full verification

**Files:** none. This task runs commands and fixes whatever they report.

**Interfaces:** none.

- [ ] **Step 1: The app's own suite**

Run:

```bash
cd app && npm test
```

Expected: PASS, every file — including the ones this work did not touch (`esp32.test.ts`,
`store.test.ts`, `screen.test.ts`, `discovery.test.ts`, `format.test.ts`, `newsurl.test.ts`,
`newsurlsync.test.ts`) and the eight new ones (`parse`, `demo`, `format`, `freshness`, `photo`,
`client`, `store`, `tiles`, `useEdition` — nine files).

- [ ] **Step 2: Typecheck**

Run:

```bash
cd app && npm run typecheck
```

Expected: no output, exit 0.

- [ ] **Step 3: Prove nothing under `components/` moved**

The app now reads `components/news_core/test/host/fixtures/news.json` from two jest tests, and
`lib/screen.ts` was refactored against the same format the firmware writes. Both are regression
surfaces for the C side, so run the desk's suite and the host test that pins the fixture:

```bash
sh server/test/run.sh
cmake -S components/news_core/test/host -B /tmp/vt && cmake --build /tmp/vt && /tmp/vt/test_news_mock
```

Expected: both PASS. `test_news_mock` failing here means the fixture was edited — which would
also have failed `demo.test.ts`, and the fix is to restore the fixture (or to regenerate it with
`python3 tools/mock_news_server.py --write-fixture` and re-copy it to `app/src/lib/edition/demo.json`),
never to loosen either test.

- [ ] **Step 4: Confirm the working tree carries no leftovers**

Run:

```bash
git status --short
grep -rn "TODO\|FIXME\|test.skip\|test.only\|it.only\|describe.only" app/src/lib/edition app/src/components/edition app/src/app/edition
```

Expected: `git status` shows only intended files; the grep prints nothing. A `.only` left in a
test file silently skips every other test in it, which is the failure mode this check exists for.

- [ ] **Step 5: Commit the verification pass if anything was fixed**

```bash
git add -A
git commit -m "test(app): full verification of the edition reader"
```

If nothing needed fixing, there is nothing to commit and that is the expected outcome.

---

## Self-Review

Run after the plan was complete, against the spec with fresh eyes.

**1. Spec coverage.** Every section of
`docs/superpowers/specs/2026-09-03-app-edition-reader-design.md` maps to a task: the wire type is
Task 1's input (already written); Parsing → Task 1; Fetching → Task 4; The cache → Task 5;
The demo → Task 1; Freshness and the formatters → Task 2; Tiles → Task 6; the photo decoder and
the `lib/screen.ts` refactor → Task 3; The screen hook → Task 7; Visual tokens and every component
in the architecture listing → Task 8; The Today tab and the detail route → Task 9; Settings and
both documentation edits → Task 10; the "run the desk and host tests once at the end" line →
Task 11. Every row of the spec's error-handling table is either a reducer case with a test
(Task 7) or a component branch with a comment naming it (Tasks 8 and 9).

**2. Placeholder scan.** No "TBD", no "implement later", no "similar to Task N", no "add error
handling". Every code step carries the real file. Two spec deviations are stated at the point they
occur rather than left implicit: the `now` option dropped from `EditionClientOptions` (Task 4) and
the freshness minute tier extended from 30 to 60 minutes (Task 2). One addition is stated the same
way: `changeArrow` beside the spec's three formatters, and `components/edition/tone.ts` for the
tone-to-colour mapping.

**3. Type consistency.** `Tile`'s nine members, `Chip`'s five values, `CachedEdition`'s four
fields, `EditionFetch`'s two shapes and `EditionState`'s three all appear identically in every
task that names them. `estimateTileHeight`'s per-row constants (28 figures, 56 briefs, 28 peers,
32 tape, 22 heading) are repeated as named constants in the matching tile bodies in Task 8, with a
comment in both places saying they must change together. Fixed inline during the review: the
reducer's test helper now imports `EditionEvent` rather than a type that does not exist, and
`Masonry`/`EditionTile` both thread `newsUrl` so `PhotoTile` can resolve its own bytes.
