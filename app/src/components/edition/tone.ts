// A direction, turned into the right colour for the job.
//
// theme.ts keeps two greens and two reds on purpose: the TEXT pair (`up`/`down`) is darkened to
// clear 4.5:1 on white and on the canvas, and the GRAPHICS pair (`upBright`/`downBright`) is the
// saturated one, which only has to clear 3:1 because it is a stroke and not a sentence. Picking
// the wrong one is not a style slip — the text pair on a 1.5 px sparkline is muddy, and the
// graphics pair on a 13 px label fails contrast.
//
// `flat` is deliberately grey in both duties. Zero is not a small rise.
//
// This lives under `components/` and not `lib/` because a colour is a theme fact, and
// `lib/edition` holds no colours by design. Five components need the mapping; two hand-written
// copies of it is two places for a chart stroke and its label to end up different greens.

import { colors } from '../../theme'
import { type ChangeTone } from '../../lib/edition/format'

/** For anything the reader reads: a percentage, a delta, an arrow beside one. */
export function toneTextColor(t: ChangeTone): string {
  return t === 'up' ? colors.up : t === 'down' ? colors.down : colors.textDim
}

/** For anything drawn: a sparkline, a bar, a rule, a fill. */
export function toneGraphicsColor(t: ChangeTone): string {
  return t === 'up' ? colors.upBright : t === 'down' ? colors.downBright : colors.textDim
}
