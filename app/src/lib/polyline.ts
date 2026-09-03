// One series of closes -> one SVG `points` string.
//
// Two components draw exactly this line: `components/Sparkline.tsx` (the watchlist row, the tape)
// and `ChartFigure`'s line mode (the edition's chart tile and its detail page). They had the same
// eight lines of arithmetic written twice, which is two places for a plot to acquire a different
// inset — and the two are drawn side by side on the detail page, where a one-pixel disagreement
// between an index's sparkline and the company's chart is visible.

/**
 * `values` mapped across a `width` x `height` box, as `"x,y x,y …"`.
 *
 * Non-finite entries are dropped before anything is measured — a NaN must not decide the scale of
 * the points beside it. FEWER THAN TWO DRAWABLE POINTS RETURNS THE EMPTY STRING: a single point is
 * not a line, and the caller draws its empty state at the same size so the slot never collapses.
 *
 * x runs across `[1, width - 1]` and y across `[height - 2, 2]`, so a 2 px stroke has room for its
 * own width at the extremes instead of being clipped in half by the viewport. A flat series
 * (span 0) draws the horizontal midline.
 */
export function polylinePoints(values: number[], width: number, height: number): string {
  const usable = values.filter((v) => Number.isFinite(v))
  if (usable.length < 2) return ''
  const min = Math.min(...usable)
  const max = Math.max(...usable)
  const span = max - min
  return usable
    .map((v, i) => {
      const x = 1 + (i * (width - 2)) / (usable.length - 1)
      const y = span === 0 ? height / 2 : height - 2 - ((v - min) * (height - 4)) / span
      return `${x},${y}`
    })
    .join(' ')
}
