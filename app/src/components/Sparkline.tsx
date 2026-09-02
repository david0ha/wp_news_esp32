import { View } from 'react-native'
import Svg, { Polyline } from 'react-native-svg'

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
  // NaN (and any other non-finite) points are dropped before scaling.
  const values = data.filter((n) => Number.isFinite(n))
  if (values.length < 2) return <View style={{ width, height }} />

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min

  // x: index mapped linearly to [1, width-1]; y: value mapped to [height-2, 2] over
  // [min, max]. A flat series (span 0) draws the horizontal midline.
  const points = values
    .map((v, i) => {
      const x = 1 + (i * (width - 2)) / (values.length - 1)
      const y = span === 0 ? height / 2 : height - 2 - ((v - min) * (height - 4)) / span
      return `${x},${y}`
    })
    .join(' ')

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
