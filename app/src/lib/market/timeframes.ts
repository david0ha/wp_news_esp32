// Timeframe → Yahoo {range, interval} table (spec §4.4). This is the canonical Timeframe type —
// TimeframePills declares a textually identical union locally, but this one is the contract.

import { type ChartData } from './types'

export type Timeframe = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL'

export const TIMEFRAMES: readonly Timeframe[] = ['1D', '1W', '1M', '3M', '1Y', 'ALL']

export const TIMEFRAME_PARAMS: Record<Timeframe, { range: string; interval: string }> = {
  '1D': { range: '1d', interval: '5m' },
  '1W': { range: '5d', interval: '30m' },
  '1M': { range: '1mo', interval: '1d' },
  '3M': { range: '3mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1wk' },
  ALL: { range: 'max', interval: '1mo' },
}

/** Chart line color baseline: prevClose on 1D (the Robinhood rule), first close otherwise. */
export function baselineFor(tf: Timeframe, chart: ChartData): number | null {
  if (tf === '1D') return chart.prevClose
  return chart.points[0]?.close ?? null
}
