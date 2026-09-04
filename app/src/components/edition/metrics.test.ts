import { describe, it, expect } from '@jest/globals'
import { lineHeightOf } from './metrics'
import { RANGE_CAPTION_LINE, RANGE_TRACK_ROW_H } from './tiles/RangeTile'
import {
  FIGURES_LABEL_LINE,
  FIGURES_ROW,
  FIGURES_ROW_GAP,
  FIGURES_VALUE_EMPH_SIZE,
  FIGURES_VALUE_LINE,
  FIGURES_VALUE_SIZE,
  RANGE_TRACK_H,
  TILE_HEAD,
} from '../../lib/edition/tiles'
import { space, type } from '../../theme'

// THE ESTIMATOR'S LITERALS, TIED TO THE TOKENS THE BODIES ACTUALLY DRAW WITH.
//
// `lib/edition/tiles.ts` computes every tile's height before anything renders, and it is
// forbidden from importing the theme — it is the pure half of this app and its test runs under a
// plain transform with no React Native to allowlist. So it carries those heights as literals: 24
// for a heading line, 44 for the range tile's track box. The bodies read the same quantities off
// the theme at runtime.
//
// Nothing tied the two together. A retuned type ramp — one line height moved by two pixels — left
// the estimator sizing a box for the old ramp and the body drawing the new one, and the only
// symptom is a clipped descender or a sliced caption on a phone nobody has measured. This file is
// that tie, and it lives under `components/` because that is the side of the wall the theme is on.

describe('the estimator’s literals against the type ramp', () => {
  it('gives a tile heading exactly the line its token draws', () => {
    expect(TILE_HEAD).toBe(lineHeightOf(type.headingSm))
  })

  it('gives the range tile’s caption exactly the line its token draws', () => {
    expect(RANGE_CAPTION_LINE).toBe(lineHeightOf(type.caption))
  })

  it('gives a figures label exactly the line its token draws', () => {
    expect(FIGURES_LABEL_LINE).toBe(lineHeightOf(type.caption))
  })

  it('builds FIGURES_ROW out of the two lines a figure row stacks', () => {
    // A figure row is a caption-size label ABOVE its value, because the two side by side in a
    // 145 pt content box ellipsized "MARKET CAP" to "MARKET…". So the row is the label's line,
    // the gap, and the value's own line — and the value's line is a constant rather than the
    // font's intrinsic metric, so this sum is one somebody can check.
    expect(FIGURES_ROW).toBe(FIGURES_LABEL_LINE + FIGURES_ROW_GAP + FIGURES_VALUE_LINE)
  })

  it('gives a figure value a line taller than either face that draws in it', () => {
    // The one part of `FIGURES_ROW` with no theme token behind it. Its two faces are bare sizes —
    // 14 semibold for a plain figure, 15 extrabold for the emphasised one — so the sum that holds
    // the row together is only true while the line box clears the taller of them. Nothing else
    // would catch a raised face: the row height is fixed, so the value would simply crop.
    const largest = Math.max(FIGURES_VALUE_SIZE, FIGURES_VALUE_EMPH_SIZE)
    expect(FIGURES_VALUE_LINE).toBeGreaterThan(largest)
    // And by enough to hold a line of it. A font's line box runs about 1.2 times its size once
    // the ascender and descender are counted, so clearing the size alone is a floor, not the need.
    expect(FIGURES_VALUE_LINE).toBeGreaterThanOrEqual(Math.ceil(largest * 1.2))
  })

  it('builds RANGE_TRACK_H out of the blocks the track box actually draws', () => {
    // 4 pad + the 14 px track row + a 4 px gap + the caption + 4 pad. The sum is in `RangeTile`'s
    // header comment; this is the same sum, checked.
    expect(RANGE_TRACK_H).toBe(2 * space.xs + RANGE_TRACK_ROW_H + space.xs + RANGE_CAPTION_LINE)
  })
})
