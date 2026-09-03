// One reader for a type token's line height.
//
// The tiles that have to make their own vertical arithmetic add up — the lead story deciding how
// many lines of body fit, the chart sizing its plot, the range tile packing a track and four
// numbers — need the exact height of a line they are about to draw. Reading it off the token the
// `<Text>` actually uses is what keeps the sum honest: a magic `18` beside a `type.caption` is a
// number that stops being true the day the ramp is retuned, and nothing measures afterwards to
// notice.

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
