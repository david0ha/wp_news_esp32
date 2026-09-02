import { describe, it, expect } from '@jest/globals'
import {
  arrow,
  currencySymbol,
  formatCompact,
  formatDateShort,
  formatDelta,
  formatIv,
  formatPct,
  formatPrice,
  formatRatio,
  formatTime,
  relativeTime,
} from './format'

describe('formatPrice', () => {
  it('renders >= 1 with 2dp and thousands commas', () => {
    expect(formatPrice(1042.72)).toBe('1,042.72')
    expect(formatPrice(1)).toBe('1.00')
    expect(formatPrice(189.873)).toBe('189.87')
  })
  it('renders |n| < 1 with 4dp (penny stocks keep their precision)', () => {
    expect(formatPrice(0.1234)).toBe('0.1234')
    expect(formatPrice(0.5)).toBe('0.5000')
    expect(formatPrice(0)).toBe('0.0000')
  })
  it('keeps the sign on negatives', () => {
    expect(formatPrice(-1042.72)).toBe('-1,042.72')
    expect(formatPrice(-0.5)).toBe('-0.5000')
  })
  it('— for null/undefined/NaN/Infinity', () => {
    expect(formatPrice(null)).toBe('—')
    expect(formatPrice(undefined)).toBe('—')
    expect(formatPrice(NaN)).toBe('—')
    expect(formatPrice(Infinity)).toBe('—')
  })
})

describe('formatDelta', () => {
  it('renders the unsigned magnitude at 2dp — the arrow carries the sign', () => {
    expect(formatDelta(14.75)).toBe('14.75')
    expect(formatDelta(-14.75)).toBe('14.75')
    expect(formatDelta(0)).toBe('0.00')
  })
  it('— when not finite', () => {
    expect(formatDelta(null)).toBe('—')
    expect(formatDelta(NaN)).toBe('—')
  })
})

describe('formatPct', () => {
  it('takes the number already scaled to percent — no ×100 inside', () => {
    expect(formatPct(0.16)).toBe('0.16%')
    expect(formatPct(12.345)).toBe('12.35%')
  })
  it('is unsigned', () => {
    expect(formatPct(-0.16)).toBe('0.16%')
  })
  it('collapses magnitudes under 0.0001 to 0.00%', () => {
    expect(formatPct(0.00005)).toBe('0.00%')
    expect(formatPct(0)).toBe('0.00%')
    expect(formatPct(-0.00005)).toBe('0.00%')
  })
  it('— when not finite', () => {
    expect(formatPct(null)).toBe('—')
    expect(formatPct(undefined)).toBe('—')
    expect(formatPct(NaN)).toBe('—')
  })
})

describe('formatCompact', () => {
  it('below 1000 renders the integer as-is', () => {
    expect(formatCompact(999)).toBe('999')
    expect(formatCompact(0)).toBe('0')
  })
  it('scales through K/M/B/T at 1dp', () => {
    expect(formatCompact(1234)).toBe('1.2K')
    expect(formatCompact(3.4e6)).toBe('3.4M')
    expect(formatCompact(1.2e9)).toBe('1.2B')
    expect(formatCompact(2.3e12)).toBe('2.3T')
  })
  it("keeps the trailing '.0' off", () => {
    expect(formatCompact(12000)).toBe('12K')
    expect(formatCompact(1e9)).toBe('1B')
  })
  it('keeps the sign on negatives', () => {
    expect(formatCompact(-1234)).toBe('-1.2K')
  })
  it('promotes across the unit boundary when 1dp rounding would print a 1000 mantissa', () => {
    expect(formatCompact(999_960)).toBe('1M') // not '1000K'
    expect(formatCompact(999.96e9)).toBe('1T') // not '1000B'
    expect(formatCompact(999.5)).toBe('1K') // not a suffixless '1000'
    expect(formatCompact(999_949)).toBe('999.9K') // just below the window stays put
    expect(formatCompact(-999_960)).toBe('-1M')
  })
  it('— when not finite', () => {
    expect(formatCompact(null)).toBe('—')
    expect(formatCompact(NaN)).toBe('—')
  })
})

describe('formatIv', () => {
  it('fractional in, whole percent out', () => {
    expect(formatIv(0.345)).toBe('35%')
    expect(formatIv(0.34)).toBe('34%')
    expect(formatIv(1.2)).toBe('120%')
  })
  it('— when not finite', () => {
    expect(formatIv(null)).toBe('—')
    expect(formatIv(undefined)).toBe('—')
  })
})

describe('formatRatio', () => {
  it('2dp, sign preserved', () => {
    expect(formatRatio(1.5)).toBe('1.50')
    expect(formatRatio(-0.435)).toBe('-0.43')
  })
  it('— when not finite', () => {
    expect(formatRatio(null)).toBe('—')
    expect(formatRatio(NaN)).toBe('—')
  })
})

describe('relativeTime', () => {
  const nowMs = 1_800_000_000_000 // fixed; no branch may read the real clock

  it('under a minute is now', () => {
    expect(relativeTime(nowMs / 1000 - 59, nowMs)).toBe('now')
    expect(relativeTime(nowMs / 1000, nowMs)).toBe('now')
  })
  it('minutes, hours, days', () => {
    expect(relativeTime(nowMs / 1000 - 60, nowMs)).toBe('1m ago')
    expect(relativeTime(nowMs / 1000 - 59 * 60, nowMs)).toBe('59m ago')
    expect(relativeTime(nowMs / 1000 - 3600, nowMs)).toBe('1h ago')
    expect(relativeTime(nowMs / 1000 - 23 * 3600, nowMs)).toBe('23h ago')
    expect(relativeTime(nowMs / 1000 - 86400, nowMs)).toBe('1d ago')
    expect(relativeTime(nowMs / 1000 - 6 * 86400, nowMs)).toBe('6d ago')
  })
  it('a week or more falls through to formatDateShort with the same nowMs', () => {
    const epochSec = nowMs / 1000 - 8 * 86400
    expect(relativeTime(epochSec, nowMs)).toBe(formatDateShort(epochSec, nowMs))
  })
})

describe('formatDateShort', () => {
  it('same year as nowMs → no year suffix (UTC-based)', () => {
    const sec = Date.UTC(2025, 8, 4, 12, 0, 0) / 1000
    expect(formatDateShort(sec, Date.UTC(2025, 0, 15))).toBe('Sep 4')
  })
  it('another year carries the year', () => {
    const sec = Date.UTC(2025, 8, 4, 12, 0, 0) / 1000
    expect(formatDateShort(sec, Date.UTC(2026, 0, 15))).toBe('Sep 4, 2025')
  })
  it('reads the date in UTC, not device-local time', () => {
    // 23:30 UTC on Dec 31 is already Jan 1 in eastern timezones; the label must say Dec 31.
    const sec = Date.UTC(2025, 11, 31, 23, 30, 0) / 1000
    expect(formatDateShort(sec, Date.UTC(2025, 11, 31))).toBe('Dec 31')
  })
})

describe('formatTime', () => {
  it('renders HH:MM 24h in device-local time (asserted via the same local-time APIs)', () => {
    const sec = 1_800_000_000
    const d = new Date(sec * 1000)
    const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    expect(formatTime(sec)).toBe(expected)
    expect(formatTime(sec)).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('currencySymbol', () => {
  it('maps the listed codes', () => {
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('GBP')).toBe('£')
    expect(currencySymbol('JPY')).toBe('¥')
    expect(currencySymbol('')).toBe('')
  })
  it('falls back to the ISO code plus a space', () => {
    expect(currencySymbol('SEK')).toBe('SEK ')
    expect(currencySymbol('KRW')).toBe('KRW ')
  })
  it("renders pence as the ISO fallback — every return is a prefix, and 'p245.30' would be garbled", () => {
    expect(currencySymbol('GBp')).toBe('GBp ')
  })
})

describe('arrow', () => {
  it('carries the sign', () => {
    expect(arrow(1.23)).toBe('▲')
    expect(arrow(-0.01)).toBe('▼')
  })
  it('zero carries no sign, and neither does an absent value', () => {
    expect(arrow(0)).toBe('')
    expect(arrow(null)).toBe('')
    expect(arrow(undefined)).toBe('')
    expect(arrow(NaN)).toBe('')
  })
})
