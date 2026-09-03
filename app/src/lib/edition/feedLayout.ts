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

/** A detail-page photograph is allowed to be this much taller than it is wide, and no more. */
const PHOTO_MAX_ASPECT = 3 / 2
/** ...and this much wider. A lead photo runs to 3.56:1 and is meant to. */
const PHOTO_MIN_ASPECT = 1 / 3

/**
 * The box for a photograph shown at a given width — the band above the grid, and the picture on
 * the detail page.
 *
 * The photo's own aspect, clamped at both ends. `PhotoTile` covers its box, so the clamp crops
 * rather than distorts: without it a 1:10 portrait would be a ten-screen tower nothing could
 * scroll past, and a 12:1 strip would be a 30 px smear with a caption under it. The band's own
 * rule (`editionToTiles`) only admits photos wider than 2:1, so in practice this clamp bites on
 * the tall end and on a `w` of 0, which would otherwise be a division by zero.
 */
export function photoBoxHeight(photo: EditionPhoto, width: number): number {
  const aspect = photo.w > 0 ? photo.h / photo.w : 1
  const clamped = Math.min(PHOTO_MAX_ASPECT, Math.max(PHOTO_MIN_ASPECT, aspect))
  return Math.max(1, Math.round(width * clamped))
}
