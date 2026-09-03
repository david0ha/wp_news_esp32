# The edition in the app — design

**Status:** approved for implementation, 2026-09-03.
**Plan:** [../plans/2026-09-03-app-edition-reader.md](../plans/2026-09-03-app-edition-reader.md)

## The problem

The companion app can only show what the board is printing by asking the board. The board is
unreachable most of the time by design — a board on a cell wakes for three seconds, asks its desk
one conditional question and sleeps — and a phone with no board at all lands on the Markets tab
and never sees an edition. The user's words: *"if the board isn't connected, the material that
goes on the board can't be seen in the app. Make the material itself viewable — not the newspaper
spread out, a clean design that looks good in the app, a Pinterest-like experience."*

The material is not on the board. It is at the edition URL, which the phone already stores as its
own setting (`claudepost.newsUrl`) and which the desk serves unauthenticated on its device plane
(`GET /news.json`, `GET /tiles/<id>.bin` — [desk-server.md](../../desk-server.md), "The two
planes"). `app/README.md` has said since the first version that the phone can fetch it as easily
as the board can. Nothing has, until now.

## What this builds

A **Today** tab that fetches the edition JSON directly from the stored URL, renders it as a
two-column masonry of tiles, keeps the last good edition on disk so it reads offline, and opens
each tile into a detail page with the rest of the edition continuing underneath. A **demo
edition** is bundled so a phone with no URL shows exactly what an unconfigured board prints.

Not built, and why:

- **An archive of past days.** `GET /api/editions` is `producer` scope; the phone holds no desk
  token. The user asked for today's material.
- **The A1/A2 proof sheets.** Same token. The board's own `/api/screen` preview already exists for
  the days the board answers.
- **A dark theme, new dependencies, shared-element transitions.** All ruled out by the app-market
  spec's ground rules (no reanimated, no expo-image, no FlashList, no styling library). Masonry
  is hand-rolled; the detail opens with the native stack push.
- **Charts drawn from the statements' numeric plane** (`tables[].rows[].n`). The tile shows the
  rows; the detail shows the full grid. A second implementation of `ui_chart.c` is not a v1 need.

## What the research decided

The UX memo (Pinterest, YouTube, TikTok) is at `docs/superpowers/specs/` sibling
[2026-09-03-app-edition-reader-ux-research.md](2026-09-03-app-edition-reader-ux-research.md).
The decisions it drove:

1. **Height before render.** Pinterest's transferable mechanic is not the grid, it is that every
   tile's height is *known before layout*, so nothing reflows and returning from a detail restores
   the same page. Tiles are therefore **sized by a pure estimator**, not measured with `onLayout`:
   `estimateTileHeight(tile, colWidth)` sets each tile's `height` style, and the content adapts to
   it with `numberOfLines`. Two column arrays, shortest-column-first, inside one `ScrollView`. At
   five to fifteen tiles there is nothing to virtualise, and `FlatList numColumns` cannot stagger.
2. **Masonry earns its place only where content differs in height.** It does on the Today feed —
   a 700-character lead and a four-row dossier group are genuinely different objects — and the
   tile taxonomy gives each kind a fixed aspect so the heterogeneity is real, not manufactured.
3. **Type is the image.** A story tile has no picture; its headline at 22/26 carries the visual
   weight a photograph would. A number tile is one figure at display size.
4. **Borrowed from YouTube:** the chip row that narrows a heterogeneous feed in place
   (All / Stories / Numbers / Accounts / Photos), and progressive disclosure — a body clamped in
   the tile, full in the detail.
5. **Borrowed from Pinterest's closeup:** the detail page is a continuation of the feed. Under the
   opened item, the remaining tiles resume as "More from this edition".
6. **Not borrowed from TikTok:** the action rail (earned by social mechanics this content lacks)
   and full-screen paging (immersion is a different surface from browsing).
7. **Staleness is tiered, not binary.** Nothing under five minutes, "Updated 12m ago" to thirty,
   "Updated 3h ago" to a day, "Last updated yesterday" beyond. A banner only when a fetch actually
   failed and cached content is being shown.
8. **The five anti-patterns are rules:** no uniform tiles in the masonry; no all-caps eyebrow on
   every tile; no dot-separated meta lines; no gradient or shadow on a tile; colour means direction
   or series identity, never decoration — the firmware's rule, carried into the app.

## Architecture

```
app/src/lib/edition/
  types.ts        the TS mirror of docs/news-contract.md — the ONLY file that knows a wire field name
  parse.ts        parseEdition(unknown) -> Edition   total, clamping, rank-sorting, never throws
  client.ts       createEditionClient({fetchFn, now, timeoutMs}) -> { fetch(url, etag?) }
                  EditionError, humanEditionError, tileUrl(newsUrl, id)
  store.ts        the last-good edition on disk (AsyncStorage) + the in-memory current edition
  demo.json       the bundled demo edition — byte-identical to components/news_core/test/host/fixtures/news.json
  demo.ts         demoEdition(): Edition
  freshness.ts    freshnessLabel(fetchedAt, now) -> string | null   (the tiers)
  format.ts       formatPrice(number), formatPct(number), changeTone(number)  — decimals, not cents
  tiles.ts        Tile union, editionToTiles(edition), estimateTileHeight(tile, colWidth),
                  splitColumns(tiles, colWidth, n), filterTiles(tiles, chip), CHIPS
  photo.ts        decodeTile(bytes, w, h) -> pngBase64  (generalised from lib/screen.ts)
  useEdition.ts   the screen hook: cache-first load, focus refresh, pull-to-refresh, error state
app/src/components/edition/
  Masthead.tsx    company, dateline, price + change, freshness line, demo chip, failure banner
  ChipRow.tsx     horizontal pill filters
  Masonry.tsx     two columns from splitColumns; renders <EditionTile/> per placed tile
  EditionTile.tsx switch on tile.kind -> one of the tile bodies below; press feedback
  tiles/StoryTile.tsx RangeTile.tsx ChartTile.tsx PhotoTile.tsx FiguresTile.tsx
        BriefsTile.tsx PeersTile.tsx TableTile.tsx TapeTile.tsx
  detail/TileDetail.tsx  the full content of one tile, by kind
app/src/app/(tabs)/edition.tsx     the Today tab
app/src/app/edition/[tile].tsx     the detail route (root stack, deep-linkable)
```

`lib/screen.ts` keeps its public `decode(fbBytes)` for the board preview; its PNG encoder gains a
width/height parameter so a photo tile (`w*h/2` bytes, same nibble layout, same ink palette) goes
through the same code. That is a refactor of one function, not a second encoder.

### The wire type (`types.ts`)

The edition's numbers are **decimals** (`last: 1631.47`, `change_pct: 4.21`), unlike the device
API's cents and basis points, so nothing from `lib/format.ts` is reused on them. Strings the
producer preformatted (`figures[].value`, `peers[].per`, table cells) render verbatim.

```ts
export interface EditionSubject {
  symbol: string; name: string; exchange: string; sector: string
  last: number | null; changePct: number | null; prevClose: number | null
  open: number | null; high: number | null; low: number | null
  wk52High: number | null; wk52Low: number | null      // null when absent or 0 (0 = unknown on the wire)
}
export interface EditionPhoto { id: string; w: number; h: number; caption: string; credit: string }
export interface EditionStory {
  rank: number; kicker: string; headline: string; deck: string; byline: string; body: string
  chart: number | null            // index into charts[], null when absent or out of range
  photo: EditionPhoto | null
}
export interface EditionFigure {
  group: string; label: string; value: string; changePct: number | null; emph: boolean
  bar: number | null              // 0..1000, null when absent (absent is NOT 0)
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
export interface EditionChart {
  kind: 'line' | 'candle' | 'bar' | 'sparkline'; label: string; span: string; note: string
  open: number[]; high: number[]; low: number[]; close: number[]
}
export interface EditionIndex {
  symbol: string; name: string; last: number | null; changePct: number | null; spark: number[]
}
export interface Edition {
  edition: string; dateline: string; session: string; asOf: string; generatedAt: string
  subject: EditionSubject
  stories: EditionStory[]         // ≤ 5, ascending rank (the five lowest ranks survive)
  figures: EditionFigure[]        // ≤ 28, wire order
  briefs: EditionBrief[]          // ≤ 8
  peers: EditionPeer[]            // ≤ 6
  tables: EditionTable[]          // ≤ 2
  charts: EditionChart[]          // ≤ 2
  indices: EditionIndex[]         // ≤ 5
  thumbs: EditionPhoto[]          // wire order
}
export const EDITION_CAPS = { stories: 5, figures: 28, briefs: 8, peers: 6, tables: 2, charts: 2, indices: 5 } as const
```

### Parsing (`parse.ts`)

`parseEdition(json: unknown): Edition` is total: every field is optional on the wire and absent,
`null` and wrong-typed all become the default (`''`, `null`, `[]`), exactly as `news_parse.c`
does. A story without a `headline` is dropped; a figure without `label` and `value` is dropped; a
peer without `symbol` is dropped. Stories are sorted ascending by `rank` (default 9), stable, and
cut to five *after* sorting so a payload that appends its lead keeps it. `chart` outside
`[0, charts.length)` becomes `null`. `wk52High`/`wk52Low` of `0` become `null`. A chart `kind`
outside the four becomes `'line'`. Non-finite numbers become `null`. Unknown keys are ignored.

`parseEdition` **never throws**; the caller decides whether an edition with no `subject.symbol`
and no stories is worth showing (`isEmptyEdition(e)` is exported for that).

### Fetching (`client.ts`)

```ts
export type EditionErrorCode = 'no_url' | 'transport' | 'http' | 'too_large' | 'bad_json'
export class EditionError extends Error { code: EditionErrorCode; status?: number }
export function humanEditionError(e: unknown): string
export type EditionFetch =
  | { status: 'ok'; edition: Edition; etag: string | null }
  | { status: 'not_modified' }
export interface EditionClientOptions { fetchFn?: typeof fetch; now?: () => number; timeoutMs?: number }
export function createEditionClient(opts?: EditionClientOptions): {
  fetch(url: string, etag: string | null): Promise<EditionFetch>
  fetchTile(url: string, w: number, h: number): Promise<Uint8Array>
}
export function tileUrl(newsUrl: string, id: string): string
```

The request is what the board sends: plain `GET`, `If-None-Match` when an ETag is held, 15 s
timeout via `AbortController`, a `320 * 1024`-byte cap on the body (the device's own; a payload
bigger than that is one the board would reject too), `304` → `not_modified`, non-2xx → `http`,
unparsable body → `bad_json`, thrown fetch → `transport`. A `200` whose body parses to an empty
edition is `bad_json`. `tileUrl` is the contract's rule: the news URL's directory (everything up to
and including the last `/`, query and fragment removed) plus `tiles/<id>.bin`.
`fetchTile` rejects a body that is not exactly `w*h/2` bytes.

Failure copy (`humanEditionError`) is written for the reader, in the interface's voice:
`no_url` "No edition URL yet. Add one in Settings.", `transport` "Couldn't reach the edition
server. Check the connection, then pull to refresh.", `http` "The edition server answered
<status>.", `too_large` "The edition is too large to read here.", `bad_json` "The edition didn't
parse. The desk may be mid-publish; pull to refresh in a minute." Transport failures take
`colors.warn`, never direction red.

### The cache (`store.ts`)

```ts
export interface CachedEdition { url: string; etag: string | null; fetchedAt: number; edition: Edition }
export function readCachedEdition(): Promise<CachedEdition | null>
export function writeCachedEdition(c: CachedEdition): Promise<void>
export function touchCachedEdition(fetchedAt: number): Promise<void>     // after a 304
export function clearCachedEdition(): Promise<void>
export function getCurrentEdition(): CachedEdition | null                // in-memory, for the detail route
export function setCurrentEdition(c: CachedEdition | null): void
export function __resetEditionStoreForTests(): void
```

One AsyncStorage key, `claudepost.edition`, JSON. The cached `edition` is the *parsed* form, so a
cache written by a newer app is re-parsed through `parseEdition` on read — a shape the parser does
not recognise degrades to defaults rather than crashing a launch. Every write absorbs its own
storage failure. A cache whose `url` differs from the stored news URL is ignored (not shown as
today's material for a different desk) and overwritten on the next success. `fetchedAt` is the
last time the server confirmed the content — a `200` or a `304` — which is what the freshness
line is about.

Photo tiles are cached in memory only (a `Map` keyed by tile URL, cleared when the edition
changes). The text is the material; a photo that has to be re-fetched after a cold launch is
acceptable and the alternative is hundreds of kilobytes of base64 per edition in AsyncStorage.

### The demo (`demo.json`, `demo.ts`)

`demo.json` is a copy of `components/news_core/test/host/fixtures/news.json`, the same payload
`news_mock.c` prints on an unconfigured board. A jest test reads both files and asserts they are
byte-identical, the way `test_news_mock` holds the firmware to the fixture. Its photo tiles live
in `sim/tiles/`, not in the app, so the demo's photo tiles show their captions on a plain ground.
The masthead shows a `Demo edition` chip whenever the demo is what is on screen.

### Freshness (`freshness.ts`)

```ts
export function freshnessLabel(fetchedAt: number, now: number): string | null
```

| age | label |
|---|---|
| < 5 min | `null` (nothing shown) |
| < 30 min | `Updated 12m ago` |
| < 24 h | `Updated 3h ago` |
| < 48 h | `Last updated yesterday` |
| otherwise | `Last updated 30 Aug` (day and short month, no year) |

### Tiles (`tiles.ts`)

```ts
export type Chip = 'all' | 'stories' | 'numbers' | 'accounts' | 'photos'
export const CHIPS: ReadonlyArray<{ id: Chip; label: string }>   // All, Stories, Numbers, Accounts, Photos
export type Tile =
  | { kind: 'story';   id: string; story: EditionStory; lead: boolean }
  | { kind: 'range';   id: string; subject: EditionSubject }           // open/high/low/prev, 52-wk
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
export function availableChips(tiles: Tile[]): Chip[]          // 'all' + every chip with ≥1 tile
export function estimateTileHeight(t: Tile, colWidth: number): number
export interface PlacedTile { tile: Tile; height: number }
export function splitColumns(tiles: Tile[], colWidth: number, columns?: number): PlacedTile[][]
export function findTile(layout: EditionLayout, id: string): Tile | null
```

**Ids** are `${kind}:${n}` with `n` the tile's index among its kind (`story:0`, `figures:2`), so a
detail route can name a tile and a re-parse of the same edition yields the same ids.

**Order** (the "All" feed): `range` → the lead `story` → `chart[0]` → the remaining stories in rank
order → one `figures` tile per distinct `group` in first-seen order → one `photo` tile per
`thumbs[]` entry → `briefs` (one tile, when any) → `peers` (when any) → one `table` per table →
`tape` (when any index) → remaining charts. A tile kind with nothing behind it is absent, not
empty. The **band** is the lead story's `photo` when it exists and its `w/h > 2` — a 1140×320 strip
at column width would be 47 px tall, so it spans the full width above the grid instead; a lead
photo of ordinary aspect becomes the first `photo` tile.

**Chips:** `stories` = story, briefs; `numbers` = range, chart, figures, peers, tape;
`accounts` = table; `photos` = photo.

**Heights** (`estimateTileHeight`, all in px, `P = 14` padding):

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

**Placement:** `splitColumns` walks the tiles in order and appends each to the currently shortest
column (ties → the leftmost). Properties a test holds: every tile is placed exactly once, order
within a column is feed order, and the tallest and shortest column differ by at most the tallest
single tile.

### The screen hook (`useEdition.ts`)

```ts
export type EditionState =
  | { status: 'loading' }                                   // cold start, nothing to show yet
  | { status: 'ready'; cached: CachedEdition; demo: boolean; refreshing: boolean; error: string | null }
  | { status: 'error'; error: string }                      // first load failed and no cache
export function useEdition(): { state: EditionState; refresh: (opts?: { fresh?: boolean }) => Promise<void> }
```

Load order on mount: read the stored news URL and the cache in parallel → if the cache matches the
URL, show it immediately (`ready`, `refreshing: true`) → fetch with the cached ETag → `ok` writes
the cache and replaces the edition; `not_modified` touches `fetchedAt`; a failure keeps the cache
and sets `error` (the banner). With no cache: `loading` until the fetch settles, then `ready` or
`error`. With an empty URL: `ready` with the demo, `demo: true`, no network. A `useFocusEffect`
refreshes silently when `fetchedAt` is older than five minutes; there is **no interval** — the
edition changes once a day, and the desk answers a conditional GET with a 304 for the rest of it.
A sequence counter discards a response that lands after the URL changed. `refresh({fresh: true})`
is pull-to-refresh: it sends the ETag anyway (a 304 is the honest answer) and sets `refreshing`.

The decision logic — what to show given (url, cache, fetch outcome) — is a pure function,
`nextEditionState(prev, event)`, with a test, because there is no component test runner.

### The Today tab (`(tabs)/edition.tsx`)

Registered **first** in the tab bar as `Today` (Ionicons `today` / `today-outline`); the entry
gate (`entryRouteFor`) is unchanged — it still lands on Board or Markets, and Today is one tap
away in both. A `ScrollView` with `RefreshControl`, `Screen` edges `['top']`:

1. `Masthead`: `subject.name` in `type.headingLg`, `dateline` in `type.caption`, then the price
   row — `formatPrice(last)` at `type.display` size with `tabular`, `DeltaText`-style change in
   the direction colour (zero is grey and unsigned). Tapping the symbol pushes
   `/market/<symbol>`. Under it: the freshness line (caption), the `Demo edition` chip when
   `demo`, and the failure banner (`warnBg`, one sentence from `humanEditionError`, a `Retry`
   text button) when `error` is set and content is showing.
2. The band photo, full width, when `layout.band` is set.
3. `ChipRow` — `availableChips`, selection in component state, default `all`.
4. `Masonry` — `splitColumns(filterTiles(tiles, chip), colWidth, 2)` where
   `colWidth = (windowWidth - 2 * layout.gutter - 12) / 2`, gutter 12 between columns.

States: `loading` → `ScreenMessage loading`; `error` → `ScreenMessage error onRetry`; a `no_url`
never happens here because an empty URL shows the demo. Tapping a tile pushes
`/edition/<encodeURIComponent(id)>`.

### The detail route (`edition/[tile].tsx`)

Reads `getCurrentEdition()`; if `null` (cold deep link) reads the cache; if still nothing,
`router.replace('/edition')`. Renders `TileDetail` for the named tile — the full body, every
figure in the group, every brief, the whole table as a scrollable grid, the chart at full width
with its `note` — then a `More from this edition` heading and a `Masonry` of the other tiles.
Back is `router.canGoBack() ? router.back() : router.replace('/edition')`. A tile id that names
nothing renders `ScreenMessage` with "This item isn't in today's edition."

### Visual tokens (extending `theme.ts`, not replacing it)

| token | value |
|---|---|
| columns | 2 |
| outer margin | `layout.gutter` (16) |
| column gutter | 12 |
| tile radius | `radius.lg` (18) |
| tile chrome | `colors.surface`, **no border, no shadow** |
| tile padding | 14 |
| `type.pinHeadline` | `Inter_800ExtraBold` 22/26, letterSpacing -0.4 |
| `type.pinDeck` | `Inter_400Regular` 14/19, `colors.textDim` |
| press feedback | `Animated` scale to 0.97 over 150 ms, back on release |
| sparkline / line stroke | `upBright` / `downBright` / `textDim` by the series' own direction |
| bar fill | `colors.navy` (one series is ink; a filled control colour, graphics duty) |
| range bar position | `colors.text` mark on a `surfaceAlt` track |

No gradient inside a tile, no `type.label` eyebrow on a tile (the tile's *kicker* is content,
rendered in `type.caption` sentence case as the producer wrote it), no icon badges, no separators
built from middle dots.

### Settings

The **News source** section currently hides itself when `hasDevice === false`. The URL is the
app's own setting now and the Today tab reads it, so the editor shows without a board; only the
board-poll rows (`Last poll`, `Last success`, `Polls`) stay gated on a client. The save path
already handles `{ noClient: true }` through `decideNewsUrlSave`.

## Error handling, in one table

| situation | what the reader sees |
|---|---|
| empty URL | the demo edition, `Demo edition` chip |
| first launch, network down, no cache | `ScreenMessage` with the transport sentence and Retry |
| cache present, refresh fails | the cached edition, freshness line, warn banner with Retry |
| 304 | nothing changes but the freshness line |
| new content | the tiles re-lay out; the chip resets to `all` only if the current chip is now empty |
| a tile's photo fails to load | the tile keeps its height, caption on `surfaceAlt` |
| edition parses but is empty | treated as `bad_json` — the previous cache stays up |
| URL changed in Settings | the old cache is ignored; `loading` until the new one lands |

## Testing

Pure logic only, jest, injected `fetch` and clock, exactly like `esp32.test.ts` — there is no
component test runner and the spec does not add one.

- `parse.test.ts` — the fixture round-trips with the expected counts; caps; rank sort keeps an
  appended lead; missing headline drops the story; `chart` out of range → `null`; `wk52 = 0` →
  `null`; non-finite → `null`; wrong types → defaults; `parseEdition(undefined)` returns an empty
  edition rather than throwing.
- `client.test.ts` — 200 → `ok` with ETag; 304 → `not_modified`; 500 → `http` with status;
  invalid JSON → `bad_json`; empty edition → `bad_json`; oversize → `too_large`; thrown fetch →
  `transport`; timeout aborts; `If-None-Match` is sent only with an ETag; `tileUrl` strips query
  and fragment and resolves beside the payload; `fetchTile` rejects the wrong length.
- `store.test.ts` — round trip; a cache for another URL is ignored; a corrupt value reads as
  `null`; `touch` updates only `fetchedAt`; storage failures are absorbed.
- `demo.test.ts` — `demo.json` is byte-identical to the repo fixture; it parses non-empty.
- `freshness.test.ts` — each tier boundary.
- `format.test.ts` — `formatPrice` thousands and two decimals; `formatPct` sign and two decimals;
  zero unsigned; `null` → `'—'`.
- `tiles.test.ts` — the fixture yields the documented order and ids; the band rule; every chip's
  membership; `availableChips` hides empty chips; heights positive and per the table; the
  `splitColumns` properties on the fixture and on a synthetic 40-tile feed; `findTile`.
- `photo.test.ts` — a 2×2 tile encodes to a PNG whose IHDR carries 2×2 and whose pixels index the
  ink palette; the board preview's `decode` still produces the same bytes it did (`screen.test.ts`
  unchanged and passing).
- `useEdition` — `nextEditionState` transition table.
- The simulator, firmware and desk are untouched; `sh server/test/run.sh` and the host tests are
  run once at the end as a regression check that nothing under `components/` moved.

## Documentation

- `app/README.md` — a "Reading the edition" section: what Today shows, where the data comes from,
  the demo, the cache, and why photos are memory-only.
- `docs/app-control.md` — one sentence under the desk's device plane noting the app is now a
  client of `/news.json`.
- The tile model and the height table live in the code, in `tiles.ts`'s header comment, because
  that is where the next change to them will be made.
