import { describe, it, expect } from '@jest/globals'
import { barLayout } from './bars'

describe('barLayout', () => {
  it('scales from zero and not from the minimum', () => {
    // 95 and 100 differ by 5%. From zero that is a 5% difference in height; from the minimum it
    // would be the difference between nothing and the full box, which is the lie this guards.
    const { heights } = barLayout([95, 100], 100, 100)
    expect(heights).toEqual([95, 100])
  })

  it('gives the maximum the full height', () => {
    expect(barLayout([1, 2, 4], 100, 40).heights[2]).toBe(40)
  })

  it('drops non-finite values before it measures', () => {
    const { heights } = barLayout([NaN, 50, Infinity, 100], 100, 100)
    expect(heights).toEqual([50, 100])
  })

  it('floors every bar at one pixel so a small number is not missing data', () => {
    expect(barLayout([0.0001, 100], 100, 50).heights[0]).toBe(1)
  })

  it('flattens an all-zero series instead of dividing by zero', () => {
    expect(barLayout([0, 0, 0], 100, 50).heights).toEqual([1, 1, 1])
  })

  it('flattens an all-negative series rather than inverting it', () => {
    expect(barLayout([-3, -1], 100, 50).heights).toEqual([1, 1])
  })

  it('splits the width by the bar count with the gaps taken out', () => {
    // 3 bars, 2 gaps of 3 px: (100 - 6) / 3.
    expect(barLayout([1, 2, 3], 100, 50).barWidth).toBeCloseTo(94 / 3)
  })

  it('compresses a dense series into the box instead of running off the end of it', () => {
    // The board keeps the LAST 48 samples of a series (`NEWS_BARS_MAX`), and a chart tile's plot
    // is about 142 px on a 360 dp phone. Floored at 2 px with a 3 px gap, 48 bars asked for 237 px
    // and the newest ones — the right-hand end, the ones being read — fell outside the `<Svg>`
    // and were simply not painted.
    const { barWidth, gap } = barLayout(new Array(48).fill(1), 142, 50)
    expect(48 * barWidth + 47 * gap).toBeLessThanOrEqual(142)
    expect(barWidth).toBeGreaterThan(0)
  })

  it('gives up the gap before it gives up the bar', () => {
    // 48 bars in 142 px still fit at a 1 px gap, so that is what it spends before thinning.
    expect(barLayout(new Array(48).fill(1), 142, 50).gap).toBe(1)
    // 60 in 100 px do not: the gap goes entirely and the bars share what is left.
    const dense = barLayout(new Array(60).fill(1), 100, 50)
    expect(dense.gap).toBe(0)
    expect(60 * dense.barWidth).toBeLessThanOrEqual(100)
  })

  it('keeps the full gap while the bars are still comfortable', () => {
    expect(barLayout([1, 2, 3], 100, 50).gap).toBe(3)
  })

  it('draws nothing for an empty series', () => {
    expect(barLayout([], 100, 50)).toEqual({ barWidth: 0, gap: 3, heights: [] })
  })
})
