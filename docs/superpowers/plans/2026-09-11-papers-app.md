# Papers — App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today becomes a horizontal pager over the desk's papers — one current newspaper per watchlist company — and the Board tab can put any of them on the glass.

**Architecture:** One new seam and three surfaces. The seam is `EditionSource`: a value object that says where one edition's payload lives, how to build a tile URL for it, and what headers to send. Everything that used to resolve a picture from "the news URL" now asks the source, so the same reader renders an unauthenticated `/news.json` and an authenticated `/api/editions/<eid>/news.json` with no branch in it. Above that, `lib/papers/` holds the list (a module store in the `useEventBook.ts` idiom) and a per-edition payload cache, both decided by pure functions with tests. The three surfaces — Today's pager, the Board tab's section, the Settings row — are layout only, because this app has no component test runner.

**Tech Stack:** TypeScript, React Native 0.85 / Expo SDK 56, expo-router, AsyncStorage, Jest (`jest-expo` preset). The pager is a horizontal `FlatList` with `pagingEnabled` from `react-native` itself — `react-native-pager-view` is **not** a dependency of this app and this plan does not add one.

**Spec:** [docs/superpowers/specs/2026-09-11-papers-per-ticker-design.md](../specs/2026-09-11-papers-per-ticker-design.md) — this plan owns **section 5 (App)** and the App row of section 8. Sections 3 (desk) and 4 (worker) are separate plans landing in parallel.

## Global Constraints

These are the spec's project-wide requirements and the cross-plan interfaces. Every task's requirements implicitly include this section.

- **The wire this plan codes against, exactly.** The desk plan implements all four; nothing here may invent a field.
  - `GET /api/papers` (Bearer, producer) → `{ok: true, papers: [{symbol: string, name: string, edition_id: string|null, created_at: number|null (unix SECONDS), lang: string|null, headline: string|null, on_board: boolean, stale: boolean}], board: string|null}`, in watchlist order.
  - `GET /api/editions/<eid>/news.json` (Bearer, producer) → the same payload shape as `/news.json`, policy block spliced in, with `ETag` / `If-None-Match` → `304`.
  - `GET /api/editions/<eid>/tiles/<id>.bin` (Bearer, producer) → tile bytes, byte-for-byte the same format as `/tiles/<id>.bin`.
  - `POST /api/papers/<SYMBOL>/publish` (Bearer, operator) → `{ok: true, edition_id, state}`; `404 {ok: false, error: "no_paper"}`.
  - `GET/PUT /api/settings` now carries `paper_refresh_hours: number` (1..72) beside `lang`.
- **`DeskClient` method names are fixed by the cross-plan interface:** `papers()`, `editionPayload(eid, etag?)`, `editionTile(eid, id)`, `publishPaper(symbol)`.
- **`created_at` is unix SECONDS, not milliseconds.** Everything else in this app that carries a timestamp as a number (`fetchedAt`, `Date.now()`) is milliseconds. Multiply once, at the parse, and never again.
- **The pager appears only when the desk answers with at least one paper.** No token, no address, a desk that refuses, an empty list — every one of those leaves Today exactly as it is today: one page, `editionUrl(newsUrl, deskBaseUrl)`, `useEdition`. This is the rule that keeps the demo path byte-for-byte unchanged, and it is why the single-page reader stays mounted as the floor rather than being replaced by a spinner while `/api/papers` is out.
- **The operator token never reaches AsyncStorage, a log, or the message of anything thrown.** `desk.ts`'s existing rule. This plan puts the token in one new place — an `EditionSource.headers` object held in memory — and `store.ts`'s write path must stay a four-key write (`url`, `etag`, `fetchedAt`, `wire`) so it cannot follow an edition to disk. Task 1 pins that with a test.
- **Every user-visible string goes through i18n**, in both `en.ts` and `ko.ts`, with named placeholders (`{symbol}`), never concatenation. `i18n/index.test.ts` fails on a key present in Korean and still carrying the English sentence, and on a dropped placeholder.
- **`entryRouteFor` must be unaffected.** Nothing in this plan touches `src/onboarding/flow.ts`, `src/app/index.tsx`, or the three storage keys that decide the entry route.
- **Test commands.** Per task: `cd app && npx jest <path>`. Before every commit: `cd app && npm test && npm run typecheck`, and every commit leaves both green.
- **Every commit message ends with these two lines:**
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
  ```
- **Two ordering dependencies on the desk plan.** Tasks 1–11 are testable against fakes without a desk; only Task 13 needs the desk plan landed.
  1. `GET /api/papers`, the two per-edition routes and `POST /api/papers/<S>/publish` do not exist today. The pager rule above means an app shipped ahead of the desk degrades to today's Today rather than to an error.
  2. **`PUT /api/settings` refuses an unknown key over the whole document** (`settings.py`'s `_KEYS`, `bad_settings`). So Task 4's `putSettings` sends `paper_refresh_hours` **only when the desk's own GET reported one**. An app that always sent it would turn every language write against an older desk into a 400.

---

## File Structure

**Created:**
- `app/src/lib/papers/order.ts` — the pure decisions about the LIST: pager order, whether there is a pager at all, a paper's age label, index clamping. + `order.test.ts`
- `app/src/lib/papers/list.ts` — the module store over `GET /api/papers`: one copy, one clock, `usePapers()`, `loadPapers()`, and the remembered page index. Modelled on `lib/useEventBook.ts`. + `list.test.ts`
- `app/src/lib/papers/cache.ts` — the per-edition-id payload cache and `usePaperPage()`, plus the pure `paperPageOf()` that says what a page is showing. + `cache.test.ts`
- `app/src/lib/papers/publish.ts` — `runPaperPublish()`, the board-publish sequence as one testable function. + `publish.test.ts`
- `app/src/components/edition/PaperPage.tsx` — one page of the pager: header, the reader, its own source.
- `app/src/components/edition/PaperPageHeader.tsx` — symbol, name, age, and the "on the board" mark.
- `app/src/components/board/PaperSection.tsx` — the Board tab's "Paper on the board".
- `tools/mock_desk_server.py` — a mock desk for the simulator task, wrapping `tools/mock_news_server.py` rather than duplicating its fixture.

**Renamed:**
- `app/src/components/edition/editionUrl.tsx` → `app/src/components/edition/editionSource.tsx` — the context now carries an `EditionSource`, not a string.

**Modified:**
- `app/src/lib/edition/source.ts` (+ `source.test.ts`) — `EditionSource`, `deviceSource`, `paperSource`, `NO_SOURCE`, and `deviceTileUrl` moved in from `client.ts`.
- `app/src/lib/edition/client.ts` (+ `client.test.ts`) — `fetch` and `fetchTile` take headers; `tileUrl` moves out.
- `app/src/lib/edition/store.ts` (+ `store.test.ts`) — `CachedEdition.source`, and the four-key write pinned.
- `app/src/lib/edition/editionState.ts` — `demoCache()` carries a source.
- `app/src/lib/edition/useEdition.ts` — the fetched entry carries a source.
- `app/src/lib/edition/invalidate.ts` (+ `invalidate.test.ts`) — one mark, two readers.
- `app/src/lib/desk.ts` (+ `desk.test.ts`) — `Paper`, `PapersDoc`, `papers()`, `editionPayload()`, `editionTile()`, `editionSource()`, `publishPaper()`, and `paperRefreshHours` on `DeskSettings`.
- `app/src/components/edition/tiles/PhotoTile.tsx` — asks the source for the URL and the headers.
- `app/src/app/(tabs)/edition.tsx` — the pager over the existing reader.
- `app/src/app/(tabs)/board.tsx` — the section.
- `app/src/app/(tabs)/settings.tsx` — the cadence row.
- `app/src/app/tile/[id].tsx` — the provider takes the entry's own source.
- `app/src/i18n/en.ts`, `app/src/i18n/ko.ts`
- `docs/app-control.md`

---

### Task 1: `EditionSource` — one seam for "where this edition lives"

**Files:**
- Modify: `app/src/lib/edition/source.ts`, `app/src/lib/edition/source.test.ts`
- Modify: `app/src/lib/edition/client.ts:89,103,202` and `app/src/lib/edition/client.test.ts`
- Modify: `app/src/lib/edition/store.ts:40-52,72-91,122-136`, `app/src/lib/edition/store.test.ts`
- Modify: `app/src/lib/edition/editionState.ts:65-69`
- Modify: `app/src/lib/edition/useEdition.ts:88-94`
- Rename: `app/src/components/edition/editionUrl.tsx` → `app/src/components/edition/editionSource.tsx`
- Modify: `app/src/components/edition/tiles/PhotoTile.tsx:5,7,47,63`
- Modify: `app/src/app/(tabs)/edition.tsx:9,145`, `app/src/app/tile/[id].tsx:8,167`

**Interfaces:**
- Consumes: `editionUrl(newsUrl, deskBaseUrl)`, `tileUrl(newsUrl, id)` (moving), `EditionClient`, `CachedEdition`.
- Produces:
  - `export interface EditionSource { payloadUrl: string; tileUrl(id: string): string; headers: Readonly<Record<string, string>> }`
  - `export function deviceTileUrl(newsUrl: string, id: string): string` — the old `client.ts` `tileUrl`, moved verbatim
  - `export function deviceSource(newsUrl: string): EditionSource`
  - `export function paperSource(opts: { deskBaseUrl: string; editionId: string; token: string }): EditionSource`
  - `export const NO_SOURCE: EditionSource`
  - On `EditionClient`: `fetch(url: string, etag: string | null, headers?: Record<string, string>)`, `fetchTile(url: string, w: number, h: number, headers?: Record<string, string>)`
  - On `CachedEdition`: `source: EditionSource`
  - `export function EditionSourceProvider({ source, children }: { source: EditionSource; children: ReactNode })`, `export function useEditionSource(): EditionSource`

**Why this is one task and not three.** A photograph is fetched from "the news URL's directory" by a component three levels below the screen, through a context that carries a string. A paper's photograph lives behind a bearer token at a path derived from an edition id, and there is no string that can express that. Splitting the type change from the call sites would leave the tree uncompilable between two commits; splitting the client's headers off would leave the source unable to say the one thing it exists to say. **Nothing about the device plane's behaviour changes in this task** — `deviceSource(url).tileUrl(id)` is the old `tileUrl(url, id)`, and `headers` is `{}`.

- [ ] **Step 1: Write the failing tests**

**First, MOVE the existing `tileUrl` block.** `client.test.ts:250-286` is a `describe('tileUrl')` with eight assertions and `client.test.ts:9` imports `tileUrl` from `./client`. Cut the whole describe block out of that file, drop the import, and paste it into `source.test.ts` with every `tileUrl(` rewritten as `deviceTileUrl(` and the describe renamed. **Do not retype those assertions from memory** — they cover a bare authority, a query, a fragment and a `../` id, and each one is a bug that was found rather than imagined.

Then append to `app/src/lib/edition/source.test.ts`:

```ts
import { deviceSource, deviceTileUrl, NO_SOURCE, paperSource } from './source'

describe('deviceSource', () => {
  it('is the device plane: the URL as given, tiles beside it, and NO credential', () => {
    // The whole point of the device plane is that it carries none. A header here would send the
    // operator's token to whatever host the reader typed into the edition field.
    const s = deviceSource('http://desk.local:8123/news.json')
    expect(s.payloadUrl).toBe('http://desk.local:8123/news.json')
    expect(s.tileUrl('sndk_fab')).toBe('http://desk.local:8123/tiles/sndk_fab.bin')
    expect(s.headers).toEqual({})
  })

  it('folds an empty address to a source that can fetch nothing', () => {
    const s = deviceSource('')
    expect(s.payloadUrl).toBe('')
    expect(s.tileUrl('a')).toBe('')
  })
})

describe('paperSource', () => {
  it('addresses one edition on the control plane, with the bearer on both halves', () => {
    const s = paperSource({
      deskBaseUrl: 'https://desk.example.dev/',
      editionId: 'a1b2c3d4e5f60718',
      token: 'operator-token',
    })
    expect(s.payloadUrl).toBe('https://desk.example.dev/api/editions/a1b2c3d4e5f60718/news.json')
    expect(s.tileUrl('sndk_fab')).toBe(
      'https://desk.example.dev/api/editions/a1b2c3d4e5f60718/tiles/sndk_fab.bin',
    )
    expect(s.headers).toEqual({ Authorization: 'Bearer operator-token' })
  })

  it('percent-encodes both segments', () => {
    const s = paperSource({ deskBaseUrl: 'https://d', editionId: 'a/b', token: 't' })
    expect(s.payloadUrl).toBe('https://d/api/editions/a%2Fb/news.json')
    expect(s.tileUrl('x/y')).toBe('https://d/api/editions/a%2Fb/tiles/x%2Fy.bin')
  })
})

describe('NO_SOURCE', () => {
  it('fetches nothing and says nothing — the default a mount outside a provider gets', () => {
    expect(NO_SOURCE.payloadUrl).toBe('')
    expect(NO_SOURCE.tileUrl('a')).toBe('')
    expect(NO_SOURCE.headers).toEqual({})
  })
})
```

Append to `app/src/lib/edition/client.test.ts`:

```ts
const PAPER = 'https://d/api/editions/e1/news.json'

describe('the headers a fetch carries', () => {
  it('sends the caller’s headers beside Accept, so a paper can be authenticated', async () => {
    const { client: c, calls } = client([{ text: fixtureText(), headers: { ETag: '"abc"' } }])
    await c.fetch(PAPER, null, { Authorization: 'Bearer t' })
    expect(header(calls[0].init, 'Accept')).toBe('application/json')
    expect(header(calls[0].init, 'Authorization')).toBe('Bearer t')
  })

  it('still sends If-None-Match alongside them', async () => {
    const { client: c, calls } = client([{ status: 304 }])
    await c.fetch(PAPER, '"abc"', { Authorization: 'Bearer t' })
    expect(header(calls[0].init, 'If-None-Match')).toBe('"abc"')
    expect(header(calls[0].init, 'Authorization')).toBe('Bearer t')
  })

  it('sends a tile’s headers too — a paper’s photograph is behind the same token', async () => {
    const { client: c, calls } = client([{ bytes: new Uint8Array(8) }])
    await c.fetchTile('https://d/api/editions/e1/tiles/a.bin', 4, 4, { Authorization: 'Bearer t' })
    expect(header(calls[0].init, 'Authorization')).toBe('Bearer t')
  })

  it('sends no Authorization when the source has none', async () => {
    const { client: c, calls } = client([{ bytes: new Uint8Array(8) }])
    await c.fetchTile('http://d/tiles/a.bin', 4, 4)
    expect(header(calls[0].init, 'Authorization')).toBeUndefined()
  })
})
```

> `client(...)`, `fakeFetch`, `fixtureText()`, `header(...)` and the `{ status, text, bytes, headers }` reply shape all exist at the top of `client.test.ts:17-57`. Use them as they are; write no second fake.

Append to `app/src/lib/edition/store.test.ts`:

```ts
import { deviceSource } from './source'

describe('the source on a cache entry', () => {
  it('is rebuilt from the stored URL on a read', async () => {
    await AsyncStorage.setItem(
      EDITION_CACHE_KEY,
      JSON.stringify({ url: 'http://d/news.json', etag: '"a"', fetchedAt: 5, wire: demoWire() }),
    )
    __resetEditionStoreForTests()
    const entry = await readCachedEdition()
    expect(entry?.source.payloadUrl).toBe('http://d/news.json')
    expect(entry?.source.tileUrl('a')).toBe('http://d/tiles/a.bin')
    expect(entry?.source.headers).toEqual({})
  })

  it('NEVER reaches the disk, because a paper’s source carries a bearer token', async () => {
    // The one rule `desk.ts` is built around: the operator token is in one header and in nothing
    // that is written down. A paper's entry carries it in `source.headers`, and this write path is
    // the only thing between that object and AsyncStorage.
    await writeCachedEdition(
      entry({
        source: {
          payloadUrl: 'https://d/api/editions/e1/news.json',
          tileUrl: (id: string) => `https://d/api/editions/e1/tiles/${id}.bin`,
          headers: { Authorization: 'Bearer operator-token' },
        },
      }),
    )
    const raw = (await AsyncStorage.getItem(EDITION_CACHE_KEY)) ?? ''
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['etag', 'fetchedAt', 'url', 'wire'])
    expect(raw).not.toContain('operator-token')
    expect(raw).not.toContain('Authorization')
  })
})
```

`store.test.ts:26-34`'s `entry()` helper builds a `CachedEdition` literal, so it needs the new field to typecheck: add `source: deviceSource(URL),` to its defaults, above the `...over` spread.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx jest src/lib/edition/source.test.ts src/lib/edition/client.test.ts src/lib/edition/store.test.ts`
Expected: FAIL — `deviceSource is not a function`, `deviceTileUrl is not a function`, and the store test failing on `source` being absent.

- [ ] **Step 3: Add the source type and the two builders**

At the top of `app/src/lib/edition/source.ts`, after the existing `EDITION_PATH` declaration, add:

```ts
/**
 * WHERE ONE EDITION LIVES, as a value.
 *
 * Three facts and no behaviour: the address of the payload, how to turn a producer's tile id into
 * an address, and what headers both need. It exists because there are now TWO planes an edition
 * can arrive on and the reader must not know which it is looking at:
 *
 *   - the device plane — `GET /news.json` and `<its directory>/tiles/<id>.bin`, no credential,
 *     open to anything that can reach the desk; and
 *   - one paper — `GET /api/editions/<eid>/news.json` and `/api/editions/<eid>/tiles/<id>.bin`,
 *     behind the operator bearer.
 *
 * A STRING CANNOT EXPRESS THE SECOND. The old context carried the news URL and `PhotoTile` derived
 * the picture's address from it by string surgery; a paper's picture is not beside its payload in
 * any sense a directory join can reach, and it needs a header besides. So the resolution moves
 * from the consumer to the producer of the address, and every consumer asks rather than derives.
 *
 * `headers` is held IN MEMORY ONLY. `store.ts`'s write path persists four keys and this is not one
 * of them — see its header, and `store.test.ts`'s "NEVER reaches the disk".
 */
export interface EditionSource {
  /** The document to GET. `''` when there is nothing to fetch, which is what draws the demo. */
  payloadUrl: string
  /** That edition's tile, by the producer's id. `''` when there is nowhere to resolve against. */
  tileUrl(id: string): string
  /** Sent on the payload AND on every tile. `{}` on the device plane, and that is the point. */
  headers: Readonly<Record<string, string>>
}

/**
 * Where a DEVICE-PLANE photo tile lives: the news URL's DIRECTORY plus `tiles/<id>.bin`.
 *
 * Moved here from `client.ts` unchanged, because it is now one of two addressing rules and they
 * belong beside each other. The query and the fragment are removed first — a `?v=2` on the payload
 * does not belong on a picture, and a URL that carried one would 404 on every tile. The id is
 * percent-encoded because it is the producer's string and a `../` in it would resolve to a path
 * this app never meant to ask for.
 *
 * Returns `''` for anything with no directory to resolve beside; the caller treats that as "no
 * picture", which is the same outcome as a failed fetch and needs no second branch.
 */
export function deviceTileUrl(newsUrl: string, id: string): string {
  const path = newsUrl.split('#')[0].split('?')[0]
  const cut = path.lastIndexOf('/')
  // A bare `news.json` with no slash at all, or an empty string: nothing to resolve against.
  if (cut < 0) return ''
  // THE TRAP: a URL with no path at all — a bare authority like `http://host.local:8123` — still
  // has slashes, the scheme's own `//`. `lastIndexOf('/')` finds the second one of those, and
  // cutting there drops the host entirely: `http://tiles/id.bin`. Detect that case by checking
  // whether the cut point falls inside the scheme separator itself (index of '://', +2 for its
  // two slashes) rather than in an actual path segment, and resolve directly after the authority.
  const schemeEnd = path.indexOf('://')
  if (schemeEnd >= 0 && cut === schemeEnd + 2) {
    return `${path}/tiles/${encodeURIComponent(id)}.bin`
  }
  return `${path.slice(0, cut + 1)}tiles/${encodeURIComponent(id)}.bin`
}

/** The open plane. No credential, ever: this address is whatever the reader typed in Settings. */
export function deviceSource(newsUrl: string): EditionSource {
  return {
    payloadUrl: newsUrl,
    tileUrl: (id: string) => deviceTileUrl(newsUrl, id),
    headers: {},
  }
}

/**
 * One paper, on the desk's control plane.
 *
 * Both segments are percent-encoded even though the desk's own ids are 16 hex characters and a
 * producer's tile ids pass `TILE_ID_RE`: the edition id arrives over the network in a JSON field,
 * and a client that trusts a remote string to be path-safe is a client that can be told to ask for
 * a path it never meant to.
 */
export function paperSource(opts: {
  deskBaseUrl: string
  editionId: string
  token: string
}): EditionSource {
  const base = opts.deskBaseUrl.replace(/\/+$/, '')
  const dir = `${base}/api/editions/${encodeURIComponent(opts.editionId)}`
  return {
    payloadUrl: `${dir}/news.json`,
    tileUrl: (id: string) => `${dir}/tiles/${encodeURIComponent(id)}.bin`,
    headers: { Authorization: `Bearer ${opts.token}` },
  }
}

/** A source that can fetch nothing. The default outside a provider, and the demo's own. */
export const NO_SOURCE: EditionSource = deviceSource('')
```

- [ ] **Step 4: Let the client carry headers, and move `tileUrl` out**

In `app/src/lib/edition/client.ts`:

Widen the interface at `:87-90`:

```ts
export interface EditionClient {
  fetch(url: string, etag: string | null, headers?: Record<string, string>): Promise<EditionFetch>
  fetchTile(
    url: string,
    w: number,
    h: number,
    headers?: Record<string, string>,
  ): Promise<Uint8Array>
}
```

Delete the whole `tileUrl` function and its doc comment (`:92-118`) — it now lives in `source.ts` as `deviceTileUrl`.

In `fetchEdition`, take the extra argument and merge it into the header map it already builds:

```ts
  async function fetchEdition(
    url: string,
    etag: string | null,
    extra: Record<string, string> = {},
  ): Promise<EditionFetch> {
    if (url.trim() === '') throw new EditionError('no_url', 'no edition URL configured')

    // The source's headers FIRST, so nothing a caller passes can displace `Accept` or the
    // conditional question this function is responsible for asking correctly.
    const headers: Record<string, string> = { ...extra, Accept: 'application/json' }
```

and in `fetchTile`:

```ts
  async function fetchTile(
    url: string,
    w: number,
    h: number,
    extra: Record<string, string> = {},
  ): Promise<Uint8Array> {
    if (url.trim() === '') throw new EditionError('no_url', 'no tile URL')
    const res = await get(url, extra)
```

- [ ] **Step 5: Put the source on the cache entry**

In `app/src/lib/edition/store.ts`, add the import and the field:

```ts
import { deviceSource, type EditionSource } from './source'
```

In `CachedEdition`, after `edition`:

```ts
  /**
   * How to fetch this edition's pictures — and, for a paper, with what credential.
   *
   * DERIVED AND NEVER PERSISTED. A device-plane entry's source is `deviceSource(url)` and is
   * rebuilt on every read; a paper's carries a bearer token and is only ever in memory. The write
   * below stores four keys and this is not one of them, which is the whole reason it is safe for
   * this field to hold a credential at all.
   */
  source: EditionSource
```

In `sanitize()`, before the return, and in the returned object:

```ts
  return {
    url: o.url,
    etag: typeof o.etag === 'string' ? o.etag : null,
    fetchedAt: o.fetchedAt,
    wire: o.wire,
    edition,
    // Rebuilt, not read: nothing about a source is written down. An entry on disk is by
    // construction a device-plane one — a paper is cached in memory only (`lib/papers/cache.ts`).
    source: deviceSource(o.url),
  }
```

`writeCachedEdition`'s `stored` object is already exactly the four keys and must stay that way. Add one line to its comment:

```ts
    // The wire body, NOT the entry: `edition` is derived from `wire` on every read, and writing
    // both would store the same content twice in two spellings — the second of which is the one
    // the reader cannot use. See the header. `source` is left out for a harder reason: a paper's
    // carries the operator's bearer token, and this is the only path from one to a disk.
```

- [ ] **Step 6: Give the demo and the fetched entry their sources**

In `app/src/lib/edition/editionState.ts`, import and use it:

```ts
import { deviceSource } from './source'
```

```ts
export function demoCache(): CachedEdition {
  return {
    url: '',
    etag: null,
    fetchedAt: 0,
    wire: demoWire(),
    edition: demoEdition(),
    // `''` all the way down: the bundled edition's photographs are on no server this phone can
    // reach, which is why `editionToTiles` cuts it without them in the first place.
    source: deviceSource(''),
  }
}
```

In `app/src/lib/edition/useEdition.ts:88`, add the field to the entry it writes:

```ts
        const written = writeCachedEdition({
          url,
          etag: result.etag,
          fetchedAt,
          wire: result.wire,
          edition: result.edition,
          source: deviceSource(url),
        })
```

with `import { deviceSource, editionUrl } from './source'` replacing the existing `source` import at `:30`.

- [ ] **Step 7: Rename the context and make it carry the source**

```bash
git mv app/src/components/edition/editionUrl.tsx app/src/components/edition/editionSource.tsx
```

Then replace the body of the renamed file (keeping the existing doc comment's argument, updated for the new type):

```tsx
import { createContext, useContext, type ReactNode } from 'react'
import { NO_SOURCE, type EditionSource } from '../../lib/edition/source'

/**
 * WHERE THIS EDITION CAME FROM, for the one component that needs it.
 *
 * Only `PhotoTile` reads it, and only to build `source.tileUrl(photo.id)` with `source.headers`.
 * Everything between the screen and that one call was passing a string through untouched:
 * `Masonry` -> `EditionTile` -> `PhotoTile`, and `TileDetail` -> `DetailPhoto` -> `PhotoTile`.
 * Five components declared a prop that four of them had no use for.
 *
 * IT CARRIES A SOURCE AND NO LONGER A URL, because there are now two planes an edition can arrive
 * on and a string can only express one of them. See `lib/edition/source.ts`.
 *
 * A context and not a field on the tile, because the address belongs to the CACHE ENTRY and not to
 * the edition: `editionToTiles` is pure and knows nothing about where the JSON was served from.
 *
 * The default is `NO_SOURCE`, which resolves every id to `''` — so a mount outside a provider
 * draws its caption on a plain ground rather than throwing.
 */
const EditionSourceContext = createContext<EditionSource>(NO_SOURCE)

export function EditionSourceProvider({
  source,
  children,
}: {
  source: EditionSource
  children: ReactNode
}) {
  return <EditionSourceContext.Provider value={source}>{children}</EditionSourceContext.Provider>
}

/** How to fetch the pictures of the edition on screen. `NO_SOURCE` when there is nowhere. */
export function useEditionSource(): EditionSource {
  return useContext(EditionSourceContext)
}
```

- [ ] **Step 8: Point the three consumers at it**

`app/src/components/edition/tiles/PhotoTile.tsx` — replace the two imports at `:5,7` and the two call sites:

```tsx
import { editionClient } from '../../../lib/edition/client'
import { useEditionSource } from '../editionSource'
```

```tsx
  const src = useEditionSource()
  const url = src.tileUrl(photo.id)
```

```tsx
        const bytes = await editionClient.fetchTile(url, photo.w, photo.h, src.headers)
```

The effect's dependency list at `:91` stays `[url, photo.w, photo.h]`. **Do not add `src.headers` to it**: the object identity changes on every render of the provider's parent, which would re-fetch every photograph on every render, and the URL already moves whenever the credential's edition does.

`app/src/app/(tabs)/edition.tsx:9,145` and `app/src/app/tile/[id].tsx:8,167`:

```tsx
import { EditionSourceProvider } from '../../components/edition/editionSource'
```

```tsx
      <EditionSourceProvider source={state.cached.source}>
```

```tsx
      <EditionSourceProvider source={cached.source}>
```

(with the closing tags renamed to match).

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd app && npx jest src/lib/edition`
Expected: PASS, including every test that existed before this task.

- [ ] **Step 10: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add app/src/lib/edition app/src/components/edition app/src/app
git commit -m "$(cat <<'EOF'
refactor(app): an edition knows where it lives, credential and all

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
EOF
)"
```

---

### Task 2: The desk client learns the papers

**Files:**
- Modify: `app/src/lib/desk.ts` (types beside `Command` at `:239-286`; the interface at `:325-367`; the implementation at `:533-660`)
- Test: `app/src/lib/desk.test.ts`

**Interfaces:**
- Consumes: `createDeskClient`, `DeskClient`, `DeskError`, and the private `send` / `refusal` helpers already inside `createDeskClient`.
- Produces:
  - `export interface Paper { symbol: string; name: string; editionId: string | null; createdAt: number | null; lang: string | null; headline: string | null; onBoard: boolean; stale: boolean }`
  - `export interface PapersDoc { papers: Paper[]; board: string | null }`
  - `export type PublishPaperOutcome = { kind: 'published'; editionId: string; state: string } | { kind: 'no_paper' }`
  - On `DeskClient`: `papers(): Promise<PapersDoc>`, `publishPaper(symbol: string): Promise<PublishPaperOutcome>`

**Three decisions later tasks depend on.**

`createdAt` is **milliseconds** in this app's model and **seconds** on the wire. The multiply happens once, in `parsePaper`, and nothing downstream converts anything: every other timestamp the app holds as a number is milliseconds (`fetchedAt`, `Date.now()`), and a seconds-valued one leaking into `formatAge` renders "2 minutes ago" for something written in 1970.

A row this client cannot read is **dropped, not refused**. The opposite call from `command()`, and the reason is the same one `pushOf` gives: a paper list is a list of *other* symbols, and refusing the whole document over one malformed entry would take the pager down for four companies because the fifth has a broken row. A row with no `symbol` is the only thing that cannot be salvaged, because the symbol is what every later lookup is keyed on.

`publishPaper` answers `{kind: 'no_paper'}` for a 404 rather than throwing — the same rule as `publishNow`'s `nothing_staged` and `forgetPushDevice`'s 404. A symbol whose paper has been pruned since the list was fetched is a **state the row renders**, not a network failure a retry fixes.

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/desk.test.ts`:

```ts
const paperRow = (over: Record<string, unknown> = {}) => ({
  symbol: 'SNDK',
  name: 'SanDisk',
  edition_id: 'a1b2c3d4e5f60718',
  created_at: 1_757_000_000,
  lang: 'en',
  headline: 'The guide, not the buyback',
  on_board: true,
  stale: false,
  ...over,
})

const papersBody = (papers: unknown[], board: unknown = 'a1b2c3d4e5f60718') =>
  JSON.stringify({ ok: true, papers, board })

describe('deskClient.papers', () => {
  it('GETs /api/papers with the bearer and reads the rows in the order given', async () => {
    const { client: c, calls } = client([
      {
        text: papersBody([
          paperRow(),
          paperRow({ symbol: 'TSLA', name: 'Tesla', on_board: false }),
        ]),
      },
    ])
    const doc = await c.papers()
    expect(calls[0].url).toBe('https://desk.example.dev/api/papers')
    expect(calls[0].init?.method).toBe('GET')
    expect(header(calls[0].init, 'Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(doc.board).toBe('a1b2c3d4e5f60718')
    expect(doc.papers.map((p) => p.symbol)).toEqual(['SNDK', 'TSLA'])
    expect(doc.papers[0]).toEqual({
      symbol: 'SNDK',
      name: 'SanDisk',
      editionId: 'a1b2c3d4e5f60718',
      // SECONDS ON THE WIRE, MILLISECONDS IN THE MODEL. Everything else this app holds as a
      // number is a millisecond stamp, and one that is not renders as 1970.
      createdAt: 1_757_000_000_000,
      lang: 'en',
      headline: 'The guide, not the buyback',
      onBoard: true,
      stale: false,
    })
  })

  it('reads a symbol with no paper as a row of nulls, not as an absent row', async () => {
    // The pager draws a page for it saying the desk has not written one yet. Skipping it would
    // make a company disappear from the phone because it is new to the watchlist.
    const { client: c } = client([
      {
        text: papersBody([
          paperRow({
            symbol: 'MU',
            name: 'Micron',
            edition_id: null,
            created_at: null,
            lang: null,
            headline: null,
            on_board: false,
            stale: true,
          }),
        ]),
      },
    ])
    const doc = await c.papers()
    expect(doc.papers[0]).toMatchObject({
      symbol: 'MU',
      editionId: null,
      createdAt: null,
      headline: null,
      onBoard: false,
      stale: true,
    })
  })

  it('drops a row it cannot type instead of refusing the whole list', async () => {
    // Four companies must not vanish because the fifth has a broken row. `pushOf`'s rule.
    const { client: c } = client([
      { text: papersBody([{ name: 'no symbol here' }, paperRow({ symbol: 'TSLA' })]) },
    ])
    expect((await c.papers()).papers.map((p) => p.symbol)).toEqual(['TSLA'])
  })

  it('reads a desk with no current edition as board: null', async () => {
    const { client: c } = client([{ text: papersBody([paperRow({ on_board: false })], null) }])
    expect((await c.papers()).board).toBeNull()
  })

  it('refuses a 200 that carries no papers array at all', async () => {
    // A captive portal answering 200 for everything, or a desk not speaking this contract. An
    // empty pager drawn from it would say "no companies" about a watchlist with five.
    const { client: c } = client([{ text: '{"ok":true}' }])
    await expect(c.papers()).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('passes a refusal through with the desk’s own reason', async () => {
    const { client: c } = client([{ status: 403, text: '{"ok":false,"error":"forbidden"}' }])
    await expect(c.papers()).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

describe('deskClient.publishPaper', () => {
  it('POSTs to the symbol’s publish route and reads what was promoted', async () => {
    const { client: c, calls } = client([
      { text: '{"ok":true,"edition_id":"a1b2c3d4e5f60718","state":"published"}' },
    ])
    expect(await c.publishPaper('SNDK')).toEqual({
      kind: 'published',
      editionId: 'a1b2c3d4e5f60718',
      state: 'published',
    })
    expect(calls[0].url).toBe('https://desk.example.dev/api/papers/SNDK/publish')
    expect(calls[0].init?.method).toBe('POST')
  })

  it('reads “that paper is already on the board” without inventing a failure', async () => {
    const { client: c } = client([{ text: '{"ok":true,"edition_id":"e1","state":"unchanged"}' }])
    expect(await c.publishPaper('SNDK')).toEqual({
      kind: 'published',
      editionId: 'e1',
      state: 'unchanged',
    })
  })

  it('reads a 404 as “there is no paper for this symbol”, a state and not a failure', async () => {
    const { client: c } = client([{ status: 404, text: '{"ok":false,"error":"no_paper"}' }])
    expect(await c.publishPaper('MU')).toEqual({ kind: 'no_paper' })
  })

  it('percent-encodes the symbol into the path', async () => {
    const { client: c, calls } = client([
      { text: '{"ok":true,"edition_id":"e","state":"published"}' },
    ])
    await c.publishPaper('BRK.B')
    expect(calls[0].url).toBe('https://desk.example.dev/api/papers/BRK.B/publish')
  })

  it('refuses a 200 with no edition id — there is nothing to say went on the glass', async () => {
    const { client: c } = client([{ text: '{"ok":true,"state":"published"}' }])
    await expect(c.publishPaper('SNDK')).rejects.toMatchObject({ code: 'bad_json' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx jest src/lib/desk.test.ts`
Expected: FAIL — `c.papers is not a function`.

- [ ] **Step 3: Add the types and the row reader**

In `app/src/lib/desk.ts`, after the `Command` / `AskBody` / `PublishOutcome` block (`:239-286`), add:

```ts
/**
 * One company's current newspaper, as `GET /api/papers` reports it.
 *
 * A PAPER IS NOT A THING THE DESK STORES. It is the newest edition whose subject is this symbol,
 * derived on every read from the editions table (spec §2). So a row is a snapshot of an answer and
 * not an object with an identity: two fetches a minute apart can name two different `editionId`s
 * for the same symbol, and the pager is expected to follow.
 *
 * `editionId` is `null` for a symbol on the watchlist the desk has not written yet — a row of
 * nulls rather than an absent row, so the pager can say "not written yet" rather than silently
 * being one page shorter than the watchlist.
 */
export interface Paper {
  /** Uppercase, 1–8 characters. The key everything else is looked up by. */
  symbol: string
  /** From the watchlist item, not from the edition. `''` when the desk sent none. */
  name: string
  editionId: string | null
  /**
   * MILLISECONDS. The wire carries unix SECONDS and `parsePaper` multiplies once — every other
   * numeric stamp in this app is milliseconds, and mixing the two renders 1970.
   */
  createdAt: number | null
  lang: string | null
  /** The lead story's headline, for the row on the Board tab. */
  headline: string | null
  /** This is the edition currently on the glass. */
  onBoard: boolean
  /** Older than the desk's own `paper_refresh_hours`. The DESK decides this, not the phone. */
  stale: boolean
}

/** Every printable watchlist symbol, in watchlist order, and what is on the board. */
export interface PapersDoc {
  papers: Paper[]
  /** The current edition's id, or `null` for a desk that has published none. */
  board: string | null
}

/** What `POST /api/papers/<S>/publish` did. `no_paper` is a state — see the implementation. */
export type PublishPaperOutcome =
  | { kind: 'published'; editionId: string; state: string }
  | { kind: 'no_paper' }

/**
 * One row, or `null` for one this client cannot type.
 *
 * Only `symbol` is required, because it is what every lookup downstream is keyed on and there is
 * no honest default for it. Everything else falls back, because a row missing its `headline` is
 * still a paper worth paging to.
 */
function parsePaper(raw: unknown): Paper | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.symbol !== 'string' || o.symbol === '') return null
  const created =
    typeof o.created_at === 'number' && Number.isFinite(o.created_at) ? o.created_at * 1000 : null
  return {
    symbol: o.symbol,
    name: typeof o.name === 'string' ? o.name : '',
    editionId: typeof o.edition_id === 'string' && o.edition_id !== '' ? o.edition_id : null,
    createdAt: created,
    lang: typeof o.lang === 'string' && o.lang !== '' ? o.lang : null,
    headline: typeof o.headline === 'string' && o.headline !== '' ? o.headline : null,
    onBoard: o.on_board === true,
    stale: o.stale === true,
  }
}
```

- [ ] **Step 4: Declare the two methods on the interface**

In the `DeskClient` interface, below `publishNow()`:

```ts
  /**
   * Every printable watchlist symbol's current paper, in watchlist order.
   *
   * The ORDER IS THE DESK'S and is carried through untouched — `orderPapers` in
   * `lib/papers/order.ts` is the only thing allowed to move a row, and it moves exactly one.
   */
  papers(): Promise<PapersDoc>
  /** Put one symbol's newest edition on the glass. `no_paper` is an outcome, not a throw. */
  publishPaper(symbol: string): Promise<PublishPaperOutcome>
```

- [ ] **Step 5: Implement them**

Inside `createDeskClient`, beside `commandOf`, add the envelope reader:

```ts
  // The paper list. A row this client cannot type is DROPPED, `pushOf`'s rule and for `pushOf`'s
  // reason: the list is mostly about other companies, and refusing the document over one bad entry
  // would take the whole pager down. A missing `papers` array is different and does refuse — that
  // is a desk not speaking this contract, and an empty pager drawn from it would say "no
  // companies" about a watchlist with five.
  async function papersOf(res: Response): Promise<PapersDoc> {
    if (!res.ok) throw await refusal(res, 'papers')
    let payload: unknown
    try {
      payload = JSON.parse(await res.text())
    } catch {
      throw new DeskError('bad_json', 'papers did not answer JSON', res.status)
    }
    const envelope = payload as { papers?: unknown; board?: unknown } | null
    if (!Array.isArray(envelope?.papers)) {
      throw new DeskError('bad_json', 'papers answered a list this app cannot read', res.status)
    }
    const rows: Paper[] = []
    for (const raw of envelope.papers) {
      const row = parsePaper(raw)
      if (row !== null) rows.push(row)
    }
    const board = envelope.board
    return { papers: rows, board: typeof board === 'string' && board !== '' ? board : null }
  }
```

and the two methods in the returned object, after `publishNow`:

```ts
    async papers(): Promise<PapersDoc> {
      return papersOf(await send('/api/papers', { method: 'GET' }))
    },

    async publishPaper(symbol: string): Promise<PublishPaperOutcome> {
      const res = await send(`/api/papers/${encodeURIComponent(symbol)}/publish`, {
        method: 'POST',
      })
      // THE 404 RULE AGAIN, over the narrowest fact this client has: the list said there was a
      // paper and by the time the tap landed there was not — pruned, or the symbol dropped off the
      // watchlist between the fetch and the finger. The row redraws as "no paper yet"; a thrown
      // error would put a network banner over a desk that answered perfectly well.
      if (res.status === 404) return { kind: 'no_paper' }
      if (!res.ok) throw await refusal(res, 'papers')
      let payload: unknown
      try {
        payload = JSON.parse(await res.text())
      } catch {
        throw new DeskError('bad_json', 'publish did not answer JSON', res.status)
      }
      const o = payload as { edition_id?: unknown; state?: unknown } | null
      // Without an edition id there is nothing to say went on the glass, and the Board row would
      // tick itself against an answer that named nothing.
      if (typeof o?.edition_id !== 'string' || o.edition_id === '') {
        throw new DeskError('bad_json', 'publish answered without an edition', res.status)
      }
      return {
        kind: 'published',
        editionId: o.edition_id,
        state: typeof o.state === 'string' ? o.state : '',
      }
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd app && npx jest src/lib/desk.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```
git add app/src/lib/desk.ts app/src/lib/desk.test.ts
git commit
```

with the message:

```
feat(app): the desk client can list the papers and put one on the board

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 3: The desk client addresses one edition

**Files:**
- Modify: `app/src/lib/desk.ts` (the interface, and the returned object)
- Test: `app/src/lib/desk.test.ts`

**Interfaces:**
- Consumes: Task 1's `EditionSource`, `paperSource`, and `editionClient` / `EditionFetch` from `lib/edition/client.ts`; Task 2's `Paper`.
- Produces, on `DeskClient`:
  - `editionSource(editionId: string): EditionSource`
  - `editionPayload(editionId: string, etag?: string | null): Promise<EditionFetch>`

**Why this delegates instead of fetching for itself, and where `editionTile` went.**

`GET /api/editions/<eid>/news.json` answers the same document as `GET /news.json`, so it has to be read the same way: the board's 320 KB cap, the board's fifteen-second deadline, `parseEdition`, and `isEmptyEdition` refusing a 200 that carries furniture and no content. Every one of those lives in `lib/edition/client.ts` and none of them is about the control plane. So `editionPayload` builds the authenticated address and the header and hands both to `editionClient.fetch` — one parser, one cap, one failure vocabulary (`EditionError`, which the Today screen already draws through `humanEditionError`). A second reader inside `desk.ts` would be a second chance to disagree about what a valid edition is, and the disagreement would show up as one plane rendering a page the other refuses.

**`editionTile(eid, id)` is deliberately NOT a method here.** The app's only tile consumer is `PhotoTile`, three levels below any screen, and it reaches its bytes through the `EditionSource` in context — `source.tileUrl(id)` plus `source.headers` into `editionClient.fetchTile`, which checks the body against `w*h/2` before it is decoded. A `DeskClient.editionTile` would be a second path to the same route with no geometry to check against, and its only possible caller would be the one that already has a better one. The route itself is coded against exactly, by `paperSource().tileUrl` in Task 1. This is the one place this plan departs from the cross-plan method list, and it departs in the direction of having no unreachable code.

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/desk.test.ts`:

```ts
import { readFileSync } from 'fs'
import { join } from 'path'

const EDITION_FIXTURE = join(
  __dirname,
  '../../../components/news_core/test/host/fixtures/news.json',
)

describe('deskClient.editionSource', () => {
  it('addresses one edition, payload and pictures, with the bearer on both', () => {
    const { client: c } = client([])
    const s = c.editionSource('a1b2c3d4e5f60718')
    expect(s.payloadUrl).toBe(
      'https://desk.example.dev/api/editions/a1b2c3d4e5f60718/news.json',
    )
    expect(s.tileUrl('sndk_fab')).toBe(
      'https://desk.example.dev/api/editions/a1b2c3d4e5f60718/tiles/sndk_fab.bin',
    )
    expect(s.headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
  })
})

describe('deskClient.editionPayload', () => {
  it('GETs the edition through the edition client, bearer and Accept together', async () => {
    const { client: c, calls } = client([
      { text: readFileSync(EDITION_FIXTURE, 'utf8'), headers: { ETag: '"e1"' } },
    ])
    const got = await c.editionPayload('a1b2c3d4e5f60718')
    expect(calls[0].url).toBe(
      'https://desk.example.dev/api/editions/a1b2c3d4e5f60718/news.json',
    )
    expect(header(calls[0].init, 'Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(header(calls[0].init, 'Accept')).toBe('application/json')
    expect(got.status).toBe('ok')
    if (got.status !== 'ok') throw new Error('unreachable')
    expect(got.etag).toBe('"e1"')
    // THE SAME PARSE THE DEVICE PLANE GETS, and the same wire body carried beside it — the cache
    // stores wire bodies, not parsed editions (`edition/store.ts`'s header). A paper read by a
    // second parser would be a second newspaper maintained as one.
    expect(got.edition.subject.symbol).not.toBe('')
    expect(got.wire).toEqual(JSON.parse(readFileSync(EDITION_FIXTURE, 'utf8')))
  })

  it('asks the conditional question when it holds a tag, and reads the 304', async () => {
    const { client: c, calls } = client([{ status: 304 }])
    expect(await c.editionPayload('e1', '"e1"')).toEqual({ status: 'not_modified' })
    expect(header(calls[0].init, 'If-None-Match')).toBe('"e1"')
  })

  it('fails as an EditionError, not a DeskError — Today already draws those sentences', async () => {
    const { client: c } = client([{ status: 404, text: '{"ok":false,"error":"not_found"}' }])
    await expect(c.editionPayload('gone')).rejects.toMatchObject({
      name: 'EditionError',
      code: 'http',
      status: 404,
    })
  })
})
```

> The fake in `desk.test.ts:22-34` answers only `{ok, status, text}`. `editionClient` needs `headers.get()` and `arrayBuffer()`, so **widen that fake** to match the one in `edition/client.test.ts:26-49` — add the `headers` reply key with a case-insensitive `get`, and an `arrayBuffer` built from the reply's text. Widening the existing fake, not adding a second: two fakes in one file is two answers to "what does a response look like here".

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx jest src/lib/desk.test.ts`
Expected: FAIL — `c.editionSource is not a function`.

- [ ] **Step 3: Declare the two methods**

In `app/src/lib/desk.ts`, add the imports at the top:

```ts
import { editionClient, type EditionFetch } from './edition/client'
import { paperSource, type EditionSource } from './edition/source'
```

and on the `DeskClient` interface, below `publishPaper`:

```ts
  /**
   * How to reach one stored edition — its payload, its pictures, and the header both need.
   *
   * Handed to the reader as a value so nothing below the screen has to know which plane it is
   * rendering: `lib/edition/source.ts` explains why that is a value and not a string.
   */
  editionSource(editionId: string): EditionSource
  /**
   * One stored edition, read exactly as the device plane's is.
   *
   * Answers `EditionFetch` and throws `EditionError`, not `DeskError`, and that is deliberate:
   * this route serves the same document as `/news.json` under the same 320 KB cap, and the Today
   * screen already has a sentence for every way that can fail (`humanEditionError`).
   */
  editionPayload(editionId: string, etag?: string | null): Promise<EditionFetch>
```

- [ ] **Step 4: Implement them**

In the returned object, after `publishPaper`:

```ts
    editionSource(editionId: string): EditionSource {
      return paperSource({ deskBaseUrl: baseUrl, editionId, token: opts.token })
    },

    async editionPayload(editionId: string, etag: string | null = null): Promise<EditionFetch> {
      // NOT `send()`. `send` is the control plane's envelope reader and this route does not answer
      // an envelope — it answers an edition, and the one thing in this app that knows what a valid
      // edition is lives in `edition/client.ts`. What this method contributes is the address and
      // the credential; the cap, the deadline, the conditional GET and the parse are that client's,
      // unchanged, so a paper and the board's own edition are read by the same code.
      const src = paperSource({ deskBaseUrl: baseUrl, editionId, token: opts.token })
      return editionClient.fetch(src.payloadUrl, etag, src.headers)
    },
```

> `createDeskClient` takes a `fetchFn` and `editionClient` is a module singleton built around the global `fetch`, so **the singleton will not see a test's fake**. Give `createDeskClient` its own edition client instead: at the top of `createDeskClient`, `const editions = opts.fetchFn === undefined ? editionClient : createEditionClient({ fetchFn: opts.fetchFn, timeoutMs })`, import `createEditionClient` beside `editionClient`, and call `editions.fetch(...)` above. One line, and it is what makes the tests in step 1 exercise the real path rather than the network.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd app && npx jest src/lib/desk.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add app/src/lib/desk.ts app/src/lib/desk.test.ts
git commit
```

with the message:

```
feat(app): the desk client can read one stored edition

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 4: The settings document carries the cadence

**Files:**
- Modify: `app/src/lib/desk.ts:52-56` (`DeskSettings`), `:420-434` (`settingsOf`), `:533-552` (`putSettings`)
- Test: `app/src/lib/desk.test.ts` — **and the four existing `getSettings` / `putSettings` tests at `:48-95` change**, because `DeskSettings` gains a field.

**Interfaces:**
- Produces:
  - `export interface DeskSettings { lang: string; paperRefreshHours: number | null }`
  - `export const PAPER_REFRESH_MIN = 1`, `export const PAPER_REFRESH_MAX = 72`

**The one decision, and it is the ordering constraint from the header made concrete.**

`paperRefreshHours` is `number | null`, and `null` means **this desk did not report one** — an older desk, or a `settings.json` written before the field existed. It is not "not read yet"; the screen holds `DeskSettings | null` for that.

That distinction is load-bearing rather than tidy. `PUT /api/settings` refuses an unknown key over the whole document with `bad_settings`, so a phone that always sent `paper_refresh_hours` would turn **every language write against an older desk** into a 400 — a feature that has nothing to do with this one, breaking for everyone who upgrades their phone before their desk. So `putSettings` sends the key only when the caller passes a number, and the caller only has a number because the desk's own GET gave it one.

An out-of-range or non-integer value reads as `null` rather than being clamped. Clamping would draw a chip the desk never agreed to and offer to "change" the cadence to the value it already claims — the same argument `settingsOf` already makes about a language this app does not offer.

- [ ] **Step 1: Write the failing tests**

In `app/src/lib/desk.test.ts`, change `okBody` to carry the new field and update the four existing assertions, then append the new block:

```ts
// The desk's settings document, as a current desk answers it. `paper_refresh_hours` joined it
// with the papers feature; `okBodyNoPapers` below is what an older one still answers.
const okBody = (lang: string, hours: number | null = 12) =>
  JSON.stringify({
    ok: true,
    source: 'file',
    settings: hours === null ? { lang } : { lang, paper_refresh_hours: hours },
  })
```

```ts
describe('deskClient settings — the paper cadence', () => {
  it('reads the cadence beside the language', async () => {
    const { client: c } = client([{ text: okBody('ko', 6) }])
    expect(await c.getSettings()).toEqual({ lang: 'ko', paperRefreshHours: 6 })
  })

  it('reads a desk that does not carry the field as null, not as a default', async () => {
    // NOT 12. A default invented here would draw a chip the desk never agreed to, on a desk that
    // has no such setting at all — and the row's own note is the honest thing to show instead.
    const { client: c } = client([{ text: okBody('en', null) }])
    expect(await c.getSettings()).toEqual({ lang: 'en', paperRefreshHours: null })
  })

  it('reads a value outside 1..72, or a fractional one, as null rather than clamping it', async () => {
    for (const bad of [0, 73, 12.5, -1]) {
      const { client: c } = client([
        { text: JSON.stringify({ ok: true, settings: { lang: 'en', paper_refresh_hours: bad } }) },
      ])
      expect((await c.getSettings()).paperRefreshHours).toBeNull()
    }
  })

  it('PUTs both fields when it has both', async () => {
    const { client: c, calls } = client([{ text: okBody('ko', 24) }])
    await c.putSettings({ lang: 'ko', paperRefreshHours: 24 })
    expect(calls[0].init?.body).toBe('{"lang":"ko","paper_refresh_hours":24}')
  })

  it('OMITS the key when it has no cadence, so an older desk still takes a language write', async () => {
    // `settings.py` refuses an unknown key over the WHOLE document. A phone that always sent this
    // would turn every language write against a desk one release behind into a 400 — a feature
    // breaking for a reason that has nothing to do with it.
    const { client: c, calls } = client([{ text: okBody('ko', null) }])
    await c.putSettings({ lang: 'ko', paperRefreshHours: null })
    expect(calls[0].init?.body).toBe('{"lang":"ko"}')
  })

  it('answers with what is IN FORCE, not with what was asked for', async () => {
    const { client: c } = client([{ text: okBody('ko', 12) }])
    expect(await c.putSettings({ lang: 'ko', paperRefreshHours: 1 })).toEqual({
      lang: 'ko',
      paperRefreshHours: 12,
    })
  })
})
```

Then fix the four existing expectations: `:52` `expect(await c.getSettings()).toEqual({ lang: 'ko' })` becomes `toEqual({ lang: 'ko', paperRefreshHours: 12 })`; `:69` likewise for `'fr'`; `:75` `putSettings({ lang: 'ko' })` becomes `putSettings({ lang: 'ko', paperRefreshHours: 12 })` and its body assertion becomes `'{"lang":"ko","paper_refresh_hours":12}'`. Read them and adjust each to match — do not delete one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx jest src/lib/desk.test.ts`
Expected: FAIL — the new block on `paperRefreshHours` being `undefined`, and the four old ones on the added key.

- [ ] **Step 3: Widen the type**

In `app/src/lib/desk.ts`, replace the `DeskSettings` declaration:

```ts
/** The lowest and highest cadence the desk takes, `settings.py`'s own range. */
export const PAPER_REFRESH_MIN = 1
export const PAPER_REFRESH_MAX = 72

/** The desk's settings document, as this app uses it. Two fields; the route owns the shape. */
export interface DeskSettings {
  /** BCP-47 primary subtag — `en`, `ko`, or anything else the desk has been set to. */
  lang: string
  /**
   * How often the desk refreshes each company's paper, in hours, 1..72.
   *
   * `null` MEANS THE DESK DID NOT REPORT ONE — an older release, or a hand-written
   * `settings.json` — and NOT "not read yet", which is `DeskSettings | null` at the call site.
   * The distinction decides whether `putSettings` may send the key at all: see its comment.
   */
  paperRefreshHours: number | null
}
```

- [ ] **Step 4: Read it, and write it only when there is one**

In `settingsOf`, after the `lang` check and before the return:

```ts
    // Absent, out of range, or fractional all read the same way: this desk has no cadence this
    // app can draw. Clamping would put a chip on screen the desk never agreed to, and the row
    // would then offer to "change" the cadence to the value it already claims — the same argument
    // the `lang` arm above makes about a language this app does not offer.
    const raw = (JSON.parse(text) as { settings?: { paper_refresh_hours?: unknown } })?.settings
      ?.paper_refresh_hours
    const hours =
      typeof raw === 'number' &&
      Number.isInteger(raw) &&
      raw >= PAPER_REFRESH_MIN &&
      raw <= PAPER_REFRESH_MAX
        ? raw
        : null
    return { lang, paperRefreshHours: hours }
```

> `settingsOf` currently reads `await res.text()` inside its own `try`. Hoist that string into a `const text` above the `try` and parse once, rather than calling `res.text()` a second time — a `Response` body can only be read once, and the fake in the tests is more forgiving than the real one.

In `putSettings`, replace the body:

```ts
      // `lang` always; the cadence ONLY when this phone actually has one from the desk's own GET.
      // The desk refuses an unknown key over the whole document (`bad_settings`), so a client that
      // always sent `paper_refresh_hours` would turn every language write against a desk one
      // release behind into a 400 — a feature breaking for a reason unrelated to it.
      const wire: Record<string, unknown> = { lang: settings.lang }
      if (settings.paperRefreshHours !== null) {
        wire.paper_refresh_hours = settings.paperRefreshHours
      }
      const res = await send('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wire),
      })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd app && npx jest src/lib/desk.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS. `settings.tsx:839` calls `putSettings({ lang: next })` and will now fail to typecheck — fix it here by threading the cadence the screen already read: `putSettings({ lang: next, paperRefreshHours: hours })`, where `hours` is whatever the last `getSettings` reported. Task 11 rebuilds that state properly; this step only has to keep the build green, so the minimal change is to hold the whole `DeskSettings` in the screen's state instead of just `lang` and pass its `paperRefreshHours` through unchanged.

- [ ] **Step 7: Commit**

```
git add app/src/lib/desk.ts app/src/lib/desk.test.ts "app/src/app/(tabs)/settings.tsx"
git commit
```

with the message:

```
feat(app): the settings document carries the paper cadence

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 5: What the pager shows, decided in pure functions

**Files:**
- Create: `app/src/lib/papers/order.ts`
- Test: `app/src/lib/papers/order.test.ts`

**Interfaces:**
- Consumes: `Paper`, `PapersDoc` from `../desk` (Task 2); `formatAge` from `../format`; `strings` / `fill` from `../../i18n`.
- Produces:
  - `export function orderPapers(doc: PapersDoc): Paper[]`
  - `export function papersPagerView(input: { ready: boolean | null; doc: PapersDoc | null }): { pager: boolean; papers: Paper[] }`
  - `export function paperAgeLabel(createdAt: number | null, now: number): string | null`
  - `export function clampPaperIndex(index: number, count: number): number`
  - `export function paperKey(paper: Paper): string`

**Why these are four functions in a file rather than four expressions in a screen.** This app has no component test runner. Anything decided inside a `.tsx` is decided in prose, and the spec's App test row names three of these four by name: pager order with the board's paper first, the placeholder page, and no pager without a token. They are the argument; the screen is the drawing.

**The order rule is one move, not a sort.** The desk answers in watchlist order and that order is the owner's own — it is the sequence they see everywhere else in this app. `orderPapers` moves exactly one row, the one that is on the board, to the front. A `sort` with a comparator would be free to move others as a side effect of a tie, and there is nothing it could be sorting *by* that the owner asked for.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/papers/order.test.ts`:

```ts
import { describe, it, expect, beforeEach } from '@jest/globals'
import {
  clampPaperIndex,
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx jest src/lib/papers/order.test.ts`
Expected: FAIL — `Cannot find module './order'`.

- [ ] **Step 3: Write the implementation**

Create `app/src/lib/papers/order.ts`:

```ts
// What the pager shows, and in what order.
//
// Four decisions, all pure, all here rather than inside `edition.tsx`, for the reason every other
// `lib/` file in this app gives: there is no component test runner, so a rule argued inside a
// `.tsx` is argued only in prose. The spec's App test row names three of these by name.

import { fill, strings } from '../../i18n'
import { formatAge } from '../format'
import { type Paper, type PapersDoc } from '../desk'

/**
 * Pager order: the board's paper first, then the desk's order untouched.
 *
 * ONE MOVE, NOT A SORT. The desk answers in WATCHLIST order, which is the owner's own sequence and
 * the one they see on every other surface in this app; the only thing that outranks it is "the one
 * that is actually on the glass, which is what you came to look at". A comparator would be free to
 * reorder rows that tie, and there is nothing else here worth sorting by — `stale` is the desk's
 * judgement about refresh, not about what the reader wants first.
 *
 * Exactly one row moves even if the desk marked two. Two `on_board` rows cannot happen against a
 * correct desk (`current` is one pointer), and if one ever arrives, promoting both would reorder
 * the list a second way and make the pager jump on a refetch for a reason nothing on screen
 * explains.
 */
export function orderPapers(doc: PapersDoc): Paper[] {
  const at = doc.papers.findIndex((p) => p.onBoard)
  if (at <= 0) return [...doc.papers]
  const rows = [...doc.papers]
  const [board] = rows.splice(at, 1)
  return [board, ...rows]
}

/**
 * Whether Today is a pager at all, and over what.
 *
 * THE PAGER IS A LAYER OVER THE SINGLE-PAGE READER, NOT A REPLACEMENT FOR IT. Every state that is
 * not "the desk answered with at least one paper" answers `pager: false`, and the screen then draws
 * exactly what it draws today: one page, `editionUrl(newsUrl, deskBaseUrl)`, `useEdition`. That
 * covers a phone with no desk, a desk that refused, a desk one release behind that has no
 * `/api/papers` at all, an empty watchlist, and the first frame of every cold launch before storage
 * has answered — and it is what makes "without a token, Today is unchanged" a property of one
 * function rather than a promise.
 *
 * `ready` is `null` while storage has not answered about the address and the token. It is folded in
 * with `false` here because the outcome is the same; it is a separate state to the CALLER, which
 * must not start a fetch on it.
 */
export function papersPagerView(input: {
  ready: boolean | null
  doc: PapersDoc | null
}): { pager: boolean; papers: Paper[] } {
  if (input.ready !== true || input.doc === null) return { pager: false, papers: [] }
  const papers = orderPapers(input.doc)
  return { pager: papers.length > 0, papers }
}

/**
 * How long ago the desk wrote this paper — `6h ago`, `6시간 전` — or `null`.
 *
 * `formatAge` and not `freshnessLabel`, and the difference matters: `freshnessLabel` answers null
 * under five minutes because an edition confirmed a moment ago should read as current with no
 * label. This line answers a different question — how old is this company's paper, against a
 * cadence measured in HOURS — and a page whose header went blank for five minutes after a refresh
 * would look like the header had failed.
 *
 * In the APP's language, not the edition's. This row is the app talking about a paper; the paper's
 * own language governs the type below it (`typeRamp.tsx`) and nothing up here.
 *
 * `null` for a symbol with no paper, and `null` for a stamp in the future — a desk whose clock is
 * ahead. `-1h ago` is worse than silence, which is `freshnessLabel`'s rule and holds here too.
 */
export function paperAgeLabel(createdAt: number | null, now: number): string | null {
  if (createdAt === null || !Number.isFinite(createdAt) || createdAt <= 0) return null
  const ageMs = now - createdAt
  if (ageMs < 0) return null
  return formatAge(ageMs / 1000)
}

/**
 * A remembered page index, held against a list that may have changed under it.
 *
 * The watchlist is the desk's and moves without the phone asking: a symbol added is a page
 * inserted, a symbol removed is a page gone. The index is remembered for the session (see
 * `list.ts`), so it has to survive both.
 */
export function clampPaperIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0
  return Math.min(Math.max(Math.trunc(index), 0), count - 1)
}

/**
 * The identity of a page, for React's key and for nothing else.
 *
 * SYMBOL AND EDITION TOGETHER. The symbol alone would keep a page mounted across a refresh that
 * gave that company a NEW edition, and `PhotoTile`'s effect keys on the tile URL — which contains
 * the edition id, so it would in fact refetch — but `editionToTiles` would be re-cut under a
 * mounted masonry rather than remounted, which is exactly the "yesterday's photograph under
 * today's caption" failure `feedLayout.ts`'s `editionKey` exists to prevent. The edition alone
 * would collide across the symbols that have no edition at all.
 */
export function paperKey(paper: Paper): string {
  return `${paper.symbol}:${paper.editionId ?? ''}`
}
```

> `fill` and `strings` are imported for the doc above but `formatAge` does the formatting; if the implementation ends up not using them, drop the import rather than leaving it — `npm run typecheck` will say so.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx jest src/lib/papers/order.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add app/src/lib/papers/order.ts app/src/lib/papers/order.test.ts
git commit
```

with the message:

```
feat(app): the pager's order, its gate and its ages, decided in one place

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 6: The paper list — one copy, one clock, one mark

**Files:**
- Create: `app/src/lib/papers/list.ts`, `app/src/lib/papers/list.test.ts`
- Modify: `app/src/lib/edition/invalidate.ts`, `app/src/lib/edition/invalidate.test.ts`

**Interfaces:**
- Consumes: `createDeskClient`, `PapersDoc` (Task 2); `getDeskToken` from `../deskToken`; `getDeskBaseUrl` from `../store`; `takePapersStale` from `../edition/invalidate`.
- Produces:
  - `export interface PapersState { ready: boolean | null; doc: PapersDoc | null }`
  - `export const PAPERS_REFRESH_AFTER_MS = 5 * 60_000`
  - `export function papersFetchDue(input: { now: number; fetchedAt: number; address: string; cachedAddress: string | null; cachedReady: boolean | null; forced: boolean }): boolean`
  - `export function loadPapers(): Promise<void>`
  - `export function usePapers(): PapersState & { load: () => Promise<void> }`
  - `export function rememberPaperIndex(index: number): void`, `export function lastPaperIndex(): number`
  - `export function __resetPapersForTests(): void`
  - In `invalidate.ts`: `export function takePapersStale(): boolean`, and `markEditionStale()` now sets both bits.

**Two design notes that decide the whole file.**

**One copy in module scope, in `lib/useEventBook.ts`'s idiom, not a `useState` per hook.** Two surfaces read this list — Today's pager and the Board tab's section — and they can be mounted at once. A copy each would give them a fetch each and let them disagree about which paper is on the board, which is precisely the fact one of them draws a tick beside. `useSyncExternalStore` is how a component subscribes; there is one snapshot and every reader sees it.

**`markEditionStale()` already means "the paper changed underneath us", so it marks both.** The ask thread calls it after a `revised` and after a publish (`useAskThread.ts:256,338`); the Board tab will call it after putting a paper on the glass. Every one of those changes what `/api/papers` would answer as well as what `/news.json` would. Adding a second call beside each would give two marks that have to be kept in step by hand, and the first place they would drift is the one added next. So `invalidate.ts` keeps one writer and gains a second reader — **and `useAskThread.ts` is not touched by this task at all.**

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/edition/invalidate.test.ts`:

```ts
import { markEditionStale, takeEditionStale, takePapersStale } from './invalidate'
import { __resetEditionStaleForTests } from './invalidate'

describe('one mark, two readers', () => {
  beforeEach(() => __resetEditionStaleForTests())

  it('marks the paper list as well as the edition on screen', () => {
    // A `revised` rewrote an edition. That is also a new `created_at` for that company's paper and
    // possibly a new `edition_id` on the board, so both readers have stale answers.
    markEditionStale()
    expect(takeEditionStale()).toBe(true)
    expect(takePapersStale()).toBe(true)
  })

  it('gives each reader its own bit, so one taking it does not rob the other', () => {
    markEditionStale()
    expect(takeEditionStale()).toBe(true)
    expect(takeEditionStale()).toBe(false)
    // Today's pager may not even be mounted when the edition reader takes its bit.
    expect(takePapersStale()).toBe(true)
    expect(takePapersStale()).toBe(false)
  })

  it('is clear to start with', () => {
    expect(takePapersStale()).toBe(false)
  })
})
```

Create `app/src/lib/papers/list.test.ts`:

```ts
import { describe, it, expect } from '@jest/globals'
import { PAPERS_REFRESH_AFTER_MS, papersFetchDue } from './list'

const base = {
  now: 1_000_000,
  fetchedAt: 1_000_000 - 1000,
  address: 'https://desk.example.dev',
  cachedAddress: 'https://desk.example.dev',
  cachedReady: true as boolean | null,
  forced: false,
}

describe('papersFetchDue', () => {
  it('is the same five minutes Today already waits', () => {
    // Today's focus re-check is throttled to `FOCUS_REFRESH_AFTER_MS`. The list and the page it
    // frames must move on the same clock, or a header would say one thing and the sheet another.
    expect(PAPERS_REFRESH_AFTER_MS).toBe(5 * 60_000)
  })

  it('does not refetch inside the window', () => {
    expect(papersFetchDue(base)).toBe(false)
  })

  it('refetches past the window', () => {
    expect(papersFetchDue({ ...base, fetchedAt: base.now - PAPERS_REFRESH_AFTER_MS })).toBe(true)
  })

  it('refetches when the desk address moved, whatever the clock says', () => {
    expect(papersFetchDue({ ...base, cachedAddress: 'https://other.example.dev' })).toBe(true)
    expect(papersFetchDue({ ...base, cachedAddress: null })).toBe(true)
  })

  it('refetches when no desk has actually been asked yet', () => {
    expect(papersFetchDue({ ...base, cachedReady: null })).toBe(true)
    expect(papersFetchDue({ ...base, cachedReady: false })).toBe(true)
  })

  it('refetches on a mark, inside the window', () => {
    // The desk rewrote a paper and told this phone so. Waiting out four more minutes on the one
    // screen the change is about is the failure `invalidate.ts` exists to prevent.
    expect(papersFetchDue({ ...base, forced: true })).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx jest src/lib/papers/list.test.ts src/lib/edition/invalidate.test.ts`
Expected: FAIL — `Cannot find module './list'`, and `takePapersStale is not a function`.

- [ ] **Step 3: Give `invalidate.ts` its second reader**

Replace the state and add the reader in `app/src/lib/edition/invalidate.ts`:

```ts
// ONE WRITER, TWO READERS, AND THAT IS DELIBERATE. "The paper changed underneath us" is one fact
// and two screens act on it: the Today reader must defeat its five-minute throttle and refetch the
// edition, and — since the papers feature — the pager's LIST must refetch too, because a revision
// moves that company's `created_at` and can move which edition is on the board. A second mark
// beside this one would be two facts to keep in step by hand, and the first place they would drift
// is the third caller somebody adds next.
//
// Two bits and not one, because the two readers take theirs at different moments and neither may
// rob the other: Today's pager can be unmounted when the edition reader consumes its own.

let editionStale = false
let papersStale = false

/** Say the paper changed. Called after a `revised`, a successful publish, and a board publish. */
export function markEditionStale(): void {
  editionStale = true
  papersStale = true
}

/** Read and clear. The caller is `useEdition`'s `load`, and it is the only one. */
export function takeEditionStale(): boolean {
  const was = editionStale
  editionStale = false
  return was
}

/** Read and clear. The caller is `lib/papers/list.ts`'s `loadPapers`, and it is the only one. */
export function takePapersStale(): boolean {
  const was = papersStale
  papersStale = false
  return was
}

export function __resetEditionStaleForTests(): void {
  editionStale = false
  papersStale = false
}
```

- [ ] **Step 4: Write the store**

Create `app/src/lib/papers/list.ts`:

```ts
// The paper list, fetched once for the two surfaces that read it.
//
// ONE COPY, ONE CLOCK, EVERY READER ON THE SAME SNAPSHOT — `lib/useEventBook.ts`'s shape, for
// `useEventBook`'s reason. Today's pager and the Board tab's section can be mounted at the same
// moment, and a `useState` apiece would give them a fetch apiece and let them disagree about which
// paper is on the board — which is exactly the fact one of them draws a tick beside.
//
// THE ONE RULE THAT IS NOT ABOUT RENDERING: a phone with no desk address and no operator token
// never calls `/api/papers` at all. Not "calls it and hides the failure" — never calls it. A
// request built out of a missing address is a request to somebody.
//
// A FAILURE LEAVES THE LIST ALONE. `ready` moves, because the desk WAS asked, and `doc` keeps
// whatever it had. Dropping the list on a failed refresh would collapse a five-page pager to the
// single-page reader mid-read, on a phone whose only problem is a tunnel that blinked.
//
// The token is read for the call and gone with the frame — `useEventBook`'s rule and `desk.ts`'s:
// it lives in the keychain, reaches exactly one header inside `createDeskClient`, and is in nothing
// this module keeps.

import { useCallback, useSyncExternalStore } from 'react'
import { createDeskClient, type PapersDoc } from '../desk'
import { getDeskToken } from '../deskToken'
import { getDeskBaseUrl } from '../store'
import { takePapersStale } from '../edition/invalidate'

export interface PapersState {
  /** A desk address and an operator token are both saved. `null` while storage has not answered. */
  ready: boolean | null
  /** The list, or `null` for a call that has not produced one. A THROW LEAVES THIS ALONE. */
  doc: PapersDoc | null
}

/**
 * The same five minutes `FOCUS_REFRESH_AFTER_MS` gives the edition itself.
 *
 * Not imported from `editionState.ts`: that constant is the throttle on ONE conditional GET that a
 * healthy desk answers with a 304, and this one paces a list the desk computes per call. They are
 * the same number today because the answer to "how often is it worth asking" is the same, and they
 * are free to move apart — which an import would quietly prevent.
 */
export const PAPERS_REFRESH_AFTER_MS = 5 * 60_000

/**
 * Whether to ask again. Pure, and the whole cadence.
 *
 * `forced` is the mark from `invalidate.ts`. Everything else is `bookFetchDue`'s shape and for its
 * reasons: a changed desk address invalidates the copy outright, and a copy that was never really
 * fetched (`cachedReady !== true`) is not a copy to throttle against.
 */
export function papersFetchDue(input: {
  now: number
  fetchedAt: number
  address: string
  cachedAddress: string | null
  cachedReady: boolean | null
  forced: boolean
}): boolean {
  if (input.forced) return true
  if (input.address !== input.cachedAddress) return true
  if (input.cachedReady !== true) return true
  return input.now - input.fetchedAt >= PAPERS_REFRESH_AFTER_MS
}

// ---------------------------------------------------------------------------
// The one copy
// ---------------------------------------------------------------------------

const IDLE: PapersState = { ready: null, doc: null }

let current: PapersState = IDLE
let cachedAddress: string | null = null
let fetchedAt = 0
let inFlight: Promise<void> | null = null

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): PapersState {
  return current
}

/** Swap the copy and tell every subscriber, over a COPY of the set — a listener may unsubscribe
 *  while being notified, which a component unmounting inside a re-render does. */
function publish(next: PapersState): void {
  current = next
  for (const listener of [...listeners]) listener()
}

/**
 * The remembered page, for THIS SESSION ONLY.
 *
 * Module scope and not AsyncStorage, and the spec says so: "page position is remembered for the
 * session, not persisted". A persisted index would open tomorrow's app on the page a reader left
 * yesterday, over a watchlist that may have moved under it — and the page worth opening on is
 * always the board's, which is page 0 by construction.
 */
let rememberedIndex = 0

export function rememberPaperIndex(index: number): void {
  rememberedIndex = index
}

export function lastPaperIndex(): number {
  return rememberedIndex
}

/**
 * Ask the desk, or answer from the copy in memory. Never throws: both callers are focus effects
 * and neither is equipped to catch anything.
 */
export async function loadPapers(): Promise<void> {
  if (inFlight !== null) return inFlight

  const run = (async () => {
    const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])

    if (!address || !token) {
      // No desk on this phone. PUBLISHED rather than merely not-fetched, because forgetting the
      // token in Settings must take the pager down at once — and dropping `doc` here is what stops
      // a list outliving the credential it was fetched with. Guarded so a repeated focus on a
      // deskless phone is not a re-render apiece.
      cachedAddress = null
      fetchedAt = 0
      if (current.ready !== false || current.doc !== null) publish({ ready: false, doc: null })
      return
    }

    // TAKEN BEFORE THE DUE CHECK, not inside it, and unconditionally: a mark is one refetch, and
    // leaving it set because this pass was already due would spend a second one on the next focus.
    const forced = takePapersStale()
    const due = papersFetchDue({
      now: Date.now(),
      fetchedAt,
      address,
      cachedAddress,
      cachedReady: current.ready,
      forced,
    })
    if (!due) return

    try {
      const doc = await createDeskClient({ baseUrl: address, token }).papers()
      publish({ ready: true, doc })
    } catch {
      // Whatever was in hand survives; only `ready` moves, because the desk WAS asked. A pager
      // that collapsed to one page because a tunnel blinked is worse than one showing a list a few
      // minutes old, and the header on each page says how old the paper itself is anyway.
      publish({ ...current, ready: true })
    } finally {
      // Stamped on BOTH arms. A settled failure is throttled exactly like a settled success, or a
      // desk that is down becomes a request every time the tab is touched.
      cachedAddress = address
      fetchedAt = Date.now()
    }
  })()

  inFlight = run
  try {
    await run
  } finally {
    inFlight = null
  }
}

export function usePapers(): PapersState & { load: () => Promise<void> } {
  // Third argument is the server snapshot, which react-native-web's static render asks for; it is
  // the same store, so it is the same function.
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  const load = useCallback(() => loadPapers(), [])
  return { ...state, load }
}

/** Test hook: forget the copy, the clock and the remembered page. */
export function __resetPapersForTests(): void {
  current = IDLE
  cachedAddress = null
  fetchedAt = 0
  inFlight = null
  rememberedIndex = 0
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd app && npx jest src/lib/papers src/lib/edition/invalidate.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add app/src/lib/papers app/src/lib/edition/invalidate.ts app/src/lib/edition/invalidate.test.ts
git commit
```

with the message:

```
feat(app): one paper list, one clock, and one mark that means both

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 7: One paper's pages, cached by edition id

**Files:**
- Create: `app/src/lib/papers/cache.ts`, `app/src/lib/papers/cache.test.ts`

**Interfaces:**
- Consumes: `Paper` (Task 2); `createDeskClient` and its `editionSource` / `editionPayload` (Task 3); `CachedEdition` from `../edition/store`; `humanEditionError` from `../edition/client`; `parseEdition` is not needed — `editionPayload` answers a parsed edition already.
- Produces:
  - `export type PaperPageState = { status: 'placeholder' } | { status: 'loading' } | { status: 'ready'; cached: CachedEdition } | { status: 'error'; error: string }`
  - `export function paperPageOf(input: { paper: Paper; cached: CachedEdition | null; error: string | null }): PaperPageState`
  - `export const MAX_CACHED_PAPERS = 6`
  - `export function readPaperCache(editionId: string): CachedEdition | null`
  - `export function putPaperCache(editionId: string, entry: CachedEdition): void`
  - `export function usePaperPage(paper: Paper, active: boolean): PaperPageState`
  - `export function __resetPaperCacheForTests(): void`

**Three decisions.**

**Keyed on the EDITION ID, not on the symbol.** A paper is "the newest edition about S" and that identity moves; an entry filed under `SNDK` would be handed to a refreshed paper that is a different document. The id is also what makes the entry safe to keep: an edition id is a content fingerprint on this desk (`editions.py`'s `_fingerprint_draft`), so two ids are two documents and the same id is the same bytes. There is no ETag revalidation inside a session for that reason — a cached edition id cannot go stale, only stop being the newest, and the LIST is what says so.

**Memory only, never AsyncStorage.** The disk cache holds one edition, the device plane's, and that is `edition/store.ts`'s business. Papers are five editions of about twenty kilobytes each behind a credential; writing them down would put five companies' newspapers on the phone's disk to save a fetch the reader will make over the same connection that just delivered the list. `MAX_CACHED_PAPERS` is six — one more than today's watchlist — and the oldest insertion is evicted, so a watchlist that grows does not grow the resident set without bound.

**A symbol with no paper is `placeholder` and no fetch is attempted.** It is not an error and not a loading state: the desk has said, in the list, that it has not written one. Drawing a spinner over that would promise something is coming within the second, and it is coming on the desk's next idle pass.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/papers/cache.test.ts`:

```ts
import { describe, it, expect, beforeEach } from '@jest/globals'
import {
  MAX_CACHED_PAPERS,
  paperPageOf,
  putPaperCache,
  readPaperCache,
  __resetPaperCacheForTests,
} from './cache'
import { deviceSource } from '../edition/source'
import { demoEdition, demoWire } from '../edition/demo'
import { type CachedEdition } from '../edition/store'
import { type Paper } from '../desk'

const paper = (over: Partial<Paper> = {}): Paper => ({
  symbol: 'SNDK',
  name: 'SanDisk',
  editionId: 'e-sndk',
  createdAt: 1_757_000_000_000,
  lang: 'en',
  headline: 'The guide',
  onBoard: false,
  stale: false,
  ...over,
})

const entry = (url = 'https://d/api/editions/e-sndk/news.json'): CachedEdition => ({
  url,
  etag: null,
  fetchedAt: 1_757_000_000_000,
  wire: demoWire(),
  edition: demoEdition(),
  source: deviceSource(url),
})

beforeEach(() => __resetPaperCacheForTests())

describe('paperPageOf', () => {
  it('is a placeholder for a symbol the desk has not written yet', () => {
    // Not loading and not an error: the desk has SAID, in the list, that there is no paper. A
    // spinner would promise one within the second.
    expect(paperPageOf({ paper: paper({ editionId: null }), cached: null, error: null })).toEqual({
      status: 'placeholder',
    })
  })

  it('is a placeholder even while an error is in hand, because there is nothing to fetch', () => {
    expect(
      paperPageOf({ paper: paper({ editionId: null }), cached: null, error: 'boom' }),
    ).toEqual({ status: 'placeholder' })
  })

  it('is loading for a paper with an edition and nothing fetched yet', () => {
    expect(paperPageOf({ paper: paper(), cached: null, error: null })).toEqual({
      status: 'loading',
    })
  })

  it('is ready once the payload is in hand', () => {
    const c = entry()
    expect(paperPageOf({ paper: paper(), cached: c, error: null })).toEqual({
      status: 'ready',
      cached: c,
    })
  })

  it('keeps the page on screen when a refresh failed over content it already has', () => {
    // The page is a whole newspaper. Replacing it with an error card because a later fetch failed
    // is `board.tsx`'s rule read on another screen: a failure is never grounds for taking away
    // what is already drawn.
    const c = entry()
    expect(paperPageOf({ paper: paper(), cached: c, error: 'the desk did not answer' })).toEqual({
      status: 'ready',
      cached: c,
    })
  })

  it('is an error only when there is nothing to show', () => {
    expect(
      paperPageOf({ paper: paper(), cached: null, error: 'the desk did not answer' }),
    ).toEqual({ status: 'error', error: 'the desk did not answer' })
  })
})

describe('the per-edition cache', () => {
  it('files an entry under the edition id and hands it back', () => {
    const c = entry()
    putPaperCache('e-sndk', c)
    expect(readPaperCache('e-sndk')).toBe(c)
  })

  it('answers null for an edition it has never held', () => {
    expect(readPaperCache('e-nothing')).toBeNull()
  })

  it('holds one more edition than today’s watchlist, then evicts the oldest insertion', () => {
    expect(MAX_CACHED_PAPERS).toBe(6)
    for (let i = 0; i < MAX_CACHED_PAPERS + 1; i++) putPaperCache(`e${i}`, entry(`https://d/${i}`))
    expect(readPaperCache('e0')).toBeNull()
    expect(readPaperCache('e1')).not.toBeNull()
    expect(readPaperCache(`e${MAX_CACHED_PAPERS}`)).not.toBeNull()
  })

  it('re-filing an edition does not evict a different one', () => {
    for (let i = 0; i < MAX_CACHED_PAPERS; i++) putPaperCache(`e${i}`, entry(`https://d/${i}`))
    putPaperCache('e0', entry('https://d/0-again'))
    expect(readPaperCache('e1')).not.toBeNull()
    expect(readPaperCache('e0')?.url).toBe('https://d/0-again')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx jest src/lib/papers/cache.test.ts`
Expected: FAIL — `Cannot find module './cache'`.

- [ ] **Step 3: Write the implementation**

Create `app/src/lib/papers/cache.ts`:

```ts
// One paper's payload, fetched once per edition and kept for the session.
//
// KEYED ON THE EDITION ID AND NOT ON THE SYMBOL. A paper IS "the newest edition about S", so the
// identity moves under the symbol; an entry filed under `SNDK` would be handed to a refreshed paper
// that is a different document. The id is also what makes an entry safe to keep without
// revalidating: on this desk an edition id IS a content fingerprint (`editions.py`), so the same id
// is the same bytes. A cached edition cannot go stale — it can only stop being the newest, and
// `list.ts` is what says so.
//
// MEMORY ONLY. `edition/store.ts` writes ONE edition to disk, the device plane's, and that is the
// whole of what belongs there. Five companies' newspapers behind a credential do not: it would be
// a hundred kilobytes of somebody's watchlist on the phone's disk to save a fetch the reader makes
// over the connection that just delivered the list. `photo.ts` decided the same thing about
// pictures, for the same reason and at ten times the size.

import { useCallback, useEffect, useState } from 'react'
import { createDeskClient, type Paper } from '../desk'
import { getDeskToken } from '../deskToken'
import { getDeskBaseUrl } from '../store'
import { humanEditionError } from '../edition/client'
import { type CachedEdition } from '../edition/store'

/** What one page of the pager is showing. */
export type PaperPageState =
  | { status: 'placeholder' }
  | { status: 'loading' }
  | { status: 'ready'; cached: CachedEdition }
  | { status: 'error'; error: string }

/**
 * One more than today's watchlist, so a full pager fits with room for the board's own edition to
 * be a sixth. Beyond that the oldest INSERTION goes: a reader who has paged through everything has
 * seen the early pages longest ago, and re-entering one costs a conditional GET the desk answers
 * quickly.
 */
export const MAX_CACHED_PAPERS = 6

const byEdition = new Map<string, CachedEdition>()

export function readPaperCache(editionId: string): CachedEdition | null {
  return byEdition.get(editionId) ?? null
}

export function putPaperCache(editionId: string, entry: CachedEdition): void {
  // Delete first, so re-filing an edition refreshes its position rather than counting twice — a
  // `Map` keeps insertion order and `set` on an existing key does not move it.
  byEdition.delete(editionId)
  byEdition.set(editionId, entry)
  while (byEdition.size > MAX_CACHED_PAPERS) {
    const oldest = byEdition.keys().next()
    if (oldest.done === true) break
    byEdition.delete(oldest.value)
  }
}

/**
 * What to draw, from the three facts a page has. Pure, because this is the decision worth arguing
 * about and `PaperPage.tsx` is layout.
 *
 * THE ORDER OF THE ARMS IS THE ARGUMENT. `placeholder` comes first because a symbol with no edition
 * has nothing to fetch, so neither a spinner nor an error about it is ever true. `ready` comes
 * before `error` because a page is a whole newspaper and a failed refresh is not grounds for taking
 * it away — `board.tsx`'s rule, read on another screen.
 */
export function paperPageOf(input: {
  paper: Paper
  cached: CachedEdition | null
  error: string | null
}): PaperPageState {
  if (input.paper.editionId === null) return { status: 'placeholder' }
  if (input.cached !== null) return { status: 'ready', cached: input.cached }
  if (input.error !== null) return { status: 'error', error: input.error }
  return { status: 'loading' }
}

/**
 * One page's data.
 *
 * `active` is "this page is the one on screen, or next to it". A pager mounts several pages at once
 * and fetching all five at a focus would be five authenticated requests for four pages nobody is
 * looking at; the screen passes `true` for the current index and its immediate neighbours, which is
 * what makes a swipe land on a page that is already there.
 *
 * The fetch is skipped outright when the cache already holds this edition — see the header: an
 * edition id is a content fingerprint, so there is nothing a revalidation could learn.
 */
export function usePaperPage(paper: Paper, active: boolean): PaperPageState {
  const editionId = paper.editionId
  const [cached, setCached] = useState<CachedEdition | null>(() =>
    editionId === null ? null : readPaperCache(editionId),
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (editionId === null || !active) return
    const hit = readPaperCache(editionId)
    if (hit !== null) {
      setCached(hit)
      setError(null)
      return
    }
    let alive = true
    void (async () => {
      const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
      if (!alive) return
      if (!address || !token) {
        // The credential went while this page was mounted — Settings forgot the token. The pager
        // itself comes down on the next list load; there is nothing useful to say on one page.
        return
      }
      const client = createDeskClient({ baseUrl: address, token })
      try {
        const got = await client.editionPayload(editionId)
        if (!alive) return
        if (got.status !== 'ok') return
        const entry: CachedEdition = {
          url: client.editionSource(editionId).payloadUrl,
          etag: got.etag,
          fetchedAt: Date.now(),
          wire: got.wire,
          edition: got.edition,
          // THE SOURCE CARRIES THE BEARER, and this entry is never written down — see
          // `edition/store.ts`'s `source` field and the test that pins it.
          source: client.editionSource(editionId),
        }
        putPaperCache(editionId, entry)
        setCached(entry)
        setError(null)
      } catch (e) {
        if (!alive) return
        // The edition client's own vocabulary, which the Today screen already draws.
        setError(humanEditionError(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [editionId, active])

  return paperPageOf({ paper, cached, error })
}

/** Test hook: empty the cache. */
export function __resetPaperCacheForTests(): void {
  byEdition.clear()
}
```

> `useCallback` is imported for symmetry with the rest of `lib/`; if the implementation does not use it, drop the import — `npm run typecheck` will say so.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx jest src/lib/papers/cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add app/src/lib/papers/cache.ts app/src/lib/papers/cache.test.ts
git commit
```

with the message:

```
feat(app): a paper is cached by its edition, in memory, for the session

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 8: Putting a paper on the board, as one testable sequence

**Files:**
- Create: `app/src/lib/papers/publish.ts`, `app/src/lib/papers/publish.test.ts`

**Interfaces:**
- Consumes: `DeskClient` (Tasks 2–3), `markEditionStale` from `../edition/invalidate`, `loadPapers` from `./list`, `humanDeskError` from `../desk`.
- Produces:
  - `export type PaperPublishResult = { kind: 'published'; editionId: string } | { kind: 'no_paper' } | { kind: 'failed'; error: string }`
  - `export interface PaperPublishDeps { client: Pick<DeskClient, 'publishPaper'>; invalidate: () => void; reloadPapers: () => Promise<void>; pollBoard: (() => Promise<void>) | null }`
  - `export function runPaperPublish(symbol: string, deps: PaperPublishDeps): Promise<PaperPublishResult>`

**Why the sequence is a function and not four lines in an `onPress`.** It has four steps, three of which can fail independently and two of which must run even when a later one does. The spec's App test row names it: "the board list publishes and refreshes". An `onPress` that did this inline would be four untested decisions inside a component this app cannot render under test.

**The order, and what it survives.** Publish, then mark, then refetch the list, then tell the board to poll. The mark and the refetch happen because the DESK changed, so they must not be conditional on the board answering — a board that is asleep, unreachable, or not owned at all is the ordinary case, and a publish that "failed" because the ESP32 did not pick up would be a lie about a desk that did exactly what it was asked. `pollBoard` is therefore `null`-able and its failure is swallowed: the board polls on its own interval anyway, and `client.refresh()` only buys the next few minutes.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/papers/publish.test.ts`:

```ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { runPaperPublish, type PaperPublishDeps } from './publish'
import { setActiveLanguage } from '../../i18n'
import { DeskError } from '../desk'

const deps = (
  publishPaper: PaperPublishDeps['client']['publishPaper'],
  over: Partial<PaperPublishDeps> = {},
) => {
  const calls = { invalidate: 0, reload: 0, poll: 0 }
  const d: PaperPublishDeps = {
    client: { publishPaper },
    invalidate: () => {
      calls.invalidate++
    },
    reloadPapers: async () => {
      calls.reload++
    },
    pollBoard: async () => {
      calls.poll++
    },
    ...over,
  }
  return { d, calls }
}

beforeEach(() => setActiveLanguage('en'))

describe('runPaperPublish', () => {
  it('publishes, marks Today stale, refetches the list, then pokes the board', async () => {
    const { d, calls } = deps(async () => ({
      kind: 'published' as const,
      editionId: 'e1',
      state: 'published',
    }))
    expect(await runPaperPublish('SNDK', d)).toEqual({ kind: 'published', editionId: 'e1' })
    expect(calls).toEqual({ invalidate: 1, reload: 1, poll: 1 })
  })

  it('treats “already on the board” as a publish', async () => {
    // `promote()` answers `unchanged` when the symbol's newest edition is already `current`. The
    // row was drawn without a tick, the owner tapped it, and the world now matches what they
    // asked for. Reporting a failure over that would be reporting the request as the problem.
    const { d, calls } = deps(async () => ({
      kind: 'published' as const,
      editionId: 'e1',
      state: 'unchanged',
    }))
    expect(await runPaperPublish('SNDK', d)).toEqual({ kind: 'published', editionId: 'e1' })
    expect(calls.reload).toBe(1)
  })

  it('refetches the list after a no_paper too, because the list was wrong', async () => {
    // The row said there was a paper and the desk says there is not — pruned since the fetch. The
    // list on screen is out of date about exactly this row, so it is the one thing worth doing.
    const { d, calls } = deps(async () => ({ kind: 'no_paper' as const }))
    expect(await runPaperPublish('MU', d)).toEqual({ kind: 'no_paper' })
    expect(calls.reload).toBe(1)
    // Nothing went on the glass, so there is nothing for Today or the board to go and look at.
    expect(calls.invalidate).toBe(0)
    expect(calls.poll).toBe(0)
  })

  it('reports the desk’s own reason when the publish is refused', async () => {
    const { d, calls } = deps(async () => {
      throw new DeskError('unauthorized', 'papers responded 403', 403)
    })
    const result = await runPaperPublish('SNDK', d)
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('unreachable')
    expect(result.error).toContain('operator')
    expect(calls).toEqual({ invalidate: 0, reload: 0, poll: 0 })
  })

  it('still counts as published when the board cannot be reached', async () => {
    // THE BOARD IS NOT THE SUBJECT. A sleeping board, an unreachable one, or no board at all is
    // the ordinary case; the desk did what it was asked and the glass catches up on its own
    // interval. Failing here would blame the desk for the ESP32.
    const { d, calls } = deps(
      async () => ({ kind: 'published' as const, editionId: 'e1', state: 'published' }),
      {
        pollBoard: async () => {
          throw new Error('board asleep')
        },
      },
    )
    expect(await runPaperPublish('SNDK', d)).toEqual({ kind: 'published', editionId: 'e1' })
    expect(calls.invalidate).toBe(1)
    expect(calls.reload).toBe(1)
  })

  it('publishes perfectly well on a phone that owns no board', async () => {
    const { d, calls } = deps(
      async () => ({ kind: 'published' as const, editionId: 'e1', state: 'published' }),
      { pollBoard: null },
    )
    expect(await runPaperPublish('SNDK', d)).toEqual({ kind: 'published', editionId: 'e1' })
    expect(calls.poll).toBe(0)
    expect(calls.reload).toBe(1)
  })

  it('marks and refetches even when the refetch itself throws', async () => {
    // `loadPapers` never throws by construction, but this is the one caller that would be left
    // half-done if it ever did, and the mark it would drop is the one Today reads.
    const seen: string[] = []
    const { d } = deps(
      async () => ({ kind: 'published' as const, editionId: 'e1', state: 'published' }),
      {
        invalidate: () => seen.push('invalidate'),
        reloadPapers: async () => {
          seen.push('reload')
          throw new Error('nope')
        },
      },
    )
    expect(await runPaperPublish('SNDK', d)).toEqual({ kind: 'published', editionId: 'e1' })
    expect(seen).toEqual(['invalidate', 'reload'])
  })

  it('sends the symbol through untouched', async () => {
    const seen: string[] = []
    const { d } = deps(async (s: string) => {
      seen.push(s)
      return { kind: 'published' as const, editionId: 'e1', state: 'published' }
    })
    await runPaperPublish('BRK.B', d)
    expect(seen).toEqual(['BRK.B'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx jest src/lib/papers/publish.test.ts`
Expected: FAIL — `Cannot find module './publish'`.

- [ ] **Step 3: Write the implementation**

Create `app/src/lib/papers/publish.ts`:

```ts
// Putting one company's paper on the glass: four steps, three of which can fail on their own.
//
// A function and not four lines in an `onPress`, for this app's standing reason — there is no
// component test runner, so a sequence argued inside a `.tsx` is argued only in prose — and for one
// specific to this sequence: THE BOARD IS NOT THE SUBJECT. The desk is. A publish that reported
// failure because an ESP32 asleep on a shelf did not answer would be blaming the wrong machine for
// a thing that already happened, and the owner's next act would be to tap it again.

import { humanDeskError, type DeskClient } from '../desk'

export type PaperPublishResult =
  | { kind: 'published'; editionId: string }
  /** The list said there was a paper and the desk says there is not — pruned since the fetch. */
  | { kind: 'no_paper' }
  | { kind: 'failed'; error: string }

export interface PaperPublishDeps {
  client: Pick<DeskClient, 'publishPaper'>
  /** `markEditionStale` — Today's edition AND its paper list are both out of date now. */
  invalidate: () => void
  /** `loadPapers` — the tick moves to the new row. */
  reloadPapers: () => Promise<void>
  /**
   * `client.refresh()` on the BOARD, so the glass picks the new edition up now rather than at its
   * next interval. `null` on a phone that owns no board, which is a supported configuration and
   * not a degraded one.
   */
  pollBoard: (() => Promise<void>) | null
}

export async function runPaperPublish(
  symbol: string,
  deps: PaperPublishDeps,
): Promise<PaperPublishResult> {
  let outcome
  try {
    outcome = await deps.client.publishPaper(symbol)
  } catch (e) {
    // Nothing moved, so nothing is invalidated and nothing is refetched: the list on screen is
    // still exactly right, and the sentence is the desk's own.
    return { kind: 'failed', error: humanDeskError(e) }
  }

  if (outcome.kind === 'no_paper') {
    // The DESK is right and the row is wrong. Refetch, so the row redraws as "not written yet"
    // rather than going on offering a paper that is gone. Nothing went on the glass, so there is
    // nothing for Today or the board to go and look at.
    await deps.reloadPapers().catch(() => undefined)
    return { kind: 'no_paper' }
  }

  // ORDER, AND WHY THE FIRST TWO ARE UNCONDITIONAL. The desk's `current` pointer has moved, which
  // is a fact about the desk and not about anything downstream — so Today is stale and the list is
  // stale whatever happens next.
  deps.invalidate()
  await deps.reloadPapers().catch(() => undefined)
  // And last, the board, whose failure is swallowed whole: it polls on its own interval anyway,
  // and this only buys the next few minutes. See the header.
  if (deps.pollBoard !== null) await deps.pollBoard().catch(() => undefined)

  return { kind: 'published', editionId: outcome.editionId }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx jest src/lib/papers/publish.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add app/src/lib/papers/publish.ts app/src/lib/papers/publish.test.ts
git commit
```

with the message:

```
feat(app): putting a paper on the board is one sequence with one argument

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 9: The words, in both languages

**Files:**
- Modify: `app/src/i18n/en.ts`, `app/src/i18n/ko.ts`
- Test: `app/src/i18n/index.test.ts` (runs unchanged; it is what fails on a missing or untranslated key)

**Interfaces:**
- Produces: `strings().papers.*` and three new rows under `strings().settings.desk.*`. Tasks 10, 11 and 12 use these exact key paths.

**Why the strings come before the screens.** `index.test.ts` fails a build on a key present in `ko.ts` that still carries the English sentence, and on a placeholder dropped in translation. Writing the catalogue first means the three screens that follow are drawing keys that already exist and are already proven parallel, rather than three commits each of which breaks the parity test until its own `ko.ts` half lands.

**One rule about the age line.** The header says "6h ago" through `formatAge`, which is `strings().format.ago` and already exists in both languages. Nothing in this task re-spells it.

- [ ] **Step 1: Write the failing test run**

There is no new test to write — `index.test.ts` is the test. Confirm it is green before you start so the failure you see next is yours:

Run: `cd app && npx jest src/i18n/index.test.ts`
Expected: PASS (this is the baseline).

- [ ] **Step 2: Add the English block**

In `app/src/i18n/en.ts`, after the `ask: {...}` block at `:921-959` and before the closing brace, add:

```ts
  // The papers: one current newspaper per company on the desk's watchlist. Today pages through
  // them, the Board tab puts one on the glass, and Settings paces how often the desk rewrites one.
  papers: {
    /** The page header, above the masthead: which company this page is. */
    page: {
      /** Beside the symbol on the page that is currently on the board. */
      onBoard: 'On the board',
      /** The desk thinks this one is due a rewrite. Its own judgement, not the phone's. */
      stale: 'Due a refresh',
      /** The age line when the desk gave no `created_at` at all. */
      noAge: 'Written at an unknown time',
    },
    /** A watchlist symbol the desk has not written a paper for yet. */
    placeholder: {
      title: 'No paper for {symbol} yet',
      body: 'It’s on the watchlist, so the desk writes one on its next quiet pass. This page fills in when it does.',
    },
    /** A page whose payload would not load, with nothing cached behind it. */
    pageFailed: 'This paper wouldn’t load. {detail}',
    /** The Board tab's section. */
    board: {
      title: 'Paper on the board',
      help: 'The desk keeps a current paper for every company you watch. Tap one to print it — tomorrow’s own pick replaces it.',
      /** A row for a symbol with no paper. The row is drawn and is not tappable. */
      noPaper: 'Not written yet',
      /** The confirmation, because this spends twenty-five seconds of the panel. */
      confirmTitle: 'Print {symbol}?',
      confirmBody: 'The board redraws the whole sheet, which takes about half a minute. Tomorrow’s pick replaces it in the normal way.',
      confirm: 'Put it on the board',
      cancel: 'Cancel',
      /** After a successful publish. */
      published: '{symbol} is on the board. The panel takes about half a minute to redraw.',
      /** The desk no longer has a paper for this symbol — it was pruned since the list arrived. */
      gone: 'The desk has no paper for {symbol} any more.',
      failed: 'That didn’t go on the board. {detail}',
      a11y: {
        row: '{name}, paper written {age}',
        onBoard: '{name}, on the board now',
      },
    },
  },
```

and inside the existing `settings.desk` block, after `languageSaved`:

```ts
      /** How often the desk rewrites each company's paper. `settings.py`'s 1..72 hours. */
      paperRefresh: 'Paper refresh',
      paperRefreshHelp:
        'How often the desk rewrites each watched company’s paper. Every run costs the desk about half an hour of work, so twelve hours is the default and shorter is only worth it for a short watchlist.',
      paperRefreshSaved: 'The desk paces its papers at this from now on.',
      /** The desk answered, and its settings carry no cadence: an older desk. */
      paperRefreshAbsent:
        'This desk doesn’t keep papers yet. Update it and this row starts working.',
      /** A cadence in force that is not one of the chips — set by hand, or by another client. */
      paperRefreshCustom: 'Set to {hours}h, which isn’t one of the choices above.',
```

- [ ] **Step 3: Add the Korean block**

In `app/src/i18n/ko.ts`, at the matching positions:

```ts
  papers: {
    page: {
      onBoard: '보드에 걸린 지면',
      stale: '갱신할 때가 됐어요',
      noAge: '작성 시각을 알 수 없어요',
    },
    placeholder: {
      title: '{symbol} 지면은 아직 없어요',
      body: '관심 목록에 있으니 데스크가 다음 한가한 시간에 만들어요. 만들어지면 이 면이 채워져요.',
    },
    pageFailed: '이 지면을 불러오지 못했어요. {detail}',
    board: {
      title: '보드에 걸 지면',
      help: '데스크는 관심 목록의 회사마다 최신 지면을 하나씩 들고 있어요. 눌러서 보드에 걸 수 있고, 내일 고른 회사가 다시 덮어써요.',
      noPaper: '아직 안 만들었어요',
      confirmTitle: '{symbol}을(를) 인쇄할까요?',
      confirmBody: '보드가 화면 전체를 다시 그려서 30초쯤 걸려요. 내일 고른 회사가 평소대로 다시 덮어써요.',
      confirm: '보드에 걸기',
      cancel: '취소',
      published: '{symbol}을(를) 보드에 걸었어요. 화면이 다시 그려지는 데 30초쯤 걸려요.',
      gone: '데스크에 {symbol} 지면이 더 이상 없어요.',
      failed: '보드에 걸지 못했어요. {detail}',
      a11y: {
        row: '{name}, {age} 작성',
        onBoard: '{name}, 지금 보드에 걸려 있음',
      },
    },
  },
```

and under `settings.desk`:

```ts
      paperRefresh: '지면 갱신 주기',
      paperRefreshHelp:
        '데스크가 관심 목록의 회사마다 지면을 다시 쓰는 주기예요. 한 번 쓸 때마다 30분쯤 걸리니 기본값은 12시간이고, 관심 목록이 짧을 때만 더 짧게 둘 만해요.',
      paperRefreshSaved: '이제부터 이 주기로 지면을 다시 써요.',
      paperRefreshAbsent: '이 데스크는 아직 지면 기능이 없어요. 데스크를 업데이트하면 이 항목이 동작해요.',
      paperRefreshCustom: '지금은 {hours}시간으로 돼 있어요. 위 선택지에는 없는 값이에요.',
```

- [ ] **Step 4: Run the parity test**

Run: `cd app && npx jest src/i18n/index.test.ts`
Expected: PASS — every key present in both, no Korean value left in English, every placeholder (`{symbol}`, `{name}`, `{age}`, `{detail}`, `{hours}`) carried across.

If it fails on a placeholder, fix the Korean sentence rather than the test: word order moves a placeholder around a Korean sentence, which is exactly why these are templates and not concatenation.

- [ ] **Step 5: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add app/src/i18n/en.ts app/src/i18n/ko.ts
git commit
```

with the message:

```
feat(app): the words for the papers, in both languages

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 10: Today pages through the papers

**Files:**
- Create: `app/src/components/edition/PaperPageHeader.tsx`
- Create: `app/src/components/edition/PaperPage.tsx`
- Modify: `app/src/app/(tabs)/edition.tsx` — the screen becomes a switch over one extracted component

**Interfaces:**
- Consumes: `papersPagerView`, `paperAgeLabel`, `paperKey`, `clampPaperIndex` (Task 5); `usePapers`, `loadPapers`, `rememberPaperIndex`, `lastPaperIndex` (Task 6); `usePaperPage` (Task 7); `Paper` (Task 2); `EditionSourceProvider` (Task 1); `setCurrentEdition` from `lib/edition/store`; the existing `Masthead`, `ChipRow`, `Masonry`, `PhotoTile`, `EditionTypeProvider`, `ScreenMessage`, `editionToTiles`, `availableChips`, `filterTiles`, `resolveChip`, `columnWidth`, `photoBoxHeight`, `editionKey`, `freshnessLabel`.
- Produces:
  - `export function PaperPageHeader({ paper, now }: { paper: Paper; now: number })`
  - `export function PaperPage({ paper, active, width, onAsk, onPressSymbol, onOpenTile }: {...})`
  - `edition.tsx` exports `default function EditionScreen()` as now — its signature does not change.

**The shape of the change, and the one thing that must not move.**

Today's screen body — `useEdition`, the chip state, the masonry, the band, the masthead — is extracted **verbatim** into a local component, `TodayEdition`, in the same file. `EditionScreen` becomes: read the papers, and either render `TodayEdition` (exactly as now) or render the pager. **Extract, do not rewrite.** Every line of the no-token path has to come out the other side unchanged, and the way to guarantee that is to move it rather than retype it.

**The single-page reader is the floor, not a fallback.** It is what renders while `/api/papers` is out, on a phone with no desk, against a desk one release behind, and for the whole of a cold launch's first frame. The pager is laid over it the moment `papersPagerView` says `pager: true`. That costs one `/news.json` fetch on a desk phone whose pager then appears — and it is not a wasted one: `editionUrl` falls back to the desk's own `/news.json`, which is the board's current edition, which is page 0 of the pager. The reader sees the same paper before and after the swap.

**A pager page does not use `useEdition` at all.** It reads `usePaperPage`, which is its own cache and its own fetch. `useEdition`'s throttle, its ETag, its disk cache and its demo publishing are the device plane's and stay there.

**`setCurrentEdition` is called on the settled page.** `/tile/[id]` reads the edition on screen from that module slot (`tile/[id].tsx:72`), so the pager has to keep it pointed at the page the reader is actually on, or a tap on a tile opens the wrong company's story.

- [ ] **Step 1: Write the page header**

Create `app/src/components/edition/PaperPageHeader.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { Chip } from '../Chip'
import { paperAgeLabel } from '../../lib/papers/order'
import { type Paper } from '../../lib/desk'
import { fill, useStrings } from '../../i18n'
import { colors, fonts, layout, space, tabular } from '../../theme'

/**
 * Which company's paper this page is, above the masthead.
 *
 * It exists because a pager has a problem a single page does not: the masthead names the COMPANY,
 * beautifully, in the edition's own face — and gives the reader nothing to tell them they are on
 * page three of five, nor how old this particular paper is. The board's edition carries its
 * freshness on the masthead; a paper's freshness is a different fact (when the DESK WROTE IT, not
 * when this phone last confirmed it) and belongs beside the symbol.
 *
 * THE APP'S OWN TYPE RAMP, not the edition's. Everything below this row is set in the paper's
 * language through `EditionTypeProvider`; this row is the app talking about the paper, so it takes
 * the app's face the way `tile/[id].tsx`'s "More from this edition" heading does.
 */
export function PaperPageHeader({ paper, now }: { paper: Paper; now: number }) {
  const t = useStrings()
  const age = paperAgeLabel(paper.createdAt, now)

  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <Text style={styles.symbol}>{paper.symbol}</Text>
        {paper.onBoard ? <Chip label={t.papers.page.onBoard} icon="tv" tone="accent" /> : null}
        {/* The DESK's judgement about whether this paper is due a rewrite, carried through rather
            than recomputed: the phone does not know the cadence the desk is pacing at, and a
            second opinion here could contradict the row on the Board tab. */}
        {paper.stale && !paper.onBoard ? (
          <Chip label={t.papers.page.stale} icon="time" tone="warn" />
        ) : null}
      </View>
      <Text style={styles.meta} numberOfLines={1}>
        {[paper.name, age ?? t.papers.page.noAge].filter(Boolean).join(' · ')}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  symbol: {
    fontFamily: fonts.bold,
    fontSize: 15,
    letterSpacing: 0.5,
    color: colors.textDim,
    ...tabular,
  },
  meta: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textFaint,
  },
})
```

> `colors.textDim` / `colors.textFaint` / `space.sm` are used elsewhere in `components/edition/`; check `app/src/theme.ts` and use the names that are actually there rather than inventing one.

- [ ] **Step 2: Write one page**

Create `app/src/components/edition/PaperPage.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { Screen } from '../Screen'
import { ScreenMessage } from '../ScreenMessage'
import { Masthead } from './Masthead'
import { ChipRow } from './ChipRow'
import { Masonry } from './Masonry'
import { PaperPageHeader } from './PaperPageHeader'
import { EditionSourceProvider } from './editionSource'
import { EditionTypeProvider } from './typeRamp'
import { PhotoTile } from './tiles/PhotoTile'
import { usePaperPage } from '../../lib/papers/cache'
import { freshnessLabel } from '../../lib/edition/freshness'
import {
  COLUMN_GAP,
  columnWidth,
  editionKey,
  photoBoxHeight,
  resolveChip,
} from '../../lib/edition/feedLayout'
import {
  availableChips,
  editionToTiles,
  filterTiles,
  type Chip as ChipName,
  type Tile,
} from '../../lib/edition/tiles'
import { type Paper } from '../../lib/desk'
import { fill, useStrings } from '../../i18n'
import { colors, layout, radius, space, type } from '../../theme'

/**
 * One company's paper, as one page of Today's pager.
 *
 * It is the SAME reader the single-page Today draws — masthead, band, chips, masonry — over a
 * different source. That sameness is the whole point of `EditionSource`: a paper arrives on the
 * control plane behind a bearer token and renders through code that does not know it.
 *
 * `active` is passed down to `usePaperPage` and decides whether this page fetches at all. The pager
 * mounts several pages; only the one on screen and its neighbours ask the desk for anything.
 */
export function PaperPage({
  paper,
  active,
  width,
  onAsk,
  onPressSymbol,
  onOpenTile,
}: {
  paper: Paper
  active: boolean
  /** The page's width — the pager's, not the window's, so a page fills its slot exactly. */
  width: number
  onAsk?: () => void
  onPressSymbol: (symbol: string) => void
  onOpenTile: (tile: Tile) => void
}) {
  const t = useStrings()
  const page = usePaperPage(paper, active)
  const [chip, setChip] = useState<ChipName>('all')

  const edition = page.status === 'ready' ? page.cached.edition : null
  // A paper always has photographs to fetch — it came from the desk, over a credential that also
  // reaches its tiles. The `isDemo` question the single-page reader asks cannot arise here.
  const feed = useMemo(
    () => (edition === null ? null : editionToTiles(edition, { photos: true })),
    [edition],
  )

  const chips: ChipName[] = feed === null ? ['all'] : availableChips(feed.tiles)
  const active_ = resolveChip(chips, chip)
  const tiles = feed === null ? [] : filterTiles(feed.tiles, active_)
  const colWidth = columnWidth(width, layout.gutter, COLUMN_GAP)
  const contentWidth = width - 2 * layout.gutter

  if (page.status === 'placeholder') {
    return (
      <View style={[styles.page, { width }]}>
        <PaperPageHeader paper={paper} now={Date.now()} />
        <View style={styles.centred}>
          <Text style={type.headingSm}>{fill(t.papers.placeholder.title, {
            symbol: paper.symbol,
          })}</Text>
          <Text style={styles.body}>{t.papers.placeholder.body}</Text>
        </View>
      </View>
    )
  }

  if (page.status === 'loading') {
    return (
      <View style={[styles.page, { width }]}>
        <PaperPageHeader paper={paper} now={Date.now()} />
        <ScreenMessage loading />
      </View>
    )
  }

  if (page.status === 'error') {
    return (
      <View style={[styles.page, { width }]}>
        <PaperPageHeader paper={paper} now={Date.now()} />
        <ScreenMessage error={fill(t.papers.pageFailed, { detail: page.error })} />
      </View>
    )
  }

  const cached = page.cached
  const band = feed?.band ?? null
  const key = editionKey(cached)

  return (
    <View style={[styles.page, { width }]}>
      {/* This page's own source and its own language — not the pager's and not the phone's. */}
      <EditionSourceProvider source={cached.source}>
        <EditionTypeProvider lang={cached.edition.lang}>
          <ScrollView contentContainerStyle={styles.scroll}>
            <PaperPageHeader paper={paper} now={Date.now()} />
            <Masthead
              edition={cached.edition}
              demo={false}
              // The desk CONFIRMED this payload when this phone fetched it, which is the question
              // the masthead's line answers. How old the paper itself is, is the header's line
              // above — two different facts, and collapsing them would say a paper written
              // yesterday was "updated just now" because the phone fetched it a moment ago.
              freshness={freshnessLabel(cached.fetchedAt, Date.now())}
              error={null}
              onRetry={() => undefined}
              onPressSymbol={() => {
                const symbol = cached.edition.subject.symbol
                if (symbol === '') return
                onPressSymbol(symbol)
              }}
              onAsk={onAsk}
            />

            {band !== null ? (
              <View style={styles.band}>
                <View style={styles.bandFrame}>
                  <PhotoTile
                    key={`${key}:band`}
                    tile={{ kind: 'photo', id: 'band', photo: band }}
                    width={contentWidth}
                    height={photoBoxHeight(band, contentWidth)}
                  />
                </View>
              </View>
            ) : null}

            <ChipRow chips={chips} selected={active_} onSelect={setChip} />

            <View style={styles.grid}>
              <Masonry tiles={tiles} colWidth={colWidth} editionKey={key} onPress={onOpenTile} />
            </View>
          </ScrollView>
        </EditionTypeProvider>
      </EditionSourceProvider>
    </View>
  )
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  scroll: {
    paddingBottom: space.xxl,
  },
  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: layout.gutter,
    gap: space.sm,
  },
  body: {
    ...type.body,
    color: colors.textDim,
    textAlign: 'center',
  },
  band: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
  },
  bandFrame: {
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  grid: {
    paddingHorizontal: layout.gutter,
  },
})
```

> `Screen`, `useWindowDimensions` and `fill` may end up unused in this file. Drop whichever the typechecker names rather than leaving them.

- [ ] **Step 3: Turn the screen into a switch**

In `app/src/app/(tabs)/edition.tsx`:

1. **Rename** the existing `export default function EditionScreen()` to `function TodayEdition({ canAsk }: { canAsk: boolean })` and delete only the `canAsk` state and its `useFocusEffect` (lines `:64-76`) from it — that read moves up to the new screen, which needs it too. Everything else in the function body, and the whole `StyleSheet` at the bottom, stays exactly as it is.
2. Add the new default export above it:

```tsx
export default function EditionScreen() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const { ready, doc, load } = usePapers()

  // Whether the desk can be talked to at all — the same read the Ask pill has always done, now
  // serving two purposes. `useFocusEffect` and not a mount effect: this screen is registered first
  // and mounts at app boot, before Settings has necessarily been touched, and the tab navigator
  // keeps it mounted across the trip to Settings and back. A plain `useEffect` would run once at
  // boot and never again, so a phone set up in this session would not get a pager until it was
  // killed and relaunched.
  const [canAsk, setCanAsk] = useState(false)
  useFocusEffect(
    useCallback(() => {
      let alive = true
      void (async () => {
        const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
        if (alive) setCanAsk(Boolean(address) && Boolean(token))
      })()
      // The list rides the same focus. `loadPapers` reads its own throttle and its own mark, so a
      // focus inside the window costs one storage read and no request.
      void load()
      return () => {
        alive = false
      }
    }, [load]),
  )

  const view = papersPagerView({ ready, doc })

  // THE SINGLE-PAGE READER IS THE FLOOR. Every state that is not "the desk answered with at least
  // one paper" draws exactly what this tab drew before the papers feature: a phone with no desk, a
  // desk that refused, a desk one release behind with no `/api/papers` at all, an empty watchlist,
  // and the first frame of every cold launch. The pager is laid OVER it, which is also why the
  // `/news.json` fetch that happens first is not wasted — `editionUrl` falls back to the desk's own
  // device plane, which serves the board's current edition, which is page 0 of the pager.
  if (!view.pager) return <TodayEdition canAsk={canAsk} />

  return (
    <PaperPager
      papers={view.papers}
      width={width}
      canAsk={canAsk}
      onOpenAsk={() => router.push('/ask')}
      onOpenSymbol={(symbol) => router.push(`/market/${encodeURIComponent(symbol)}`)}
      onOpenTile={(tile) => router.push(`/tile/${encodeURIComponent(tile.id)}`)}
    />
  )
}
```

3. Add the pager itself, below `TodayEdition` in the same file:

```tsx
/**
 * The papers, side by side.
 *
 * A horizontal `FlatList` with `pagingEnabled` and not a pager library: `react-native-pager-view`
 * is not a dependency of this app, and a list that already knows how to virtualise, key and
 * recycle is what this needs — five pages, each a whole newspaper with decoded photographs in it.
 *
 * `getItemLayout` is what makes `initialScrollIndex` work: without it the list cannot know where
 * page three starts without measuring pages one and two, and a remembered index would scroll to
 * the wrong place or to nowhere.
 *
 * WHICH PAGE IS "ACTIVE" DECIDES WHAT FETCHES. The page on screen and its two neighbours fetch;
 * the rest are mounted and idle. That is what makes a swipe land on a page that is already there
 * without asking the desk for five editions at a focus.
 */
function PaperPager({
  papers,
  width,
  canAsk,
  onOpenAsk,
  onOpenSymbol,
  onOpenTile,
}: {
  papers: Paper[]
  width: number
  canAsk: boolean
  onOpenAsk: () => void
  onOpenSymbol: (symbol: string) => void
  onOpenTile: (tile: Tile) => void
}) {
  // Seeded from the session's remembered page and clamped against THIS list, which may be shorter
  // than the one the index was remembered against — the watchlist is the desk's and moves.
  const [index, setIndex] = useState(() => clampPaperIndex(lastPaperIndex(), papers.length))

  // The edition the detail route will read. `/tile/[id]` takes it from the module slot in
  // `lib/edition/store.ts` rather than from a prop, so the pager has to keep that slot pointed at
  // the page the reader is actually on — otherwise a tap on a tile opens another company's story.
  useEffect(() => {
    const paper = papers[index]
    if (paper?.editionId === undefined || paper.editionId === null) return
    const entry = readPaperCache(paper.editionId)
    if (entry !== null) setCurrentEdition(entry)
  }, [papers, index])

  const settle = useCallback(
    (next: number) => {
      const at = clampPaperIndex(next, papers.length)
      setIndex(at)
      rememberPaperIndex(at)
    },
    [papers.length],
  )

  return (
    <Screen edges={['top']}>
      <FlatList
        data={papers}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={clampPaperIndex(index, papers.length)}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        keyExtractor={paperKey}
        onMomentumScrollEnd={(e) =>
          settle(Math.round(e.nativeEvent.contentOffset.x / Math.max(width, 1)))
        }
        renderItem={({ item, index: i }) => (
          <PaperPage
            paper={item}
            // The page on screen and its immediate neighbours. See the doc above.
            active={Math.abs(i - index) <= 1}
            width={width}
            onAsk={canAsk ? onOpenAsk : undefined}
            onPressSymbol={onOpenSymbol}
            onOpenTile={onOpenTile}
          />
        )}
      />
    </Screen>
  )
}
```

4. Add the imports the two new functions need, beside the existing ones:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { PaperPage } from '../../components/edition/PaperPage'
import { getDeskToken } from '../../lib/deskToken'
import { clampPaperIndex, paperKey, papersPagerView } from '../../lib/papers/order'
import { lastPaperIndex, rememberPaperIndex, usePapers } from '../../lib/papers/list'
import { readPaperCache } from '../../lib/papers/cache'
import { setCurrentEdition } from '../../lib/edition/store'
import { type Paper } from '../../lib/desk'
```

- [ ] **Step 4: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS. There is no unit test for this task — every decision it makes was tested in Tasks 5, 6 and 7, which is the point of those three files. Task 13 is where it is looked at.

- [ ] **Step 5: Commit**

```
git add "app/src/app/(tabs)/edition.tsx" app/src/components/edition/PaperPage.tsx app/src/components/edition/PaperPageHeader.tsx
git commit
```

with the message:

```
feat(app): Today pages through every company the desk watches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 11: The Board tab puts a paper on the glass

**Files:**
- Create: `app/src/components/board/PaperSection.tsx`
- Modify: `app/src/app/(tabs)/board.tsx` — three mount sites and the imports

**Interfaces:**
- Consumes: `usePapers`, `loadPapers` (Task 6); `orderPapers`, `paperAgeLabel` (Task 5); `runPaperPublish` (Task 8); `markEditionStale` from `lib/edition/invalidate`; `createDeskClient` from `lib/desk`; `getDeskBaseUrl`, `getDeskToken`; the existing `Card`, `Chip`, `InfoRow`, `Button` and `board.tsx`'s local `Section`.
- Produces: `export function PaperSection({ pollBoard }: { pollBoard: (() => Promise<void>) | null })`

**Where it mounts, and why in three places rather than one.** `board.tsx` has three early returns before the dashboard: storage has not answered (`:203`), no board is saved (`:211`), and a board is saved but has not answered yet (`:238`). Only the first is genuinely transient. The other two are resting states somebody can sit in for a long time — a phone whose owner tapped SET UP LATER, and a board asleep on a shelf — and this section has nothing to do with the board: it talks to the desk, and publishing works perfectly well with no board attached. So it mounts in the "no board" branch, the "board not answering" branch, and the dashboard. It does **not** mount in the first, which is one frame of every cold launch and would flash.

**Hidden without a desk token.** `usePapers()` answers `ready: false` for a phone with no address or no token, and the section draws nothing at all — not an empty state. The spec says hidden, and a "no papers" card on the Board tab of a phone that has never heard of a desk is an explanation of a feature nobody asked about.

- [ ] **Step 1: Write the section**

Create `app/src/components/board/PaperSection.tsx`:

```tsx
import { useCallback, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from 'expo-router'
import { Card } from '../Card'
import { createDeskClient, type Paper } from '../../lib/desk'
import { getDeskToken } from '../../lib/deskToken'
import { getDeskBaseUrl } from '../../lib/store'
import { markEditionStale } from '../../lib/edition/invalidate'
import { loadPapers, usePapers } from '../../lib/papers/list'
import { orderPapers, paperAgeLabel } from '../../lib/papers/order'
import { runPaperPublish } from '../../lib/papers/publish'
import { fill, useStrings } from '../../i18n'
import { colors, fonts, layout, space, tabular } from '../../theme'

/**
 * Every company's current paper, and which one is on the glass.
 *
 * It is the Board tab's only section that does not talk to the board. The desk owns which edition
 * is `current`; the board polls and prints whatever that is. So a tap here is a desk call, and the
 * board is told afterwards only so the glass catches up now rather than at its next interval —
 * `runPaperPublish` holds that order and its argument.
 *
 * DRAWS NOTHING WITHOUT A DESK. Not an empty card: `usePapers` answers `ready: false` for a phone
 * with no address or no token, and a "no papers yet" card on the Board tab of a phone that has
 * never heard of a desk is an explanation of a feature nobody asked about.
 */
export function PaperSection({ pollBoard }: { pollBoard: (() => Promise<void>) | null }) {
  const t = useStrings()
  const { ready, doc } = usePapers()
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null)

  // The list rides this tab's focus as well as Today's. `loadPapers` reads its own throttle, so
  // the second caller costs one storage read inside the window.
  useFocusEffect(
    useCallback(() => {
      void loadPapers()
    }, []),
  )

  const publish = useCallback(
    async (paper: Paper) => {
      if (busy !== null) return
      const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
      if (!address || !token) return
      setBusy(paper.symbol)
      setNote(null)
      const result = await runPaperPublish(paper.symbol, {
        client: createDeskClient({ baseUrl: address, token }),
        invalidate: markEditionStale,
        reloadPapers: loadPapers,
        pollBoard,
      })
      setBusy(null)
      if (result.kind === 'published') {
        setNote({ tone: 'ok', message: fill(t.papers.board.published, { symbol: paper.symbol }) })
      } else if (result.kind === 'no_paper') {
        setNote({ tone: 'error', message: fill(t.papers.board.gone, { symbol: paper.symbol }) })
      } else {
        setNote({ tone: 'error', message: fill(t.papers.board.failed, { detail: result.error }) })
      }
    },
    [busy, pollBoard, t],
  )

  const confirm = useCallback(
    (paper: Paper) => {
      // A CONFIRMATION, because this spends twenty-five seconds of a panel that has no partial
      // refresh — the one cost in this app that is measured in half-minutes of hardware rather
      // than in a request. `Alert` is the platform's own and the first in this app; there is no
      // in-app dialog to reuse, and inventing one for a single yes/no would be a component with
      // no second caller.
      Alert.alert(
        fill(t.papers.board.confirmTitle, { symbol: paper.symbol }),
        t.papers.board.confirmBody,
        [
          { text: t.papers.board.cancel, style: 'cancel' },
          { text: t.papers.board.confirm, onPress: () => void publish(paper) },
        ],
      )
    },
    [publish, t],
  )

  if (ready !== true || doc === null) return null
  const papers = orderPapers(doc)
  if (papers.length === 0) return null

  const now = Date.now()

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t.papers.board.title}</Text>
      <Card style={styles.rows}>
        {papers.map((paper, i) => {
          const age = paperAgeLabel(paper.createdAt, now)
          const none = paper.editionId === null
          return (
            <Pressable
              key={paper.symbol}
              accessibilityRole="button"
              accessibilityState={{ disabled: none || busy !== null, selected: paper.onBoard }}
              accessibilityLabel={fill(
                paper.onBoard ? t.papers.board.a11y.onBoard : t.papers.board.a11y.row,
                { name: paper.name || paper.symbol, age: age ?? '' },
              )}
              // A row with no paper is DRAWN AND DEAD. Dropping it would make a company that is on
              // the owner's watchlist absent from a list titled after their watchlist.
              disabled={none || paper.onBoard || busy !== null}
              onPress={() => confirm(paper)}
              style={[styles.row, i < papers.length - 1 && styles.bordered]}
            >
              <View style={styles.rowText}>
                <Text style={styles.symbol}>{paper.symbol}</Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {none ? t.papers.board.noPaper : [paper.name, age].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {paper.onBoard ? (
                <Ionicons name="checkmark-circle" size={20} color={colors.accent} />
              ) : null}
            </Pressable>
          )
        })}
      </Card>
      <Text style={styles.note}>{t.papers.board.help}</Text>
      {note !== null ? (
        <Text style={[styles.note, note.tone === 'error' && styles.error]}>{note.message}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: layout.gutter, paddingTop: space.xl, gap: space.sm },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 13, letterSpacing: 0.8, color: colors.textDim },
  rows: { paddingVertical: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    gap: space.sm,
  },
  bordered: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowText: { flexShrink: 1, gap: 2 },
  symbol: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...tabular },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textFaint },
  note: { fontFamily: fonts.regular, fontSize: 13, color: colors.textFaint },
  error: { color: colors.down },
})
```

> The style names here mirror `board.tsx`'s own (`section`, `sectionTitle`, `rows`, `note`). Read `app/src/theme.ts` and use the tokens that exist — `colors.border`, `colors.textDim`, `colors.textFaint`, `space.sm`, `space.xl` — rather than inventing one the theme does not carry.

- [ ] **Step 2: Mount it in the three branches**

In `app/src/app/(tabs)/board.tsx`, add the import:

```tsx
import { PaperSection } from '../../components/board/PaperSection'
```

Then mount it at three of the four returns, **not the first**:

- At `:203`, the `hasDevice === null` branch: **leave it alone.** That is one frame of every cold launch and a section appearing and vanishing in it reads as a flicker.
- At `:211`, above `<NoBoardYet />`:

```tsx
      <Screen edges={['top']}>
        <Header baseUrl={null} />
        {/* This section is about the DESK, not the board. A phone with no board still has papers
            worth putting on one later, and the publish itself works with nothing attached —
            `pollBoard` is null and `runPaperPublish` skips it. */}
        <PaperSection pollBoard={null} />
        <NoBoardYet />
      </Screen>
```

- At `:238`, the "a board is configured but has not answered" branch, above the `<ScreenMessage …/>`:

```tsx
        <PaperSection pollBoard={() => client.refresh()} />
```

  `client` is non-null here — the branch above narrowed it — and a board that is not answering will
  fail that call, which `runPaperPublish` swallows by design.

- In the dashboard's `ScrollView`, immediately above the status `chipRow` at `:251`:

```tsx
        <PaperSection pollBoard={() => client.refresh()} />
```

  **Above the device rows**, which is where the spec puts it: what is on the glass is the first thing this tab is about.

- [ ] **Step 3: Run the suite and the typechecker**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add app/src/components/board/PaperSection.tsx "app/src/app/(tabs)/board.tsx"
git commit
```

with the message:

```
feat(app): any company's paper goes on the board at a tap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 12: The cadence, in Settings

**Files:**
- Create: nothing
- Modify: `app/src/lib/desk.ts` (one pure view function beside `deskLanguageView`), `app/src/lib/desk.test.ts`, `app/src/app/(tabs)/settings.tsx` (`DeskSection`, `:640-960`)

**Interfaces:**
- Consumes: `DeskSettings`, `PAPER_REFRESH_MIN`, `PAPER_REFRESH_MAX` (Task 4).
- Produces:
  - `export const PAPER_REFRESH_PRESETS: readonly number[] = [3, 6, 12, 24, 48, 72]`
  - `export type PaperRefreshNote = 'needs_setup' | 'absent' | 'custom' | null`
  - `export function paperRefreshView(input: { address: string | null; token: string | null; settings: DeskSettings | null; busy: boolean; loaded: boolean }): { selectedIndex: number; disabled: boolean; note: PaperRefreshNote; hours: number | null }`

**Why a pure view function and not four conditions in the component.** `deskLanguageView` is right there doing the same job for the row above, for the reason its own comment gives: this app has no screen tests, so anything argued inside a `.tsx` is argued only in prose. This row has one state the language row does not — a desk that answered perfectly well and carries no such setting — and that state is the one most likely to be drawn wrongly as "nothing is selected", which reads as a broken control.

**Chips and not a free number field.** 1..72 is the desk's range, not a list of sensible answers; a stepper over 72 values is a control nobody wants to use for a setting they change twice a year. Six presets cover the range, and `custom` says so honestly when the desk is on a value none of them names — which is exactly what a cadence set by hand, or by a future client, looks like from here.

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/desk.test.ts`:

```ts
import { PAPER_REFRESH_PRESETS, paperRefreshView } from './desk'

const settings = (hours: number | null) => ({ lang: 'en', paperRefreshHours: hours })

describe('paperRefreshView', () => {
  const on = { address: 'https://d', token: 'tok', busy: false, loaded: true }

  it('offers six choices across the desk’s whole range', () => {
    expect([...PAPER_REFRESH_PRESETS]).toEqual([3, 6, 12, 24, 48, 72])
  })

  it('lights the chip the desk is set to', () => {
    expect(paperRefreshView({ ...on, settings: settings(12) })).toEqual({
      selectedIndex: 2,
      disabled: false,
      note: null,
      hours: 12,
    })
  })

  it('says nothing while storage has not answered, rather than telling a set-up phone to set up', () => {
    expect(
      paperRefreshView({ address: null, token: null, settings: null, busy: false, loaded: false }),
    ).toMatchObject({ note: null, disabled: true })
  })

  it('asks for an address and a token when there are none', () => {
    expect(
      paperRefreshView({ address: null, token: null, settings: null, busy: false, loaded: true }),
    ).toMatchObject({ note: 'needs_setup', disabled: true, selectedIndex: -1 })
  })

  it('is dead and quiet while a read or a write is out', () => {
    expect(paperRefreshView({ ...on, busy: true, settings: settings(12) })).toMatchObject({
      disabled: true,
      note: null,
    })
  })

  it('says the desk has no such setting when it answered without one', () => {
    // NOT "nothing is selected", which reads as a broken control over a desk that answered
    // perfectly well. This is the state of every desk one release behind.
    expect(paperRefreshView({ ...on, settings: settings(null) })).toMatchObject({
      note: 'absent',
      disabled: true,
      selectedIndex: -1,
    })
  })

  it('says so when the desk is on a value none of the chips names', () => {
    // 1..72 is the desk's RANGE; the chips are six points in it. A cadence set by hand is legal
    // and has to be drawn honestly rather than rounded to the nearest chip.
    expect(paperRefreshView({ ...on, settings: { lang: 'en', paperRefreshHours: 9 } })).toMatchObject({
      note: 'custom',
      hours: 9,
      selectedIndex: -1,
      // Still usable: tapping a chip is how you leave a custom value.
      disabled: false,
    })
  })

  it('never disables the control over a value it simply does not recognise', () => {
    expect(paperRefreshView({ ...on, settings: { lang: 'en', paperRefreshHours: 9 } }).disabled).toBe(
      false,
    )
  })

  it('stays within the desk’s own range', () => {
    for (const h of PAPER_REFRESH_PRESETS) {
      expect(h).toBeGreaterThanOrEqual(PAPER_REFRESH_MIN)
      expect(h).toBeLessThanOrEqual(PAPER_REFRESH_MAX)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx jest src/lib/desk.test.ts`
Expected: FAIL — `paperRefreshView is not a function`.

- [ ] **Step 3: Write the view function**

In `app/src/lib/desk.ts`, after `deskLanguageView` (`:236`), add:

```ts
/**
 * The cadences the phone offers, in the order the chips are drawn.
 *
 * SIX POINTS IN A RANGE, NOT THE RANGE. The desk takes any integer from 1 to 72; these are the
 * answers worth one tap. Twelve is the desk's own default and the spec's — a paper costs the
 * worker thirty to forty minutes, so six hours does not fit in a day beside the board's own runs
 * for a watchlist of any size. Three is there for a one-symbol watchlist, and seventy-two for
 * somebody who wants the papers kept warm and little else.
 */
export const PAPER_REFRESH_PRESETS: readonly number[] = [3, 6, 12, 24, 48, 72]

export type PaperRefreshNote = 'needs_setup' | 'absent' | 'custom' | null

export interface PaperRefreshView {
  /** Index into `PAPER_REFRESH_PRESETS`, or `-1` for "no chip is the answer". */
  selectedIndex: number
  disabled: boolean
  note: PaperRefreshNote
  /** What the desk says is in force, for the `custom` note to quote. */
  hours: number | null
}

/**
 * What the cadence row draws.
 *
 * `deskLanguageView`'s shape, with ONE STATE THAT ROW DOES NOT HAVE: a desk that answered
 * perfectly well and carries no `paper_refresh_hours` at all — every desk one release behind this
 * app. Drawn as `absent` and disabled, because there is nothing a write could reach; drawn as
 * "nothing selected" it would look like a control that had broken.
 *
 * `settings === null` is "not read yet", which is why the whole document is the input rather than
 * the number: `hours === null` inside a document that arrived means something entirely different
 * from no document at all, and one nullable number cannot say both.
 */
export function paperRefreshView(input: {
  address: string | null
  token: string | null
  settings: DeskSettings | null
  busy: boolean
  loaded: boolean
}): PaperRefreshView {
  const ready = Boolean(input.address) && Boolean(input.token)
  const hours = input.settings?.paperRefreshHours ?? null
  const selectedIndex = hours === null ? -1 : PAPER_REFRESH_PRESETS.indexOf(hours)
  // Absent disables — there is nothing on the other end to write to. `custom` does NOT: tapping a
  // chip is exactly how somebody leaves a hand-set value, so a control that refused to be touched
  // would strand them on it.
  const absent = input.settings !== null && hours === null
  return {
    selectedIndex,
    disabled: !ready || input.busy || absent,
    note: !input.loaded
      ? null
      : !ready
        ? 'needs_setup'
        : input.busy
          ? null
          : absent
            ? 'absent'
            : selectedIndex < 0 && hours !== null
              ? 'custom'
              : null,
    hours,
  }
}
```

- [ ] **Step 4: Draw the row**

In `app/src/app/(tabs)/settings.tsx`'s `DeskSection`:

1. Task 4 already replaced the `lang` state with the whole document. Confirm it reads `const [settings, setSettings] = useState<DeskSettings | null>(null)`, that the read effect at `:689-702` calls `setSettings(await …getSettings())`, and that both the `!address || !token` arm and the error arm call `setSettings(null)`. `deskLanguageView`'s `lang` argument becomes `settings?.lang ?? null`.
2. Add the writer beside `chooseLanguage`:

```tsx
  // Write the cadence, then draw WHAT THE DESK PUT IN FORCE. The language write's rule, and the
  // same `alive` guard: a desk behind a cold tunnel has fifteen seconds to answer and the tab can
  // be left in one. `settings` is sent whole because `putSettings` builds the body field by field
  // and omits the cadence when there is none — see its comment.
  const chooseCadence = async (hours: number) => {
    if (!address || !token || settings === null || hours === settings.paperRefreshHours) return
    setBusy(true)
    setLangMsg(null)
    try {
      const next = await createDeskClient({ baseUrl: address, token }).putSettings({
        lang: settings.lang,
        paperRefreshHours: hours,
      })
      if (!alive.current) return
      setSettings(next)
      setLangMsg({ tone: 'ok', message: s.settings.desk.paperRefreshSaved })
    } catch (e) {
      if (alive.current) setLangMsg({ tone: 'error', message: humanDeskError(e) })
    } finally {
      if (alive.current) setBusy(false)
    }
  }
```

3. Below the language `SegmentedControl` and its note (`:946-955`), add the row:

```tsx
      <Text style={styles.deskLabel}>{s.settings.desk.paperRefresh}</Text>
      <Text style={styles.help}>{s.settings.desk.paperRefreshHelp}</Text>
      <View style={styles.chipRow}>
        {PAPER_REFRESH_PRESETS.map((hours, i) => (
          // Keyed on the interval and not on the label: the label is copy and changes with the
          // language, which would remount every chip on a language switch. `SleepEditor`'s rule.
          <Chip
            key={hours}
            label={formatInterval(hours * 3600)}
            active={i === cadence.selectedIndex}
            disabled={cadence.disabled}
            onPress={() => void chooseCadence(hours)}
          />
        ))}
      </View>
      {cadenceNote !== null ? <Text style={styles.help}>{cadenceNote}</Text> : null}
```

  with, beside the existing `const view = deskLanguageView(...)`:

```tsx
  const cadence = paperRefreshView({ address, token, settings, busy, loaded })
  const cadenceNote =
    cadence.note === 'needs_setup'
      ? s.settings.desk.needsSetup
      : cadence.note === 'absent'
        ? s.settings.desk.paperRefreshAbsent
        : cadence.note === 'custom'
          ? fill(s.settings.desk.paperRefreshCustom, { hours: String(cadence.hours ?? '') })
          : null
```

  `formatInterval` comes from `../../lib/format` and renders `3600 * 12` as "every 12h" in both languages — the same function the sleep chips use, so an interval reads identically wherever it appears. Import `Chip` from `../../components/Chip` and `PAPER_REFRESH_PRESETS`, `paperRefreshView` from `../../lib/desk` beside the existing `deskLanguageView` import at `:36`. `styles.chipRow` may not exist in this file; if not, add one matching `board.tsx:` `{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }`.

- [ ] **Step 5: Run the tests and the typechecker**

Run: `cd app && npx jest src/lib/desk.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add app/src/lib/desk.ts app/src/lib/desk.test.ts "app/src/app/(tabs)/settings.tsx"
git commit
```

with the message:

```
feat(app): how often the desk rewrites a paper is a row in Settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 13: The contract, written down

**Files:**
- Modify: `docs/app-control.md`

- [ ] **Step 1: Extend "The desk from the phone"**

After the table of queue routes added by the ask feature, insert:

```markdown
**The phone reads more than one edition now.** The desk keeps a current
newspaper for every company on the watchlist — a **paper** — and Today pages
through them. Four routes, the first three at the producer scope and the last
at the operator scope, all through `app/src/lib/desk.ts` as usual.

| Method | Path | What the phone does with it |
|---|---|---|
| GET | `/api/papers` | the list, in watchlist order, refetched on focus past a five-minute throttle |
| GET | `/api/editions/<eid>/news.json` | one page's payload, conditional, cached in memory by edition id |
| GET | `/api/editions/<eid>/tiles/<id>.bin` | that page's photographs |
| POST | `/api/papers/<SYMBOL>/publish` | put that company's paper on the glass |

Five things a client has to get right:

- **`created_at` is unix seconds.** Every other numeric stamp in the app is
  milliseconds. `parsePaper` multiplies once and nothing downstream converts
  anything.
- **A row of nulls is a symbol with no paper, and it is still a page.** The
  pager draws "not written yet" for it rather than being one page shorter than
  the watchlist, because a company vanishing from the phone the day it is added
  is indistinguishable from a bug.
- **The pager appears only when the desk answers with at least one paper.** No
  token, no address, a desk one release behind with no `/api/papers`, an empty
  watchlist — every one of those leaves Today exactly what it was: one page,
  the device plane's `news.json`, no credential. The single-page reader is the
  floor and the pager is laid over it.
- **An edition id is a content fingerprint**, so a payload cached under one
  cannot go stale. It can only stop being the newest, and the list is what says
  so. That is why there is no revalidation inside a session and why the cache
  is keyed on the id rather than on the symbol.
- **A paper's pictures are behind the same bearer as its payload.** The reader
  carries an `EditionSource` — payload address, tile address, headers — so the
  same components render an unauthenticated `/news.json` and an authenticated
  per-edition route with no branch between them. The token is in that object,
  in memory; `edition/store.ts` writes four keys to disk and that is not one of
  them.

**`GET/PUT /api/settings` carries `paper_refresh_hours` (1..72) beside `lang`.**
The phone sends it **only when the desk's own GET reported one** — the desk
refuses an unknown key over the whole document, so a phone that always sent it
would turn every language write against an older desk into a 400.

The design is
[docs/superpowers/specs/2026-09-11-papers-per-ticker-design.md](superpowers/specs/2026-09-11-papers-per-ticker-design.md).
```

- [ ] **Step 2: Commit**

```
git add docs/app-control.md
git commit
```

with the message:

```
docs(app): the phone reads a paper per company now

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

---

### Task 14: Render it on the iPhone simulator

**Files:**
- Create: `tools/mock_desk_server.py`
- Modify: nothing else unless the render finds a defect — in which case fix it here and say what it was in the commit.

**This is not optional.** [AGENTS.md](../../../AGENTS.md) carries the owner's rule: render the app on the iPhone simulator and look at it before opening a PR. Nothing in Tasks 1–13 can see a horizontal `FlatList` paging at the wrong width, a page header colliding with a masthead, a Korean chip clipped by a row, or a photograph fetched with no `Authorization` on it. The last one is the whole of Task 1 and it is invisible to every test in this plan, because every test in this plan asserts on a fake.

**Why the mock wraps rather than duplicates.** `tools/mock_news_server.py` is the reference producer: it owns the committed fixture, the tile directory, and the ETag recipe the desk itself uses. The mock desk needs all three and adds only a bearer and four routes, so it imports that module rather than copying a snapshot into a second file that could drift from it.

- [ ] **Step 1: Write the mock desk**

Create `tools/mock_desk_server.py`:

```python
#!/usr/bin/env python3
"""A mock desk, for looking at the app's papers on a simulator.

Serves the four control-plane routes the papers feature reads, plus the device
plane, over ONE payload: the reference producer's committed fixture, with the
subject's symbol and name swapped per company so the five pages are visibly
different newspapers rather than five copies of one.

It wraps tools/mock_news_server.py rather than copying it. That module owns the
fixture, the tile directory and the ETag recipe the real desk uses; a second
snapshot here would be a second thing to keep in step with news_mock.c, which
is the one equivalence this repository tests for in both directions.

    python3 tools/mock_desk_server.py --port 8080 --token dev-operator-token

Not a test and not a server anybody should point a board at: there is no
authorization worth the name, the papers are made up, and every edition id is
derived from the symbol.
"""

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mock_news_server as producer  # noqa: E402

# Five companies, the fixture's own first among them so page 0 is the paper the
# board is showing. `hours` is how long ago the desk "wrote" it, which is what
# the page header and the Board row are drawn from.
PAPERS = [
    ("SNDK", "SanDisk", 2),
    ("TSLA", "Tesla", 9),
    ("MU", "Micron", 27),
    ("AAPL", "Apple", 51),
    ("BRK.B", "Berkshire Hathaway", None),   # no paper: the placeholder page
]

SYMBOL_RE = re.compile(r"^[A-Z0-9.\-]{1,8}$")
EID_RE = re.compile(r"^[0-9a-f]{16}$")


def edition_id(symbol):
    """Deterministic, so a reload keeps the app's cache warm."""
    return hashlib.sha256(symbol.encode()).hexdigest()[:16]


def payload_for(symbol, name):
    """The fixture, with this company's name on it."""
    doc = copy.deepcopy(producer.snapshot())
    doc["subject"]["symbol"] = symbol
    doc["subject"]["name"] = name
    return doc


def papers_doc(board_symbol):
    now = int(time.time())
    rows = []
    for symbol, name, hours in PAPERS:
        if hours is None:
            rows.append({
                "symbol": symbol, "name": name, "edition_id": None,
                "created_at": None, "lang": None, "headline": None,
                "on_board": False, "stale": True,
            })
            continue
        doc = payload_for(symbol, name)
        lead = (doc.get("stories") or [{}])[0]
        rows.append({
            "symbol": symbol,
            "name": name,
            "edition_id": edition_id(symbol),
            "created_at": now - hours * 3600,
            "lang": doc.get("lang", "en"),
            "headline": lead.get("headline"),
            "on_board": symbol == board_symbol,
            "stale": hours >= 12,
        })
    return {"ok": True, "papers": rows, "board": edition_id(board_symbol)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 30
    token = "dev-operator-token"
    board = "SNDK"
    settings = {"lang": "en", "paper_refresh_hours": 12}

    def _authed(self):
        return self.headers.get("Authorization", "") == "Bearer " + self.token

    def _json(self, status, doc, etag=None):
        body = json.dumps(doc, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if etag is not None:
            self.send_header("ETag", etag)
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(data)

    def _symbol_of(self, eid):
        for symbol, _name, hours in PAPERS:
            if hours is not None and edition_id(symbol) == eid:
                return symbol
        return None

    def do_GET(self):
        path = self.path.split("?")[0]

        # The device plane, unauthenticated, exactly as the real desk serves it.
        # This is what Today reads WITHOUT a token, and the floor the pager is
        # laid over.
        if path in ("/news.json", "/"):
            name = next(n for s, n, _ in PAPERS if s == Handler.board)
            doc = payload_for(Handler.board, name)
            return self._json(200, doc, producer.Handler.etag_for(doc))
        if path.startswith("/tiles/") and path.endswith(".bin"):
            return self._tile(path[len("/tiles/"):-len(".bin")])

        if not self._authed():
            return self._json(401, {"ok": False, "error": "unauthorized"})

        if path == "/api/papers":
            return self._json(200, papers_doc(self.board))

        if path == "/api/settings":
            return self._json(200, {"ok": True, "source": "file",
                                    "settings": self.settings})

        m = re.match(r"^/api/editions/([0-9a-f]{16})/news\.json$", path)
        if m:
            symbol = self._symbol_of(m.group(1))
            if symbol is None:
                return self._json(404, {"ok": False, "error": "not_found"})
            name = [n for s, n, _ in PAPERS if s == symbol][0]
            doc = payload_for(symbol, name)
            etag = producer.Handler.etag_for(doc)
            if etag in [t.strip() for t in
                        self.headers.get("If-None-Match", "").split(",") if t.strip()]:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            return self._json(200, doc, etag)

        m = re.match(r"^/api/editions/[0-9a-f]{16}/tiles/(.+)\.bin$", path)
        if m:
            return self._tile(m.group(1))

        return self._json(404, {"ok": False, "error": "not_found"})

    def _tile(self, tile_id):
        if not producer.TILE_ID_RE.match(tile_id):
            return self._json(404, {"ok": False, "error": "not_found"})
        try:
            with open(os.path.join(producer.SIM_TILES, tile_id + ".bin"), "rb") as f:
                return self._bytes(f.read())
        except OSError:
            return self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self._authed():
            return self._json(401, {"ok": False, "error": "unauthorized"})
        m = re.match(r"^/api/papers/([A-Z0-9.\-]{1,8})/publish$", path)
        if not m:
            return self._json(404, {"ok": False, "error": "not_found"})
        symbol = m.group(1)
        row = [(s, h) for s, _n, h in PAPERS if s == symbol]
        if not row or row[0][1] is None:
            return self._json(404, {"ok": False, "error": "no_paper"})
        state = "unchanged" if symbol == Handler.board else "published"
        Handler.board = symbol
        return self._json(200, {"ok": True, "edition_id": edition_id(symbol),
                                "state": state})

    def do_PUT(self):
        if self.path.split("?")[0] != "/api/settings":
            return self._json(404, {"ok": False, "error": "not_found"})
        if not self._authed():
            return self._json(401, {"ok": False, "error": "unauthorized"})
        n = int(self.headers.get("Content-Length", "0"))
        try:
            doc = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._json(400, {"ok": False, "error": "bad_settings"})
        # The real desk refuses an unknown key over the WHOLE document, and this
        # mock does too — it is the one behaviour the app has to be tested
        # against, because getting it wrong breaks the language row as well.
        for key in doc:
            if key not in ("lang", "paper_refresh_hours"):
                return self._json(400, {"ok": False, "error": "bad_settings",
                                        "detail": "unknown key: " + key})
        Handler.settings = {**Handler.settings, **doc}
        return self._json(200, {"ok": True, "source": "file",
                                "settings": Handler.settings})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--token", default="dev-operator-token")
    args = ap.parse_args()
    Handler.token = args.token
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write("mock desk on http://%s:%d, token %s\n"
                     % (args.host, args.port, args.token))
    srv.serve_forever()


if __name__ == "__main__":
    main()
```

Check it answers before going near the simulator:

```bash
python3 tools/mock_desk_server.py --port 8080 &
curl -s localhost:8080/api/papers -H 'Authorization: Bearer dev-operator-token' | head -c 400
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/api/papers          # 401
curl -s localhost:8080/news.json | head -c 120                              # the device plane
```

Expected: five rows with one `on_board: true`, a `401` with no token, and the fixture on the open plane.

- [ ] **Step 2: Start the app under Expo Go**

```bash
cd app && npx expo start --ios --go
```

`--go` is required: `expo-dev-client` is a dependency and without the flag Expo tries to open a dev build that is not committed.

- [ ] **Step 3: Look at Today WITHOUT a token first**

Before entering anything in Settings, open Today. **It must be exactly one page** — the fixture from the device plane, or the bundled demo if no address is set — with no page header, no horizontal scroll, and no request to `/api/papers` in the mock's log.

```bash
mkdir -p .superpowers/sdd/2026-09-11-papers-app/shots
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/01-today-no-token.png
```

This is the screenshot that proves the Global Constraint. If there is a pager here, stop and fix it before anything else.

- [ ] **Step 4: Give it the desk**

In Settings, set the desk address to `http://127.0.0.1:8080` and paste `dev-operator-token`. Screenshot the Desk section so the new cadence row, with `12h` lit, is on the record:

```bash
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/02-settings-cadence.png
```

Tap `24h` and confirm the note under it says the desk is pacing at that from now on, and that the mock's log shows `PUT /api/settings` with **both** keys. Then check the failure the ordering constraint is about: stop the mock, start it with `--token dev-operator-token` again, and in a shell `curl -X PUT localhost:8080/api/settings -H 'Authorization: Bearer dev-operator-token' -d '{"lang":"en","nonsense":1}'` — it must answer `400 bad_settings`, which is the behaviour the app's omission rule exists for.

- [ ] **Step 5: Page through the papers**

Back on Today, the pager must appear within a moment. Swipe through all five pages and check each of these, which no test in this plan can:

1. **Page 0 is SNDK and carries the "On the board" chip.**
2. **Each page fills the screen exactly** — no half-page rest position, no vertical scroll stealing the horizontal gesture, no page peeking at the edge.
3. **The photographs load on every page.** A grey box where a picture should be means the `Authorization` header did not reach `fetchTile`, which is Task 1's whole point and is invisible to every test here.
4. **The page header shows the age** — `2h ago`, `9h ago`, `27h ago` — and the stale chip appears on the ones the mock marked.
5. **BRK.B is a placeholder page**, not a spinner and not a gap.

```bash
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/03-pager-board.png
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/04-pager-second.png
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/05-pager-placeholder.png
```

Then tap a tile on **page three** and confirm the detail route opens **that company's** story, not page 0's. That is the `setCurrentEdition` line in Task 10 and it fails silently.

```bash
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/06-tile-from-page-three.png
```

- [ ] **Step 6: Put another paper on the board**

Open the Board tab. The **Paper on the board** section must be above the device rows, with a tick beside SNDK and BRK.B drawn but dead. Tap Micron, confirm the alert, and watch three things: the alert's wording, the tick moving to Micron, and Today's page 0 becoming Micron on the next focus.

```bash
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/07-board-section.png
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/08-board-confirm.png
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/09-board-after.png
```

Then tap BRK.B and confirm nothing happens at all — a dead row, no alert.

- [ ] **Step 7: Korean, and the two failures**

1. **Korean.** Switch the app's language to Korean in Settings. Check the page header (`2시간 전`), the placeholder page, the Board section's title and its confirmation alert. `보드에 걸 지면` is a wider heading than `Paper on the board`; confirm nothing is clipped.
2. **The desk goes away.** Kill the mock and pull Today down. The pages already fetched must stay on screen — a pager that collapsed to one page because a tunnel blinked is the failure `list.ts`'s catch arm is written against.
3. **The token goes away.** Restart the mock, then use **Forget token** in Settings. Today must fall back to the single page, and the Board section must disappear entirely rather than becoming an empty card.

```bash
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/10-korean-pager.png
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/11-desk-down.png
xcrun simctl io booted screenshot .superpowers/sdd/2026-09-11-papers-app/shots/12-token-forgotten.png
```

- [ ] **Step 8: Fix anything the render found, then commit**

```bash
git add -A
git commit
```

with a message naming what the render found, or — if it found nothing — committing only the mock:

```
test(app): a mock desk, and the papers rendered on the simulator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pxz7nt2DE47CnaMzY4kvNJ
```

Attach the twelve screenshots to the PR; that is what the owner's rule is for.

- [ ] **Step 9: The full local suite, one last time**

```bash
cd app && npm test && npm run typecheck
```

Expected: PASS, with no skipped and no `.only` tests. `sh server/test/run.sh` and `sh agent/test/run.sh` belong to the other two plans. The simulator and the firmware are untouched by this plan — nothing on the wire moved — but `cd sim && ./sim.sh` and `idf.py build` must still be green on the branch before it merges.

---

## Self-Review

**1. Spec coverage** — every clause of §5 and the App row of §8:

| Spec clause | Task |
|---|---|
| §5.1 Today is a horizontal pager over `GET /api/papers` when there is a desk token | 6 (the list), 10 (the pager) |
| §5.1 The board's paper first, then watchlist order | 5 (`orderPapers`), asserted in `order.test.ts` |
| §5.1 Each page is the existing edition reader over that edition's payload | 10 (`PaperPage`) |
| §5.1 Payloads through `/api/editions/<eid>/news.json`, tiles through the matching route, with the Authorization header | 1 (`paperSource`, the client's headers), 3 (`editionPayload`) |
| §5.1 Payloads cached per edition id | 7 (`cache.ts`) |
| §5.1 The list refetched on focus with Today's existing throttle | 6 (`PAPERS_REFRESH_AFTER_MS`, `papersFetchDue`), 10 (the focus effect) |
| §5.1 A `revised` / `published` outcome invalidates it the way it invalidates the edition | 6 (`markEditionStale` marks both — `useAskThread` is not touched) |
| §5.1 A page header with symbol, name and age, in both languages | 5 (`paperAgeLabel`), 9 (the strings), 10 (`PaperPageHeader`) |
| §5.1 A placeholder page for a symbol with no paper | 7 (`paperPageOf`'s first arm), 9, 10 |
| §5.1 Page position remembered for the session, not persisted | 6 (`rememberPaperIndex` in module scope), 10 |
| §5.1 Without a desk token, Today is exactly what it is today | Global Constraints; 5 (`papersPagerView`), 10 (`TodayEdition` extracted, not rewritten), 14 step 3 (the screenshot that proves it) |
| §5.2 A "Paper on the board" section above the device rows | 11 |
| §5.2 Rows with symbol, name, age and a check on the one on the board | 11 |
| §5.2 Tap → confirm → `publishPaper` → mark → invalidate Today → `client.refresh()` | 8 (`runPaperPublish`), 11 (the alert) |
| §5.2 Disabled rows for a symbol with no paper | 11 |
| §5.2 Hidden without a desk token | 11 (`ready !== true` returns null) |
| §5.3 A cadence row, 1..72, through `putSettings` | 4 (the wire), 12 (`paperRefreshView` and the chips) |
| §5.4 `DeskClient` gains `papers()`, `editionPayload()`, `editionTile()`, `publishPaper()`; types mirror §3.7 | 2 and 3 — **`editionTile` deliberately not implemented**, see below |
| §8 App: pager order with the board's paper first | 5 |
| §8 App: placeholder page for a symbol with no paper | 7 |
| §8 App: no pager without a token | 5 |
| §8 App: the board list publishes and refreshes | 8 |
| §8 App: the client methods' paths, headers and result shapes | 2, 3, 4 |
| §8 Simulator and firmware unchanged and still green | 14 step 9 |

**One deviation, argued at the point of it (Task 3).** `DeskClient.editionTile(eid, id)` is not implemented. The route is reached instead through `paperSource().tileUrl(id)` plus `source.headers` into `editionClient.fetchTile`, which is the only tile path this app has and the only one that checks the body against `w*h/2` before decoding it. A `DeskClient.editionTile` would be a second path to the same bytes with nothing to check them against, and its only possible caller already has a better one. The route itself is coded against exactly.

**2. Placeholder scan** — no "TBD", no "add error handling", no "similar to Task N", no test described without its code. Two steps describe an edit rather than quoting the file around it, and both name the lines: Task 10's step 3, inside a 220-line `edition.tsx` whose existing body must be MOVED rather than retyped — quoting it back would invite exactly the retyping it warns against — and Task 12's step 4, inside a 1,300-line `settings.tsx`, which names `:36`, `:689-702`, `:839` and `:946-955` and quotes the code to put at each. Task 14's steps are manual by nature and each one says what must be true rather than what to look at.

**3. Type consistency** — checked across tasks. `EditionSource` / `deviceSource` / `paperSource` / `deviceTileUrl` / `NO_SOURCE` are Task 1's and used with those names in 3, 7, 10 and 11. `EditionSourceProvider` / `useEditionSource` are Task 1's and used in 10. `CachedEdition.source` is Task 1's and read in 7 and 10. `Paper` / `PapersDoc` / `PublishPaperOutcome` are Task 2's and used in 5, 6, 7, 8, 10 and 11. `editionSource()` / `editionPayload()` are Task 3's and used in 7. `DeskSettings.paperRefreshHours` / `PAPER_REFRESH_MIN` / `PAPER_REFRESH_MAX` are Task 4's and used in 12. `orderPapers` / `papersPagerView` / `paperAgeLabel` / `clampPaperIndex` / `paperKey` are Task 5's and used in 10 and 11. `PapersState` / `usePapers` / `loadPapers` / `papersFetchDue` / `rememberPaperIndex` / `lastPaperIndex` are Task 6's and used in 8, 10 and 11. `takePapersStale` is Task 6's and read only by `list.ts`. `PaperPageState` / `paperPageOf` / `usePaperPage` / `readPaperCache` / `putPaperCache` / `MAX_CACHED_PAPERS` are Task 7's and used in 10. `runPaperPublish` / `PaperPublishDeps` / `PaperPublishResult` are Task 8's and used in 11. `PAPER_REFRESH_PRESETS` / `paperRefreshView` / `PaperRefreshNote` are Task 12's and used in 12 alone. `strings().papers.*` is Task 9's and every key used in 10 and 11 — `page.onBoard`, `page.stale`, `page.noAge`, `placeholder.title`, `placeholder.body`, `pageFailed`, `board.title`, `board.help`, `board.noPaper`, `board.confirmTitle`, `board.confirmBody`, `board.confirm`, `board.cancel`, `board.published`, `board.gone`, `board.failed`, `board.a11y.row`, `board.a11y.onBoard` — is defined there, as are the five `settings.desk.paperRefresh*` keys Task 12 uses.

**One collision found in review and fixed inline.** The page's state type was called `PaperPage`, which is also the name of the component in `components/edition/PaperPage.tsx`. They are in different modules and would never have been imported into the same file, but a type and a component sharing a name is a thing a reader has to hold two meanings of. The type is `PaperPageState` throughout Tasks 7 and 10; the component keeps the name its file is called after.
