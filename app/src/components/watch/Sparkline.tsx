import Svg, { Polyline } from 'react-native-svg'
import { sparkRows } from '../../lib/spark'
import { colors } from '../../theme/index'

/**
 * One watchlist item's own price history, drawn small — `sparkRows()` (src/lib/spark.ts) is the
 * app-side twin of the device's `ui_chart_y()`, so the row a bar lands on here never disagrees
 * with the one the board would put it on. One ink stroke, no axis, no fill: the hard-pixel rule in
 * CLAUDE.md is the e-paper panel's own reason and does not reach a phone screen — SVG antialiasing
 * is fine here — but the same plainness still reads as this app's own hand.
 *
 * Fewer than two points draws nothing, `sparkRows()`'s own rule: a single bar has no line to draw,
 * and a dot invented from one value would be a claim the data doesn't make.
 */
export function Sparkline({
  values,
  width = 120,
  height = 32,
  stroke = colors.ink,
  strokeWidth = 1.5,
}: {
  values: readonly number[]
  width?: number
  height?: number
  stroke?: string
  strokeWidth?: number
}) {
  const rows = sparkRows(values, height)
  if (rows.length < 2) return null

  const stepX = width / (rows.length - 1)
  const points = rows.map((row, i) => `${i * stepX},${row}`).join(' ')

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
