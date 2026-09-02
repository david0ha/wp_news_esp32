// The Yahoo Finance client (spec §4.5) — the only file in the app that knows a Yahoo field
// name. Everything is defensively coerced through num()/str() so a malformed payload yields
// nulls/''/[] rather than a throw; only a missing top-level envelope is a MarketError('parse').
//
// Unofficial API, so the failure vocabulary matters as much as the happy path:
//   network throw/abort → 'transport'; 429 → 'rate_limited'; 401/403 on crumb-gated endpoints →
//   the §4.2 retry contract (invalidate → re-bootstrap once → retry once) then 'crumb'; 404 or an
//   empty result array → 'not_found'; other non-2xx → 'http'; bad JSON or a missing envelope →
//   'parse'.

import { createCrumbProvider, YAHOO_BROWSER_HEADERS } from './crumb'
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
  crumb?: ReturnType<typeof createCrumbProvider> // injectable for tests
  cache?: ReturnType<typeof createTtlCache>
}

export function createYahooClient(opts: YahooClientOptions = {}) {
  const fetchFn = opts.fetchFn ?? fetch
  const now = opts.now ?? Date.now
  const crumb = opts.crumb ?? createCrumbProvider({ fetchFn, now })
  const cache = opts.cache ?? createTtlCache(now)

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

  // Crumb-gated GET. makeUrl receives the already-encoded crumb token. 401/403 means Yahoo no
  // longer honours the crumb: invalidate, re-bootstrap ONCE, retry ONCE; a second refusal is
  // MarketError('crumb') — the section's degraded card, not a retry loop.
  async function getJsonGated(makeUrl: (crumbToken: string) => string): Promise<Record<string, unknown>> {
    const first = await crumb.getCrumb()
    let res = await httpGet(makeUrl(encodeURIComponent(first)))
    if (res.status === 401 || res.status === 403) {
      await crumb.invalidate()
      const second = await crumb.getCrumb()
      res = await httpGet(makeUrl(encodeURIComponent(second)))
      if (res.status === 401 || res.status === 403) {
        throw new MarketError('crumb', `Yahoo refused the crumb twice (${res.status})`)
      }
    }
    if (!res.ok) throw statusError(res.status)
    return bodyOf(res)
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

  // ----- /v10/finance/quoteSummary — crumb-gated -----

  function quoteSummaryResult(body: Record<string, unknown>, symbol: string): Record<string, unknown> {
    if (body.quoteSummary === undefined) throw new MarketError('parse', 'quoteSummary envelope missing')
    const result = obj(body.quoteSummary).result
    if (!Array.isArray(result)) throw new MarketError('parse', 'quoteSummary result missing')
    if (result.length === 0 || result[0] == null) {
      throw new MarketError('not_found', `no summary data for ${symbol}`)
    }
    return obj(result[0])
  }

  async function keyStatsAndProfile(
    symbol: string,
    o?: { fresh?: boolean },
  ): Promise<{ stats: KeyStats; profile: ProfileInfo }> {
    const sym = normalize(symbol)
    return cache.through(
      `stats:${sym}`,
      STATS_TTL_MS,
      async () => {
        const body = await getJsonGated(
          (c) =>
            `${BASE}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=assetProfile,summaryDetail,defaultKeyStatistics&crumb=${c}`,
        )
        const r0 = quoteSummaryResult(body, sym)
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
        const body = await getJsonGated(
          (c) =>
            `${BASE}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=calendarEvents,earningsHistory&crumb=${c}`,
        )
        const r0 = quoteSummaryResult(body, sym)
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

  // ----- /v7/finance/options — crumb-gated -----

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
        // Both URL forms written out — crumb takes the `?` itself when it is the first param.
        const body = await getJsonGated((c) =>
          expiration === undefined
            ? `${BASE}/v7/finance/options/${encodeURIComponent(sym)}?crumb=${c}`
            : `${BASE}/v7/finance/options/${encodeURIComponent(sym)}?date=${expiration}&crumb=${c}`,
        )
        if (body.optionChain === undefined) throw new MarketError('parse', 'optionChain envelope missing')
        const result = obj(body.optionChain).result
        if (!Array.isArray(result)) throw new MarketError('parse', 'optionChain result missing')
        if (result.length === 0 || result[0] == null) {
          throw new MarketError('not_found', `no options for ${sym}`)
        }
        const r0 = obj(result[0])
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
