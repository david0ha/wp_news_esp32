import { it, expect } from '@jest/globals'
import { buildStrategy, type Strategy } from './optionStrategy'
import { type OptionContract } from './types'

function contract(strike: number, bid: number | null, ask: number | null, extra: Partial<OptionContract> = {}): OptionContract {
  return { strike, bid, ask, lastPrice: 9, volume: null, openInterest: null,
    impliedVolatility: null, inTheMoney: false, multiplier: 100,
    delta: 0.6, gamma: 0.04, theta: -0.03, vega: 0.2, rho: 0.1, ...extra }
}

it.each<[Strategy, number, number, number, number, number, number]>([
  ['long_call', 6, 106, Infinity, 600, -600, 1400],
  ['long_put', 6, 94, 9400, 600, 1400, -600],
])('%s uses the ask and dollar outcomes', (strategy, premium, breakEven, maxProfit, maxLoss, at80, at120) => {
  const result = buildStrategy(strategy, contract(100, 5, 6))
  expect(result).toMatchObject({ premium, premiumTotal: 600, breakEven, maxProfit, maxLoss, totalBid: 5, totalAsk: 6 })
  expect(result.payoff(80)).toBe(at80)
  expect(result.payoff(120)).toBe(at120)
  expect(result.payoff(breakEven)).toBeCloseTo(0)
})

it.each<[Strategy, number, number, number, number, number, number]>([
  ['long_call_spread', 4, 104, 600, 400, -400, 600],
  ['short_call_spread', -2, 102, 200, 800, 200, -800],
  ['long_put_spread', 4, 106, 600, 400, 600, -400],
  ['short_put_spread', -2, 108, 200, 800, -800, 200],
])('%s sorts strikes and prices each trade side', (strategy, premium, breakEven, maxProfit, maxLoss, at80, at120) => {
  const put = strategy.includes('put')
  const low = contract(100, put ? 2 : 5, put ? 3 : 6)
  const high = contract(110, put ? 5 : 2, put ? 6 : 3)
  for (const [a, b] of [[low, high], [high, low]]) {
    const result = buildStrategy(strategy, a, b)
    expect(result).toMatchObject({ premium, premiumTotal: premium * 100, breakEven, maxProfit, maxLoss })
    expect(result.payoff(80)).toBe(at80)
    expect(result.payoff(120)).toBe(at120)
    expect(result.payoff(breakEven)).toBeCloseTo(0)
  }
})

it('aggregates signed Greeks and leaves a missing Greek unavailable', () => {
  const result = buildStrategy('long_call_spread', contract(100, 5, 6), contract(110, 2, 3, {delta: 0.2, gamma: 0.01, theta: -0.01, vega: null}))
  expect(result.delta).toBeCloseTo(0.4)
  expect(result.gamma).toBeCloseTo(0.03)
  expect(result.theta).toBeCloseTo(-0.02)
  expect(result.vega).toBeNull()
  expect(result.rho).toBe(0)
})

it.each([[null, null], [1, null], [null, 2], [3, 2], [0, 0], [-1, 2], [1, NaN]])('does not invent entry prices from invalid quotes %s/%s', (bid, ask) => {
  const result = buildStrategy('long_call', contract(100, bid, ask))
  expect(result.premium).toBeNull()
  expect(result.maxLoss).toBeNull()
  expect(result.payoff(120)).toBeNull()
})

it('accepts a genuine zero bid when the ask is positive', () => {
  expect(buildStrategy('long_call', contract(100, 0, 1)).premium).toBe(1)
})

it.each([undefined, 10, 150])('does not compute contract risk for unknown or nonstandard multiplier %s', multiplier => {
  const result = buildStrategy('long_call', contract(100, 5, 6, { multiplier }))
  expect(result.premiumTotal).toBeNull()
  expect(result.breakEven).toBeNull()
  expect(result.maxProfit).toBeNull()
  expect(result.payoff(120)).toBeNull()
})

it.each(['long_call_spread', 'short_call_spread', 'long_put_spread', 'short_put_spread'] as Strategy[])('rejects incomplete or same-strike %s', strategy => {
  for (const second of [undefined, contract(100, 2, 3)]) {
    expect(buildStrategy(strategy, contract(100, 5, 6), second).premium).toBeNull()
  }
})

it('rejects inverted and excessive spread economics', () => {
  for (const result of [
    buildStrategy('long_call_spread', contract(100, 1, 2), contract(110, 5, 6)),
    buildStrategy('long_call_spread', contract(100, 15, 16), contract(110, 2, 3)),
    buildStrategy('short_call_spread', contract(100, 1, 2), contract(110, 5, 6)),
    buildStrategy('short_call_spread', contract(100, 15, 16), contract(110, 2, 3)),
  ]) {
    expect(result.premium).toBeNull()
    expect(result.breakEven).toBeNull()
    expect(result.maxProfit).toBeNull()
    expect(result.payoff(120)).toBeNull()
  }
})

it('rejects negative spots and invalid strikes', () => {
  expect(buildStrategy('long_call', contract(100, 5, 6)).payoff(-1)).toBeNull()
  expect(buildStrategy('long_call', contract(NaN, 5, 6)).premium).toBeNull()
})

it('uses an edited debit for risk without changing market quotes', () => {
  const result = buildStrategy('long_call', contract(100, 5, 6), undefined, 5.5)
  expect(result).toMatchObject({ premium: 5.5, premiumTotal: 550, breakEven: 105.5, maxLoss: 550, totalAsk: 6, totalBid: 5 })
  expect(result.payoff(110)).toBe(450)
})

it('uses an edited credit for spread risk', () => {
  const result = buildStrategy('short_put_spread', contract(100, 2, 3), contract(110, 5, 6), -2.5)
  expect(result).toMatchObject({ premium: -2.5, breakEven: 107.5, maxProfit: 250, maxLoss: 750 })
})

it.each([NaN, -2, 0, Infinity])('rejects invalid edited debit %s', entry => {
  expect(buildStrategy('long_call', contract(100, 5, 6), undefined, entry).premium).toBeNull()
})
