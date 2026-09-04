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
// DIRECTION IS THE ONLY THING COLOUR MEANS ON THE EDITION'S TWO SCREENS. The firmware's rule
// allows a second meaning — series identity, `ui_series_t` — but that only arises inside a
// graphic carrying more than one series, and the phone draws none: a line chart is one series, a
// bar chart is one series in `colors.navy`, a range mark is ink. So there is no identity mapping
// here to pick the wrong entry from, and anything on these pages that is not a percentage change
// or a plotted series is ink. Adding a second series to a graphic is what would need one.
//
// This lives under `components/` and not `lib/` because a colour is a theme fact, and
// `lib/edition` holds no colours by design. Two hand-written copies of the mapping would be two
// places for a chart stroke and its label to end up different greens. The text pair now has a
// single caller — `Change`, which is every percentage on both of the edition's screens — and the
// graphics pair has three, one per thing that draws.

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
