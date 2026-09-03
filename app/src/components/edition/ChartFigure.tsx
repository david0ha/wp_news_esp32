import Svg, { Polyline, Rect } from 'react-native-svg'
import { colors } from '../../theme'
import { changeTone } from '../../lib/edition/format'
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

/** The gap between two bars, in pixels. `barLayout` takes it out of the width. */
const BAR_GAP = 3

/**
 * Bars as SVG rects, drawn from the baseline up. The scaling is `barLayout`, which is pure and
 * tested — see `tiles/bars.ts` for why scaling a bar chart from zero rather than from its own
 * minimum is the decision worth a test.
 */
function Bars({ values, width, height }: { values: number[]; width: number; height: number }) {
  const { barWidth, heights } = barLayout(values, width, height, BAR_GAP)
  return (
    <>
      {heights.map((barHeight, i) => (
        <Rect
          key={i}
          x={i * (barWidth + BAR_GAP)}
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
 * The same polyline `Sparkline` draws, inlined so both kinds share one `<Svg>` and one box. Fewer
 * than two drawable points draws nothing and keeps the space, so the plot never collapses and the
 * tile below it never moves up.
 */
function Line({ values, width, height }: { values: number[]; width: number; height: number }) {
  const usable = values.filter((v) => Number.isFinite(v))
  if (usable.length < 2) return null

  const first = usable[0]
  const last = usable[usable.length - 1]
  const stroke = toneGraphicsColor(changeTone(last - first))

  const min = Math.min(...usable)
  const max = Math.max(...usable)
  const span = max - min
  // x across [1, width-1] and y across [height-2, 2], so a 2 px stroke has room for its own
  // width at the extremes instead of being clipped in half by the viewport.
  const points = usable
    .map((v, i) => {
      const x = 1 + (i * (width - 2)) / (usable.length - 1)
      const y = span === 0 ? height / 2 : height - 2 - ((v - min) * (height - 4)) / span
      return `${x},${y}`
    })
    .join(' ')

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
