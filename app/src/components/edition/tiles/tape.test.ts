import { describe, it, expect } from '@jest/globals'
import { TILE_PADDING } from '../../../lib/edition/tiles'
import {
  TAPE_CHANGE_W,
  TAPE_GAP,
  TAPE_SPARK_MAX,
  TAPE_SPARK_MIN,
  TAPE_SYMBOL_CHARS,
  TAPE_SYMBOL_FULL_COL,
  TAPE_SYMBOL_W,
  tapeSparkWidth,
} from './tape'

/** A 390 pt phone at this app's gutters and column gap. */
const W = 173

/**
 * What Yoga hands the `flex: 1` symbol once the sparkline and the change have taken theirs — the
 * residual the tile does not compute, stated here so the invariant it rests on can be checked.
 * The same trick `story.test.ts`'s `drawnHeight` uses.
 */
function symbolRoom(tileWidth: number): number {
  const spark = tapeSparkWidth(tileWidth)
  const gaps = spark > 0 ? 2 * TAPE_GAP : TAPE_GAP
  return tileWidth - 2 * TILE_PADDING - spark - TAPE_CHANGE_W - gaps
}

describe('tapeSparkWidth', () => {
  it('reserves six characters for the symbol before the sparkline takes anything', () => {
    // The defect: the sparkline had a fixed 42 and the symbol had the flex, so at a 145 pt
    // content box the symbol was left 25 pt and "NDX" rendered as "N…", "UST10Y" as "U…".
    expect(TAPE_SYMBOL_CHARS).toBe(6) // UST10Y, the longest the fixture carries
    expect(TAPE_SYMBOL_W).toBeGreaterThanOrEqual(48)
    expect(tapeSparkWidth(W)).toBe(145 - TAPE_SYMBOL_W - TAPE_CHANGE_W - 2 * TAPE_GAP)
  })

  it('caps the sparkline at the width it already had, so a wide column widens the symbol', () => {
    expect(tapeSparkWidth(260)).toBe(TAPE_SPARK_MAX)
    expect(symbolRoom(260)).toBeGreaterThan(symbolRoom(W))
  })

  it('drops the sparkline rather than drawing a stub when the room runs out', () => {
    // A 320 pt phone gives a 138 px column. A five-point polyline is a smudge that still costs
    // the symbol five points, so below the minimum the tape draws the row without one.
    expect(tapeSparkWidth(138)).toBe(0)
    expect(tapeSparkWidth(0)).toBe(0)
    expect(tapeSparkWidth(-100)).toBe(0)
  })

  it('never returns a width between zero and the legible minimum', () => {
    for (let w = 100; w <= 500; w++) {
      const spark = tapeSparkWidth(w)
      expect(Number.isInteger(spark)).toBe(true)
      expect(spark === 0 || spark >= TAPE_SPARK_MIN).toBe(true)
      expect(spark).toBeLessThanOrEqual(TAPE_SPARK_MAX)
    }
  })

  it('leaves the symbol the width the module reserves for it, from 143 px up', () => {
    // The property the whole arrangement exists for, asserted against the module's OWN figure and
    // not against a rounder one: `TAPE_SYMBOL_W` is what six characters were measured to need, so
    // anything less is the reservation not being met. It holds through the width where the
    // sparkline is dropped, because dropping it is what keeps it true.
    expect(TAPE_SYMBOL_FULL_COL).toBe(143)
    for (let colWidth = TAPE_SYMBOL_FULL_COL; colWidth <= 260; colWidth++) {
      expect(symbolRoom(colWidth)).toBeGreaterThanOrEqual(TAPE_SYMBOL_W)
    }
  })

  it('falls short by at most five points below that, and never more', () => {
    // The documented shortfall — see `TAPE_SYMBOL_FULL_COL`. A 320 pt phone gives a 138 px column
    // and the symbol 44 pt against the 49 it wants, which is "UST10Y" ellipsizing and nothing
    // else. The bound is the point of this test: the gap may not widen, and it may not appear at
    // a column where it does not exist today.
    for (let colWidth = 138; colWidth < TAPE_SYMBOL_FULL_COL; colWidth++) {
      expect(symbolRoom(colWidth)).toBeGreaterThanOrEqual(TAPE_SYMBOL_W - 5)
      expect(symbolRoom(colWidth)).toBeLessThan(TAPE_SYMBOL_W)
    }
    expect(symbolRoom(138)).toBe(44)
  })
})
