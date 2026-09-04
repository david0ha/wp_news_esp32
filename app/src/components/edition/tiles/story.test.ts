import { describe, it, expect } from '@jest/globals'
import { estimateTileHeight, TILE_PADDING, type Tile } from '../../../lib/edition/tiles'
import {
  BODY_LINE,
  DECK_LINE,
  HEADLINE_LEAD_LINES,
  HEADLINE_LINE,
  KICKER_LINE,
  STORY_GAP,
  storyLines,
  type StoryFit,
} from './story'

const W = 170 // the same realistic column `tiles.test.ts` uses

const storyTile = (lead: boolean): Tile => ({
  kind: 'story',
  id: lead ? 'story:0' : 'story:1',
  lead,
  story: {
    rank: 0,
    kicker: 'k',
    headline: 'h',
    deck: 'd',
    byline: '',
    body: 'b',
    chart: null,
    photo: null,
  },
})

/** What the tile actually draws for a given answer, gaps included. */
function drawnHeight(fit: StoryFit, lines: ReturnType<typeof storyLines>): number {
  const parts = [
    lines.kicker * KICKER_LINE,
    lines.headline * HEADLINE_LINE,
    lines.deck * DECK_LINE,
    lines.body * BODY_LINE,
  ].filter((h) => h > 0)
  return parts.reduce((a, b) => a + b, 0) + Math.max(0, parts.length - 1) * STORY_GAP
}

describe('storyLines', () => {
  it('gives the lead exactly what its own estimated height leaves', () => {
    // The whole point: the input is the estimator's answer, not a number typed twice.
    const h = estimateTileHeight(storyTile(true), W) // round(170 * 3/2)
    expect(h).toBe(255)
    expect(storyLines(h, { lead: true, hasKicker: true, hasDeck: true })).toEqual({
      kicker: 1,
      headline: 5,
      deck: 2,
      body: 3, // 227 content − 18 − 105 − 38 − 3 gaps = 54, which is three 18 px lines
    })
  })

  it('never draws more than the content box holds, at any plausible column', () => {
    // The bug this replaces: a fixed clamp of 6 asked for 108 px of a 27 px box, and the surplus
    // lines were sliced horizontally rather than ellipsized.
    for (const lead of [true, false]) {
      for (const hasKicker of [true, false]) {
        for (const hasDeck of [true, false]) {
          for (const colWidth of [140, 155, 165, 170, 200, 260]) {
            const fit = { lead, hasKicker, hasDeck }
            const h = estimateTileHeight(storyTile(lead), colWidth)
            expect(drawnHeight(fit, storyLines(h, fit))).toBeLessThanOrEqual(h - 2 * TILE_PADDING)
          }
        }
      }
    }
  })

  it('lets nothing but the headline overflow, at every width a phone produces', () => {
    // The denser cousin of the sweep above: every integer column from 138 (a 320 dp iPhone SE at
    // this gutter) to 174 (a 393 dp Pixel), and both story kinds. The claim is not merely "it
    // fits" — it is that the ONE part allowed out of the box is the headline, and only when the
    // box is too short for even a single line of it. A deck or a body that overflowed would be
    // sliced horizontally by the tile's `overflow: 'hidden'`, with no ellipsis to admit it.
    for (let colWidth = 138; colWidth <= 174; colWidth++) {
      for (const lead of [true, false]) {
        for (const hasKicker of [true, false]) {
          for (const hasDeck of [true, false]) {
            const fit = { lead, hasKicker, hasDeck }
            const h = estimateTileHeight(storyTile(lead), colWidth)
            const content = h - 2 * TILE_PADDING
            const lines = storyLines(h, fit)
            const headlineLine = HEADLINE_LINE
            // What the headline costs, charged back ONLY when a single line genuinely did not
            // fit — that is the one overflow `storyLines` is allowed, and this subtracts exactly
            // it. Deducted unconditionally the assertion would be vacuous; not deducted at all it
            // would fail on the very short boxes the minimum exists for. Every case is asserted.
            const before = lines.kicker > 0 ? KICKER_LINE + STORY_GAP : 0
            const forced = lines.headline === 1 && content - before < headlineLine
            const excused = forced ? headlineLine + (lines.kicker > 0 ? STORY_GAP : 0) : 0
            expect(drawnHeight(fit, lines) - excused).toBeLessThanOrEqual(content)
            // And when it was forced, nothing else was drawn to be sliced beside it.
            if (forced) {
              expect(lines.deck).toBe(0)
              expect(lines.body).toBe(0)
            }
          }
        }
      }
    }
  })

  it('sheds the deck before the headline when a narrow column runs out', () => {
    // The priority order, at the width where it now bites. At a 125 px column the lead's full
    // furniture — kicker, five headline lines, two deck lines and the two gaps between those three
    // children — wants 169 px of a 160 px box, so the deck gives up its second line and the
    // headline keeps all five. (The 173 in the 170 px case is the same sum plus a third gap,
    // charged there because a line of body follows the deck.)
    const h = estimateTileHeight(storyTile(true), 125) // round(125 * 3/2) = 188
    const lines = storyLines(h, { lead: true, hasKicker: true, hasDeck: true })
    expect(lines.headline).toBe(HEADLINE_LEAD_LINES)
    expect(lines.deck).toBe(1)
    expect(lines.body).toBe(0)
  })

  it('holds the lead’s whole furniture at every column a phone produces', () => {
    // What the 3:2 lead height bought. At 4:3 with a 26 px headline line the lead was the one
    // story whose headline ellipsized — five lines of a 57-character headline against a cap of
    // four — and at the narrow end it lost a deck line as well. From the narrowest phone column
    // to the widest, the lead now keeps its kicker, all five headline lines and both deck lines.
    for (let colWidth = 138; colWidth <= 174; colWidth++) {
      const h = estimateTileHeight(storyTile(true), colWidth)
      const lines = storyLines(h, { lead: true, hasKicker: true, hasDeck: true })
      expect(lines.kicker).toBe(1)
      expect(lines.headline).toBe(HEADLINE_LEAD_LINES)
      expect(lines.deck).toBe(2)
    }
  })

  it('leaves the lead body copy at the column an iPhone 17e produces', () => {
    // 390 pt wide, 16 pt gutters and a 12 pt column gap give 173. That is the render this height
    // was retuned for: the headline gets its five lines AND there is copy under the deck, where
    // the 4:3 lead had an ellipsized headline and one line of body.
    const h = estimateTileHeight(storyTile(true), 173)
    expect(h).toBe(260)
    const lines = storyLines(h, { lead: true, hasKicker: true, hasDeck: true })
    expect(lines.headline).toBe(5)
    expect(lines.body).toBeGreaterThanOrEqual(1)
  })

  it('keeps a headline line even when nothing fits at all', () => {
    // A story tile without its headline is not a story tile, so this is the one part allowed to
    // overflow rather than vanish.
    const lines = storyLines(0, { lead: true, hasKicker: true, hasDeck: true })
    expect(lines.headline).toBe(1)
    expect(lines.deck).toBe(0)
    expect(lines.body).toBe(0)
  })

  it('answers zero body rather than a sliced line when nothing is left', () => {
    const h = estimateTileHeight(storyTile(false), W)
    expect(storyLines(h, { lead: false, hasKicker: true, hasDeck: true }).body).toBe(0)
  })

  it('lets a bare secondary story fill its tile with copy', () => {
    // The old `lead &&` gate left this as white paper; the room decides now, not the rank.
    const h = estimateTileHeight(storyTile(false), W)
    expect(
      storyLines(h, { lead: false, hasKicker: false, hasDeck: false }).body,
    ).toBeGreaterThan(2)
  })

  it('grows the body as the column grows, since the lead height follows the width', () => {
    const fit = { lead: true, hasKicker: true, hasDeck: true }
    const narrow = storyLines(estimateTileHeight(storyTile(true), 170), fit).body
    const wide = storyLines(estimateTileHeight(storyTile(true), 260), fit).body
    expect(wide).toBeGreaterThan(narrow)
  })

  it('never answers a negative count, whatever it is handed', () => {
    for (const h of [0, -100]) {
      const lines = storyLines(h, { lead: false, hasKicker: true, hasDeck: true })
      expect(lines.kicker).toBeGreaterThanOrEqual(0)
      expect(lines.headline).toBeGreaterThanOrEqual(1)
      expect(lines.deck).toBeGreaterThanOrEqual(0)
      expect(lines.body).toBeGreaterThanOrEqual(0)
    }
  })
})
