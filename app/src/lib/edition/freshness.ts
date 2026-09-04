// How old the thing on screen is, said in tiers rather than to the second.
//
// The point of the tiers is that an edition changes about once a day, so a live-ticking "23
// seconds ago" is precision about a quantity nobody is watching, and it makes a page that is
// perfectly current look like it is being monitored. Under five minutes there is nothing worth
// saying at all, and saying nothing is the design: an unlabelled page reads as current.
//
// `fetchedAt` is the last time the SERVER CONFIRMED THE CONTENT — a 200 or a 304 — not the last
// time it changed. That is the question the line answers: "is what I am reading still what the
// desk is serving?"

import { months } from '../months'
import { fill, strings } from '../../i18n'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * `null` under five minutes, then `Updated 12m ago`, `Updated 3h ago`, `Last updated yesterday`,
 * and finally `Last updated 30 Aug`.
 *
 * The minute tier runs to sixty and not to the thirty the design table names: at thirty-five
 * minutes the hour tier would render `Updated 0h ago`, which reads as a bug. Every label the
 * table actually shows is unchanged.
 *
 * Local time, not UTC. This is a phone telling its owner how long ago something happened on
 * their own clock; a date rendered in UTC would name yesterday to anyone east of Greenwich in
 * the evening.
 *
 * `fetchedAt` of 0 (the demo edition — no server ever confirmed it) and a stamp in the future
 * (a clock that moved backwards) both answer null. There is nothing true to say in either case,
 * and "Updated -60m ago" is worse than silence.
 */
export function freshnessLabel(fetchedAt: number, now: number): string | null {
  const t = strings().freshness
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return null
  const age = now - fetchedAt
  if (age < 5 * MINUTE) return null
  if (age < HOUR) return fill(t.minutes, { n: String(Math.floor(age / MINUTE)) })
  if (age < DAY) return fill(t.hours, { n: String(Math.floor(age / HOUR)) })
  if (age < 2 * DAY) return t.yesterday
  const d = new Date(fetchedAt)
  return fill(t.date, { day: String(d.getDate()), month: months()[d.getMonth()] })
}
