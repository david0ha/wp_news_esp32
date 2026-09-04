// The last good edition, kept so the Today tab reads on a train.
//
// One AsyncStorage key holding one JSON object: the URL it came from, the ETag to send next
// time, when the server last CONFIRMED it, and THE WIRE BODY EXACTLY AS THE DESK SERVED IT. Four
// fields and no schema version, because the read re-parses through `parseEdition` — a cache
// written by a newer build degrades to defaults instead of crashing a launch, which is the only
// version handling a shape this small needs.
//
// THE WIRE BODY AND NOT THE PARSED EDITION, and that is the whole point of this file's shape.
// `parseEdition` reads WIRE names — `prev_close`, `change_pct`, `is_subject`, `as_of` — and the
// model spells them `prevClose`, `changePct`, `isSubject`, `asOf`. Storing the parsed edition and
// re-parsing THAT dropped every field whose two spellings differ, silently, while every field
// spelled the same on both sides (`open`, `high`, `last`, `headline`) came through untouched and
// hid it. The visible half was a Range tile of em dashes on a cold deep link, under a masthead
// that had the same numbers from the same desk. Re-parsing is only "a cache a newer build wrote
// degrades gracefully" if what is re-parsed is what the parser reads.
//
// So an entry written before this — one carrying `edition` and no `wire` — reads as NO CACHE at
// all. A parsed edition cannot be turned back into wire names, and half an edition is worse than
// none. It costs one fetch, once, on the first launch after the update.
//
// `fetchedAt` is a confirmation, not a change: a 304 moves it (`touchCachedEdition`) without
// touching a byte of content. That is exactly the question the freshness line answers, and it is
// the one field that moves WITHOUT A DISK WRITE — see `touchCachedEdition`.
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
  /**
   * The JSON body as it arrived, parsed from the response text and otherwise untouched. THIS IS
   * WHAT IS PERSISTED; `edition` below is derived from it and is not written to disk.
   */
  wire: unknown
  /** `parseEdition(wire)`. Kept beside it so no caller has to re-derive what the reader already did. */
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
  // An entry from before this cache stored wire bodies. See the header: there is no way back to
  // the wire names from a parsed edition, so it is treated as nothing cached.
  if (!('wire' in o)) return null
  const edition = parseEdition(o.wire)
  // An entry with nothing showable in it is worse than no entry: it would put a blank sheet on
  // screen and suppress the load that would have replaced it.
  if (isEmptyEdition(edition)) return null
  return {
    url: o.url,
    etag: typeof o.etag === 'string' ? o.etag : null,
    fetchedAt: o.fetchedAt,
    wire: o.wire,
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
  // Published to `current` WITHOUT ASKING WHOSE DESK IT IS. This file does not know the phone's
  // news URL, and taking a dependency on `lib/store.ts` to find out is more coupling than the
  // question is worth — so both readers ask it themselves instead. `useEdition`'s reducer drops
  // a cache entry whose `url` is not the stored one, and the detail route's cold deep link
  // compares the two before it renders. A foreign entry is therefore reachable through
  // `getCurrentEdition()` and is put on screen by neither.
  if (entry !== null) current = entry
  return entry
}

export async function writeCachedEdition(c: CachedEdition): Promise<void> {
  // The in-memory copy is set BEFORE the disk write is awaited, the same order `store.ts`'s
  // `saveNewsUrl` uses: the caller's next act is to render, and a detail route opened while the
  // write is in flight must see what was just fetched.
  current = c
  try {
    // The wire body, NOT the entry: `edition` is derived from `wire` on every read, and writing
    // both would store the same content twice in two spellings — the second of which is the one
    // the reader cannot use. See the header.
    const stored = { url: c.url, etag: c.etag, fetchedAt: c.fetchedAt, wire: c.wire }
    await AsyncStorage.setItem(EDITION_CACHE_KEY, JSON.stringify(stored))
  } catch {
    // best-effort: the cost is re-fetching one edition on the next cold launch
  }
}

/**
 * After a 304 — the content did not move, but the server just confirmed it.
 *
 * IN MEMORY ONLY, AND SYNCHRONOUS. Re-serialising a whole edition — twenty kilobytes of JSON —
 * to move one integer is the most expensive way to store the cheapest fact this cache holds, and
 * the poll that triggers it is the one that found nothing new. The screen does not read this
 * copy anyway: the reducer moves `fetchedAt` in React state from the same event, so the freshness
 * line is right the instant the 304 lands, with or without a disk write.
 *
 * What that costs is one cold launch: the entry read back off disk carries the last 200's stamp
 * rather than the last confirmation's, so the freshness line can open a second or so too old,
 * until the fetch that always follows a cold read answers and moves it. The next real write —
 * any 200 — persists whatever this left in memory.
 */
export function touchCachedEdition(fetchedAt: number): void {
  if (current === null) return
  current = { ...current, fetchedAt }
}

/** Test hook: drop the in-memory copy so a fresh read hits the (mocked) store. */
export function __resetEditionStoreForTests(): void {
  current = null
}
