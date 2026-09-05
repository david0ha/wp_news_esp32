// How big the four numbers under the range track are set, which is not the same in every edition.
//
// The stat grid is two 50% cells of a tile column — 72 pt on a 390 pt phone — and each holds a
// label over a price. What fits depends on how long a price is, and that is a fact about the
// market the edition is written about rather than about the design: a US quote is `226.30`, a KRX
// quote is `94,100.00`. At the size the tile has always used, nine characters measure about 70 pt
// and the two columns' numbers met with two points between them, reading as one eighteen-digit
// number. A point off the size buys five points of room and settles it.
//
// KEYED OFF THE EDITION'S LANGUAGE, not off the string. It is a proxy — an English paper about a
// Korean company would carry the same long price — but it is the same proxy every other
// language-shaped decision on this page uses (`typeRamp.tsx`'s ramp, `detail/tableGrid.ts`'s
// `labelEm`), and it is the one that keeps a tile's four numbers the same size as each other. A
// per-value size would set Open at 14 and Prev close at 13 in the same row, which is a worse
// failure than the one it fixes.
//
// It lives out here rather than in `RangeTile.tsx` for the reason `tape.ts` and `story.ts` do:
// this app has no screen tests, so a number argued inside a `.tsx` is argued only in prose.

import { type TextStyle } from 'react-native'
import { isCjkScript } from '../typeRamp'

/**
 * The size an edition Inter can set draws its stat values at.
 *
 * 14 is what this tile has always used, and holding it is the point of this module: the Korean
 * fix was applied to every edition at first, and English pages got a point smaller for a problem
 * they do not have.
 */
export const RANGE_STAT_VALUE_SIZE = 14

/**
 * And the size for a CJK script, where the prices run long.
 *
 * A point, and no more. The label in the same cell is the other half of the budget — `Prev close`
 * measures about 65 pt of the 72 — so the room has to come from somewhere that is not the gutter,
 * and 13 is the last size at which a nine-character price still fits beside one.
 */
export const RANGE_STAT_VALUE_SIZE_CJK = 13

/**
 * The advance of a digit in the value face, as a fraction of the size — measured off the strings
 * this tile actually draws (`94,100.00` runs about 70 pt at 14, 65 at 13).
 *
 * Here so the arithmetic above can be checked rather than believed. Nothing renders with it.
 */
export const RANGE_VALUE_DIGIT_EM = 0.556

/** The size the stat values are drawn at in an edition written in `lang`. */
export function rangeStatValueSize(lang: string): number {
  return isCjkScript(lang) ? RANGE_STAT_VALUE_SIZE_CJK : RANGE_STAT_VALUE_SIZE
}

// One object per answer, built once. The tile spreads this into a style array on every stat of
// every render, and a fresh `{ fontSize }` each time would make each of those a new style —
// `typeRamp.tsx`'s `buildFace` keeps its faces for the same reason.
const LATIN_STYLE: TextStyle = { fontSize: RANGE_STAT_VALUE_SIZE }
const CJK_STYLE: TextStyle = { fontSize: RANGE_STAT_VALUE_SIZE_CJK }

/** The same answer as a style to spread, which is what the tile actually needs. */
export function rangeStatValueStyle(lang: string): TextStyle {
  return isCjkScript(lang) ? CJK_STYLE : LATIN_STYLE
}
