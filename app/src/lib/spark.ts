// Pure integer scaling for the app's own sparklines — the same arithmetic as the board's
// `components/news_core/ui_chart.c`'s `ui_chart_y()`, mirrored rather than approximated for the
// reason CLAUDE.md gives for keeping the device's own chart scaling integer and libm-free: a
// float rounds differently depending on who is asked, and a sparkline on the phone describing the
// same series as a chart on the sheet must not disagree with it over a fraction of a pixel.
//
// Unlike `ui_chart_window()`, there is no headroom margin here — `lo`/`hi` are the series' own
// min and max, because a watchlist sparkline has no fixed window to sit inside the way a chart
// with a drawn axis does.

/**
 * One row (0 = top, `h - 1` = bottom) per value, scaled to a box `h` px tall.
 *
 * Fewer than two points is `[]` — a single point has no line to draw. A flat series (`hi === lo`)
 * puts every point on the middle row rather than dividing by zero, the same choice
 * `ui_chart_y()` makes when a window has no span. Every step is integer division, rounded rather
 * than truncated so a value exactly halfway between two rows does not always fall the same way —
 * `ui_chart_y()`'s own comment.
 */
export function sparkRows(values: readonly number[], h: number): number[] {
  if (values.length < 2) return []

  let lo = values[0]
  let hi = values[0]
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }

  if (h <= 1) return values.map(() => 0)

  const span = hi - lo
  if (span <= 0) {
    const mid = Math.floor((h - 1) / 2)
    return values.map(() => mid)
  }

  const half = Math.floor(span / 2)
  return values.map((v) => {
    const d = v - lo
    const row = Math.floor((d * (h - 1) + half) / span)
    return h - 1 - row
  })
}
