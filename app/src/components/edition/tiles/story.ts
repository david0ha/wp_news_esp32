// How many lines each part of a story tile gets — the pure half of `StoryTile`.
//
// This is the app's `ui_fit_text()`: the firmware copyfits a body to the box the compositor gave
// it, and for the same reason. The tile's height was decided by `estimateTileHeight` before
// anything rendered and the content has to adapt to it, so the question "how many lines" has one
// right answer per tile and it is arithmetic, not a constant.
//
// A FIXED `numberOfLines` is the bug this replaces. At a 170 px column the lead tile is 227, its
// content box 199, and the kicker, four lines of headline, two of deck and three gaps take 172 of
// it — leaving 27 px, which is one line. A clamp of 6 asks for 108, so Yoga hands the `flex: 1`
// body the 27 px it has left, line 2 is sliced in half by the tile's `overflow: 'hidden'`, and the
// ellipsis that would have signalled the truncation sits at line 6 where nobody sees it. A shorter
// headline does not rescue it; it slices a later line instead.
//
// It runs the other way at a narrow column: at 140 the lead's fixed furniture alone — kicker,
// four lines of headline, two of deck, the gaps — wants 168 px of a 159 px box, so the deck is
// what gets sliced and there was never any body to blame. That is why this returns a count for
// EVERY part rather than for the body alone.
//
// Deriving them makes the tile self-correcting: the estimator's `colWidth * 4 / 3` is likely to be
// tuned again, and this follows it without anybody remembering to.

import { type } from '../../../theme'
import { TILE_PADDING } from '../../../lib/edition/tiles'
import { lineHeightOf } from '../metrics'

/** The gap `StoryTile`'s root puts between each pair of children. Shared with its StyleSheet. */
export const STORY_GAP = 4

/** The secondary headline's own metrics — `type.pinHeadline` a size down. */
export const HEADLINE_SM_SIZE = 17
export const HEADLINE_SM_LINE = 21

/** Read off the tokens the corresponding `<Text>` draws with, never restated as literals. */
export const KICKER_LINE = lineHeightOf(type.caption)
export const DECK_LINE = lineHeightOf(type.pinDeck)
export const BODY_LINE = lineHeightOf(type.caption)
export const HEADLINE_LEAD_LINE = lineHeightOf(type.pinHeadline)

/** The lead gets four lines of headline, a secondary three. */
export const HEADLINE_LEAD_LINES = 4
export const HEADLINE_SM_LINES = 3

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
  const headlineLine = fit.lead ? HEADLINE_LEAD_LINE : HEADLINE_SM_LINE
  const headlineMax = fit.lead ? HEADLINE_LEAD_LINES : HEADLINE_SM_LINES

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

  const headline = Math.max(1, Math.min(headlineMax, Math.floor(room() / headlineLine)))
  place(headline * headlineLine)

  const deck = fit.hasDeck ? Math.max(0, Math.min(DECK_LINES, Math.floor(room() / DECK_LINE))) : 0
  if (deck > 0) place(deck * DECK_LINE)

  const body = Math.max(0, Math.floor(room() / BODY_LINE))
  return { kicker, headline, deck, body }
}
