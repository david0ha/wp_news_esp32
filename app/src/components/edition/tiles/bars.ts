// The bar chart's geometry, as a pure function.
//
// It lives beside `ChartTile` rather than inside it because it is the one decision on that tile
// that can be wrong in a way a reader would believe: a bar chart scaled from its own smallest
// value makes a 5% move look like a doubling, which is the single thing a bar is supposed not to
// do. That is worth a test, and a test cannot reach into a component.

export interface BarLayout {
  /** Every bar is the same width; the caller draws each `heights[i]` tall. */
  barWidth: number
  /** One pixel height per drawable bar, in input order after non-finite values are dropped. */
  heights: number[]
}

/**
 * `values` scaled to a `height` box, FROM ZERO.
 *
 * Non-finite entries are dropped before anything is measured, the same way `Sparkline` drops
 * them — a NaN in the series must not decide the scale of the bars beside it. The maximum is
 * taken against zero, so an all-negative or all-zero series flattens to the 1 px floor instead
 * of inverting. Every bar keeps at least one pixel: a bar that rounds to nothing reads as
 * missing data rather than as a small number.
 */
export function barLayout(values: number[], width: number, height: number, gap = 3): BarLayout {
  const usable = values.filter((v) => Number.isFinite(v))
  if (usable.length === 0) return { barWidth: 0, heights: [] }
  const max = Math.max(...usable, 0)
  const barWidth = Math.max(2, (width - gap * (usable.length - 1)) / usable.length)
  const heights = usable.map((v) =>
    max > 0 ? Math.max(1, Math.round((v / max) * height)) : 1,
  )
  return { barWidth, heights }
}
