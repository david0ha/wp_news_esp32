// Pure display formatters for the dashboard. Kept tiny and testable so the same number is
// rendered the same way everywhere and nothing throws on the board's loosely-typed JSON.

import { SLEEP_SECONDS_DEFAULT, type NewsFetchResult, type PollSource, type SleepSource } from './esp32'

/** The value that means "the board's own built-in interval" — POST /api/sleep's `0`. */
const SLEEP_PRESET_DEFAULT = SLEEP_SECONDS_DEFAULT

/**
 * Page index → the app's label, in the firmware's order (ui_news.c).
 *
 * There are two. The board also reports its own `pageTitle` — "FRONT PAGE" / "MARKETS" — which is
 * what is actually printed on the sheet; these are the switcher's labels, which name the pages the
 * way a reader holding the paper would.
 */
export const PAGE_LABELS = ['A1 Front', 'A2 Accounts'] as const

export function pageLabel(page: number): string {
  return PAGE_LABELS[page] ?? `Page ${page}`
}

/** Thousands-separated count. Returns '—' for non-finite. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('en-US')
}

/**
 * Money, from the integer cents the wire carries.
 *
 * NO CURRENCY SYMBOL, deliberately. Nothing in `/api/state` says which currency this is, and the
 * board is as happy printing a Korean listing as an American one — so a `$` here would be the app
 * inventing a fact. The decimal point is the app's to place (docs/app-control.md says so
 * explicitly), and this is the only place it places one.
 *
 * Split with integer arithmetic rather than `(cents / 100).toFixed(2)`: the division is the one
 * step in this file that could put a float between the wire and the screen, and 1631.465 rounding
 * to 1631.46 or 1631.47 depending on the engine is not a difference worth having.
 */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return '—'
  const n = Math.round(cents)
  const abs = Math.abs(n)
  const whole = Math.floor(abs / 100).toLocaleString('en-US')
  const frac = String(abs % 100).padStart(2, '0')
  return `${n < 0 ? '-' : ''}${whole}.${frac}`
}

/**
 * A change, from the basis points the wire carries: `bp = pct × 100`, so 62 is +0.62%.
 *
 * Signed, and a zero carries NO sign — "+0.00%" claims a direction the number does not have.
 */
export function formatChange(bp: number): string {
  if (!Number.isFinite(bp)) return '—'
  const n = Math.round(bp)
  const abs = Math.abs(n)
  const body = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`
  if (n > 0) return `+${body}`
  if (n < 0) return `-${body}`
  return body
}

/**
 * "12s" / "3m" / "1h ago" style age for `source.ageSeconds`.
 *
 * -1 is the board's "no poll has ever succeeded", which is a different fact from "0 seconds ago"
 * and must not render as one — a board that has never reached its server would otherwise look
 * freshly synced.
 */
export function formatAge(ageSec: number): string {
  if (!Number.isFinite(ageSec) || ageSec < 0) return 'never'
  if (ageSec < 60) return `${Math.round(ageSec)}s ago`
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`
  return `${Math.round(ageSec / 86400)}d ago`
}

/**
 * An interval as "every 45s" / "every 5m" / "every 6h".
 *
 * It runs to hours because the same function renders the SLEEP interval, which the board clamps at
 * a day: "every 1440m" is a number nobody can picture.
 */
export function formatInterval(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `every ${Math.round(seconds)}s`
  if (seconds < 3600) {
    const m = seconds / 60
    return `every ${Number.isInteger(m) ? m : m.toFixed(1)}m`
  }
  const h = seconds / 3600
  return `every ${Number.isInteger(h) ? h : h.toFixed(1)}h`
}

/**
 * The measured refresh time. Zero means the firmware has not refreshed since boot, which is "not
 * measured yet" — printing "0 ms" would read as an impossibly fast e-Paper panel.
 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** A sentence for each `source.lastResult`, saying what to go and check. */
export function fetchResultMessage(result: NewsFetchResult): string {
  switch (result) {
    case 'ok':
      return 'Last poll succeeded.'
    case 'not_modified':
      return 'The board asked and the desk said nothing had changed. That is a successful poll.'
    case 'no_url':
      return 'No news URL set — the board is showing its built-in demo edition.'
    case 'transport':
      return 'Couldn’t reach that address. Is the machine serving it awake and on this network?'
    case 'http_status':
      return 'The server answered, but with an error. Check the path in the address.'
    case 'bad_payload':
      return 'The server answered with something that isn’t an edition.'
    default:
      return 'The board reported a result this app doesn’t recognise.'
  }
}

/** Short status word for the chip beside the edition. */
export function fetchResultLabel(result: NewsFetchResult): string {
  switch (result) {
    case 'ok':
      return 'synced'
    case 'not_modified':
      return 'up to date'
    case 'no_url':
      return 'demo'
    case 'transport':
      return 'unreachable'
    case 'http_status':
      return 'server error'
    case 'bad_payload':
      return 'bad payload'
    default:
      return 'unknown'
  }
}

export type Tone = 'up' | 'down' | 'warn' | 'neutral'

/**
 * Chip colour for a fetch result.
 *
 * Two of these are load-bearing. `not_modified` is a 304 and a SUCCESS — the most common outcome
 * there is on a board polling all day, so colouring it as a failure would paint a healthy board
 * red for most of its life. `no_url` is neutral, not a warning: a board with no URL is a complete,
 * working product showing its demo edition, not a broken one.
 */
export function fetchResultTone(result: NewsFetchResult): Tone {
  switch (result) {
    case 'ok':
    case 'not_modified':
      return 'up'
    case 'no_url':
      return 'neutral'
    case 'transport':
    case 'http_status':
    case 'bad_payload':
      return 'down'
    default:
      return 'warn'
  }
}

/** Green for a rise, red for a fall, and nothing at all for a price that did not move. */
export function changeTone(bp: number): Tone {
  if (!Number.isFinite(bp) || Math.round(bp) === 0) return 'neutral'
  return bp > 0 ? 'up' : 'down'
}

/**
 * Who set the poll cadence in force.
 *
 * Not decoration: an hourly poll the desk asked for ends when its quiet window does, and an hourly
 * poll built into the image does not. A reader who cannot tell which cannot tell whether the
 * number will still be true tomorrow.
 */
export function pollSourceLabel(source: PollSource): string {
  return source === 'policy' ? 'set by the desk' : 'built into this board'
}

/** Which of the four layers set the sleep interval (docs/app-control.md's table). */
export function sleepSourceLabel(source: SleepSource): string {
  switch (source) {
    case 'policy':
      return 'set by the desk'
    case 'api':
      return 'set from this app'
    case 'nvs':
      return 'set during setup'
    default:
      return 'the board’s built-in default'
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `news.generatedAt` — the producer's own timestamp — as a line a reader can compare with the
 * dateline printed on the sheet.
 *
 * Sliced out of the ISO string rather than parsed through `Date`, ON PURPOSE. The reader is
 * standing in front of the paper, and the paper carries the moment the desk chose; a phone in
 * another timezone rendering "13 Aug, 22:12" beside a sheet that says the 14th is the app
 * disagreeing with the thing it is describing. Anything that is not an ISO timestamp is shown as
 * it arrived — a producer sending something else is a producer bug, and this is where it is seen.
 */
export function formatGeneratedAt(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return iso
  const month = MONTHS[Number(m[2]) - 1]
  if (!month) return iso
  return `${Number(m[3])} ${month} ${m[1]}, ${m[4]}:${m[5]}${iso.endsWith('Z') ? ' UTC' : ''}`
}

/**
 * Which sleep interval is actually in force, as a value a caller can match a preset against — or
 * null when none of them is.
 *
 * The order matters and it is not the obvious one: **which layer won decides before the number
 * does.** `sleepSeconds` is the EFFECTIVE interval, so under `policy` it is the desk's cadence
 * rather than anything the user stored, and matching a preset to it would claim they chose a
 * figure the desk chose. Under `default` the compiled-in interval is in force, and on this build
 * that is 900 — exactly the "15m" preset — so answering with the number would light 15m and say
 * the user had picked it. `default` is a LAYER, not a figure, so it answers with its own sentinel.
 *
 * `default` counts as in force at all because it is one of the three LOCAL layers the desk
 * outranks (docs/app-control.md's table): policy, then api, then nvs, then default. A board
 * running on its built-in interval is in a state one of the chips describes precisely, and leaving
 * every chip dark there makes a tap on "Default" look like a tap that was lost.
 */
export function sleepPresetInForce(source: SleepSource, sleepSeconds: number): number | null {
  if (source === 'policy') return null
  if (source === 'default') return SLEEP_PRESET_DEFAULT
  return sleepSeconds
}

const DAY_ABBR: Record<string, string> = {
  SUNDAY: 'SUN',
  MONDAY: 'MON',
  TUESDAY: 'TUE',
  WEDNESDAY: 'WED',
  THURSDAY: 'THU',
  FRIDAY: 'FRI',
  SATURDAY: 'SAT',
}

const MONTH_ABBR: Record<string, string> = {
  JANUARY: 'JAN',
  FEBRUARY: 'FEB',
  MARCH: 'MAR',
  APRIL: 'APR',
  MAY: 'MAY',
  JUNE: 'JUN',
  JULY: 'JUL',
  AUGUST: 'AUG',
  SEPTEMBER: 'SEP',
  OCTOBER: 'OCT',
  NOVEMBER: 'NOV',
  DECEMBER: 'DEC',
}

/**
 * `news.dateline` ("FRIDAY, AUGUST 14, 2026") to the masthead's dateline row ("FRI, AUG 14").
 *
 * Shown as it arrived on anything that doesn't parse — same posture as `formatGeneratedAt()`: a
 * producer bug belongs on screen, not silently hidden behind a fallback that looks plausible.
 */
export function formatDateline(dateline: string): string {
  const m = /^([A-Za-z]+),\s*([A-Za-z]+)\s+(\d{1,2}),?\s*\d{4}$/.exec(dateline.trim())
  if (!m) return dateline
  const day = DAY_ABBR[m[1].toUpperCase()]
  const month = MONTH_ABBR[m[2].toUpperCase()]
  if (!day || !month) return dateline
  return `${day}, ${month} ${Number(m[3])}`
}

/**
 * `WatchlistItem.last_printed` ("2026-08-12") as the Watch row's "printed AUG 12" stamp (Task 27).
 * The caller supplies "printed "; this only turns the date into the paper's own month
 * abbreviation, reusing the `MONTHS` table `formatGeneratedAt()` already carries.
 *
 * Shown as it arrived on anything that isn't `YYYY-MM-DD` — `formatDateline()`'s own posture: a
 * desk sending something else is a desk bug, and this is where it would be seen, not hidden.
 * The caller omits the whole stamp for `null`; this function is never asked about that case.
 */
export function formatPrintedDate(dateISO: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateISO)
  if (!m) return dateISO
  const month = MONTHS[Number(m[2]) - 1]
  if (!month) return dateISO
  return `${month.toUpperCase()} ${Number(m[3])}`
}

/**
 * An edition's `published_at` (epoch seconds) as a "06:04" stamp — `<OnTheGlass>`'s
 * "hangs there since" line.
 *
 * UTC, not the phone's own zone: `formatGeneratedAt()`'s reasoning applies again — a reader must
 * not see a different hour than the desk's own record because of where the phone happens to be.
 * Empty for anything that isn't a real past instant, so the caller omits the stamp rather than
 * printing a clock reading midnight 1970.
 */
export function formatSinceTime(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return ''
  const d = new Date(epochSeconds * 1000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * An instant's UTC calendar date, as the paper's own "NOV 14" stamp — or '' when it is not an
 * instant at all.
 *
 * The one place this app turns an epoch second into a date, so `formatPrintedDate()`'s month table
 * is not re-implemented beside every caller. UTC, for `formatSinceTime()`'s reason: the desk's
 * record is the desk's, and a phone in another zone printing a different day than the desk's log is
 * the app disagreeing with the thing it is describing.
 */
export function formatDateStamp(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return ''
  const d = new Date(epochSeconds * 1000)
  const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
  return formatPrintedDate(ymd)
}

/**
 * An instant a reader can act on: `"23:13"` when it falls on the same UTC day as `now`, and
 * `"NOV 15, 22:13"` the moment it does not.
 *
 * THE SWITCH IS THE CALENDAR DAY, NOT A 24-HOUR WINDOW, and that is the whole function. A hold set
 * at 22:13 to last a day targets 22:13 TOMORROW; printed as a bare clock it is character-identical
 * to the moment it was set, so for the next twenty-three hours it reads as a hold that ran out a
 * minute ago — and the reader's rational response is to set another one. Two hours is enough to
 * cross midnight and produce the same lie in the other direction. Only the date settles it.
 *
 * `auditWhen()` (src/lib/audit.ts) makes the opposite call deliberately: an audit row carries its
 * own age ("3m ago"), which already says which day it was, so the clock beside it is never
 * ambiguous and the date only takes over once the age stops being precise. A hold has no age
 * beside it, so it needs the date sooner.
 *
 * `now` is the DESK's clock wherever one is available, not the phone's — same rule as everywhere
 * else that reads an instant off `/api/state`.
 */
export function formatWhen(epochSeconds: number, nowSeconds: number): string {
  const clock = formatSinceTime(epochSeconds)
  if (clock === '') return ''
  const at = new Date(epochSeconds * 1000)
  const now = new Date(nowSeconds * 1000)
  const sameDay =
    at.getUTCFullYear() === now.getUTCFullYear() &&
    at.getUTCMonth() === now.getUTCMonth() &&
    at.getUTCDate() === now.getUTCDate()
  return sameDay ? clock : `${formatDateStamp(epochSeconds)}, ${clock}`
}
