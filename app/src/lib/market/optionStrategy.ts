import { type OptionContract } from './types'

export type Strategy = 'long_call' | 'long_put' | 'long_call_spread' | 'short_call_spread' | 'long_put_spread' | 'short_put_spread'
export interface StrategyLeg {
  contract: OptionContract
  side: 'buy' | 'sell'
}
export interface OptionStrategy {
  legs: StrategyLeg[]
  /** Signed debit per share: positive is paid, negative is received. */
  premium: number | null
  premiumTotal: number | null
  delta: number | null
  gamma: number | null
  theta: number | null
  vega: number | null
  rho: number | null
  breakEven: number | null
  /** Dollar outcomes for one standard contract per leg, excluding fees. */
  maxProfit: number | null
  maxLoss: number | null
  /** Signed net bid/ask per share, computed from individual leg quotes. */
  totalBid: number | null
  totalAsk: number | null
  payoff: (spot: number) => number | null
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const sign = (leg: StrategyLeg): number => leg.side === 'buy' ? 1 : -1

/** Contracts must belong to the same underlying, option type and expiry. */
export function buildStrategy(strategy: Strategy, first: OptionContract, second?: OptionContract, entryPremium?: number): OptionStrategy {
  const spread = strategy.endsWith('_spread')
  const put = strategy.includes('put')
  const credit = strategy.startsWith('short_')
  const contracts = spread && second ? [first, second].sort((a, b) => a.strike - b.strike) : [first]
  const legs: StrategyLeg[] = contracts.map((contract, index) => ({
    contract,
    side: !spread || (index === (put ? 1 : 0)) !== credit ? 'buy' : 'sell',
  }))
  const validStructure = contracts.every(c => finite(c.strike) && c.strike > 0)
    && (!spread || (contracts.length === 2 && contracts[0].strike < contracts[1].strike))
  const validQuotes = validStructure && contracts.every(c => finite(c.bid) && finite(c.ask)
    && c.bid >= 0 && c.ask > 0 && c.bid <= c.ask)
  let totalAsk = validQuotes ? legs.reduce((sum, leg) => sum + sign(leg) * (leg.side === 'buy' ? leg.contract.ask! : leg.contract.bid!), 0) : null
  let totalBid = validQuotes ? legs.reduce((sum, leg) => sum + sign(leg) * (leg.side === 'buy' ? leg.contract.bid! : leg.contract.ask!), 0) : null
  const width = spread && contracts.length === 2 ? contracts[1].strike - contracts[0].strike : 0
  // A vertical cannot cost more than its strike width or reverse debit/credit direction.
  if (totalAsk !== null && spread && (credit ? totalAsk >= 0 || -totalAsk >= width : totalAsk <= 0 || totalAsk >= width)) {
    totalAsk = null
    totalBid = null
  }
  // Unknown/adjusted deliverables cannot be valued with the standard 100-share payoff.
  const standard = contracts.every(c => c.multiplier === 100)
  let premium = entryPremium === undefined ? totalAsk : entryPremium
  if (!validStructure || !finite(premium)
    || (credit ? premium >= 0 : premium <= 0)
    || (spread && Math.abs(premium) >= width)) premium = null
  const canValue = premium !== null && standard
  const payoff = (spot: number): number | null => {
    if (!canValue || !finite(spot) || spot < 0) return null
    const intrinsic = legs.reduce((sum, leg) => sum + sign(leg)
      * Math.max(put ? leg.contract.strike - spot : spot - leg.contract.strike, 0), 0)
    return (intrinsic - premium!) * 100
  }
  let breakEven: number | null = null
  let maxProfit: number | null = null
  let maxLoss: number | null = null
  if (canValue) {
    const low = contracts[0].strike
    const high = contracts[contracts.length - 1].strike
    breakEven = put ? high + (credit ? premium! : -premium!) : low + (credit ? -premium! : premium!)
    if (breakEven < 0) breakEven = null
    const bounds = [payoff(0)!, payoff(high)!]
    maxProfit = !spread && !put ? Infinity : Math.max(0, ...bounds)
    maxLoss = Math.max(0, ...bounds.map(value => -value))
  }
  const greek = (key: 'delta' | 'gamma' | 'theta' | 'vega' | 'rho'): number | null => {
    if (!validStructure || legs.some(leg => !finite(leg.contract[key]))) return null
    return legs.reduce((sum, leg) => sum + sign(leg) * leg.contract[key]!, 0)
  }
  return { legs, premium, premiumTotal: canValue ? premium! * 100 : null,
    delta: greek('delta'), gamma: greek('gamma'), theta: greek('theta'), vega: greek('vega'), rho: greek('rho'),
    breakEven, maxProfit, maxLoss, totalBid, totalAsk, payoff }
}
