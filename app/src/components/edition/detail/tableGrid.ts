// How wide the statement grid's fixed label column is — the pure half of `TileDetail`'s table.
//
// The grid on the detail page is the one thing on it that cannot flex: six quarters beside each
// other ARE the argument a statement makes, so the value columns keep their width and scroll
// sideways rather than shrinking. That leaves one number to decide — how much of the card the row
// labels take before the scroll starts — and it has to be decided in advance, because the label
// column sits OUTSIDE the `ScrollView` and its rows have to line up with the rows inside it.
//
// Nothing measures text here. React Native cannot answer "how wide is this string" without
// rendering it and reporting back through `onLayout`, which would mean a first frame at the wrong
// width and a visible jump — the same reason the masonry's tiles are estimated rather than
// measured. So this estimates from the character count, and the two bounds are what make an
// estimate safe: a floor so a one-word label still reads as a column, and a cap so a long one
// cannot eat the figures it exists to be read against.

import { type } from '../../../theme'
import { fontSizeOf } from '../metrics'
import { isCjkScript } from '../typeRamp'

/**
 * The average advance of a `type.caption` character, as a fraction of the font size.
 *
 * Inter's mixed-case average sits near 0.55 em and its digits at 0.6; 0.62 buys a little room on
 * top, because the failure this guards against is asymmetric — a label estimated slightly wide
 * costs a few points of scroll, and one estimated narrow ellipsizes the row's name.
 */
export const DETAIL_LABEL_EM = 0.62

/**
 * The same average for Hangul, which has none: a syllable block is a full em, every one of them.
 *
 * That is the whole of the language's effect on this file. A Korean statement label is written in
 * about half the characters of its English name and each is nearly twice as wide, so the two land
 * near the same width — but the ARITHMETIC has to be told, or "판매비와관리비" is estimated at 57
 * points, given the 72 pt floor, and ellipsized at 91.
 */
export const DETAIL_LABEL_EM_HANGUL = 1.0

/**
 * Which of the two an edition's labels are measured with.
 *
 * Keyed off the edition's language and not the app's: the labels being measured are the
 * producer's, and they are in the language the edition was written in whatever the phone is set
 * to. Anything outside a CJK script is Latin here — Inter's own average is the right guess for a
 * language nobody has filed an edition in yet.
 *
 * The list of CJK scripts is `typeRamp.tsx`'s and not a `=== 'ko'` of this file's own: the same
 * fact decides which face the page is set in and how wide a character of it is, so the two have
 * to move together.
 */
export function labelEm(lang: string): number {
  return isCjkScript(lang) ? DETAIL_LABEL_EM_HANGUL : DETAIL_LABEL_EM
}

/** Below this a label column reads as an indent rather than a column. */
export const DETAIL_LABEL_MIN = 72

/** The share of the card a label column may take before the periods start losing room. */
export const DETAIL_LABEL_MAX_FRACTION = 0.4

/**
 * The width of the label column, given every row label the statement carries and the width of the
 * card they sit in.
 *
 * The longest label wins, so no row is the one that ellipsizes. The cap is applied last and beats
 * the floor: on a card narrow enough for the two to cross, protecting the figures matters more
 * than the column looking like one.
 *
 * `lang` is the EDITION's, and it is required rather than defaulted: a default would let a caller
 * measure a Korean statement at Latin advances without saying so, which is the one way this
 * estimate goes wrong quietly.
 */
export function detailLabelWidth(labels: string[], cardWidth: number, lang: string): number {
  const longest = labels.reduce((n, l) => Math.max(n, l.length), 0)
  const wanted = Math.ceil(longest * fontSizeOf(type.caption) * labelEm(lang))
  const cap = Math.round(cardWidth * DETAIL_LABEL_MAX_FRACTION)
  return Math.min(cap, Math.max(DETAIL_LABEL_MIN, wanted))
}

/** One period's column, wide enough that the periods read as a run rather than as odd widths. */
export const DETAIL_CELL_MIN = 76

/**
 * The figures' own size — a point up from the caption the labels draw in.
 *
 * EXPORTED, AND `TileDetail`'s `gridCell` SETS ITS `fontSize` FROM IT. The no-wrap guarantee below
 * holds only while the size measured here and the size drawn there are the same number; two 13s
 * typed independently are that only by luck, and the day one of them is raised for legibility the
 * columns stay sized for the other and every long figure loses its tail in silence. Same rule as
 * `tape.ts`'s `TAPE_SYMBOL_SIZE`, and as `tiles.ts` for heights: one number, one place.
 */
export const DETAIL_CELL_FONT = 13

/**
 * The width of ONE value column, given every column heading and every cell in the grid.
 *
 * Every column takes the same width, because the periods have to line up under their headings
 * down the whole statement — so the widest cell anywhere in the grid decides it, not the widest
 * in each column.
 *
 * There is no cap, and that is the difference from the label column. These columns scroll: a
 * column twenty points wider than it needed costs a little more scrolling and nothing else, while
 * a column narrower than its number wraps that number into a row whose height is fixed, and the
 * second line is cut off by the surface's own clipping with nothing to say it happened.
 *
 * THE HEADINGS ARE MEASURED AT THE CELL'S 13 THOUGH THEY DRAW AT 12, deliberately and not by
 * oversight. `DETAIL_LABEL_EM` is 0.62, which suits the mixed-case prose of a row label and the
 * tabular numerals of a cell; a period name is neither — "1Q26", "FY2025 H1" are uppercase and
 * digits, which run nearer 0.67 em. Charging a heading one point of size more than it draws in is
 * what covers that difference, and it is the reason an all-caps period name does not wrap. Change
 * either number and check the other: the two are load-bearing together.
 */
export function detailCellWidth(headings: string[], cells: string[]): number {
  const longest = [...headings, ...cells].reduce((n, s) => Math.max(n, s.length), 0)
  return Math.max(DETAIL_CELL_MIN, Math.ceil(longest * DETAIL_CELL_FONT * DETAIL_LABEL_EM))
}
