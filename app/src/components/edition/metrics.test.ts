import { describe, it, expect } from '@jest/globals'
import { lineHeightOf } from './metrics'
import { RANGE_CAPTION_LINE, RANGE_TRACK_ROW_H } from './tiles/RangeTile'
import { RANGE_TRACK_H, TILE_HEAD } from '../../lib/edition/tiles'
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

  it('builds RANGE_TRACK_H out of the blocks the track box actually draws', () => {
    // 4 pad + the 14 px track row + a 4 px gap + the caption + 4 pad. The sum is in `RangeTile`'s
    // header comment; this is the same sum, checked.
    expect(RANGE_TRACK_H).toBe(2 * space.xs + RANGE_TRACK_ROW_H + space.xs + RANGE_CAPTION_LINE)
  })
})
