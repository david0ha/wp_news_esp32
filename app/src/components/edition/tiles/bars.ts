// The bar chart's geometry, as a pure function.
//
// It lives beside `ChartTile` rather than inside it because it owns the two decisions on that
// tile that can be wrong in a way a reader would believe. The first is the scale: a bar chart
// measured from its own smallest value makes a 5% move look like a doubling, which is the single
// thing a bar is supposed not to do. The second is the fit: the layout must never be wider than
// the box it was given, because the caller draws into a fixed `<Svg>` and anything past its right
// edge is not clipped-and-obvious, it is INVISIBLE — and the right-hand end of a price series is
// the newest data, the part being read. Both are worth a test, and a test cannot reach into a
// component.

export interface BarLayout {
  /** Every bar is the same width; the caller draws each `heights[i]` tall. */
  barWidth: number
  /** The gap the layout actually spent, which the caller must use to place bar `i`. */
  gap: number
  /** One pixel height per drawable bar, in input order after non-finite values are dropped. */
  heights: number[]
}

/** Below this a bar reads as a hairline, so the gap is spent before the bar is thinned. */
const COMFORTABLE_BAR = 2
/** A bar thinner than this is not a bar, so the gap goes entirely rather than the bar. */
const MIN_BAR = 1

/**
 * `values` scaled to a `width` x `height` box, FROM ZERO.
 *
 * Non-finite entries are dropped before anything is measured, the same way `Sparkline` drops
 * them — a NaN in the series must not decide the scale of the bars beside it. The maximum is
 * taken against zero, so an all-negative or all-zero series flattens to the 1 px floor instead
 * of inverting. Every bar keeps at least one pixel of HEIGHT: a bar that rounds to nothing reads
 * as missing data rather than as a small number.
 *
 * THE WIDTH COMPRESSES, IT DOES NOT OVERFLOW. `n * barWidth + (n - 1) * gap <= width` always
 * holds, and the compression spends the cheapest thing first: the full gap while the bars are
 * still comfortable, then a 1 px gap, then no gap at all with the bars sharing whatever is left.
 * The board keeps the last `NEWS_BARS_MAX` = 48 samples of a series and a tile's plot is about
 * 142 px wide, so this is the ordinary case and not the pathological one — floored at 2 px with a
 * 3 px gap those 48 bars asked for 237 px, and the two dozen past the right edge of the `<Svg>`
 * were not drawn at all.
 */
export function barLayout(values: number[], width: number, height: number, gap = 3): BarLayout {
  const usable = values.filter((v) => Number.isFinite(v))
  if (usable.length === 0) return { barWidth: 0, gap, heights: [] }

  const n = usable.length
  const fit = (g: number) => (width - g * (n - 1)) / n
  let spent = gap
  if (fit(spent) < COMFORTABLE_BAR) spent = Math.min(gap, 1)
  if (fit(spent) < MIN_BAR) spent = 0
  const barWidth = Math.max(0, fit(spent))

  const max = Math.max(...usable, 0)
  const heights = usable.map((v) => (max > 0 ? Math.max(1, Math.round((v / max) * height)) : 1))
  return { barWidth, gap: spent, heights }
}
