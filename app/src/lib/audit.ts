// The desk's own record of what it has done, as one line a person can read — the timeline at the
// foot of the Desk tab (plan Task 29).
//
// The desk writes six events (`store.audit(...)` in editions.py and http.py: commit, stage,
// publish, hold, schedule, watchlist) and each carries a `detail` object of its own shape. This
// file is the only place that knows those shapes, and it is deliberately TOTAL: an event it has
// never seen prints its own name rather than vanishing, and a detail key it cannot read is dropped
// rather than rendered as "undefined". A timeline that hides rows it does not understand is worse
// than useless — it is a record that looks complete.

import type { AuditEntry } from './desk'
import { formatAge, formatDateStamp, formatSinceTime } from './format'

/** Edition ids are hex fingerprints. Eight characters is what the desk's own logs print. */
function shortId(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 8) : ''
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** `head` with ` — tail` after it, and just `head` when there is no tail. */
function joined(head: string, tail: string): string {
  return tail === '' ? head : `${head} — ${tail}`
}

/** `head` with a short edition id and then a tail, skipping whichever of the two is missing. */
function withEdition(head: string, eid: string, tail: string): string {
  return joined(eid === '' ? head : `${head} ${eid}`, tail)
}

/**
 * One audit row as a sentence.
 *
 * `commit` reads BOTH `edition` and `edition_id`. `editions.py` writes the first and
 * `scripts/mock-desk.js` writes the second, and a renderer that knew only one would print a bare
 * "Filed" against every commit row on one of the two — a difference that shows up in a screenshot
 * and nowhere else.
 */
export function auditEventLine(entry: AuditEntry): string {
  const d = entry.detail
  switch (entry.event) {
    case 'publish':
      return withEdition(
        'Published',
        shortId(d.edition ?? d.edition_id),
        d.forced === true ? 'forced' : asText(d.reason),
      )
    case 'stage':
      return withEdition('Staged', shortId(d.edition ?? d.edition_id), asText(d.reason))
    case 'commit':
      return withEdition('Filed', shortId(d.edition ?? d.edition_id), asText(d.state))
    case 'hold': {
      // The same event carries both facts, and they are opposites: `until` is an instant while
      // publishing is held, and `null` is the hold being lifted. "Held until —" would be the app
      // reporting the wrong one of the two.
      const until = typeof d.until === 'number' ? formatSinceTime(d.until) : ''
      return until === '' ? 'Hold lifted' : `Held until ${until}`
    }
    case 'schedule':
      return joined('Schedule saved', asText(d.source))
    case 'watchlist': {
      const n = typeof d.items === 'number' && Number.isFinite(d.items) ? Math.round(d.items) : null
      return joined('Watchlist updated', n === null ? '' : `${n} ${n === 1 ? 'company' : 'companies'}`)
    }
    default:
      // An event this app has never heard of. Its own name is a true statement about it; anything
      // else here would be an invention.
      return entry.event
  }
}

const DAY_SECONDS = 86400

/**
 * When a row happened: an age, and then the instant itself.
 *
 * The instant switches form at a day, because they answer different questions. Inside the day
 * "13:30" places the event against the rest of the afternoon; three days back it is a clock
 * reading with no day attached, which says nothing — so the date takes over.
 *
 * Both halves are UTC, `formatSinceTime()`'s own rule: the desk's record is the desk's, and a phone
 * in another zone printing a different hour than the desk's log is the app disagreeing with the
 * thing it is describing.
 *
 * The switch is a 24-HOUR WINDOW here and a CALENDAR DAY in `formatWhen()`, and the difference is
 * deliberate: this row carries its own age in front of the clock, so "20h ago · 02:10" cannot be
 * misread whichever day it fell on. An instant with no age beside it — a hold's target — has no
 * such guard, which is why that one needs the date sooner. See `formatWhen()`.
 *
 * `now` is the DESK's clock (`DeskState.now`), not the phone's, so a phone a few seconds off does
 * not report the newest row as being in the future. It can still be slightly ahead of a row —
 * `/api/state` and `/api/audit` are two round trips — which is why the age is clamped at zero
 * rather than passed through to `formatAge()`, whose negative case means "never" and would print
 * the freshest event in the list as the one that never happened.
 */
export function auditWhen(atSec: number, nowSec: number): string {
  const age = formatAge(Math.max(0, nowSec - atSec))
  if (!Number.isFinite(atSec) || atSec <= 0) return age
  if (nowSec - atSec < DAY_SECONDS) return `${age} · ${formatSinceTime(atSec)}`
  return `${age} · ${formatDateStamp(atSec)}`
}
