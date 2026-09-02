// The cookie+crumb bootstrap (spec §4.2). Yahoo gates /v10/finance/quoteSummary and
// /v7/finance/options behind a session cookie + a crumb token. RN's fetch uses the native HTTP
// stack whose cookie jar persists automatically (NSHTTPCookieStorage / OkHttp CookieJar), so the
// flow is exactly:
//
//   1. GET https://fc.yahoo.com/ — response body irrelevant (it 404s); its Set-Cookie seeds the jar.
//   2. GET https://query1.finance.yahoo.com/v1/test/getcrumb — body is the crumb, plain text.
//   3. Crumb-gated calls append &crumb=<encodeURIComponent(crumb)>; the cookie rides automatically.
//
// One expected-outcome caveat: from EU IPs, fc.yahoo.com serves a consent redirect and may set no
// cookies at all — a failed bootstrap there is a NORMAL outcome that lands in the UI's degraded
// state (§0.4), not an error to fix. The retry contract (401/403 → invalidate → re-bootstrap once
// → retry once) is enforced by the caller in yahoo.ts, not here.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { MarketError } from './types'

export const CRUMB_TTL_MS = 12 * 3600_000

/**
 * The browser headers EVERY Yahoo request sends — both bootstrap requests and every data call
 * (yahoo.ts imports this). Yahoo blocks the default okhttp UA, so a bootstrap that omits these
 * fails on Android every time.
 */
export const YAHOO_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
}

const COOKIE_URL = 'https://fc.yahoo.com/'
const GETCRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb'
const STORAGE_KEY = 'claudepost.yahooCrumb' // JSON: { crumb, at }
const TIMEOUT_MS = 10_000

export interface CrumbStore {
  /** The stored crumb, or null when absent/expired/unreadable. */
  get(): Promise<string | null>
  set(c: string, at: number): Promise<void>
  clear(): Promise<void>
}

// The default store persists { crumb, at } under claudepost.yahooCrumb, best-effort try/catch
// like store.ts. It closes over the provider's clock so the TTL check honours an injected `now`.
function createAsyncStorageCrumbStore(now: () => number): CrumbStore {
  return {
    async get() {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as { crumb?: unknown; at?: unknown }
        if (typeof parsed?.crumb !== 'string' || parsed.crumb === '') return null
        if (typeof parsed.at !== 'number' || !(now() - parsed.at < CRUMB_TTL_MS)) return null
        return parsed.crumb
      } catch {
        return null
      }
    },
    async set(c, at) {
      try {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ crumb: c, at }))
      } catch {
        // best-effort — worst case is one extra bootstrap next launch
      }
    },
    async clear() {
      try {
        await AsyncStorage.removeItem(STORAGE_KEY)
      } catch {
        // best-effort
      }
    },
  }
}

// An HTML error page or a JSON-quoted blob is a failed bootstrap, not a crumb.
function crumbLooksValid(body: string): boolean {
  return body.length > 0 && body.length <= 64 && !body.includes('<') && !body.includes('"')
}

export function createCrumbProvider(
  opts: {
    fetchFn?: typeof fetch
    now?: () => number
    store?: CrumbStore // default: AsyncStorage-backed
  } = {},
) {
  const fetchFn = opts.fetchFn ?? fetch
  const now = opts.now ?? Date.now
  const store = opts.store ?? createAsyncStorageCrumbStore(now)

  let cached: { crumb: string; at: number } | null = null

  // Single-flight latch: three detail sections firing their first crumb-gated fetch together
  // must share ONE storage read + bootstrap, not run three bootstrap pairs against the exact
  // host most likely to 429 (mirrors cache.ts's inflight dedupe, which cannot help here — the
  // sections use three distinct cache keys).
  let pending: Promise<string> | null = null

  // Bumped by invalidate() so an in-flight resolve that started before the invalidation cannot
  // re-populate `cached`/storage with the crumb that was just declared bad.
  let epoch = 0

  async function get(url: string, label: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      return await fetchFn(url, { headers: YAHOO_BROWSER_HEADERS, signal: controller.signal })
    } catch (e) {
      throw new MarketError('crumb', `${label} failed: ${e instanceof Error ? e.message : 'network error'}`)
    } finally {
      clearTimeout(timer)
    }
  }

  async function bootstrap(): Promise<string> {
    // Step 1 seeds the cookie jar. The 404 it answers is expected — only a network throw fails.
    await get(COOKIE_URL, 'cookie bootstrap')

    const res = await get(GETCRUMB_URL, 'getcrumb')
    if (!res.ok) throw new MarketError('crumb', `getcrumb responded ${res.status}`)
    let body: string
    try {
      body = await res.text()
    } catch {
      throw new MarketError('crumb', 'getcrumb body unreadable')
    }
    const crumb = body.trim()
    if (!crumbLooksValid(crumb)) {
      throw new MarketError('crumb', 'getcrumb answered with something that is not a crumb')
    }
    return crumb
  }

  // stored (if < CRUMB_TTL_MS old) → bootstrap, writing `cached`/storage only when no
  // invalidate() intervened since this resolve began.
  async function resolveFresh(): Promise<string> {
    const startEpoch = epoch
    const stored = await store.get()
    if (stored !== null && stored !== '') {
      if (epoch === startEpoch) cached = { crumb: stored, at: now() }
      return stored
    }
    const crumb = await bootstrap()
    if (epoch === startEpoch) {
      cached = { crumb, at: now() }
      try {
        await store.set(crumb, now())
      } catch {
        // a store that cannot persist still served this session from memory
      }
    }
    return crumb
  }

  return {
    /**
     * cached → stored (if < CRUMB_TTL_MS old) → bootstrap. Throws MarketError('crumb', …).
     * Concurrent cache-miss callers join the one in-flight resolve instead of each running
     * their own bootstrap pair.
     */
    async getCrumb(): Promise<string> {
      if (cached && now() - cached.at < CRUMB_TTL_MS) return cached.crumb
      cached = null
      if (pending === null) {
        // Pre-initialized to null so the finally closure can mention `p` without tripping
        // TS's use-before-assignment check on the IIFE: resolveFresh() is async, so the
        // finally cannot run before the assignment below completes.
        let p: Promise<string> | null = null
        p = (async () => {
          try {
            return await resolveFresh()
          } finally {
            if (pending === p) pending = null
          }
        })()
        pending = p
      }
      return pending
    },

    /** Drops memory + storage (and the in-flight latch); the next getCrumb() re-bootstraps. */
    async invalidate(): Promise<void> {
      epoch++
      cached = null
      pending = null
      try {
        await store.clear()
      } catch {
        // best-effort
      }
    },
  }
}

export type CrumbProvider = ReturnType<typeof createCrumbProvider>
