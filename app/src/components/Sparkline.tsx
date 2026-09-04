import { View } from 'react-native'
import Svg, { Polyline } from 'react-native-svg'
import { polylinePoints } from '../lib/polyline'

/**
 * The tiny watchlist-row chart — a single polyline, no fill, no axes. The caller picks the
 * stroke (TickerRow passes upBright/downBright/textDim by delta sign — graphics duty, so the
 * Bright pair). Fewer than two drawable points renders empty space at the same size, so the
 * slot never collapses.
 */
export function Sparkline({
  data,
  width = 64,
  height = 28,
  stroke,
  strokeWidth = 1.5,
}: {
  /** Closes; length >= 2 (after dropping NaN) to draw, else renders empty space. */
  data: number[]
  width?: number
  height?: number
  /** Required color — the caller owns the direction decision. */
  stroke: string
  strokeWidth?: number
}) {
  // The scaling is `lib/polyline.ts`, shared with the edition's line charts: it drops the
  // non-finite points, insets for the stroke, and answers '' when fewer than two survive.
  const points = polylinePoints(data, width, height)
  if (points === '') return <View style={{ width, height }} />

  return (
    <Svg width={width} height={height}>
      <Polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  )
}
