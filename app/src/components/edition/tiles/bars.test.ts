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

  it('keeps a minimum bar width when the series is too dense for the box', () => {
    expect(barLayout(new Array(60).fill(1), 100, 50).barWidth).toBe(2)
  })

  it('draws nothing for an empty series', () => {
    expect(barLayout([], 100, 50)).toEqual({ barWidth: 0, heights: [] })
  })
})
