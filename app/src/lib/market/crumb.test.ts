import { describe, it, expect, beforeEach } from '@jest/globals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createCrumbProvider, CRUMB_TTL_MS, YAHOO_BROWSER_HEADERS, type CrumbStore } from './crumb'

// A fake fetch replaying a queue of replies (or throwing a queued Error), recording every call.
type Reply =
  | {
      ok?: boolean
      status?: number
      text?: string
    }
  | Error

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = replies[Math.min(i, replies.length - 1)]
    i++
    if (r instanceof Error) throw r
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => r.text ?? '',
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

function memStore(): CrumbStore & { snapshot: () => string | null } {
  let value: string | null = null
  return {
    get: async () => value,
    set: async (c) => {
      value = c
    },
    clear: async () => {
      value = null
    },
    snapshot: () => value,
  }
}

beforeEach(async () => {
  await AsyncStorage.clear()
})

describe('crumb bootstrap', () => {
  it('hits fc.yahoo.com first (cookie seed), then getcrumb, in order', async () => {
    const { fetchFn, calls } = fakeFetch([
      { ok: false, status: 404 }, // fc.yahoo.com 404s and that is fine
      { text: 'AbC123.xYz' },
    ])
    const provider = createCrumbProvider({ fetchFn, now: () => 0, store: memStore() })
    expect(await provider.getCrumb()).toBe('AbC123.xYz')
    expect(calls.map((c) => c.url)).toEqual([
      'https://fc.yahoo.com/',
      'https://query1.finance.yahoo.com/v1/test/getcrumb',
    ])
  })

  it('both bootstrap requests carry YAHOO_BROWSER_HEADERS', async () => {
    const { fetchFn, calls } = fakeFetch([{ ok: false, status: 404 }, { text: 'crumb1' }])
    const provider = createCrumbProvider({ fetchFn, now: () => 0, store: memStore() })
    await provider.getCrumb()
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.init?.headers).toEqual(YAHOO_BROWSER_HEADERS)
    }
    expect(YAHOO_BROWSER_HEADERS['User-Agent']).toContain('Mozilla/5.0')
    expect(YAHOO_BROWSER_HEADERS.Accept).toBe('application/json')
  })

  it('caches in memory — a second getCrumb makes no requests', async () => {
    const { fetchFn, calls } = fakeFetch([{ ok: false, status: 404 }, { text: 'crumb1' }])
    const provider = createCrumbProvider({ fetchFn, now: () => 0, store: memStore() })
    await provider.getCrumb()
    expect(await provider.getCrumb()).toBe('crumb1')
    expect(calls).toHaveLength(2)
  })

  it('writes the crumb to the store', async () => {
    const store = memStore()
    const { fetchFn } = fakeFetch([{ ok: false, status: 404 }, { text: 'crumb1' }])
    const provider = createCrumbProvider({ fetchFn, now: () => 0, store })
    await provider.getCrumb()
    expect(store.snapshot()).toBe('crumb1')
  })

  it('prefers a stored crumb over a bootstrap', async () => {
    const store = memStore()
    await store.set('stored-crumb', 0)
    const { fetchFn, calls } = fakeFetch([{ text: 'should-not-be-fetched' }])
    const provider = createCrumbProvider({ fetchFn, now: () => 0, store })
    expect(await provider.getCrumb()).toBe('stored-crumb')
    expect(calls).toHaveLength(0)
  })
})

describe('crumb TTL', () => {
  it('re-bootstraps once the memory cache is CRUMB_TTL_MS old (injected clock)', async () => {
    let t = 0
    const { fetchFn, calls } = fakeFetch([
      { ok: false, status: 404 },
      { text: 'crumb1' },
      { ok: false, status: 404 },
      { text: 'crumb2' },
    ])
    // A store holding nothing: the memory cache is the only cache, so its TTL is what expires.
    // (The store-level TTL is covered by the default-AsyncStorage-store suite below.)
    const empty: CrumbStore = { get: async () => null, set: async () => {}, clear: async () => {} }
    const provider = createCrumbProvider({ fetchFn, now: () => t, store: empty })
    expect(await provider.getCrumb()).toBe('crumb1')
    t = CRUMB_TTL_MS - 1
    expect(await provider.getCrumb()).toBe('crumb1') // still fresh
    expect(calls).toHaveLength(2)
    t = CRUMB_TTL_MS
    expect(await provider.getCrumb()).toBe('crumb2') // expired → bootstrap again
    expect(calls).toHaveLength(4)
  })

  it('is 12 hours', () => {
    expect(CRUMB_TTL_MS).toBe(12 * 3600 * 1000)
  })
})

describe('crumb validity', () => {
  async function expectRejected(text: string) {
    const { fetchFn } = fakeFetch([{ ok: false, status: 404 }, { text }])
    const provider = createCrumbProvider({ fetchFn, now: () => 0, store: memStore() })
    await expect(provider.getCrumb()).rejects.toMatchObject({ name: 'MarketError', code: 'crumb' })
  }

  it('rejects an HTML error page', async () => {
    await expectRejected('<html><body>Error</body></html>')
  })

  it('rejects a JSON-quoted blob', async () => {
    await expectRejected('"looks-like-json"')
  })

  it('rejects an empty body', async () => {
    await expectRejected('')
  })

  it('rejects an over-long body', async () => {
    await expectRejected('x'.repeat(65))
  })

  it('rejects a non-ok getcrumb response', async () => {
    const { fetchFn } = fakeFetch([{ ok: false, status: 404 }, { ok: false, status: 500, text: 'nope' }])
    const provider = createCrumbProvider({ fetchFn, now: () => 0, store: memStore() })
    await expect(provider.getCrumb()).rejects.toMatchObject({ code: 'crumb' })
  })

  it('a network throw during the cookie seed is a crumb failure (the EU consent case)', async () => {
    const { fetchFn } = fakeFetch([new Error('connection refused')])
    const provider = createCrumbProvider({ fetchFn, now: () => 0, store: memStore() })
    await expect(provider.getCrumb()).rejects.toMatchObject({ code: 'crumb' })
  })
})

describe('single-flight', () => {
  it('concurrent getCrumb calls share ONE bootstrap pair', async () => {
    const { fetchFn, calls } = fakeFetch([{ ok: false, status: 404 }, { text: 'crumb1' }])
    const provider = createCrumbProvider({ fetchFn, now: () => 0, store: memStore() })
    const [a, b, c] = await Promise.all([provider.getCrumb(), provider.getCrumb(), provider.getCrumb()])
    expect([a, b, c]).toEqual(['crumb1', 'crumb1', 'crumb1'])
    expect(calls).toHaveLength(2) // one fc.yahoo.com + one getcrumb, not three pairs
  })

  it('an invalidate during an in-flight resolve keeps the doomed crumb out of the cache', async () => {
    let releaseGet: (v: string | null) => void = () => {}
    const gate = new Promise<string | null>((res) => {
      releaseGet = res
    })
    let cleared = false
    const store: CrumbStore = {
      get: () => (cleared ? Promise.resolve(null) : gate),
      set: async () => {},
      clear: async () => {
        cleared = true
      },
    }
    const { fetchFn, calls } = fakeFetch([{ ok: false, status: 404 }, { text: 'fresh' }])
    const provider = createCrumbProvider({ fetchFn, now: () => 0, store })

    const first = provider.getCrumb() // suspends on the gated store read
    await provider.invalidate() // declares whatever that read returns bad
    releaseGet('stale-crumb')
    expect(await first).toBe('stale-crumb') // the joined caller still gets an answer…

    // …but the invalidated resolve must not have re-populated memory: the next call
    // finds nothing and runs a fresh bootstrap.
    expect(await provider.getCrumb()).toBe('fresh')
    expect(calls).toHaveLength(2)
    expect(await provider.getCrumb()).toBe('fresh') // and THAT one is cached
    expect(calls).toHaveLength(2)
  })
})

describe('invalidate', () => {
  it('drops memory and storage so the next getCrumb re-bootstraps', async () => {
    const store = memStore()
    const { fetchFn, calls } = fakeFetch([
      { ok: false, status: 404 },
      { text: 'crumb1' },
      { ok: false, status: 404 },
      { text: 'crumb2' },
    ])
    const provider = createCrumbProvider({ fetchFn, now: () => 0, store })
    await provider.getCrumb()
    await provider.invalidate()
    expect(store.snapshot()).toBeNull()
    expect(await provider.getCrumb()).toBe('crumb2')
    expect(calls).toHaveLength(4)
  })
})

describe('the default AsyncStorage store', () => {
  it('round-trips { crumb, at } under claudepost.yahooCrumb', async () => {
    const { fetchFn } = fakeFetch([{ ok: false, status: 404 }, { text: 'persisted-crumb' }])
    const provider = createCrumbProvider({ fetchFn, now: () => 1000 })
    await provider.getCrumb()

    const raw = await AsyncStorage.getItem('claudepost.yahooCrumb')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual({ crumb: 'persisted-crumb', at: 1000 })

    // A fresh provider (new memory) reads the stored crumb without any network.
    const second = fakeFetch([{ text: 'never' }])
    const reread = createCrumbProvider({ fetchFn: second.fetchFn, now: () => 2000 })
    expect(await reread.getCrumb()).toBe('persisted-crumb')
    expect(second.calls).toHaveLength(0)
  })

  it('treats a stored crumb older than the TTL as absent', async () => {
    await AsyncStorage.setItem('claudepost.yahooCrumb', JSON.stringify({ crumb: 'old', at: 0 }))
    const { fetchFn, calls } = fakeFetch([{ ok: false, status: 404 }, { text: 'fresh' }])
    const provider = createCrumbProvider({ fetchFn, now: () => CRUMB_TTL_MS })
    expect(await provider.getCrumb()).toBe('fresh')
    expect(calls).toHaveLength(2)
  })

  it('treats corrupt storage as absent', async () => {
    await AsyncStorage.setItem('claudepost.yahooCrumb', 'not json{')
    const { fetchFn } = fakeFetch([{ ok: false, status: 404 }, { text: 'fresh' }])
    const provider = createCrumbProvider({ fetchFn, now: () => 0 })
    expect(await provider.getCrumb()).toBe('fresh')
  })
})
