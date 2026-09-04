import Svg, { Polyline, Rect } from 'react-native-svg'
import { colors } from '../../theme'
import { changeTone } from '../../lib/edition/format'
import { polylinePoints } from '../../lib/polyline'
import { type EditionChart } from '../../lib/edition/types'
import { toneGraphicsColor } from './tone'
import { barLayout } from './tiles/bars'

/**
 * ONE drawing of a chart, at whatever size it is given.
 *
 * The tile and the detail page both mount this, which is the point: a bar chart tapped from the
 * feed has to open as the same bar chart, and a `kind` switch written twice is exactly how it
 * would open as a line instead. Nothing here knows which surface it is on — the caller owns the
 * box, this owns what goes in it.
 *
 * The stroke colour comes from the SERIES' OWN DIRECTION — its last close against its first — and
 * takes the graphics pair (`upBright`/`downBright`), never the text pair. That is the only colour
 * a line chart carries; its axis, its label and its span are ink.
 *
 * A `candle` renders as its closes, because four series in a 128 px box is a smudge and the
 * detail page shows the same line larger. A `bar` chart is bars, in `colors.navy`: one series is
 * ink-or-a-filled-control, so there is no series identity to encode and nothing to look up in the
 * app's equivalent of `ui_series_t` — that question only arises with two series in one graphic,
 * which the phone does not draw in v1.
 */
export function ChartFigure({
  chart,
  width,
  height,
}: {
  chart: EditionChart
  width: number
  height: number
}) {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  return (
    <Svg width={w} height={h}>
      {chart.kind === 'bar' ? (
        <Bars values={chart.close} width={w} height={h} />
      ) : (
        <Line values={chart.close} width={w} height={h} />
      )}
    </Svg>
  )
}

/**
 * Bars as SVG rects, drawn from the baseline up. The scaling AND the fit are `barLayout`, which
 * is pure and tested — see `tiles/bars.ts` for why a bar chart is measured from zero, and why the
 * gap it hands back has to be the one used to place the bars: a dense series is fitted by
 * spending the gap, so a caller that placed on its own preferred 3 px would push the newest bars
 * straight back out of the `<Svg>` this was written to keep them inside.
 */
function Bars({ values, width, height }: { values: number[]; width: number; height: number }) {
  const { barWidth, gap, heights } = barLayout(values, width, height)
  return (
    <>
      {heights.map((barHeight, i) => (
        <Rect
          key={i}
          x={i * (barWidth + gap)}
          y={height - barHeight}
          width={barWidth}
          height={barHeight}
          rx={2}
          fill={colors.navy}
        />
      ))}
    </>
  )
}

/**
 * The same polyline `Sparkline` draws — the arithmetic is `lib/polyline.ts`, shared with it, so a
 * chart and the sparkline beside it cannot end up with different insets. This owns only the
 * `<Svg>`-less markup, because a `bar` and a `line` share one box on this component.
 *
 * Fewer than two drawable points draws nothing and keeps the space, so the plot never collapses
 * and the tile below it never moves up.
 */
function Line({ values, width, height }: { values: number[]; width: number; height: number }) {
  const points = polylinePoints(values, width, height)
  if (points === '') return null

  // The stroke is the SERIES' OWN DIRECTION — its last close against its first — read off the
  // same non-finite filter the points were plotted through, so the colour describes the line that
  // was actually drawn.
  const usable = values.filter((v) => Number.isFinite(v))
  const stroke = toneGraphicsColor(changeTone(usable[usable.length - 1] - usable[0]))

  return (
    <Polyline
      points={points}
      fill="none"
      stroke={stroke}
      strokeWidth={2}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  )
}
