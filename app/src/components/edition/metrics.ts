// The readers for a type token's own metrics.
//
// The tiles that have to make their own arithmetic add up — the lead story deciding how many lines
// of body fit, the chart sizing its plot, the range tile packing a track and four numbers, the
// detail page's statement grid deciding how wide a row label runs — need the exact size of the
// text they are about to draw. Reading it off the token the `<Text>` actually uses is what keeps
// the sum honest: a magic `18` beside a `type.caption` is a number that stops being true the day
// the ramp is retuned, and nothing measures afterwards to notice.

import { type TextStyle } from 'react-native'

/**
 * The line height a type token draws at.
 *
 * Every entry in `theme.ts`'s `type` ramp sets one. The throw is here so that a token which ever
 * stops doing so fails loudly at import, rather than silently sizing a box to `undefined` and
 * clipping a line of somebody's story.
 */
export function lineHeightOf(style: TextStyle): number {
  const h = style.lineHeight
  if (typeof h !== 'number') {
    throw new Error('metrics: this type token sets no lineHeight')
  }
  return h
}

/**
 * The size a type token draws at — the horizontal counterpart of the above.
 *
 * Only the width estimates need it: how far a string of N characters runs is N times an advance,
 * and an advance is a fraction of the size. It throws for the same reason `lineHeightOf` does —
 * a token with no size would silently estimate every label as zero points wide.
 */
export function fontSizeOf(style: TextStyle): number {
  const s = style.fontSize
  if (typeof s !== 'number') {
    throw new Error('metrics: this type token sets no fontSize')
  }
  return s
}
