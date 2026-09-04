// Market display formatters (spec §4.7) — distinct from the device's lib/format.ts, which
// renders the board's integer-cents wire format. These take Yahoo's floats. Every '—' below is
// the same em dash, so an absent value looks the same on every screen.
//
// No currency symbol inside formatPrice/formatDelta: screens prefix via
// currencySymbol(quote.currency) — never a literal '$'.

import { months } from '../months'
import { fill, strings } from '../../i18n'

/** Exported because `lib/edition/format.ts` re-exports these formatters and their dash. */
export const DASH = '—'

function isFiniteNumber(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** |n| >= 1 → 2dp with thousands commas ('1,042.72'); |n| < 1 → 4dp; else '—'. */
export function formatPrice(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return DASH
  if (Math.abs(n) >= 1) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return n.toFixed(4)
}

/** Unsigned magnitude, 2dp ('14.75') — the arrow carries the sign. '—' when not finite. */
export function formatDelta(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return DASH
  return Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Takes the number ALREADY SCALED to percent — formatPct(0.16) === '0.16%'. 2dp, unsigned,
 * NO ×100 inside; magnitudes under 0.0001 collapse to '0.00%'. '—' when not finite.
 */
export function formatPct(f: number | null | undefined): string {
  if (!isFiniteNumber(f)) return DASH
  const a = Math.abs(f)
  if (a < 0.0001) return '0.00%'
  return `${a.toFixed(2)}%`
}

/**
 * 999 → '999', 1234 → '1.2K', 3.4e6 → '3.4M', 1.2e9 → '1.2B', 2.3e12 → '2.3T'. 1dp with the
 * trailing '.0' kept off ('12K', not '12.0K'). '—' when not finite. A value whose 1dp rounding
 * crosses a unit boundary promotes to the larger unit — 999.96e9 is '1T', never '1000B'
 * (matching Intl compact notation); only above 1000T does a four-digit mantissa remain.
 */
export function formatCompact(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return DASH
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a < 999.5) return `${sign}${Math.round(a)}` // 999.5 rounds to 1000 → falls through to '1K'
  const units: ReadonlyArray<readonly [number, string]> = [
    [1e3, 'K'],
    [1e6, 'M'],
    [1e9, 'B'],
    [1e12, 'T'],
  ]
  let idx = 0
  while (idx + 1 < units.length && a >= units[idx + 1][0]) idx++
  let scaled = Number((a / units[idx][0]).toFixed(1))
  if (scaled >= 1000 && idx + 1 < units.length) {
    // The 1dp rounding crossed the boundary (e.g. 999_960 → '1000.0K') — promote instead.
    idx++
    scaled = Number((a / units[idx][0]).toFixed(1))
  }
  return `${sign}${scaled.toFixed(1).replace(/\.0$/, '')}${units[idx][1]}`
}

/** Fractional IV in → whole percent out: 0.345 → '35%' (0dp). '—' when not finite. */
export function formatIv(f: number | null | undefined): string {
  if (!isFiniteNumber(f)) return DASH
  return `${Math.round(f * 100)}%`
}

/** 2dp, signed as the number is. '—' when not finite. */
export function formatRatio(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return DASH
  return n.toFixed(2)
}

/**
 * <60s 'now'; <1h '{m}m ago'; <24h '{h}h ago'; <7d '{d}d ago'; else formatDateShort — the same
 * nowMs threads through, so no branch reads the real clock when a test injects one.
 */
export function relativeTime(epochSec: number, nowMs?: number): string {
  const ago = strings().format.ago
  if (!Number.isFinite(epochSec)) return DASH
  const diff = Math.floor((nowMs ?? Date.now()) / 1000) - epochSec
  if (diff < 60) return ago.now
  if (diff < 3600) return fill(ago.minutes, { n: String(Math.floor(diff / 60)) })
  if (diff < 86400) return fill(ago.hours, { n: String(Math.floor(diff / 3600)) })
  if (diff < 7 * 86400) return fill(ago.days, { n: String(Math.floor(diff / 86400)) })
  return formatDateShort(epochSec, nowMs)
}

/**
 * 'Sep 4' when the year matches nowMs's (default Date.now()), 'Sep 4, 2025' otherwise.
 * UTC-based like formatGeneratedAt to avoid TZ drift; nowMs is injectable so tests never depend
 * on the real date.
 */
export function formatDateShort(epochSec: number, nowMs?: number): string {
  if (!Number.isFinite(epochSec)) return DASH
  const d = new Date(epochSec * 1000)
  const parts = {
    month: months()[d.getUTCMonth()],
    day: String(d.getUTCDate()),
    year: String(d.getUTCFullYear()),
  }
  const nowYear = new Date(nowMs ?? Date.now()).getUTCFullYear()
  // Two whole templates rather than one plus a suffix: Korean puts the year in FRONT of the
  // month, so "add the year on the end when it differs" is an English-only rule.
  const t = strings().format
  return fill(d.getUTCFullYear() === nowYear ? t.dateShort : t.dateShortYear, parts)
}

/**
 * 'HH:MM' 24h in DEVICE-LOCAL time — a 1D scrub label must read as the user's clock; UTC is for
 * date-granularity labels only.
 */
export function formatTime(epochSec: number): string {
  if (!Number.isFinite(epochSec)) return DASH
  const d = new Date(epochSec * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 'USD'→'$', 'EUR'→'€', 'GBP'→'£', 'JPY'→'¥', ''→''; anything else → the ISO code plus a
 * space ('SEK ', 'GBp '). Every return value is consumed as a PREFIX (`${cs}${price}`), which
 * is why 'GBp' (pence — how Yahoo quotes LSE equities) deliberately has no 'p' mapping: pence
 * is suffix notation, so a prefixed 'p245.30' reads as a garbled symbol while 'GBp 245.30' is
 * unambiguous.
 */
export function currencySymbol(code: string): string {
  switch (code) {
    case '':
      return ''
    case 'USD':
      return '$'
    case 'EUR':
      return '€'
    case 'GBP':
      return '£'
    case 'JPY':
      return '¥'
    default:
      return `${code} `
  }
}

/** Zero carries no sign: 0/null/NaN → ''. */
export function arrow(delta: number | null | undefined): '▲' | '▼' | '' {
  if (!isFiniteNumber(delta) || delta === 0) return ''
  return delta > 0 ? '▲' : '▼'
}
