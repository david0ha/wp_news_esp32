import { describe, it, expect } from '@jest/globals'
import { TILE_PADDING } from '../../../lib/edition/tiles'
import { space } from '../../../theme'
import {
  RANGE_STAT_VALUE_SIZE,
  RANGE_STAT_VALUE_SIZE_CJK,
  RANGE_VALUE_DIGIT_EM,
  rangeStatValueSize,
} from './range'

/** A 390 pt phone at this app's gutters and column gap — `tape.test.ts`'s number. */
const COL = 173

/** One of the grid's two 50% cells, less the gutter charged to it. */
const CELL = Math.floor((COL - 2 * TILE_PADDING) / 2) - space.xs

/** The longest price the tile draws: five digits, a separator and two decimals. */
const KRX = '94,100.00'

const width = (s: string, size: number) => s.length * size * RANGE_VALUE_DIGIT_EM

describe('the range tile’s stat value size', () => {
  it('is what an English edition has always drawn', () => {
    // The regression this module exists to hold. The Korean fix — a point off the size — was
    // applied to the tile rather than to the language, so every English edition got the smaller
    // type for a problem it does not have: a US price is six characters and fits at any of these
    // sizes with twenty points to spare.
    expect(rangeStatValueSize('en')).toBe(14)
    expect(RANGE_STAT_VALUE_SIZE).toBe(14)
  })

  it('drops a point for a CJK script, where the prices run long', () => {
    expect(rangeStatValueSize('ko')).toBe(RANGE_STAT_VALUE_SIZE_CJK)
    expect(RANGE_STAT_VALUE_SIZE_CJK).toBe(13)
  })

  it('treats every other language as Latin, including one nobody has filed yet', () => {
    // The same list `typeRamp.tsx` keeps, and for the same reason: adding `ja` has to move one
    // set, not two. Anything absent from it is a language Inter can set.
    for (const lang of ['en', 'fr', 'de', '', 'zz']) {
      expect(rangeStatValueSize(lang)).toBe(RANGE_STAT_VALUE_SIZE)
    }
  })

  it('is the size at which a KRX price fits its cell, and the old one is not', () => {
    // Why the Korean number is 13 and not 14, checked rather than asserted in prose. Both are
    // estimates off the advance this tile measured, so the margin is the claim: a point of size
    // is five points of room, and the cell is 68.
    expect(width(KRX, RANGE_STAT_VALUE_SIZE_CJK)).toBeLessThan(CELL)
    expect(width(KRX, RANGE_STAT_VALUE_SIZE)).toBeGreaterThan(CELL)
  })

  it('fits an ordinary US price at the Latin size with room to spare', () => {
    expect(width('226.30', RANGE_STAT_VALUE_SIZE)).toBeLessThan(CELL - 20)
  })
})
