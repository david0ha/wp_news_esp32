import { describe, it, expect } from '@jest/globals'
import { analyzeChain, ivSummary, maxPain, putCallRatio } from './analysis'
import { type OptionChain, type OptionContract } from './types'

// Contract shorthand — only the fields the analytics read vary per test.
function contract(strike: number, extra: Partial<OptionContract> = {}): OptionContract {
  return {
    strike,
    lastPrice: null,
    bid: null,
    ask: null,
    volume: null,
    openInterest: null,
    impliedVolatility: null,
    inTheMoney: false,
    ...extra,
  }
}

function chain(
  calls: OptionContract[],
  puts: OptionContract[],
  spot: number | null = null,
): OptionChain {
  return {
    symbol: 'TEST',
    spot,
    expirationDates: [1_760_000_000],
    expiration: 1_760_000_000,
    calls,
    puts,
  }
}

describe('putCallRatio', () => {
  it('sums OI and volume with nulls as 0', () => {
    const c = chain(
      [contract(100, { openInterest: 10, volume: 5 }), contract(110, { openInterest: null, volume: null })],
      [contract(100, { openInterest: 15, volume: 20 }), contract(90, { openInterest: 5, volume: null })],
    )
    const r = putCallRatio(c)
    expect(r.oi).toBeCloseTo(20 / 10, 10)
    expect(r.volume).toBeCloseTo(20 / 5, 10)
  })

  it('a zero call denominator → null, per side', () => {
    const c = chain(
      [contract(100, { openInterest: null, volume: 3 })],
      [contract(100, { openInterest: 50, volume: 7 })],
    )
    const r = putCallRatio(c)
    expect(r.oi).toBeNull() // call OI total is 0
    expect(r.volume).toBeCloseTo(7 / 3, 10)
  })
})

describe('maxPain', () => {
  // Hand-computed 3-strike fixture:
  //   calls: K=90 OI=10, K=100 OI=20, K=110 OI=30
  //   puts:  K=90 OI=30, K=100 OI=10, K=110 OI=5
  //   pain(90)  = 0                        + (10·10 + 5·20)      = 200
  //   pain(100) = 10·10                    + 5·10               = 150   ← minimum
  //   pain(110) = 10·20 + 20·10            + 0                  = 400
  const threeStrikes = chain(
    [
      contract(90, { openInterest: 10 }),
      contract(100, { openInterest: 20 }),
      contract(110, { openInterest: 30 }),
    ],
    [
      contract(90, { openInterest: 30 }),
      contract(100, { openInterest: 10 }),
      contract(110, { openInterest: 5 }),
    ],
  )

  it('finds the strike minimizing the writers payout', () => {
    expect(maxPain(threeStrikes)).toBe(100)
  })

  it('a tie goes to the lowest strike', () => {
    // pain(100) = 0 + 1·(110−100) = 10; pain(110) = 1·(110−100) + 0 = 10 → 100 wins.
    const tied = chain([contract(100, { openInterest: 1 })], [contract(110, { openInterest: 1 })])
    expect(maxPain(tied)).toBe(100)
  })

  it('null OI counts as 0 in the payout', () => {
    // The null-OI call at 90 must not move the answer.
    const withNulls = chain(
      [contract(90, { openInterest: null }), contract(100, { openInterest: 1 })],
      [contract(110, { openInterest: 1 })],
    )
    expect(maxPain(withNulls)).toBe(100)
  })

  it('every OI zero/null → null (an identically-zero pain names no strike)', () => {
    const dead = chain(
      [contract(90, { openInterest: 0 }), contract(100, { openInterest: null })],
      [contract(110, { openInterest: 0 })],
    )
    expect(maxPain(dead)).toBeNull()
  })

  it('an empty chain → null', () => {
    expect(maxPain(chain([], []))).toBeNull()
  })
})

describe('ivSummary', () => {
  it('with a spot, only strikes within 10% qualify (boundary inclusive)', () => {
    const c = chain(
      [
        contract(95, { impliedVolatility: 0.3 }), // 5% away — in
        contract(110, { impliedVolatility: 0.5 }), // exactly 10% — in
        contract(111, { impliedVolatility: 0.9 }), // 11% — out
      ],
      [
        contract(90, { impliedVolatility: 0.4 }), // exactly 10% — in
        contract(80, { impliedVolatility: 0.8 }), // 20% — out
      ],
      100,
    )
    const s = ivSummary(c)
    expect(s.callIv).toBeCloseTo((0.3 + 0.5) / 2, 10)
    expect(s.putIv).toBeCloseTo(0.4, 10)
    expect(s.overallIv).toBeCloseTo((0.3 + 0.5 + 0.4) / 3, 10)
  })

  it('without a spot, every contract with valid IV qualifies', () => {
    const c = chain(
      [contract(95, { impliedVolatility: 0.3 }), contract(500, { impliedVolatility: 0.5 })],
      [contract(5, { impliedVolatility: 0.4 })],
      null,
    )
    const s = ivSummary(c)
    expect(s.callIv).toBeCloseTo(0.4, 10)
    expect(s.putIv).toBeCloseTo(0.4, 10)
    expect(s.overallIv).toBeCloseTo(0.4, 10)
  })

  it('null and zero IV never qualify', () => {
    const c = chain(
      [contract(100, { impliedVolatility: null }), contract(100, { impliedVolatility: 0 })],
      [contract(100, { impliedVolatility: 0.4 })],
      100,
    )
    const s = ivSummary(c)
    expect(s.callIv).toBeNull()
    expect(s.putIv).toBeCloseTo(0.4, 10)
    expect(s.overallIv).toBeCloseTo(0.4, 10) // union mean, not a mean of means
  })

  it("ignores Yahoo's ~1e-05 no-quote IV placeholder, even inside the ±10% window", () => {
    const SENTINEL = 1.0000000000000003e-5
    const c = chain(
      [
        contract(100, { impliedVolatility: 0.3 }), // at the money — in
        contract(102, { impliedVolatility: SENTINEL }), // no live quote — must not drag the mean
      ],
      [
        contract(98, { impliedVolatility: SENTINEL }),
        contract(100, { impliedVolatility: 0.4 }),
      ],
      100,
    )
    const s = ivSummary(c)
    expect(s.callIv).toBeCloseTo(0.3, 10)
    expect(s.putIv).toBeCloseTo(0.4, 10)
    expect(s.overallIv).toBeCloseTo((0.3 + 0.4) / 2, 10)
  })

  it('nothing qualifies anywhere → all null', () => {
    const s = ivSummary(chain([contract(100)], [contract(100)], 100))
    expect(s).toEqual({ callIv: null, putIv: null, overallIv: null })
  })

  it('overallIv is the mean of the UNION, not the mean of the two side means', () => {
    const c = chain(
      [contract(100, { impliedVolatility: 0.2 }), contract(101, { impliedVolatility: 0.4 })],
      [contract(100, { impliedVolatility: 0.9 })],
      null,
    )
    const s = ivSummary(c)
    // Mean of means would be ((0.3) + 0.9) / 2 = 0.6; the union mean is 0.5.
    expect(s.overallIv).toBeCloseTo((0.2 + 0.4 + 0.9) / 3, 10)
  })
})

describe('analyzeChain', () => {
  it('composes the three analytics', () => {
    const c = chain(
      [contract(100, { openInterest: 10, volume: 4, impliedVolatility: 0.3 })],
      [contract(110, { openInterest: 20, volume: 2, impliedVolatility: 0.5 })],
      100,
    )
    const a = analyzeChain(c)
    expect(a.putCallRatioOi).toBeCloseTo(2, 10)
    expect(a.putCallRatioVolume).toBeCloseTo(0.5, 10)
    expect(a.maxPain).toBe(maxPain(c))
    expect(a.callIv).toBeCloseTo(0.3, 10)
    expect(a.putIv).toBeCloseTo(0.5, 10)
    expect(a.overallIv).toBeCloseTo(0.4, 10)
  })
})
