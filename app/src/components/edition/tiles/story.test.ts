import { describe, it, expect } from '@jest/globals'
import { estimateTileHeight, TILE_PADDING, type Tile } from '../../../lib/edition/tiles'
import {
  BODY_LINE,
  DECK_LINE,
  HEADLINE_LEAD_LINE,
  HEADLINE_SM_LINE,
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
  const headlineLine = fit.lead ? HEADLINE_LEAD_LINE : HEADLINE_SM_LINE
  const parts = [
    lines.kicker * KICKER_LINE,
    lines.headline * headlineLine,
    lines.deck * DECK_LINE,
    lines.body * BODY_LINE,
  ].filter((h) => h > 0)
  return parts.reduce((a, b) => a + b, 0) + Math.max(0, parts.length - 1) * STORY_GAP
}

describe('storyLines', () => {
  it('gives the lead exactly what its own estimated height leaves', () => {
    // The whole point: the input is the estimator's answer, not a number typed twice.
    const h = estimateTileHeight(storyTile(true), W) // round(170 * 4/3) = 227
    expect(h).toBe(227)
    expect(storyLines(h, { lead: true, hasKicker: true, hasDeck: true })).toEqual({
      kicker: 1,
      headline: 4,
      deck: 2,
      body: 1, // 199 content − 18 − 104 − 38 − 3 gaps = 27, which is one 18 px line
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

  it('sheds the deck before the headline when a narrow column runs out', () => {
    // At 140 the lead's full furniture wants 168 px of a 159 px box. The headline is the tile's
    // photograph and keeps its four lines; the deck gives up its second.
    const h = estimateTileHeight(storyTile(true), 140) // 187
    const lines = storyLines(h, { lead: true, hasKicker: true, hasDeck: true })
    expect(lines.headline).toBe(4)
    expect(lines.deck).toBe(1)
    expect(lines.body).toBe(0)
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
