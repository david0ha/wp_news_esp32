import { describe, it, expect } from '@jest/globals'
import { createYahooClient } from './yahoo'
import { createCrumbProvider, YAHOO_BROWSER_HEADERS, type CrumbStore } from './crumb'

// A fake fetch replaying a queue of replies (or throwing a queued Error to simulate the network
// refusing). Records every call so URLs, order and headers can be asserted.
type Reply =
  | {
      ok?: boolean
      status?: number
      body?: unknown
      jsonThrows?: boolean
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
      json: async () => {
        if (r.jsonThrows) throw new SyntaxError('Unexpected token in JSON')
        return r.body
      },
      text: async () => r.text ?? '',
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

// A crumb provider stub for the gated happy paths — the retry tests use the real provider.
function stubCrumb(crumb = 'ck') {
  let invalidations = 0
  const provider = {
    getCrumb: async () => crumb,
    invalidate: async () => {
      invalidations++
    },
  }
  return { provider, invalidations: () => invalidations }
}

function memStore(): CrumbStore {
  let value: string | null = null
  return {
    get: async () => value,
    set: async (c) => {
      value = c
    },
    clear: async () => {
      value = null
    },
  }
}

function client(replies: Reply[], crumb = stubCrumb().provider) {
  const f = fakeFetch(replies)
  return { ...f, yahoo: createYahooClient({ fetchFn: f.fetchFn, now: () => 0, crumb }) }
}

// ---------------------------------------------------------------------------
// Fixtures — realistic Yahoo shapes, trimmed to the fields the mappers read plus decoys.
// ---------------------------------------------------------------------------

const CHART_FIXTURE = {
  chart: {
    result: [
      {
        meta: {
          currency: 'USD',
          symbol: 'AAPL',
          exchangeName: 'NMS',
          fullExchangeName: 'NasdaqGS',
          shortName: 'Apple Inc.',
          longName: 'Apple Inc. (long)',
          regularMarketPrice: 189.87,
          chartPreviousClose: 187.6,
          previousClose: 187.55,
          regularMarketTime: 1756500000,
        },
        timestamp: [1756490000, 1756490300, 1756490600],
        indicators: { quote: [{ close: [187.9, null, 189.87] }] },
      },
    ],
    error: null,
  },
}

const SUMMARY_FIXTURE = {
  quoteSummary: {
    result: [
      {
        summaryDetail: {
          open: { raw: 188.0, fmt: '188.00' },
          dayHigh: { raw: 190.5, fmt: '190.50' },
          dayLow: { raw: 187.1, fmt: '187.10' },
          volume: { raw: 52340000, fmt: '52.34M' },
          averageVolume: { raw: 58000000, fmt: '58M' },
          fiftyTwoWeekHigh: { raw: 199.62, fmt: '199.62' },
          fiftyTwoWeekLow: { raw: 164.08, fmt: '164.08' },
          marketCap: { raw: 2950000000000, fmt: '2.95T' },
          trailingPE: { raw: 29.5, fmt: '29.50' },
          dividendYield: { raw: 0.0044, fmt: '0.44%' },
        },
        defaultKeyStatistics: {
          trailingEps: { raw: 6.43, fmt: '6.43' },
          beta: { raw: 1.29, fmt: '1.29' },
        },
        assetProfile: {
          sector: 'Technology',
          industry: 'Consumer Electronics',
          fullTimeEmployees: 161000,
          website: 'https://www.apple.com',
          longBusinessSummary: 'Apple Inc. designs, manufactures and markets smartphones.',
        },
      },
    ],
    error: null,
  },
}

const CALENDAR_FIXTURE = {
  quoteSummary: {
    result: [
      {
        calendarEvents: {
          earnings: {
            // deliberately out of order — the mapper sorts soonest-first
            earningsDate: [
              { raw: 1761868800, fmt: '2025-10-31' },
              { raw: 1761782400, fmt: '2025-10-30' },
            ],
          },
          exDividendDate: { raw: 1755043200, fmt: '2025-08-13' },
          dividendDate: { raw: 1755648000, fmt: '2025-08-20' },
        },
        earningsHistory: {
          // oldest-first with Yahoo's machine `period` tokens, which must never reach the UI
          history: [
            { quarter: { raw: 1711843200, fmt: '2024-03-31' }, epsActual: { raw: 1.53 }, epsEstimate: { raw: 1.5 }, period: '-5q' },
            { quarter: { raw: 1719705600, fmt: '2024-06-30' }, epsActual: { raw: 1.4 }, epsEstimate: { raw: 1.35 }, period: '-4q' },
            { quarter: { raw: 1727654400, fmt: '2024-09-30' }, epsActual: { raw: 1.64 }, epsEstimate: { raw: 1.6 }, period: '-3q' },
            { quarter: { raw: 1735603200, fmt: '2024-12-31' }, epsActual: { raw: 2.4 }, epsEstimate: { raw: 2.35 }, period: '-2q' },
            { quarter: { raw: 1743379200, fmt: '2025-03-31' }, epsActual: { raw: 1.65 }, epsEstimate: { raw: 1.62 }, period: '-1q' },
          ],
        },
      },
    ],
    error: null,
  },
}

const OPTIONS_FIXTURE = {
  optionChain: {
    result: [
      {
        underlyingSymbol: 'AAPL',
        expirationDates: [1760054400, 1757462400, 1758067200], // unsorted on purpose
        quote: { regularMarketPrice: 189.87 },
        options: [
          {
            expirationDate: 1757462400,
            calls: [
              { strike: 190, lastPrice: 3.1, bid: 3.0, ask: 3.2, volume: 1200, openInterest: 8000, impliedVolatility: 0.29, inTheMoney: false },
              { strike: 185, lastPrice: 6.0, bid: 5.9, ask: 6.1, volume: 400, openInterest: 5000, impliedVolatility: 0.31, inTheMoney: true },
            ],
            puts: [
              { strike: 185, lastPrice: 1.2, bid: 1.15, ask: 1.25, volume: 900, openInterest: 7000, impliedVolatility: 0.33, inTheMoney: false },
            ],
          },
        ],
      },
    ],
    error: null,
  },
}

const NEWS_FIXTURE = {
  quotes: [],
  news: [
    {
      uuid: 'n1',
      title: 'Apple ships a thing',
      publisher: 'Reuters',
      providerPublishTime: 1756400000,
      link: 'https://example.com/1',
      thumbnail: {
        resolutions: [
          { url: 'u60', width: 60, height: 40 },
          { url: 'u140', width: 140, height: 90 },
          { url: 'u400', width: 400, height: 260 },
        ],
      },
    },
    { uuid: 'n2', title: 'No link — dropped', publisher: 'AP', providerPublishTime: 1756400001 },
    {
      uuid: 'n3',
      title: 'Small thumbs only',
      publisher: 'Bloomberg',
      providerPublishTime: 1756400002,
      link: 'https://example.com/3',
      thumbnail: { resolutions: [{ url: 'u60', width: 60 }, { url: 'u120', width: 120 }] },
    },
    { uuid: 'n4', title: 'No thumbnail', publisher: 'WSJ', providerPublishTime: 1756400003, link: 'https://example.com/4' },
  ],
}

const SEARCH_FIXTURE = {
  quotes: [
    { symbol: 'AAPL', shortname: 'Apple Inc.', exchDisp: 'NASDAQ', quoteType: 'EQUITY' },
    { symbol: 'APLE', longname: 'Apple Hospitality REIT', exchange: 'NYQ', quoteType: 'EQUITY' },
    { shortname: 'entry with no symbol — dropped' },
  ],
  news: [],
}

// =====================================================================================
// quote() / chart() — the shared /v8/finance/chart request
// =====================================================================================

describe('yahoo — quote', () => {
  it('maps the 1D chart meta, drops null closes from the spark, and sends browser headers', async () => {
    const { yahoo, calls } = client([{ body: CHART_FIXTURE }])
    const q = await yahoo.quote('AAPL')
    expect(calls[0].url).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=5m&includePrePost=false',
    )
    expect(calls[0].init?.headers).toEqual(YAHOO_BROWSER_HEADERS)
    expect(q.symbol).toBe('AAPL')
    expect(q.name).toBe('Apple Inc.')
    expect(q.currency).toBe('USD')
    expect(q.exchange).toBe('NasdaqGS') // fullExchangeName wins over the NMS short code
    expect(q.price).toBe(189.87)
    expect(q.prevClose).toBe(187.6) // chartPreviousClose wins over previousClose
    expect(q.delta).toBeCloseTo(189.87 - 187.6, 10)
    expect(q.pct).toBeCloseTo(((189.87 - 187.6) / 187.6) * 100, 10)
    expect(q.marketTime).toBe(1756500000)
    expect(q.spark).toEqual([187.9, 189.87])
  })

  it('normalizes the symbol into the URL', async () => {
    const { yahoo, calls } = client([{ body: CHART_FIXTURE }])
    await yahoo.quote('  aapl ')
    expect(calls[0].url).toContain('/v8/finance/chart/AAPL?')
  })

  it('falls back to previousClose when chartPreviousClose is absent', async () => {
    const fixture = JSON.parse(JSON.stringify(CHART_FIXTURE)) as typeof CHART_FIXTURE
    delete (fixture.chart.result[0].meta as Record<string, unknown>).chartPreviousClose
    const { yahoo } = client([{ body: fixture }])
    const q = await yahoo.quote('AAPL')
    expect(q.prevClose).toBe(187.55)
    expect(q.delta).toBeCloseTo(189.87 - 187.55, 10)
  })

  it('a missing prevClose yields NaN prevClose and zero delta/pct', async () => {
    const fixture = JSON.parse(JSON.stringify(CHART_FIXTURE)) as typeof CHART_FIXTURE
    const meta = fixture.chart.result[0].meta as Record<string, unknown>
    delete meta.chartPreviousClose
    delete meta.previousClose
    const { yahoo } = client([{ body: fixture }])
    const q = await yahoo.quote('AAPL')
    expect(Number.isNaN(q.prevClose)).toBe(true)
    expect(q.delta).toBe(0)
    expect(q.pct).toBe(0)
  })
})

describe('yahoo — chart', () => {
  it('shares one fetch and one cache entry with quote() for 1D', async () => {
    const { yahoo, calls } = client([{ body: CHART_FIXTURE }])
    await yahoo.quote('AAPL')
    const c = await yahoo.chart('AAPL', '1D')
    expect(calls).toHaveLength(1)
    expect(c.points).toEqual([
      { t: 1756490000, close: 187.9 },
      { t: 1756490600, close: 189.87 },
    ])
    expect(c.prevClose).toBe(187.6)
    expect(c.currency).toBe('USD')
    expect(c.symbol).toBe('AAPL')
  })

  it('other timeframes use their own {range, interval} and their own cache key', async () => {
    const { yahoo, calls } = client([{ body: CHART_FIXTURE }])
    await yahoo.chart('AAPL', '1D')
    await yahoo.chart('AAPL', '1M')
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d&includePrePost=false',
    )
  })

  it("ChartData.prevClose is strictly meta chartPreviousClose — no previousClose fallback", async () => {
    const fixture = JSON.parse(JSON.stringify(CHART_FIXTURE)) as typeof CHART_FIXTURE
    delete (fixture.chart.result[0].meta as Record<string, unknown>).chartPreviousClose
    const { yahoo } = client([{ body: fixture }])
    const c = await yahoo.chart('AAPL', '1D')
    expect(c.prevClose).toBeNull()
  })

  it('sorts points time-ascending even when Yahoo does not', async () => {
    const fixture = JSON.parse(JSON.stringify(CHART_FIXTURE)) as typeof CHART_FIXTURE
    const r0 = fixture.chart.result[0] as unknown as {
      timestamp: number[]
      indicators: { quote: Array<{ close: Array<number | null> }> }
    }
    r0.timestamp = [30, 10, 20]
    r0.indicators.quote[0].close = [3, 1, 2]
    const { yahoo } = client([{ body: fixture }])
    const c = await yahoo.chart('AAPL', '1D')
    expect(c.points).toEqual([
      { t: 10, close: 1 },
      { t: 20, close: 2 },
      { t: 30, close: 3 },
    ])
  })
})

describe('yahoo — cache freshness', () => {
  it('a repeat quote inside the TTL serves the cache; fresh bypasses it', async () => {
    const { yahoo, calls } = client([{ body: CHART_FIXTURE }])
    await yahoo.quote('AAPL')
    await yahoo.quote('AAPL')
    expect(calls).toHaveLength(1)
    await yahoo.quote('AAPL', { fresh: true })
    expect(calls).toHaveLength(2)
  })
})

// =====================================================================================
// Error mapping
// =====================================================================================

describe('yahoo — status → error code', () => {
  it('429 → rate_limited', async () => {
    const { yahoo } = client([{ ok: false, status: 429, body: {} }])
    await expect(yahoo.quote('AAPL')).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('404 → not_found', async () => {
    const { yahoo } = client([{ ok: false, status: 404, body: {} }])
    await expect(yahoo.quote('NOPE')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('other non-2xx → http', async () => {
    const { yahoo } = client([{ ok: false, status: 500, body: {} }])
    await expect(yahoo.quote('AAPL')).rejects.toMatchObject({ code: 'http' })
  })

  it('a network throw → transport', async () => {
    const { yahoo } = client([new Error('connection refused')])
    await expect(yahoo.quote('AAPL')).rejects.toMatchObject({ code: 'transport' })
  })

  it('a non-JSON body → parse', async () => {
    const { yahoo } = client([{ jsonThrows: true }])
    await expect(yahoo.quote('AAPL')).rejects.toMatchObject({ code: 'parse' })
  })

  it('a missing envelope → parse', async () => {
    const { yahoo } = client([{ body: {} }])
    await expect(yahoo.quote('AAPL')).rejects.toMatchObject({ code: 'parse' })
  })

  it('a null result → parse', async () => {
    const { yahoo } = client([{ body: { chart: { result: null, error: { code: 'Not Found' } } } }])
    await expect(yahoo.quote('AAPL')).rejects.toMatchObject({ code: 'parse' })
  })

  it('an empty result array → not_found', async () => {
    const { yahoo } = client([{ body: { chart: { result: [] } } }])
    await expect(yahoo.quote('AAPL')).rejects.toMatchObject({ code: 'not_found' })
  })
})

// =====================================================================================
// search() / news()
// =====================================================================================

describe('yahoo — search', () => {
  it('maps quotes, drops symbol-less entries, and is not cached', async () => {
    const { yahoo, calls } = client([{ body: SEARCH_FIXTURE }])
    const results = await yahoo.search('apple')
    expect(calls[0].url).toBe(
      'https://query1.finance.yahoo.com/v1/finance/search?q=apple&quotesCount=8&newsCount=0',
    )
    expect(results).toEqual([
      { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'EQUITY' },
      { symbol: 'APLE', name: 'Apple Hospitality REIT', exchange: 'NYQ', type: 'EQUITY' },
    ])
    await yahoo.search('apple')
    expect(calls).toHaveLength(2) // no cache
  })

  it('URL-encodes the query', async () => {
    const { yahoo, calls } = client([{ body: { quotes: [], news: [] } }])
    await yahoo.search('brk & co')
    expect(calls[0].url).toContain('q=brk%20%26%20co')
  })
})

describe('yahoo — news', () => {
  it('maps items, drops link-less ones, and picks the right thumbnail per item', async () => {
    const { yahoo, calls } = client([{ body: NEWS_FIXTURE }])
    const items = await yahoo.news('AAPL')
    expect(calls[0].url).toBe(
      'https://query1.finance.yahoo.com/v1/finance/search?q=AAPL&quotesCount=0&newsCount=12',
    )
    expect(items.map((n) => n.id)).toEqual(['n1', 'n3', 'n4'])
    expect(items[0]).toEqual({
      id: 'n1',
      title: 'Apple ships a thing',
      publisher: 'Reuters',
      publishedAt: 1756400000,
      url: 'https://example.com/1',
      thumbnail: 'u140', // smallest resolution >= 140px wide
    })
    expect(items[1].thumbnail).toBe('u120') // nothing >= 140 → largest available
    expect(items[2].thumbnail).toBeNull() // no thumbnail at all
  })

  it('is cached — a repeat call makes no second request', async () => {
    const { yahoo, calls } = client([{ body: NEWS_FIXTURE }])
    await yahoo.news('AAPL')
    await yahoo.news('AAPL')
    expect(calls).toHaveLength(1)
  })
})

// =====================================================================================
// Crumb-gated endpoints
// =====================================================================================

describe('yahoo — keyStatsAndProfile', () => {
  it('appends the crumb, unwraps {raw,fmt} numbers, and splits stats from profile', async () => {
    const { yahoo, calls } = client([{ body: SUMMARY_FIXTURE }])
    const { stats, profile } = await yahoo.keyStatsAndProfile('AAPL')
    expect(calls[0].url).toBe(
      'https://query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=assetProfile,summaryDetail,defaultKeyStatistics&crumb=ck',
    )
    expect(stats).toEqual({
      open: 188.0,
      dayHigh: 190.5,
      dayLow: 187.1,
      volume: 52340000,
      avgVolume: 58000000,
      wk52High: 199.62,
      wk52Low: 164.08,
      marketCap: 2950000000000,
      trailingPE: 29.5,
      trailingEps: 6.43,
      dividendYield: 0.0044,
      beta: 1.29,
    })
    expect(profile).toEqual({
      sector: 'Technology',
      industry: 'Consumer Electronics',
      employees: 161000,
      website: 'https://www.apple.com',
      summary: 'Apple Inc. designs, manufactures and markets smartphones.',
    })
  })

  it('missing modules yield nulls and empty strings, never a throw', async () => {
    const { yahoo } = client([{ body: { quoteSummary: { result: [{}] } } }])
    const { stats, profile } = await yahoo.keyStatsAndProfile('AAPL')
    expect(stats.open).toBeNull()
    expect(stats.beta).toBeNull()
    expect(profile.sector).toBe('')
    expect(profile.employees).toBeNull()
  })
})

describe('yahoo — calendar', () => {
  it('sorts earnings dates soonest-first and renders human quarter labels, never Yahoo tokens', async () => {
    const { yahoo } = client([{ body: CALENDAR_FIXTURE }])
    const cal = await yahoo.calendar('AAPL')
    expect(cal.earningsDates).toEqual([1761782400, 1761868800])
    expect(cal.exDividendDate).toBe(1755043200)
    expect(cal.dividendDate).toBe(1755648000)
    // most recent first, max 4 — the fifth (oldest) row is dropped
    expect(cal.history.map((h) => h.quarter)).toEqual(['Q1 2025', 'Q4 2024', 'Q3 2024', 'Q2 2024'])
    expect(cal.history[0]).toEqual({ quarter: 'Q1 2025', epsActual: 1.65, epsEstimate: 1.62 })
    for (const row of cal.history) {
      expect(row.quarter).not.toMatch(/q$/) // '-1q'-style machine tokens must not reach the UI
    }
  })
})

describe('yahoo — options', () => {
  it('maps the chain: spot, sorted expirations, strike-ascending contracts', async () => {
    const { yahoo, calls } = client([{ body: OPTIONS_FIXTURE }])
    const chain = await yahoo.options('AAPL')
    expect(calls[0].url).toBe('https://query1.finance.yahoo.com/v7/finance/options/AAPL?crumb=ck')
    expect(chain.symbol).toBe('AAPL')
    expect(chain.spot).toBe(189.87)
    expect(chain.expirationDates).toEqual([1757462400, 1758067200, 1760054400])
    expect(chain.expiration).toBe(1757462400)
    expect(chain.calls.map((c) => c.strike)).toEqual([185, 190]) // sorted ascending
    expect(chain.calls[0]).toEqual({
      strike: 185,
      lastPrice: 6.0,
      bid: 5.9,
      ask: 6.1,
      volume: 400,
      openInterest: 5000,
      impliedVolatility: 0.31,
      inTheMoney: true,
    })
    expect(chain.puts).toHaveLength(1)
  })

  it('a chosen expiration goes into the URL as ?date=…&crumb=…', async () => {
    const { yahoo, calls } = client([{ body: OPTIONS_FIXTURE }])
    await yahoo.options('AAPL', 1758067200)
    expect(calls[0].url).toBe(
      'https://query1.finance.yahoo.com/v7/finance/options/AAPL?date=1758067200&crumb=ck',
    )
  })
})

describe('yahoo — the crumb retry contract', () => {
  // One fetch queue serves both the crumb provider and the client, so the ORDER of the
  // bootstrap and data requests is itself under test.

  it('401 → invalidate → re-bootstrap once → retry once → success', async () => {
    const f = fakeFetch([
      { ok: false, status: 404 }, // 1. fc.yahoo.com (cookie seed)
      { text: 'c1' }, // 2. getcrumb
      { ok: false, status: 401, body: {} }, // 3. quoteSummary with c1 — refused
      { ok: false, status: 404 }, // 4. fc.yahoo.com again
      { text: 'c2' }, // 5. getcrumb again
      { body: SUMMARY_FIXTURE }, // 6. retry with c2 — succeeds
    ])
    const crumb = createCrumbProvider({ fetchFn: f.fetchFn, now: () => 0, store: memStore() })
    const yahoo = createYahooClient({ fetchFn: f.fetchFn, now: () => 0, crumb })

    const { stats } = await yahoo.keyStatsAndProfile('AAPL')
    expect(stats.open).toBe(188.0)
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://fc.yahoo.com/',
      'https://query1.finance.yahoo.com/v1/test/getcrumb',
      'https://query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=assetProfile,summaryDetail,defaultKeyStatistics&crumb=c1',
      'https://fc.yahoo.com/',
      'https://query1.finance.yahoo.com/v1/test/getcrumb',
      'https://query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=assetProfile,summaryDetail,defaultKeyStatistics&crumb=c2',
    ])
  })

  it('a second 401 surfaces MarketError(crumb) — exactly one retry, never a loop', async () => {
    const f = fakeFetch([
      { ok: false, status: 404 },
      { text: 'c1' },
      { ok: false, status: 401, body: {} },
      { ok: false, status: 404 },
      { text: 'c2' },
      { ok: false, status: 401, body: {} },
    ])
    const crumb = createCrumbProvider({ fetchFn: f.fetchFn, now: () => 0, store: memStore() })
    const yahoo = createYahooClient({ fetchFn: f.fetchFn, now: () => 0, crumb })

    await expect(yahoo.keyStatsAndProfile('AAPL')).rejects.toMatchObject({ code: 'crumb' })
    expect(f.calls).toHaveLength(6) // one bootstrap, one refusal, one re-bootstrap, one retry — stop
  })

  it('403 takes the same path as 401', async () => {
    const f = fakeFetch([
      { ok: false, status: 404 },
      { text: 'c1' },
      { ok: false, status: 403, body: {} },
      { ok: false, status: 404 },
      { text: 'c2' },
      { body: OPTIONS_FIXTURE },
    ])
    const crumb = createCrumbProvider({ fetchFn: f.fetchFn, now: () => 0, store: memStore() })
    const yahoo = createYahooClient({ fetchFn: f.fetchFn, now: () => 0, crumb })
    const chain = await yahoo.options('AAPL')
    expect(chain.spot).toBe(189.87)
    expect(f.calls[5].url).toContain('crumb=c2')
  })

  it('a failed bootstrap surfaces MarketError(crumb) without touching the data endpoint', async () => {
    const f = fakeFetch([new Error('consent redirect, no cookies')])
    const crumb = createCrumbProvider({ fetchFn: f.fetchFn, now: () => 0, store: memStore() })
    const yahoo = createYahooClient({ fetchFn: f.fetchFn, now: () => 0, crumb })
    await expect(yahoo.calendar('AAPL')).rejects.toMatchObject({ code: 'crumb' })
    expect(f.calls.every((c) => !c.url.includes('quoteSummary'))).toBe(true)
  })
})
