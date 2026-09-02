import { describe, it, expect } from '@jest/globals'
import { TIMEFRAMES, TIMEFRAME_PARAMS, baselineFor } from './timeframes'
import { type ChartData } from './types'

describe('the timeframe table', () => {
  it('lists the six timeframes in display order', () => {
    expect(TIMEFRAMES).toEqual(['1D', '1W', '1M', '3M', '1Y', 'ALL'])
  })

  it('is exactly the §4.4 table', () => {
    expect(TIMEFRAME_PARAMS).toEqual({
      '1D': { range: '1d', interval: '5m' },
      '1W': { range: '5d', interval: '30m' },
      '1M': { range: '1mo', interval: '1d' },
      '3M': { range: '3mo', interval: '1d' },
      '1Y': { range: '1y', interval: '1wk' },
      ALL: { range: 'max', interval: '1mo' },
    })
  })
})

function chart(points: Array<{ t: number; close: number }>, prevClose: number | null): ChartData {
  return { symbol: 'TEST', points, prevClose, currency: 'USD' }
}

describe('baselineFor', () => {
  it('1D uses the chart prevClose (the Robinhood rule)', () => {
    expect(baselineFor('1D', chart([{ t: 1, close: 10 }], 9.5))).toBe(9.5)
  })

  it('1D passes a null prevClose through', () => {
    expect(baselineFor('1D', chart([{ t: 1, close: 10 }], null))).toBeNull()
  })

  it('other timeframes use the first close', () => {
    const c = chart(
      [
        { t: 1, close: 11 },
        { t: 2, close: 12 },
      ],
      9.5,
    )
    expect(baselineFor('1M', c)).toBe(11)
    expect(baselineFor('ALL', c)).toBe(11)
  })

  it('other timeframes with no points → null', () => {
    expect(baselineFor('1Y', chart([], 9.5))).toBeNull()
  })
})
