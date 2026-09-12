import { describe, it, expect } from '@jest/globals'
import { createYahooClient } from './yahoo'
import { MarketError } from './types'

/**
 * The three crumb-gated calls, after they moved to the desk.
 *
 * Why they moved: Yahoo decides who may have a crumb by looking at the TLS
 * handshake, not at the User-Agent or the address. A React Native `fetch` uses
 * NSURLSession on iOS and OkHttp on Android; neither fingerprint can be changed
 * from JavaScript, and no Node library does what `curl_cffi` does for Python.
 * So the app's own bootstrap was refused while its chart and news kept working,
 * which is precisely the shape the Info and Options tabs failed in. The desk
 * can impersonate a browser. The desk asks.
 *
 * What that changes here, and what it deliberately does not:
 *
 *   - `quote`, `chart`, `search` and `news` still go straight to Yahoo. They
 *     are ungated, they work from the phone today, and routing them through the
 *     desk would make a desk outage take the whole tab down instead of half of
 *     it. `yahoo.test.ts` still owns them.
 *   - The three gated calls ask the desk and get Yahoo's own JSON back. The
 *     mappers below them did not change, which is the point of the desk being a
 *     pipe: `test_market.py` holds the desk to forwarding `result[0]` whole,
 *     and the assertions here are the other half of that agreement.
 */

type Reply = { ok?: boolean; status?: number; body?: unknown } | Error

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
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? {}),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

const DESK = { baseUrl: 'https://desk.example', token: 'tok-abc' }

function client(replies: Reply[], desk: typeof DESK | null = DESK) {
  const f = fakeFetch(replies)
  return {
    ...f,
    yahoo: createYahooClient({ fetchFn: f.fetchFn, now: () => 0, desk: async () => desk }),
  }
}

/** The desk's envelope: `{ ok, asOf, result }`, the result being Yahoo's own object. */
function deskOk(result: unknown) {
  return { body: { ok: true, asOf: 1_700_000_000, result } }
}

const SUMMARY = {
  summaryDetail: {
    open: { raw: 238.1 },
    dayHigh: { raw: 242.4 },
    dayLow: { raw: 237.2 },
    volume: { raw: 51_000_000 },
    averageVolume: { raw: 48_000_000 },
    fiftyTwoWeekHigh: { raw: 260.1 },
    fiftyTwoWeekLow: { raw: 164.08 },
    marketCap: { raw: 4_850_000_000_000 },
    trailingPE: { raw: 37.46 },
    dividendYield: { raw: 0.0033 },
  },
  defaultKeyStatistics: { trailingEps: { raw: 8.87 }, beta: { raw: 1.09 } },
  assetProfile: {
    sector: 'Technology',
    industry: 'Consumer Electronics',
    fullTimeEmployees: 150000,
    website: 'https://www.apple.com',
    longBusinessSummary: 'Apple Inc. designs, manufactures, and markets smartphones.',
  },
}

const CHAIN = {
  underlyingSymbol: 'AAPL',
  expirationDates: [1793664000, 1793059200],
  quote: { regularMarketPrice: 335.5 },
  options: [
    {
      expirationDate: 1793059200,
      calls: [
        { strike: 340, lastPrice: 0.4, bid: 0.38, ask: 0.45, volume: 900, openInterest: 1200, impliedVolatility: 0.19, inTheMoney: false },
        { strike: 335, lastPrice: 1.02, bid: 0.98, ask: 1.05, volume: 61462, openInterest: 2911, impliedVolatility: 0.177, inTheMoney: false },
      ],
      puts: [
        { strike: 330, lastPrice: 0.8, bid: 0.75, ask: 0.85, volume: 500, openInterest: 4100, impliedVolatility: 0.21, inTheMoney: false },
      ],
    },
  ],
}

describe('the gated calls go to the desk, not to Yahoo', () => {
  it('keyStatsAndProfile asks the desk for the three modules, with the operator token', async () => {
    const c = client([deskOk(SUMMARY)])

    const got = await c.yahoo.keyStatsAndProfile('aapl')

    expect(c.calls).toHaveLength(1)
    const url = new URL(c.calls[0].url)
    expect(url.origin + url.pathname).toBe('https://desk.example/api/market/summary')
    expect(url.searchParams.get('symbol')).toBe('AAPL')
    expect(url.searchParams.get('modules')).toBe('assetProfile,summaryDetail,defaultKeyStatistics')
    expect(
      (c.calls[0].init?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBe('Bearer tok-abc')

    // Nothing Yahoo-shaped in the request, and the mapper below is untouched.
    expect(c.calls[0].url).not.toContain('yahoo.com')
    expect(got.stats.trailingPE).toBeCloseTo(37.46)
    expect(got.stats.beta).toBeCloseTo(1.09)
    expect(got.profile.sector).toBe('Technology')
    expect(got.profile.employees).toBe(150000)
  })

  it('calendar asks the desk for its own two modules', async () => {
    const events = {
      calendarEvents: {
        earnings: { earningsDate: [{ raw: 1793304000 }] },
        exDividendDate: { raw: 1786000000 },
        dividendDate: { raw: 1787000000 },
      },
      earningsHistory: {
        history: [
          { quarter: { raw: 1, fmt: '2026-06-30' }, epsActual: { raw: 1.4 }, epsEstimate: { raw: 1.35 } },
        ],
      },
    }
    const c = client([deskOk(events)])

    const got = await c.yahoo.calendar('AAPL')

    const url = new URL(c.calls[0].url)
    expect(url.pathname).toBe('/api/market/summary')
    expect(url.searchParams.get('modules')).toBe('calendarEvents,earningsHistory')
    expect(got.earningsDates).toEqual([1793304000])
    expect(got.history[0].quarter).toBe('Q2 2026')
  })

  it('options asks the desk and keeps open interest, which max pain is computed from', async () => {
    const c = client([deskOk(CHAIN)])

    const got = await c.yahoo.options('AAPL')

    const url = new URL(c.calls[0].url)
    expect(url.pathname).toBe('/api/market/options')
    expect(url.searchParams.get('symbol')).toBe('AAPL')
    expect(url.searchParams.get('date')).toBeNull()
    expect(got.spot).toBeCloseTo(335.5)
    expect(got.expirationDates).toEqual([1793059200, 1793664000])
    expect(got.calls.map((k) => k.strike)).toEqual([335, 340])
    expect(got.calls[0].openInterest).toBe(2911)
    expect(got.puts[0].openInterest).toBe(4100)
  })

  it('a chosen expiration reaches the desk as ?date=', async () => {
    const c = client([deskOk(CHAIN)])
    await c.yahoo.options('AAPL', 1793664000)
    expect(new URL(c.calls[0].url).searchParams.get('date')).toBe('1793664000')
  })
})

describe('what the tab is told when the desk cannot answer', () => {
  it('no desk configured is its own error, not a Yahoo one', async () => {
    /**
     * This is a different fact from "Yahoo is limiting detailed data", and it
     * has a different remedy: the owner has to put an address and a token in
     * Settings. Reusing the old sentence would tell somebody to wait for Yahoo
     * to relent when nothing about Yahoo is wrong.
     */
    const c = client([deskOk(SUMMARY)], null)

    await expect(c.yahoo.keyStatsAndProfile('AAPL')).rejects.toMatchObject({
      code: 'no_desk',
    })
    expect(c.calls).toHaveLength(0)
  })

  it('the desk saying no_symbol is not_found', async () => {
    const c = client([{ ok: false, status: 404, body: { ok: false, error: 'no_symbol' } }])
    await expect(c.yahoo.keyStatsAndProfile('NOPE')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('the desk relaying a Yahoo rate limit is rate_limited', async () => {
    const c = client([{ ok: false, status: 502, body: { ok: false, error: 'rate_limited' } }])
    await expect(c.yahoo.options('AAPL')).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('a desk without curl_cffi is the gentle "detailed data unavailable" state', async () => {
    /** The tab degrades exactly as it used to; only the cause moved. */
    const c = client([
      { ok: false, status: 502, body: { ok: false, error: 'market_unavailable' } },
    ])
    await expect(c.yahoo.keyStatsAndProfile('AAPL')).rejects.toMatchObject({ code: 'crumb' })
  })

  it('a desk that refuses the token is http, not a silent empty tab', async () => {
    const c = client([{ ok: false, status: 401, body: { ok: false, error: 'unauthorized' } }])
    await expect(c.yahoo.keyStatsAndProfile('AAPL')).rejects.toBeInstanceOf(MarketError)
  })

  it('the network refusing is transport', async () => {
    const c = client([new TypeError('Network request failed')])
    await expect(c.yahoo.options('AAPL')).rejects.toMatchObject({ code: 'transport' })
  })
})

describe('caching survives the move', () => {
  it('a repeated question makes no second request to the desk', async () => {
    const c = client([deskOk(SUMMARY)])
    await c.yahoo.keyStatsAndProfile('AAPL')
    await c.yahoo.keyStatsAndProfile('AAPL')
    expect(c.calls).toHaveLength(1)
  })
})
