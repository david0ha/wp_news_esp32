// The three measurements the edition's two surfaces have to agree about.
//
// There are two screens drawing the SAME masonry — the Today tab and the tile detail's "More
// from this edition" — and every tile's height is derived from the column width
// (`estimateTileHeight`), not measured. So a column width computed twice is not a two-pixel
// margin difference: it is a different page, with different heights and a different
// shortest-column-first placement, and a reader who taps a tile and comes back finds the feed
// reshuffled under them. One function, imported twice.
//
// Nothing here imports the theme. The gutter arrives as an argument for the same reason
// `components/edition/tone.ts` lives under `components/` — `lib/edition` is the portable half
// and holds no design tokens — and it keeps these testable without a React Native transform.

import { type EditionPhoto } from './types'
import { type Chip } from './tiles'

/**
 * The space between the two columns, from the spec's token table. Distinct from the outer
 * margin (`layout.gutter`, 16), which is the page's edge and not a gap between things.
 */
export const COLUMN_GAP = 12

/**
 * One masonry column, in pixels: the window less both outer margins and the gaps between the
 * columns, divided by the columns.
 *
 * Floored, because a fractional width would land the two columns on different subpixel
 * boundaries and put a hairline of canvas down one edge of every tile in one of them. Clamped
 * to at least 1 so a mid-rotation window of 0 cannot hand `estimateTileHeight` a zero and
 * collapse the page.
 */
export function columnWidth(
  windowWidth: number,
  gutter: number,
  gap: number = COLUMN_GAP,
  columns = 2,
): number {
  const n = Math.max(1, Math.trunc(columns))
  const usable = windowWidth - 2 * gutter - gap * (n - 1)
  return Math.max(1, Math.floor(usable / n))
}

/**
 * Which chip is actually showing, given the chips this edition has behind it.
 *
 * New content re-lays out the feed, and the chip the reader left selected may now have nothing
 * behind it — an edition with no photographs after one that had three. A filter showing an empty
 * page with no way to tell why is the worst of the three possible answers; falling back to `all`
 * is the only one that shows content. The reader's choice is kept in the screen's own state, so
 * a chip that comes back keeps its selection rather than being reset for good.
 */
export function resolveChip(chips: Chip[], selected: Chip): Chip {
  return chips.includes(selected) ? selected : 'all'
}

/** A photograph is allowed to be this much taller than it is wide, and no more. */
const PHOTO_MAX_ASPECT = 3 / 2

/**
 * The box for a photograph shown at a given width — the band above the grid, and the picture on
 * the detail page.
 *
 * The photo's own aspect, clamped at the TALL end only. `PhotoTile` covers its box, so a clamp
 * crops rather than distorts, and that is worth paying at the tall end: without it a 1:10 portrait
 * would be a ten-screen tower nothing could scroll past.
 *
 * THERE IS NO CLAMP AT THE WIDE END, and there must not be. The producer cuts the lead photograph
 * at 1140 x 320 — 3.5625:1 — so a floor of, say, 3:1 would take about 8% off each side of the one
 * picture that ships every single edition, silently, because the box would be taller than the
 * photograph and `cover` would eat the difference. A wide picture is meant to be wide: that is
 * exactly why `editionToTiles` promotes it out of the column and across the page.
 *
 * `w` of 0 falls back to a square, which is the case that actually needs a guard — it would
 * otherwise be a division by zero.
 */
export function photoBoxHeight(photo: EditionPhoto, width: number): number {
  const aspect = photo.w > 0 ? photo.h / photo.w : 1
  return Math.max(1, Math.round(width * Math.min(PHOTO_MAX_ASPECT, aspect)))
}
