import { MarketError, type OptionChain, type OptionContract } from './types'
import { type DeskTarget } from './yahoo'

export interface AlpacaClientOptions {
  fetchFn?: typeof fetch
  desk?: () => Promise<DeskTarget | null>
}

async function defaultDesk(): Promise<DeskTarget | null> {
  const [{ getDeskBaseUrl }, { getDeskToken }] = await Promise.all([
    import('../store'), import('../deskToken'),
  ])
  const [baseUrl, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
  return baseUrl && token ? { baseUrl, token } : null
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}
function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function nonnegative(value: unknown): number | null {
  const number = numeric(value)
  return number !== null && number >= 0 ? number : null
}
function timestamp(value: unknown): string | null {
  return typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value)) ? value : null
}
function contract(value: unknown): OptionContract {
  const c = object(value)
  const strike = numeric(c.strike)
  if (strike === null || strike <= 0) throw new MarketError('parse', 'Options response is invalid')
  const multiplier = numeric(c.multiplier)
  return {
    symbol: typeof c.symbol === 'string' && c.symbol ? c.symbol : null,
    strike, bid: nonnegative(c.bid), ask: nonnegative(c.ask), lastPrice: nonnegative(c.lastPrice),
    volume: nonnegative(c.volume), openInterest: nonnegative(c.openInterest),
    impliedVolatility: nonnegative(c.impliedVolatility), inTheMoney: c.inTheMoney === true,
    delta: numeric(c.delta), gamma: numeric(c.gamma), theta: numeric(c.theta),
    vega: numeric(c.vega), rho: numeric(c.rho),
    quoteTimestamp: timestamp(c.quoteTimestamp), tradeTimestamp: timestamp(c.tradeTimestamp),
    multiplier: multiplier !== null && multiplier > 0 ? multiplier : null,
  }
}
function parse(body: unknown, symbol: string, expiration?: number): OptionChain {
  const envelope = object(body)
  const chain = object(envelope.result)
  const dates = chain.expirationDates
  if (envelope.ok !== true || chain.source !== 'alpaca' || chain.symbol !== symbol
    || (chain.feed !== 'indicative' && chain.feed !== 'opra')
    || !Array.isArray(dates) || !dates.length || dates.some(date => !Number.isSafeInteger(date) || date <= 0)
    || !Number.isSafeInteger(chain.expiration) || !dates.includes(chain.expiration)
    || (expiration !== undefined && chain.expiration !== expiration)
    || !Array.isArray(chain.calls) || !Array.isArray(chain.puts)) {
    throw new MarketError('parse', 'Options response is invalid')
  }
  const contracts = (rows: unknown[]): OptionContract[] => rows.map(contract).sort((a, b) => a.strike - b.strike)
  return {
    symbol, source: 'alpaca', feed: chain.feed, spot: nonnegative(chain.spot),
    expiration: chain.expiration as number, expirationDates: [...new Set<number>(dates)].sort((a, b) => a - b),
    calls: contracts(chain.calls), puts: contracts(chain.puts),
  }
}

export function createAlpacaClient(opts: AlpacaClientOptions = {}) {
  const fetchFn = opts.fetchFn ?? fetch
  const deskOf = opts.desk ?? defaultDesk
  return {
    async options(symbol: string, expiration?: number, options: { fresh?: boolean } = {}): Promise<OptionChain> {
      const normalized = symbol.trim().toUpperCase()
      const desk = await deskOf()
      if (!desk?.baseUrl || !desk.token) throw new MarketError('no_desk', 'No desk is paired with this phone')
      const url = `${desk.baseUrl.replace(/\/+$/, '')}/api/market/options/alpaca?symbol=${encodeURIComponent(normalized)}`
        + (expiration === undefined ? '' : `&date=${expiration}`) + (options.fresh ? '&fresh=1' : '')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      try {
        const response = await fetchFn(url, {
          headers: { Authorization: `Bearer ${desk.token}`, Accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new MarketError(response.status === 429 ? 'rate_limited' : response.status === 404 ? 'not_found' : 'http', 'Options request was unavailable')
        }
        let body: unknown
        try { body = await response.json() }
        catch {
          if (controller.signal.aborted) throw new MarketError('transport', 'Options request failed')
          throw new MarketError('parse', 'Options response is invalid')
        }
        return parse(body, normalized, expiration)
      } catch (error) {
        if (error instanceof MarketError) throw error
        throw new MarketError('transport', 'Options request failed')
      } finally { clearTimeout(timer) }
    },
  }
}

export const alpacaOptions = createAlpacaClient().options
