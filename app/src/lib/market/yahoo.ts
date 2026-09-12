// The Yahoo Finance client (spec §4.5) — the only file in the app that knows a Yahoo field
// name. Everything is defensively coerced through num()/str() so a malformed payload yields
// nulls/''/[] rather than a throw; only a missing top-level envelope is a MarketError('parse').
//
// Unofficial API, so the failure vocabulary matters as much as the happy path:
//   network throw/abort → 'transport'; 429 → 'rate_limited'; 404 or an empty result array →
//   'not_found'; other non-2xx → 'http'; bad JSON or a missing envelope → 'parse'.
//
// TWO TRANSPORTS, and which call uses which is not a style choice.
//
// `quote`, `chart`, `search` and `news` go straight to Yahoo, as they always have. They are
// ungated and they work from a phone.
//
// `keyStatsAndProfile`, `calendar` and `options` go to the DESK, which fetches them from Yahoo
// on this phone's behalf. Yahoo gates those two endpoints behind a cookie and a crumb, and it
// decides who may have a crumb by looking at the TLS handshake — the JA3/JA4 fingerprint —
// rather than at the User-Agent or the address. Measured on one machine, one address, one
// minute: a plain client got 429 on every one of them and a browser-impersonating client got
// 200 on every one. React Native's `fetch` is NSURLSession on iOS and OkHttp on Android, and
// neither fingerprint can be changed from JavaScript; no Node library does what `curl_cffi`
// does for Python, so `yahoo-finance2` has the same problem. The crumb bootstrap that used to
// live in this directory could not have been fixed — it was asking for something this runtime
// is not allowed to have. `server/claudepost/market.py` is where those calls went.
//
// The mappers below did not change when they moved, and that is the point: the desk forwards
// Yahoo's own `result[0]` untouched, so this file remains the only place that knows a Yahoo
// field name. `test_market.py` holds the desk to that; `deskGated.test.ts` holds this half.

import { createTtlCache } from './cache'
import { TIMEFRAME_PARAMS, type Timeframe } from './timeframes'
import {
  MarketError,
  num,
  str,
  type CalendarEvents,
  type ChartData,
  type ChartPoint,
  type EarningsRow,
  type KeyStats,
  type NewsItem,
  type OptionChain,
  type OptionContract,
  type ProfileInfo,
  type Quote,
  type SearchResult,
} from './types'

const BASE = 'https://query1.finance.yahoo.com'
const TIMEOUT_MS = 10_000

/**
 * The headers every DIRECT Yahoo request sends. Yahoo blocks the default okhttp User-Agent, so
 * omitting these fails on Android every time.
 *
 * They are not enough for the gated endpoints and never were — that refusal happens below HTTP,
 * at the TLS handshake — which is why those three calls go to the desk instead. These headers
 * still earn their place on the four calls that do reach Yahoo from here.
 */
export const YAHOO_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
}

/** The desk this phone is paired with, or `null` when Settings has not been filled in. */
export interface DeskTarget {
  baseUrl: string
  token: string
}

/**
 * The paired desk, read from the same two places every screen reads them.
 *
 * The imports are deferred to the call so that this module stays importable by the host tests,
 * which have no SecureStore and no AsyncStorage — the same reason `deskGated.test.ts` injects a
 * `desk` of its own rather than mocking a native module.
 */
async function defaultDesk(): Promise<DeskTarget | null> {
  const [{ getDeskBaseUrl }, { getDeskToken }] = await Promise.all([
    import('../store'),
    import('../deskToken'),
  ])
  const [baseUrl, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
  return baseUrl && token ? { baseUrl, token } : null
}

// Cache TTLs (§4.5's table). The quote/1D-chart TTL sits BELOW the 30 s row poll so every poll
// actually fetches; `fresh` (pull-to-refresh) bypasses whatever is left.
const QUOTE_TTL_MS = 25_000
const CHART_TTL_MS = 5 * 60_000
const NEWS_TTL_MS = 5 * 60_000
const STATS_TTL_MS = 10 * 60_000
const CALENDAR_TTL_MS = 10 * 60_000
const OPTIONS_TTL_MS = 2 * 60_000

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export interface YahooClientOptions {
  fetchFn?: typeof fetch
  now?: () => number
  cache?: ReturnType<typeof createTtlCache>
  /**
   * Where the gated calls go. Read fresh on each call rather than captured once, because the
   * owner can pair a desk in Settings while a detail screen is already mounted, and a client
   * that had resolved `null` at construction would go on saying "no desk" until a reload.
   */
  desk?: () => Promise<DeskTarget | null>
}

export function createYahooClient(opts: YahooClientOptions = {}) {
  const fetchFn = opts.fetchFn ?? fetch
  const now = opts.now ?? Date.now
  const cache = opts.cache ?? createTtlCache(now)
  const deskOf = opts.desk ?? defaultDesk

  function normalize(symbol: string): string {
    return symbol.trim().toUpperCase()
  }

  async function httpGet(url: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      return await fetchFn(url, { headers: YAHOO_BROWSER_HEADERS, signal: controller.signal })
    } catch (e) {
      // Our own deadline firing and the network refusing us both read 'transport' here — the UI
      // sentence ("check your connection") is right for either.
      throw new MarketError('transport', e instanceof Error ? e.message : 'network error')
    } finally {
      clearTimeout(timer)
    }
  }

  function statusError(status: number): MarketError {
    if (status === 429) return new MarketError('rate_limited', `Yahoo responded ${status}`)
    if (status === 404) return new MarketError('not_found', `Yahoo responded ${status}`)
    return new MarketError('http', `Yahoo responded ${status}`)
  }

  async function bodyOf(res: Response): Promise<Record<string, unknown>> {
    try {
      return obj(await res.json())
    } catch {
      throw new MarketError('parse', 'Yahoo answered with a body that is not JSON')
    }
  }

  async function getJson(url: string): Promise<Record<string, unknown>> {
    const res = await httpGet(url)
    if (!res.ok) throw statusError(res.status)
    return bodyOf(res)
  }

  // The desk's own refusal codes, mapped to the vocabulary the tab already draws sentences for.
  // `market_unavailable` — a desk built without curl_cffi — becomes 'crumb' on purpose: it is the
  // same degraded state the tab has always had a gentle card for, and the cause is the owner's to
  // fix on the desk rather than the reader's to understand on the phone.
  function deskError(status: number, code: string | undefined): MarketError {
    if (code === 'no_symbol') return new MarketError('not_found', 'the desk lists nothing for that symbol')
    if (code === 'rate_limited') return new MarketError('rate_limited', 'the desk is being rate-limited by Yahoo')
    if (code === 'market_unavailable') return new MarketError('crumb', 'this desk cannot fetch detailed data')
    if (status === 404) return new MarketError('not_found', 'the desk lists nothing for that symbol')
    return new MarketError('http', `the desk responded ${status}`)
  }

  /**
   * One gated question, asked of the desk. Returns Yahoo's own `result` object, so every mapper
   * below reads exactly the fields it read when this call went to Yahoo directly.
   *
   * A phone with no desk paired is `no_desk` and makes no request — a distinct fact with a
   * distinct remedy, which is why it is not folded into the gentle 'crumb' card.
   */
  async function deskGet(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const desk = await deskOf()
    if (desk === null) {
      throw new MarketError('no_desk', 'no desk is paired with this phone')
    }
    const query = new URLSearchParams(params).toString()
    const url = `${desk.baseUrl.replace(/\/+$/, '')}${path}?${query}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let res: Response
    try {
      res = await fetchFn(url, {
        headers: { Authorization: `Bearer ${desk.token}`, Accept: 'application/json' },
        signal: controller.signal,
      })
    } catch (e) {
      throw new MarketError('transport', e instanceof Error ? e.message : 'network error')
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      // Best-effort: a tunnel or a proxy in front of the desk answers HTML, and a 502 with no
      // envelope in it is still a 502. The status is what is left to say.
      let code: string | undefined
      try {
        const refused = obj(await res.json())
        if (typeof refused.error === 'string') code = refused.error
      } catch {
        // not the desk's envelope
      }
      throw deskError(res.status, code)
    }

    const body = await bodyOf(res)
    const result = body.result
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new MarketError('parse', 'the desk answered without a result object')
    }
    return result as Record<string, unknown>
  }

  // ----- /v8/finance/chart — one request powers quote() AND chart(s, tf) -----

  // The shared cache entry stores a PARSED envelope, not raw JSON: whichever caller populates
  // the key, the other reads a defined shape.
  function mapChartEnvelope(body: Record<string, unknown>, symbol: string): { quote: Quote; chart: ChartData } {
    if (body.chart === undefined) throw new MarketError('parse', 'chart envelope missing')
    const result = obj(body.chart).result
    if (!Array.isArray(result)) throw new MarketError('parse', 'chart result missing')
    if (result.length === 0 || result[0] == null) {
      throw new MarketError('not_found', `no chart data for ${symbol}`)
    }
    const r0 = obj(result[0])
    const meta = obj(r0.meta)

    const timestamps = arr(r0.timestamp)
    const closes = arr(obj(arr(obj(r0.indicators).quote)[0]).close)

    const points: ChartPoint[] = []
    for (let i = 0; i < timestamps.length; i++) {
      const t = num(timestamps[i])
      const close = num(closes[i])
      if (t !== null && close !== null) points.push({ t, close })
    }
    points.sort((a, b) => a.t - b.t)

    const spark: number[] = []
    for (const c of closes) {
      const n = num(c)
      if (n !== null) spark.push(n)
    }

    const price = num(meta.regularMarketPrice)
    const prevCloseOrNull = num(meta.chartPreviousClose) ?? num(meta.previousClose)
    const prevClose = prevCloseOrNull ?? NaN
    const delta = price !== null && prevCloseOrNull !== null ? price - prevCloseOrNull : 0
    const pct =
      price !== null && prevCloseOrNull !== null && prevCloseOrNull !== 0
        ? (delta / prevCloseOrNull) * 100
        : 0

    const sym = str(meta.symbol) || symbol
    const currency = str(meta.currency)

    const quote: Quote = {
      symbol: sym,
      name: str(meta.shortName) || str(meta.longName),
      currency,
      exchange: str(meta.fullExchangeName) || str(meta.exchangeName),
      price: price ?? NaN,
      prevClose,
      delta,
      pct,
      marketTime: num(meta.regularMarketTime) ?? 0,
      spark,
    }

    const chart: ChartData = {
      symbol: sym,
      points,
      prevClose: num(meta.chartPreviousClose),
      currency,
    }

    return { quote, chart }
  }

  function chartEnvelope(
    symbol: string,
    tf: Timeframe,
    fresh: boolean,
  ): Promise<{ quote: Quote; chart: ChartData }> {
    const sym = normalize(symbol)
    const { range, interval } = TIMEFRAME_PARAMS[tf]
    const ttl = tf === '1D' ? QUOTE_TTL_MS : CHART_TTL_MS
    return cache.through(
      `chart:${sym}:${tf}`,
      ttl,
      async () => {
        const body = await getJson(
          `${BASE}/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false`,
        )
        return mapChartEnvelope(body, sym)
      },
      { bypass: fresh },
    )
  }

  async function quote(symbol: string, o?: { fresh?: boolean }): Promise<Quote> {
    return (await chartEnvelope(symbol, '1D', o?.fresh === true)).quote
  }

  async function chart(symbol: string, tf: Timeframe, o?: { fresh?: boolean }): Promise<ChartData> {
    return (await chartEnvelope(symbol, tf, o?.fresh === true)).chart
  }

  // ----- /v1/finance/search — search() and news() -----

  // Not cached — the UI debounces 300 ms and drops stale responses.
  async function search(query: string): Promise<SearchResult[]> {
    const body = await getJson(
      `${BASE}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`,
    )
    return arr(body.quotes)
      .map(obj)
      .filter((e) => str(e.symbol) !== '')
      .map((e) => ({
        symbol: str(e.symbol),
        name: str(e.shortname) || str(e.longname),
        exchange: str(e.exchDisp) || str(e.exchange),
        type: str(e.quoteType),
      }))
  }

  // Thumbnail rule: the smallest resolution >= 140px wide (retina for the 56px slot without
  // shipping the hero image), else the largest available, else null.
  function pickThumbnail(t: unknown): string | null {
    let smallestBigEnough: { width: number; url: string } | null = null
    let largest: { width: number; url: string } | null = null
    for (const raw of arr(obj(t).resolutions)) {
      const r = obj(raw)
      const url = str(r.url)
      const width = num(r.width)
      if (url === '' || width === null) continue
      if (width >= 140 && (smallestBigEnough === null || width < smallestBigEnough.width)) {
        smallestBigEnough = { width, url }
      }
      if (largest === null || width > largest.width) largest = { width, url }
    }
    return smallestBigEnough?.url ?? largest?.url ?? null
  }

  async function news(symbol: string, o?: { fresh?: boolean }): Promise<NewsItem[]> {
    const sym = normalize(symbol)
    return cache.through(
      `news:${sym}`,
      NEWS_TTL_MS,
      async () => {
        const body = await getJson(
          `${BASE}/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=0&newsCount=12`,
        )
        return arr(body.news)
          .map(obj)
          .filter((n) => str(n.link) !== '') // an item nobody can open is not news
          .map((n) => ({
            id: str(n.uuid) || str(n.link),
            title: str(n.title),
            publisher: str(n.publisher),
            publishedAt: num(n.providerPublishTime) ?? 0,
            url: str(n.link),
            thumbnail: pickThumbnail(n.thumbnail),
          }))
      },
      { bypass: o?.fresh === true },
    )
  }

  // ----- quoteSummary, by way of the desk -----

  async function keyStatsAndProfile(
    symbol: string,
    o?: { fresh?: boolean },
  ): Promise<{ stats: KeyStats; profile: ProfileInfo }> {
    const sym = normalize(symbol)
    return cache.through(
      `stats:${sym}`,
      STATS_TTL_MS,
      async () => {
        const r0 = await deskGet('/api/market/summary', {
          symbol: sym,
          modules: 'assetProfile,summaryDetail,defaultKeyStatistics',
        })
        const sd = obj(r0.summaryDetail)
        const ks = obj(r0.defaultKeyStatistics)
        const ap = obj(r0.assetProfile)
        const stats: KeyStats = {
          open: num(sd.open),
          dayHigh: num(sd.dayHigh),
          dayLow: num(sd.dayLow),
          volume: num(sd.volume),
          avgVolume: num(sd.averageVolume),
          wk52High: num(sd.fiftyTwoWeekHigh),
          wk52Low: num(sd.fiftyTwoWeekLow),
          marketCap: num(sd.marketCap),
          trailingPE: num(sd.trailingPE),
          trailingEps: num(ks.trailingEps),
          dividendYield: num(sd.dividendYield),
          beta: num(ks.beta),
        }
        const profile: ProfileInfo = {
          sector: str(ap.sector),
          industry: str(ap.industry),
          employees: num(ap.fullTimeEmployees),
          website: str(ap.website),
          summary: str(ap.longBusinessSummary),
        }
        return { stats, profile }
      },
      { bypass: o?.fresh === true },
    )
  }

  // 'Q2 2025' from the row's `quarter` field, whose fmt is the quarter-end date YYYY-MM-DD.
  // NEVER Yahoo's `period` field — that is a machine token ('-1q') and must not reach the UI.
  function quarterLabel(quarter: unknown): string {
    const m = /^(\d{4})-(\d{2})/.exec(str(obj(quarter).fmt))
    if (!m) return ''
    const month = Number(m[2])
    if (month < 1 || month > 12) return ''
    return `Q${Math.ceil(month / 3)} ${m[1]}`
  }

  async function calendar(symbol: string, o?: { fresh?: boolean }): Promise<CalendarEvents> {
    const sym = normalize(symbol)
    return cache.through(
      `calendar:${sym}`,
      CALENDAR_TTL_MS,
      async () => {
        const r0 = await deskGet('/api/market/summary', {
          symbol: sym,
          modules: 'calendarEvents,earningsHistory',
        })
        const ce = obj(r0.calendarEvents)

        const earningsDates = arr(obj(ce.earnings).earningsDate)
          .map(num)
          .filter((n): n is number => n !== null)
          .sort((a, b) => a - b) // soonest first

        const history: EarningsRow[] = arr(obj(r0.earningsHistory).history)
          .map(obj)
          .map((row) => ({ row, at: num(row.quarter) ?? Number.NEGATIVE_INFINITY }))
          .sort((a, b) => b.at - a.at) // most recent first
          .slice(0, 4)
          .map(({ row }) => ({
            quarter: quarterLabel(row.quarter),
            epsActual: num(row.epsActual),
            epsEstimate: num(row.epsEstimate),
          }))

        return {
          earningsDates,
          exDividendDate: num(ce.exDividendDate),
          dividendDate: num(ce.dividendDate),
          history,
        }
      },
      { bypass: o?.fresh === true },
    )
  }

  // ----- the option chain, by way of the desk -----

  function mapContracts(v: unknown): OptionContract[] {
    const out: OptionContract[] = []
    for (const raw of arr(v)) {
      const c = obj(raw)
      const strike = num(c.strike)
      if (strike === null) continue // a contract without a strike has no row and no place in max pain
      out.push({
        strike,
        lastPrice: num(c.lastPrice),
        bid: num(c.bid),
        ask: num(c.ask),
        volume: num(c.volume),
        openInterest: num(c.openInterest),
        impliedVolatility: num(c.impliedVolatility),
        inTheMoney: Boolean(c.inTheMoney),
      })
    }
    out.sort((a, b) => a.strike - b.strike)
    return out
  }

  async function options(
    symbol: string,
    expiration?: number,
    o?: { fresh?: boolean },
  ): Promise<OptionChain> {
    const sym = normalize(symbol)
    return cache.through(
      `options:${sym}:${expiration ?? 'front'}`,
      OPTIONS_TTL_MS,
      async () => {
        // `date` is omitted rather than sent empty for the front month: the desk reads its
        // absence as "the front one", and an empty string would reach its validator as text.
        const params: Record<string, string> =
          expiration === undefined
            ? { symbol: sym }
            : { symbol: sym, date: String(expiration) }
        const r0 = await deskGet('/api/market/options', params)
        const front = obj(arr(r0.options)[0])
        return {
          symbol: sym,
          spot: num(obj(r0.quote).regularMarketPrice),
          expirationDates: arr(r0.expirationDates)
            .map(num)
            .filter((n): n is number => n !== null)
            .sort((a, b) => a - b),
          expiration: num(front.expirationDate) ?? expiration ?? 0,
          calls: mapContracts(front.calls),
          puts: mapContracts(front.puts),
        }
      },
      { bypass: o?.fresh === true },
    )
  }

  return {
    quote,
    chart,
    search,
    news,
    keyStatsAndProfile,
    calendar,
    options,
  }
}

export type YahooClient = ReturnType<typeof createYahooClient>

/** The app-wide singleton, like `esp32`. */
export const yahoo: YahooClient = createYahooClient()
