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
