// The page on the glass, remembered — one entry, keyed by what the board says is printed.
//
// A decoded framebuffer is about 2.6 MB of base64: 1.92 million pixels expanded out of 960,000
// bytes, deflated and encoded, all on the one JS thread there is. It is worth not doing twice, and
// it is worth not holding twice.
//
// THE KEY IS ASSEMBLED, NOT REPORTED. The firmware has exactly the fingerprint this wants —
// `news_hash()`, which CLAUDE.md describes as covering everything that reaches the glass down to
// the individual bars — and `/api/state` does not emit it (device_api_json.c). So the key is built
// here from the state fields that CAN change the pixels. That makes it a conservative proxy rather
// than an identity: it may say "changed" when nothing did, which costs one re-read of a megabyte,
// and it must never say "unchanged" when the sheet moved, which would leave the phone showing a
// page that is not on the wall. Every field below is in it because it is ink on the sheet.
//
// ONE ENTRY, not an LRU. The board has one page on the glass at a time — `/api/screen` returns
// whatever is printed, and putting the other page up costs a twenty-to-thirty-second refresh on the
// board itself. A second slot would double the resident cost to buy a hit that the hardware makes
// expensive on purpose. (`ui_tile.c` on the device makes the same call for the same reason.)

/**
 * The part of `DeviceState` that decides what the framebuffer holds.
 *
 * Structural rather than `DeviceState` itself so the fingerprint can be reasoned about — and
 * tested — without standing up forty fields of battery and power telemetry that cannot change a
 * pixel. A real `DeviceState` satisfies it.
 */
export interface ScreenIdentity {
  page: number
  /** The board's own title for that page — esp32.ts: "the ground truth for what is on the glass". */
  pageTitle: string
  news: {
    valid: boolean
    demo: boolean
    edition: string
    generatedAt: string
    subject: { symbol: string }
  }
  source: { stale: boolean }
}

/**
 * A key for what is printed right now, or `''` when the board has not said.
 *
 * `''` is the "do not cache this" value: a decode with no fingerprint could never be invalidated,
 * so it must not be stored and must not be served. The separators matter — `edition:"AB"` with
 * `generatedAt:"C"` and `edition:"A"` with `generatedAt:"BC"` are different boards, and a key that
 * ran the fields together would say otherwise.
 */
export function screenFingerprint(state: ScreenIdentity | undefined | null): string {
  if (!state) return ''
  const n = state.news
  return [
    // Which page is up. A1 and A2 are two different framebuffers, and switching between them is
    // the one thing a reader does that changes the glass without changing the edition.
    String(state.page),
    // What the board says it drew there. The only field that can move when nothing about the
    // EDITION has, which is why it is worth carrying beside `page` rather than folding into it.
    state.pageTitle,
    // Whether the board has ever parsed an edition, and whether this is the built-in demo. Both
    // print a different sheet from a real edition, and neither moves `generatedAt` on its own.
    n.valid ? 'ok' : 'unset',
    n.demo ? 'demo' : 'live',
    // The edition itself. docs/app-control.md: "a new `symbol` or a new `generatedAt` means a new
    // edition where an unchanged pair means the board is quietly doing its job."
    n.edition,
    n.generatedAt,
    n.subject.symbol,
    // The STALE badge is drawn ON the sheet (ui_news.c's furniture), so it is part of the picture
    // and not a piece of app chrome laid over it.
    state.source.stale ? 'stale' : 'fresh',
  ].join(' ')
}

let slotKey = ''
let slotPng: string | null = null

/** The decoded sheet for `key`, or `null` — a miss, never a stale hit under another key. */
export function screenCacheGet(key: string): string | null {
  if (key === '' || key !== slotKey) return null
  return slotPng
}

/** Keep one decode. Anything already held is dropped: the old sheet is no longer on the glass. */
export function screenCachePut(key: string, pngBase64: string): void {
  if (key === '') return
  slotKey = key
  slotPng = pngBase64
}

/**
 * Drop it.
 *
 * Three callers, and the third is the important one: tests, anything that repoints the app at a
 * different board, and **an explicit "Fetch it again"**. A deliberate request and an incidental
 * remount are different events and must not share a path — see `screenCached` below.
 */
export function screenCacheClear(): void {
  slotKey = ''
  slotPng = null
}

/**
 * Serve the slot if it holds this key, otherwise produce and keep.
 *
 * This is the whole of the caching policy, in one place, because getting it wrong is invisible:
 * consulting the cache first is right for a REMOUNT (the sheet is already known, and 1.92 million
 * pixels of inflate for a picture we have is pure cost) and wrong for a REFETCH. `refetch()`
 * re-runs the producer, the producer's first act is to return the slot under the same key, and the
 * button hands back byte-identical pixels having never touched the board.
 *
 * That is not a tidiness point. `/api/screen` can return a frame caught mid-render — the firmware
 * says so, and says the remedy is to ask again — and a fingerprint does not move for a board that
 * is quietly doing its job. Without a way out, a torn capture is permanent for the rest of the day.
 * The way out is `screenCacheClear()` immediately before the refetch; the cache is not asked to
 * distinguish the two events, the caller is asked to say which one it is.
 *
 * A failed produce stores nothing, so a dropped socket is retried rather than remembered.
 */
export async function screenCached(
  key: string,
  produce: () => Promise<string>,
): Promise<string> {
  const hit = screenCacheGet(key)
  if (hit) return hit
  const png = await produce()
  screenCachePut(key, png)
  return png
}
