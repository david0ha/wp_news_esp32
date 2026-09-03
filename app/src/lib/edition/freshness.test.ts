import { describe, it, expect } from '@jest/globals'
import { freshnessLabel } from './freshness'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// A fixed instant, so the "day and short month" tier asserts a real date rather than today's.
// 2026-08-30 14:00 local — the local clock is what the tiers are about (see freshness.ts).
const NOW = new Date(2026, 7, 30, 14, 0, 0).getTime()
const ago = (ms: number) => freshnessLabel(NOW - ms, NOW)

describe('freshnessLabel — the tiers', () => {
  it('says nothing at all under five minutes', () => {
    expect(ago(0)).toBeNull()
    expect(ago(30_000)).toBeNull()
    expect(ago(5 * MIN - 1)).toBeNull()
  })

  it('counts minutes from five to sixty', () => {
    expect(ago(5 * MIN)).toBe('Updated 5m ago')
    expect(ago(12 * MIN)).toBe('Updated 12m ago')
    expect(ago(12 * MIN + 59_000)).toBe('Updated 12m ago')
    expect(ago(59 * MIN)).toBe('Updated 59m ago')
  })

  it('counts hours from one to twenty-four', () => {
    expect(ago(HOUR)).toBe('Updated 1h ago')
    expect(ago(3 * HOUR)).toBe('Updated 3h ago')
    expect(ago(23 * HOUR + 59 * MIN)).toBe('Updated 23h ago')
  })

  it('says yesterday between one day and two', () => {
    expect(ago(DAY)).toBe('Last updated yesterday')
    expect(ago(2 * DAY - 1)).toBe('Last updated yesterday')
  })

  it('gives a day and a short month beyond two days, with no year', () => {
    // 2026-08-30 14:00 minus two days is 2026-08-28.
    expect(ago(2 * DAY)).toBe('Last updated 28 Aug')
    expect(ago(30 * DAY)).toBe('Last updated 31 Jul')
  })

  it('treats a fetch stamped in the future as fresh rather than as a negative age', () => {
    // A phone whose clock moved backwards, or a cache written by a device an hour ahead. The
    // honest answer is "nothing to report", not "Updated -60m ago".
    expect(ago(-HOUR)).toBeNull()
  })

  it('says nothing for a fetch that never happened', () => {
    // `fetchedAt: 0` is the demo edition's stamp: no server ever confirmed it.
    expect(freshnessLabel(0, NOW)).toBeNull()
  })
})
