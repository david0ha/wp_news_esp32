// How the tape row divides its width — the pure half of `TapeTile`.
//
// THE ROW HAS THREE THINGS AND ONE OF THEM HAS TO YIELD. A symbol, a sparkline and a percentage
// want about 170 pt between them and have 145 in a tile on a 390 pt phone. It was the symbol that
// gave way, because it held the flex while the sparkline held a fixed 42: "NDX" rendered as "N…"
// and "UST10Y" as "U…", which is the one thing on the row a reader cannot infer from anything
// else — the arrow and the colour already say the direction, and the percentage says how far, but
// nothing says which index. So the order of yielding is inverted here. The symbol and the change
// are served first and the SPARKLINE takes what is left, down to a minimum below which it is not
// drawn at all.
//
// The symbol column is not a style width. It stays `flex: 1` in the StyleSheet and simply receives
// the residual, which this arithmetic guarantees is at least the six characters it needs; a fixed
// width would overflow the row on a phone too narrow for the sum rather than absorbing it.

import { space } from '../../../theme'
import { TILE_PADDING } from '../../../lib/edition/tiles'

/** The symbol's own size. `TapeTile`'s StyleSheet draws at this, so the estimate below is true. */
export const TAPE_SYMBOL_SIZE = 12

/** The longest symbol the tape carries: UST10Y. SPX, NDX, SOX and VIX are shorter. */
export const TAPE_SYMBOL_CHARS = 6

/**
 * An uppercase character's advance at that size, as a fraction of it.
 *
 * Symbols are uppercase letters and digits, which run wider than Inter's mixed-case average —
 * about 0.67 em rather than the 0.55 a sentence measures at.
 */
export const TAPE_SYMBOL_EM = 0.67

/** What six characters of symbol need. Roughly 8 pt each, so a little under 50. */
export const TAPE_SYMBOL_W = Math.ceil(TAPE_SYMBOL_CHARS * TAPE_SYMBOL_SIZE * TAPE_SYMBOL_EM)

/** The change column, unchanged: "▲ 12.34%" at 12 px semibold. */
export const TAPE_CHANGE_W = 62

/**
 * The gap between two things in a row.
 *
 * `space.xs` and not the `space.sm` this row used to carry: at 8 pt the two gaps cost 16 of the
 * 145, which was the difference between a sparkline the reader can see a slope in and none at all.
 */
export const TAPE_GAP = space.xs

/**
 * The narrowest column at which the symbol actually gets `TAPE_SYMBOL_W` — 143, derived and not
 * chosen: the reservation, the change column, the one gap between them and the tile's padding.
 *
 * BELOW IT THE RESERVATION IS NOT MET, and this constant exists to say so rather than to let the
 * shortfall pass unnamed. With no sparkline the symbol's residual is `colWidth - 94`, so at the
 * 138 px column a 320 pt phone produces it is 44 against the 49 six characters want — five points
 * short, enough for "UST10Y" alone among the fixture's symbols to ellipsize. Nothing here can buy
 * those five back: the change column is fixed at the width its own text needs, and dropping the
 * last gap recovers four. The honest options were to shrink the change column or to say this out
 * loud, and the second is the one that does not trade a truncated percentage for a whole symbol.
 * `tape.test.ts` holds both halves — the reservation above this width, and the bound below it.
 */
export const TAPE_SYMBOL_FULL_COL =
  TAPE_SYMBOL_W + TAPE_CHANGE_W + TAPE_GAP + 2 * TILE_PADDING

/** Below this a polyline is a smudge that still costs the symbol its width, so it is dropped. */
export const TAPE_SPARK_MIN = 24

/** The width it had before any of this, and still the most it may take. */
export const TAPE_SPARK_MAX = 42

/**
 * What the sparkline may draw in, given the tile's OUTER width — `0` for "do not draw one".
 *
 * Zero and not a small number is the point: a sparkline is the row's fourth statement and the
 * least load-bearing of them, so on a column too narrow for all four it goes rather than shrinking
 * until it says nothing while still taking room from the symbol.
 */
export function tapeSparkWidth(tileWidth: number): number {
  const content = tileWidth - 2 * TILE_PADDING
  // Two gaps when the sparkline is drawn, which is the case this is deciding.
  const room = content - TAPE_SYMBOL_W - TAPE_CHANGE_W - 2 * TAPE_GAP
  if (room < TAPE_SPARK_MIN) return 0
  return Math.min(room, TAPE_SPARK_MAX)
}
