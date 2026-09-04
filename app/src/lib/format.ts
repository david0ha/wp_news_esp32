// Pure display formatters for the dashboard. Kept tiny and testable so the same number is
// rendered the same way everywhere and nothing throws on the board's loosely-typed JSON.
//
// EVERY SENTENCE HERE IS READ FROM THE CATALOGUE INSIDE THE CALL, never captured at module scope.
// These are the functions a screen imports once at startup and calls on every render, so a
// `const MSG = strings().…` beside the imports would answer in whatever language was current when
// the bundle loaded — English, always, since the provider has not run yet — and no test that
// exercised one function would ever see it. `format.test.ts`'s Korean block is what holds this.

import { months } from './months'
import { fill, strings } from '../i18n'
import { SLEEP_SECONDS_DEFAULT, type NewsFetchResult, type PollSource, type SleepSource } from './esp32'

/** The value that means "the board's own built-in interval" — POST /api/sleep's `0`. */
const SLEEP_PRESET_DEFAULT = SLEEP_SECONDS_DEFAULT

/**
 * The app's label for each page, in the firmware's order (ui_news.c).
 *
 * There are two. The board also reports its own `pageTitle` — "FRONT PAGE" / "MARKETS" — which is
 * what is actually printed on the sheet; these are the switcher's labels, which name the pages the
 * way a reader holding the paper would.
 */
export function pageLabels(): readonly string[] {
  const { front, accounts } = strings().format.pages
  return [front, accounts]
}

export function pageLabel(page: number): string {
  return pageLabels()[page] ?? fill(strings().format.pages.other, { n: String(page) })
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
  const ago = strings().format.ago
  if (!Number.isFinite(ageSec) || ageSec < 0) return ago.never
  if (ageSec < 60) return fill(ago.seconds, { n: String(Math.round(ageSec)) })
  if (ageSec < 3600) return fill(ago.minutes, { n: String(Math.round(ageSec / 60)) })
  if (ageSec < 86400) return fill(ago.hours, { n: String(Math.round(ageSec / 3600)) })
  return fill(ago.days, { n: String(Math.round(ageSec / 86400)) })
}

/**
 * An interval as "every 45s" / "every 5m" / "every 6h".
 *
 * It runs to hours because the same function renders the SLEEP interval, which the board clamps at
 * a day: "every 1440m" is a number nobody can picture.
 */
export function formatInterval(seconds: number): string {
  const interval = strings().format.interval
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return fill(interval.seconds, { n: String(Math.round(seconds)) })
  if (seconds < 3600) {
    const m = seconds / 60
    return fill(interval.minutes, { n: Number.isInteger(m) ? String(m) : m.toFixed(1) })
  }
  const h = seconds / 3600
  return fill(interval.hours, { n: Number.isInteger(h) ? String(h) : h.toFixed(1) })
}

/**
 * The measured refresh time. Zero means the firmware has not refreshed since boot, which is "not
 * measured yet" — printing "0 ms" would read as an impossibly fast e-Paper panel.
 *
 * `ms` and `s` are SI symbols and stay out of the catalogue, for the same reason "Wi-Fi" and "IP"
 * do: they are what a Korean phone's own settings print, and a translation would make the figure
 * harder to read rather than easier.
 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** A sentence for each `source.lastResult`, saying what to go and check. */
export function fetchResultMessage(result: NewsFetchResult): string {
  const m = strings().format.fetchMessage
  switch (result) {
    case 'ok':
      return m.ok
    case 'not_modified':
      return m.notModified
    case 'no_url':
      return m.noUrl
    case 'transport':
      return m.transport
    case 'http_status':
      return m.httpStatus
    case 'bad_payload':
      return m.badPayload
    default:
      return m.unknown
  }
}

/** Short status word for the chip beside the edition. */
export function fetchResultLabel(result: NewsFetchResult): string {
  const l = strings().format.fetchLabel
  switch (result) {
    case 'ok':
      return l.ok
    case 'not_modified':
      return l.notModified
    case 'no_url':
      return l.noUrl
    case 'transport':
      return l.transport
    case 'http_status':
      return l.httpStatus
    case 'bad_payload':
      return l.badPayload
    default:
      return l.unknown
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
  const s = strings().format.pollSource
  return source === 'policy' ? s.policy : s.board
}

/** Which of the four layers set the sleep interval (docs/app-control.md's table). */
export function sleepSourceLabel(source: SleepSource): string {
  const s = strings().format.sleepSource
  switch (source) {
    case 'policy':
      return s.policy
    case 'api':
      return s.api
    case 'nvs':
      return s.nvs
    default:
      return s.default
  }
}

/**
 * `news.generatedAt` — the producer's own timestamp — as a line a reader can compare with the
 * dateline printed on the sheet.
 *
 * Sliced out of the ISO string rather than parsed through `Date`, ON PURPOSE. The reader is
 * standing in front of the paper, and the paper carries the moment the desk chose; a phone in
 * another timezone rendering "13 Aug, 22:12" beside a sheet that says the 14th is the app
 * disagreeing with the thing it is describing. Anything that is not an ISO timestamp is shown as
 * it arrived — a producer sending something else is a producer bug, and this is where it is seen.
 *
 * The ORDER is the catalogue's, not this function's. English reads "14 Aug 2026, 13:12"; Korean
 * counts down from the year, "2026년 8월 14일 13:12". So the template names its four parts and
 * each language arranges them. The ` UTC` suffix stays outside it — a timezone is not a word.
 */
export function formatGeneratedAt(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return iso
  const month = months()[Number(m[2]) - 1]
  if (!month) return iso
  const stamp = fill(strings().format.generatedAt, {
    day: String(Number(m[3])),
    month,
    year: m[1],
    time: `${m[4]}:${m[5]}`,
  })
  return `${stamp}${iso.endsWith('Z') ? ' UTC' : ''}`
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
