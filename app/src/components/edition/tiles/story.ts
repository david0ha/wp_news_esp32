// How many lines each part of a story tile gets — the pure half of `StoryTile`.
//
// This is the app's `ui_fit_text()`: the firmware copyfits a body to the box the compositor gave
// it, and for the same reason. The tile's height was decided by `estimateTileHeight` before
// anything rendered and the content has to adapt to it, so the question "how many lines" has one
// right answer per tile and it is arithmetic, not a constant.
//
// A FIXED `numberOfLines` is the bug this replaces. At a 170 px column the lead tile is 255, its
// content box 227, and the kicker, five lines of headline, two of deck and three gaps take 173 of
// it — leaving 54 px, which is exactly three 18 px lines. A clamp of 6 asks for 108, so Yoga hands
// the `flex: 1` body the 54 px it has left and line 4 falls entirely outside the box, clipped away
// by the tile's `overflow: 'hidden'` — while the ellipsis that would have signalled the truncation
// sits at line 6 where nobody sees it. A shorter headline does not rescue it; it drops a later line
// instead.
//
// It runs the other way at a narrow column: at 125 the lead's fixed furniture alone — kicker,
// five lines of headline, two of deck, and the two gaps between those three children — wants
// 169 px of a 160 px box, so the deck is
// what gets sliced and there was never any body to blame. That is why this returns a count for
// EVERY part rather than for the body alone.
//
// Deriving them makes the tile self-correcting: the estimator's lead aspect has already been tuned
// once — from `colWidth * 4 / 3` to `* 3 / 2`, when a render showed the headline ellipsized and one
// line of body under it — and this followed without being touched.

import { type } from '../../../theme'
import { TILE_PADDING } from '../../../lib/edition/tiles'
import { lineHeightOf } from '../metrics'

/** The gap `StoryTile`'s root puts between each pair of children. Shared with its StyleSheet. */
export const STORY_GAP = 4

/**
 * THE HEADLINE FACE, and there is only one of it — `type.pinHeadline`'s extrabold cut, a size
 * down, for the lead and the secondaries alike.
 *
 * The lead used to draw at `type.pinHeadline`'s own 22/26, and that made it the ONE story on the
 * page whose headline ellipsized: a 57-character lead headline needs five lines at 22 px in a
 * 145 pt column against a cap of four, while a secondary's three lines of 17/21 held its shorter
 * headline whole. A lead that loses the end of its sentence is not a louder lead. What makes it
 * the lead is its height and its position at the head of the feed, so the face came down and the
 * tile grew instead.
 */
export const HEADLINE_SIZE = 17
export const HEADLINE_LINE = 21

/** Read off the tokens the corresponding `<Text>` draws with, never restated as literals. */
export const KICKER_LINE = lineHeightOf(type.caption)
export const DECK_LINE = lineHeightOf(type.pinDeck)
export const BODY_LINE = lineHeightOf(type.caption)

/** The lead gets five lines of headline, a secondary three. */
export const HEADLINE_LEAD_LINES = 5
export const HEADLINE_SECONDARY_LINES = 3

/** The deck is clamped at two lines on both. */
export const DECK_LINES = 2

export interface StoryFit {
  lead: boolean
  hasKicker: boolean
  hasDeck: boolean
}

export interface StoryLines {
  /** 1 when the kicker is drawn, 0 when even that did not fit. */
  kicker: number
  /** Always at least 1 — see below. */
  headline: number
  deck: number
  body: number
}

/**
 * How many lines each part of a story tile may draw, given the tile's OUTER height.
 *
 * The parts are filled in EDITORIAL ORDER and each takes only what is left: kicker, then headline,
 * then deck, then body. That order is the priority order — a story tile without its headline is
 * not a story tile, a deck without a headline says nothing, and body copy is the part a reader
 * loses least by. At a 140 px column the lead's four-line headline, kicker and two-line deck want
 * 168 px of a 159 px box, so something has to give; this decides what, instead of letting Yoga
 * slice whichever line happened to be last.
 *
 * The headline is the one part allowed to overflow, clamped at a minimum of one line rather than
 * at zero. Everything else answers 0 when nothing fits and is simply not drawn — a single
 * horizontally sliced line of deck is worse than no deck.
 *
 * Gaps are charged as each part is placed, so a part that answers 0 costs neither its height nor
 * its gap.
 */
export function storyLines(height: number, fit: StoryFit): StoryLines {
  const content = height - 2 * TILE_PADDING
  // One face, two caps. The lead and the secondaries draw the same 17/21 headline; what the lead
  // gets is more of it, in a tile the estimator made half again as tall as it is wide.
  const headlineMax = fit.lead ? HEADLINE_LEAD_LINES : HEADLINE_SECONDARY_LINES

  let used = 0
  let children = 0
  /** What is left for one more child, with the gap it would cost already taken out. */
  const room = (): number => content - used - (children > 0 ? STORY_GAP : 0)
  const place = (h: number): void => {
    used += h + (children > 0 ? STORY_GAP : 0)
    children += 1
  }

  const kicker = fit.hasKicker && room() >= KICKER_LINE ? 1 : 0
  if (kicker > 0) place(KICKER_LINE)

  const headline = Math.max(1, Math.min(headlineMax, Math.floor(room() / HEADLINE_LINE)))
  place(headline * HEADLINE_LINE)

  const deck = fit.hasDeck ? Math.max(0, Math.min(DECK_LINES, Math.floor(room() / DECK_LINE))) : 0
  if (deck > 0) place(deck * DECK_LINE)

  const body = Math.max(0, Math.floor(room() / BODY_LINE))
  return { kicker, headline, deck, body }
}
