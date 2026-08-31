import { describe, it, expect } from '@jest/globals'
import { sparkRows } from './spark'

describe('sparkRows', () => {
  it('returns [] for fewer than two points', () => {
    expect(sparkRows([], 24)).toEqual([])
    expect(sparkRows([500], 24)).toEqual([])
  })

  it('puts a flat series on the mid row — hi === lo', () => {
    // h - 1 = 9, integer-divided: floor(9 / 2) = 4
    expect(sparkRows([500, 500, 500], 10)).toEqual([4, 4, 4])
  })

  it('handles negative values, highest value on the lowest row number (the top)', () => {
    // lo=-10 hi=10 span=20 half=10, h=11 so h-1=10
    // row(-10) = 10 - floor((0*10+10)/20)  = 10 - 0  = 10
    // row(0)   = 10 - floor((10*10+10)/20) = 10 - 5  = 5
    // row(10)  = 10 - floor((20*10+10)/20) = 10 - 10 = 0
    expect(sparkRows([-10, 0, 10], 11)).toEqual([10, 5, 0])
  })

  it('scales two points to the box exactly, mirroring ui_chart_y', () => {
    // lo=100 hi=200 span=100 half=50, h=5 so h-1=4
    // row(100) = 4 - floor((0+50)/100)    = 4 - 0 = 4
    // row(200) = 4 - floor((400+50)/100)  = 4 - 4 = 0
    expect(sparkRows([100, 200], 5)).toEqual([4, 0])
  })

  it('never emits a float, whatever the input', () => {
    const rows = sparkRows([1, 7, 3, 3, 9, 2, 100000000007], 24)
    for (const r of rows) expect(Number.isInteger(r)).toBe(true)
  })

  it('is bounded to the box: every row is within [0, h-1]', () => {
    const h = 24
    const rows = sparkRows([-5, 0, 3, 3, 17, -5, 9], h)
    for (const r of rows) {
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(h - 1)
    }
  })

  it('gives every row 0 when the box has no height to divide', () => {
    expect(sparkRows([1, 2, 3], 1)).toEqual([0, 0, 0])
    expect(sparkRows([1, 2, 3], 0)).toEqual([0, 0, 0])
  })
})
