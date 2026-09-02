// The AsyncStorage watchlist store (spec §4.6). Mirrors store.ts's shape: module-level
// in-memory cache, best-effort try/catch, a test reset. Symbols are stored uppercased and
// trimmed; a corrupt entry is dropped rather than taking the list down.

import AsyncStorage from '@react-native-async-storage/async-storage'

export interface WatchItem {
  symbol: string
  name: string
}

export const WATCHLIST_KEY = 'claudepost.watchlist' // JSON: WatchItem[]

let cache: WatchItem[] | null = null

// Validate a stored payload entry by entry: `symbol` must be a non-empty string (after the
// trim/uppercase normalization), duplicates keep their first appearance, everything else is
// dropped. Corrupt or missing storage → [].
function sanitize(raw: unknown): WatchItem[] {
  if (!Array.isArray(raw)) return []
  const out: WatchItem[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const symbolRaw = (entry as { symbol?: unknown }).symbol
    if (typeof symbolRaw !== 'string') continue
    const symbol = symbolRaw.trim().toUpperCase()
    if (symbol === '' || seen.has(symbol)) continue
    seen.add(symbol)
    const nameRaw = (entry as { name?: unknown }).name
    out.push({ symbol, name: typeof nameRaw === 'string' ? nameRaw : '' })
  }
  return out
}

async function load(): Promise<WatchItem[]> {
  if (cache !== null) return cache
  try {
    const raw = await AsyncStorage.getItem(WATCHLIST_KEY)
    cache = raw === null || raw === undefined ? [] : sanitize(JSON.parse(raw))
  } catch {
    cache = []
  }
  return cache
}

async function persist(list: WatchItem[]): Promise<void> {
  cache = list
  try {
    await AsyncStorage.setItem(WATCHLIST_KEY, JSON.stringify(list))
  } catch {
    // best-effort — the session keeps the in-memory list; worst case is losing it on relaunch
  }
}

/** The stored list, corrupt/missing → []. Returns a copy — callers may not mutate the cache. */
export async function getWatchlist(): Promise<WatchItem[]> {
  return [...(await load())]
}

/**
 * Uppercase the symbol, dedupe by symbol (no-op if present), append to the end, persist, and
 * return the new list.
 */
export async function addToWatchlist(item: WatchItem): Promise<WatchItem[]> {
  const list = await load()
  const symbol = item.symbol.trim().toUpperCase()
  if (symbol === '' || list.some((w) => w.symbol === symbol)) return [...list]
  const next = [...list, { symbol, name: typeof item.name === 'string' ? item.name : '' }]
  await persist(next)
  return [...next]
}

export async function removeFromWatchlist(symbol: string): Promise<WatchItem[]> {
  const list = await load()
  const sym = symbol.trim().toUpperCase()
  const next = list.filter((w) => w.symbol !== sym)
  if (next.length !== list.length) await persist(next)
  return [...next]
}

export async function isWatched(symbol: string): Promise<boolean> {
  const sym = symbol.trim().toUpperCase()
  return (await load()).some((w) => w.symbol === sym)
}

/** Test hook: drop the in-memory cache so a fresh read hits the (mocked) store. */
export function __resetWatchlistCacheForTests(): void {
  cache = null
}
