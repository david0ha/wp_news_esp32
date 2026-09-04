import { describe, it, expect } from '@jest/globals'
import { arrow, changeTone, DASH, formatPct, formatPrice } from './format'
import * as market from '../market/format'

// `formatPrice`, `formatPct`, `arrow` and `DASH` are `lib/market/format.ts`'s, re-exported. The
// cases below are the edition's own inputs — a share price, a percentage change already scaled —
// held to the behaviour that module defines, so the drift that used to sit between the two
// (`formatPrice(0)`) has one answer and one test.

describe('the edition re-exports the market formatters rather than copying them', () => {
  it('is the same function object, so the two tabs cannot drift', () => {
    expect(formatPrice).toBe(market.formatPrice)
    expect(formatPct).toBe(market.formatPct)
    expect(arrow).toBe(market.arrow)
    expect(DASH).toBe(market.DASH)
  })
})

describe('formatPrice', () => {
  it('gives two decimals with thousands separators at or above one', () => {
    expect(formatPrice(1631.47)).toBe('1,631.47')
    expect(formatPrice(1593.09)).toBe('1,593.09')
    expect(formatPrice(41.28)).toBe('41.28')
    expect(formatPrice(1642)).toBe('1,642.00')
  })

  it('keeps four decimals under 1, where two would round a real price to nothing', () => {
    expect(formatPrice(0.0842)).toBe('0.0842')
    expect(formatPrice(0.5)).toBe('0.5000')
    // Zero takes the same branch as any other sub-dollar figure. The edition's own copy used to
    // pin it to '0.00'; the market module is the one both tabs now read.
    expect(formatPrice(0)).toBe('0.0000')
  })

  it('keeps the sign of a negative', () => {
    expect(formatPrice(-370)).toBe('-370.00')
  })

  it('is the em dash for anything that is not a finite number', () => {
    expect(formatPrice(null)).toBe(DASH)
    expect(formatPrice(undefined)).toBe(DASH)
    expect(formatPrice(NaN)).toBe(DASH)
    expect(formatPrice(Infinity)).toBe(DASH)
    expect(DASH).toBe('—')
  })
})

describe('formatPct', () => {
  it('takes the number ALREADY scaled to percent and does not multiply', () => {
    expect(formatPct(2.41)).toBe('2.41%')
    expect(formatPct(0.62)).toBe('0.62%')
  })

  it('is unsigned — the arrow and the colour carry the direction', () => {
    expect(formatPct(-0.74)).toBe('0.74%')
  })

  it('collapses a magnitude under a hundredth to a flat zero', () => {
    expect(formatPct(0)).toBe('0.00%')
    expect(formatPct(0.00004)).toBe('0.00%')
    expect(formatPct(-0.00004)).toBe('0.00%')
  })

  it('is the em dash for anything that is not a finite number', () => {
    expect(formatPct(null)).toBe(DASH)
    expect(formatPct(NaN)).toBe(DASH)
  })
})

describe('changeTone and arrow', () => {
  it('reads the sign', () => {
    expect(changeTone(2.41)).toBe('up')
    expect(changeTone(-0.74)).toBe('down')
    expect(arrow(2.41)).toBe('▲')
    expect(arrow(-0.74)).toBe('▼')
  })

  it('gives zero and absence the same neutral treatment, with no mark', () => {
    // A colour reserved for movement has no business standing in for its absence.
    for (const v of [0, null, undefined, NaN]) {
      expect(changeTone(v)).toBe('flat')
      expect(arrow(v)).toBe('')
    }
  })
})
