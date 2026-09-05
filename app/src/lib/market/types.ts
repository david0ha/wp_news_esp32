// Types, defensive coercers and the error vocabulary for the market data layer
// (docs/specs/2026-09-01-app-market-ui-design.md §4.1). This is the TypeScript mirror of what
// the app expects Yahoo Finance to say — every field the UI renders is produced through the
// coercers below, so a malformed payload yields nulls/''/[] instead of a throw from deep inside
// a mapper. Only a missing top-level envelope is an error (MarketError('parse', …), yahoo.ts).
//
// Nothing in lib/market imports React or anything from components/.

import { strings } from '../../i18n'

export interface Quote {
  symbol: string
  name: string // meta shortName/longName, '' when absent
  currency: string // ISO code, e.g. 'USD'; '' when absent
  exchange: string // meta fullExchangeName ?? exchangeName ?? '' ("NASDAQ", not the "NMS" short code)
  price: number // regularMarketPrice
  prevClose: number // chartPreviousClose ?? previousClose; NaN when absent
  delta: number // price - prevClose (0 when prevClose is NaN)
  pct: number // percent-scaled change: 0.16 means +0.16% (NOT a 0–1 fraction); 0 when prevClose NaN/0
  marketTime: number // epoch seconds of regularMarketTime, 0 when absent
  spark: number[] // day's closes (nulls dropped) for the row sparkline
}

export interface ChartPoint {
  t: number // epoch seconds
  close: number // price
}

export interface ChartData {
  symbol: string
  points: ChartPoint[] // null closes dropped; always time-ascending
  prevClose: number | null // meta chartPreviousClose (1D baseline); null when absent
  currency: string
}

export interface SearchResult {
  symbol: string
  name: string
  exchange: string
  type: string // 'EQUITY' | 'ETF' | ...
}

export interface NewsItem {
  id: string
  title: string
  publisher: string
  publishedAt: number // epoch seconds
  url: string
  thumbnail: string | null // smallest resolution >= 140px wide, else largest available, else null
}

export interface KeyStats {
  open: number | null
  dayHigh: number | null
  dayLow: number | null
  volume: number | null
  avgVolume: number | null
  wk52High: number | null
  wk52Low: number | null
  marketCap: number | null
  trailingPE: number | null
  trailingEps: number | null
  dividendYield: number | null // fractional, e.g. 0.0044
  beta: number | null
}

// No name field — the display name lives on Quote, and the screen header already shows it.
export interface ProfileInfo {
  sector: string
  industry: string
  employees: number | null
  website: string
  summary: string
}

// `quarter` is the human label ('Q2 2025', yahoo.ts) — never Yahoo's machine token ('-1q').
export interface EarningsRow {
  quarter: string
  epsActual: number | null
  epsEstimate: number | null
}

export interface CalendarEvents {
  earningsDates: number[] // epoch seconds, soonest first (Yahoo gives a 1–2 date window)
  exDividendDate: number | null // epoch seconds
  dividendDate: number | null // payment date
  history: EarningsRow[] // most recent first, max 4
}

export interface OptionContract {
  strike: number
  lastPrice: number | null
  bid: number | null
  ask: number | null
  volume: number | null
  openInterest: number | null
  impliedVolatility: number | null // fractional, e.g. 0.34
  inTheMoney: boolean
}

export interface OptionChain {
  symbol: string
  spot: number | null
  expirationDates: number[] // epoch seconds, ascending
  expiration: number // the expiry this chain is for
  calls: OptionContract[] // strike-ascending
  puts: OptionContract[]
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export type MarketErrorCode = 'transport' | 'http' | 'rate_limited' | 'crumb' | 'parse' | 'not_found'

export class MarketError extends Error {
  constructor(
    public code: MarketErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MarketError'
  }
}

/**
 * A sentence per failure. `crumb` is deliberately gentle — from EU IPs the cookie bootstrap
 * failing is a normal outcome, and the chart, watchlist and news keep working without it.
 */
export function marketHumanError(e: unknown): string {
  const m = strings().errors.market
  if (e instanceof MarketError) {
    switch (e.code) {
      case 'transport':
        return m.transport
      case 'http':
        return m.http
      case 'rate_limited':
        return m.rateLimited
      case 'crumb':
        return m.crumb
      case 'parse':
        return m.parse
      case 'not_found':
        return m.notFound
    }
  }
  return m.unknown
}

// ---------------------------------------------------------------------------
// Coercers. Yahoo has two number shapes — a plain number, and `{ raw, fmt }` in quoteSummary —
// and these are the only two doors a number gets in through. Everything else (strings included:
// a numeric string is a field we misread, not a number) is null.
// ---------------------------------------------------------------------------

/** A finite number, unwrapping Yahoo's `{ raw: n }` shape; anything else → null. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const raw = (v as { raw?: unknown }).raw
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  }
  return null
}

/** A string, or '' for anything that is not one. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
