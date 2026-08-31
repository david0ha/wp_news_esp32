// The schedule document as text a person can edit, and back — the Desk tab's SCHEDULE card.
//
// `PUT /api/schedule` replaces the WHOLE document and refuses an invalid one whole (desk.ts's
// `putSchedule`), so the editor's job is to get the round trip right rather than to be clever. Two
// consequences shape this file:
//
//   1. THE BOUNDS ARE MIRRORED FROM `server/claudepost/schedule.py`, not guessed. A field the desk
//      would refuse is refused here, with a sentence under it, instead of being sent and coming
//      back as a 400 the user has to map onto a field themselves.
//   2. ONE ENTRY PER LINE, never comma-separated. A wake's `days` is itself a comma-joined list
//      ("sat,sun" — schedule.py's `_days`), so a comma-separated list of wakes could not be split
//      unambiguously. The newline sidesteps that entirely and reads as a list on a phone.
//
// Every parser answers `null` for "this does not parse", never a partial or a repaired value: a
// schedule half-understood is a desk publishing against rules nobody wrote.

import type { QuietWindow, WakeTime } from './desk'

/** schedule.py's POLL_MIN_SECONDS / POLL_MAX_SECONDS. */
export const POLL_SECONDS_MIN = 30
export const POLL_SECONDS_MAX = 86400
/** schedule.py's MAX_MIN_GAP_MINUTES. The floor is 0 — "no minimum gap" is a legal answer. */
export const MIN_GAP_MINUTES_MAX = 1440
/** schedule.py's MAX_QUIET_WINDOWS / MAX_WAKE_TIMES. */
export const QUIET_WINDOWS_MAX = 4
export const WAKE_TIMES_MAX = 12

/** schedule.py's `_HHMM_RE`, character for character. */
const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/** schedule.py's DAY_NAMES, in its order — `_days()` indexes weekday numbers out of it. */
const DAY_NAMES: readonly string[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/** The non-blank lines of a multi-line field, trimmed. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

// ---------------------------------------------------------------------------
// Quiet windows — "00:30-06:00", one per line.
// ---------------------------------------------------------------------------

export function quietToText(quiet: readonly QuietWindow[]): string {
  return quiet.map((w) => `${w.from}-${w.to}`).join('\n')
}

/** The windows the text names, or `null` if any line is not two 24-hour clock times. */
export function parseQuietText(text: string): QuietWindow[] | null {
  const rows = lines(text)
  if (rows.length > QUIET_WINDOWS_MAX) return null
  const out: QuietWindow[] = []
  for (const row of rows) {
    const parts = row.split('-').map((p) => p.trim())
    if (parts.length !== 2) return null
    if (!HHMM_RE.test(parts[0]) || !HHMM_RE.test(parts[1])) return null
    out.push({ from: parts[0], to: parts[1] })
  }
  return out
}

// ---------------------------------------------------------------------------
// Wake times — "06:00" for all seven days, "12:40 sat,sun" for a filtered one.
// ---------------------------------------------------------------------------

/**
 * Back to text. A wake on all seven days is the bare clock time, which is the form
 * `schedule_to_dict()` writes and the form a person wrote it in — writing "06:00 mon,tue,wed,thu,
 * fri,sat,sun" instead would be the editor teaching its user a spelling the desk does not use.
 */
export function wakeToText(wake: readonly WakeTime[]): string {
  return wake.map((w) => (w.days === '' ? w.at : `${w.at} ${w.days}`)).join('\n')
}

/**
 * The wakes the text names, or `null`.
 *
 * The day list is normalised to lower case and tightened, because `_days()` lower-cases and strips
 * before it looks a name up, and a document that round-trips through this editor should come back
 * spelled the way the desk spells it rather than the way it was typed.
 */
export function parseWakeText(text: string): WakeTime[] | null {
  const rows = lines(text)
  if (rows.length > WAKE_TIMES_MAX) return null
  const out: WakeTime[] = []
  for (const row of rows) {
    const space = row.indexOf(' ')
    const at = space === -1 ? row : row.slice(0, space)
    if (!HHMM_RE.test(at)) return null
    const rest = space === -1 ? '' : row.slice(space + 1).trim()
    if (rest === '') {
      out.push({ at, days: '' })
      continue
    }
    const names = rest
      .split(',')
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n !== '')
    // `_days()` refuses a `days` key that names nothing — "omit the key to mean every day" — so a
    // line of nothing but commas is a mistake rather than a seven-day wake.
    if (names.length === 0) return null
    for (const n of names) {
      if (!DAY_NAMES.includes(n)) return null
    }
    out.push({ at, days: names.join(',') })
  }
  return out
}

// ---------------------------------------------------------------------------
// The three integer fields.
// ---------------------------------------------------------------------------

/**
 * A whole number inside `low..high`, or `null`.
 *
 * The regex, rather than `Number()`, is what makes this mirror `schedule.py`'s `_int()`: that
 * refuses anything which is not an `int`, and `Number('90.5')`, `Number('9e2')` and `Number('')`
 * are all values JavaScript would hand over happily. A phone that rounded 90.5 to 90 would be
 * sending a figure its user never typed.
 */
export function parseBoundedInt(text: string, low: number, high: number): number | null {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  if (!Number.isSafeInteger(n)) return null
  return n >= low && n <= high ? n : null
}

// ---------------------------------------------------------------------------
// One transition, short enough for a row.
// ---------------------------------------------------------------------------

/** `"%Y-%m-%d %H:%M"` — the head of the desk's own `local`, before the zone it appends. */
const LOCAL_HEAD_RE = /^(\d{4}-\d{2}-\d{2} ([01][0-9]|2[0-3]):[0-5][0-9])\b/

/**
 * A `ScheduleTransition.local` with the trailing zone dropped: "2026-08-31 22:00 KST" → "2026-08-31
 * 22:00".
 *
 * The zone is dropped because it is a CONSTANT on that row — every transition the desk sends is in
 * the one zone its schedule names, and the schedule card prints that zone once, in the field that
 * owns it. What the strip has instead of eleven repeated characters is room for the transition's
 * date, which is the part that changes.
 *
 * Cutting the string rather than reformatting `at` is the whole point: time-zone arithmetic is what
 * everybody gets wrong, so the desk prints it (desk.ts's `ScheduleTransition`) and the phone does
 * not recompute it. Anything that is not the desk's own spelling is shown exactly as it arrived —
 * `formatDateline()`'s posture, so a desk bug is visible rather than hidden behind a plausible
 * fallback.
 */
export function transitionClock(local: string): string {
  const m = LOCAL_HEAD_RE.exec(local.trim())
  return m === null ? local : m[1]
}
