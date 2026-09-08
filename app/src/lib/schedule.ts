// The event book, as the phone reads and draws it.
//
// The desk's `server/claudepost/calendar.py` is the contract and this file is its reader. The
// paper answers *what happened*; this answers *what is about to happen, and what it does to your
// money* — dates the agent researched, each one annotated against a position the owner actually
// holds. There is no write half: `/api/calendar` is `producer` on both verbs because the AGENT
// files the book, and the phone only ever asks for it.
//
// THREE THINGS THIS FILE IS BUILT AROUND, each of them a rule from the design:
//
// **The source rule (§2).** Every event carries where its date came from — `"computed"` for the
// four kinds a machine knows exactly, an `https://` URL for a date somebody had to read for. A
// date with neither does not go on the wall, and `parseEvent` drops one rather than drawing a row
// a reader would trust equally. `sourceBadge` is that rule made visible: computed draws nothing
// (it is not in question), researched draws its domain and opens it.
//
// **Precision is a field, not a formatting choice.** An event known only to the day must never
// render as a clock. Inventing `09:30` for it is how a reader misses the one that mattered —
// they looked in the morning and it happened in the evening — so `timeLabel` renders exactly the
// precision the event has and `test_never invents a time` is the regression that pins it.
//
// **The wire is UTC and the rail is local, always, both directions.** `at` is a UTC stamp; the
// reader's `21:30` is their own zone, and the DAY GROUPING is their own day too, or an event at
// 23:00Z lands under a heading that says 오늘 when it is already tomorrow where they are. Every
// instant→calendar-parts conversion in this file goes through `partsOf` and nothing else.
//
// THE POSTURE ON A BAD FIELD IS THE OPPOSITE OF `positions.ts`, and the difference is worth
// stating because the two files sit beside each other. That one is STRICT — one unreadable
// position fails the whole document — because the app reads that book, edits one row and PUTs the
// whole thing back, so a silently dropped row would be *deleted* on the next write. This book is
// read-only. Nothing the phone does can write it back, so a dropped event costs exactly one row
// on one screen, and refusing the whole book over one malformed entry would hide nine good dates
// to protect the reader from a tenth.

import { fill, type Strings } from '../i18n'
import { colors } from '../theme'
import { strategyLabel, type OptionLeg, type PositionsDoc } from './positions'

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** `calendar.py`'s `PRECISIONS`. Governs `session` and what the left rail may say. */
export const PRECISIONS = ['exact', 'session', 'day'] as const
export type EventPrecision = (typeof PRECISIONS)[number]

/** Before market open / after market close — the only two answers a company gives when it says
 *  *when*, and the only two the rail renders as words rather than as a clock. */
export const SESSIONS = ['bmo', 'amc'] as const
export type EventSession = (typeof SESSIONS)[number]

export const KINDS = [
  'econ',
  'earnings',
  'dividend',
  'expiry',
  'corporate',
  'legal',
  'index',
  'other',
] as const
export type EventKind = (typeof KINDS)[number]

export const DIRECTIONS = ['for', 'against', 'both'] as const
export type AffectDirection = (typeof DIRECTIONS)[number]

/** `source` for a date a machine computed rather than read for. The one value that is not a URL. */
export const COMPUTED = 'computed'

/** How one event reaches one position, and why. The `reason` is the only thing in the system that
 *  knows both the date and the strike; nothing on this side writes or edits one. */
export interface EventAffect {
  /** Points into `positionsDoc.positions[].id`. May name a position this phone's copy of the book
   *  no longer holds — see `positionLine`. */
  positionId: string
  direction: AffectDirection
  /** The paragraph, shown when the row is opened. */
  reason: string
  /** The one sentence, shown at two lines in the closed row. */
  reasonShort: string
}

export interface CalendarEvent {
  id: string
  /** ALWAYS UTC, `YYYY-MM-DDTHH:MM:SSZ`. Never rendered as it arrives. */
  at: string
  precision: EventPrecision
  /** Present exactly when `precision` is `session`, and `null` otherwise — a session hung on an
   *  exact time would contradict the clock beside it. */
  session: EventSession | null
  title: string
  kind: EventKind
  /** `computed`, or the URL the date was found at. */
  source: string
  symbols: string[]
  /** 1 is most important. It decides which events the agent FILED; it does not order this
   *  screen — see `groupByDay`. */
  rank: number
  push: { title: string; body: string } | null
  /** Required and non-empty on the wire: an event whose reasoning reaches no position is a
   *  generic calendar entry, and the phone already has one of those. */
  affects: EventAffect[]
}

export interface CalendarDoc {
  /** The desk's own stamp, or `''` when it sent none — `calendar.load` fails that field soft. */
  generatedAt: string
  /** The language the agent WROTE in, which is the edition's and not the app's. Read, never
   *  branched on: every sentence in this document is already in it. */
  lang: string
  /** How many events the agent was asked to clear the floor with. */
  target: number
  /** The agent's sentence about what it could not cover, when fewer than `target` cleared. */
  shortfall: string | null
  events: CalendarEvent[]
}

// ---------------------------------------------------------------------------
// The wire, inbound
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

/** `calendar.py`'s `_STAMP_RE`. A stamp in any other spelling is a field this app misread. */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

function parseAffect(v: unknown): EventAffect | null {
  if (!isObj(v)) return null
  const positionId = str(v.position_id)
  const direction = oneOf<AffectDirection>(v.direction, DIRECTIONS)
  const reasonShort = str(v.reason_short)
  if (positionId === '' || direction === null || reasonShort === '') return null
  // The paragraph is allowed to be missing where the sentence is not: a row that cannot be opened
  // is a smaller loss than a row with nothing on it.
  return { positionId, direction, reason: str(v.reason), reasonShort }
}

function parsePush(v: unknown): { title: string; body: string } | null {
  if (!isObj(v)) return null
  const title = str(v.title)
  const body = str(v.body)
  return title === '' || body === '' ? null : { title, body }
}

function parseEvent(v: unknown): CalendarEvent | null {
  if (!isObj(v)) return null
  const id = str(v.id)
  const at = str(v.at)
  const title = str(v.title)
  const source = str(v.source)
  const precision = oneOf<EventPrecision>(v.precision, PRECISIONS)
  if (id === '' || title === '' || precision === null) return null
  if (!STAMP_RE.test(at) || Number.isNaN(Date.parse(at))) return null
  // §2 at the door of the phone as well as at the door of the desk. The desk already refuses a
  // sourceless event; drawing one anyway would make this the single place the rule leaked.
  if (source === '') return null

  // The precision governs the session both ways: it is required where the rail has no clock to
  // draw, and ignored where it does.
  const session = precision === 'session' ? oneOf<EventSession>(v.session, SESSIONS) : null
  if (precision === 'session' && session === null) return null

  const affects: EventAffect[] = []
  if (Array.isArray(v.affects)) {
    for (const one of v.affects) {
      const affect = parseAffect(one)
      if (affect !== null) affects.push(affect)
    }
  }
  if (affects.length === 0) return null

  const symbols = Array.isArray(v.symbols)
    ? v.symbols.filter((s): s is string => typeof s === 'string' && s !== '')
    : []

  return {
    id,
    at,
    precision,
    session,
    title,
    // A kind this build has no icon for is `other`, which is `parsePositionsDoc`'s argument for
    // `custom`: a desk one release ahead of the phone is not a reason to hide a date the owner can
    // act on.
    kind: oneOf<EventKind>(v.kind, KINDS) ?? 'other',
    source,
    symbols,
    // Zero when the desk sent none. It cannot reorder anything a reader sees — the screen is
    // ordered by time — so the default is only ever a tie-break between two events at the very
    // same instant.
    rank: int(v.rank) ?? 0,
    push: parsePush(v.push),
    affects,
  }
}

/**
 * The event book, or `null` when what arrived is not one.
 *
 * Total and never throwing — `desk.ts` is the one that knows how to refuse — and lenient per
 * event for the reason in the module docstring. `events` is the one field whose absence makes
 * this not a document at all: a desk that answered 200 without it is not speaking this contract,
 * and reading that as an empty book would draw "nothing coming up" over a desk that never said so.
 */
export function parseCalendarDoc(v: unknown): CalendarDoc | null {
  if (!isObj(v)) return null
  if (!Array.isArray(v.events)) return null
  const events: CalendarEvent[] = []
  for (const one of v.events) {
    const parsed = parseEvent(one)
    if (parsed !== null) events.push(parsed)
  }
  const shortfall = str(v.shortfall)
  return {
    generatedAt: str(v.generated_at),
    lang: str(v.lang),
    target: int(v.target) ?? 0,
    shortfall: shortfall === '' ? null : shortfall,
    events,
  }
}

// ---------------------------------------------------------------------------
// The timezone seam
//
// ONE conversion from an instant to calendar parts, and every reader of a clock or a day in this
// file goes through it. `tz` is optional and OMITTED IN PRODUCTION: with no argument this uses
// `Date`'s own local getters, which is the device's zone, which is what the rail must show. A test
// passes an IANA name and gets `Intl` instead, so the same grouping and the same formatting the
// device runs are what the assertions exercise.
//
// Keeping `Intl` off the production path is deliberate rather than incidental — the app uses it
// nowhere else, and a formatter constructed per row on a list is the kind of cost that does not
// show up until somebody has forty events and an older phone. The local getters need no ICU data
// at all.
// ---------------------------------------------------------------------------

interface DateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function partsOf(at: Date, tz?: string): DateParts {
  if (tz === undefined) {
    return {
      year: at.getFullYear(),
      month: at.getMonth() + 1,
      day: at.getDate(),
      hour: at.getHours(),
      minute: at.getMinutes(),
    }
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    // `h23` and not `hour12: false`, which spells midnight `24` in some engines and would put a
    // 24:00 on a rail.
    hourCycle: 'h23',
  }).formatToParts(at)
  const read = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0')
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** `YYYY-MM-DD` in the zone the parts were read in. Ordering these as strings orders the days. */
function dateKey(p: DateParts): string {
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}

/** The parts of a `YYYY-MM-DD` key, as numbers. */
function keyParts(date: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (m === null) return null
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

/**
 * Calendar arithmetic on a day KEY, done at UTC noon and therefore zone-free.
 *
 * A key names a day, not an instant, so shifting one has nothing to do with any zone's clocks —
 * doing it through a local `Date` would make "tomorrow" wrong on the two days a year a zone skips
 * or repeats an hour.
 */
function shiftDay(date: string, days: number): string {
  const p = keyParts(date)
  if (p === null) return date
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days, 12))
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** `Date.getDay()`'s index — Sunday 0 — for a day key, in no zone at all. */
function weekdayOf(date: string): number {
  const p = keyParts(date)
  if (p === null) return 0
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

/** Whole days from one day KEY to another, `shiftDay`'s arithmetic run backwards and for the same
 *  reason: a day is not 86,400 seconds in every zone, but it is exactly one step in a calendar. */
function daysBetween(from: string, to: string): number | null {
  const a = keyParts(from)
  const b = keyParts(to)
  if (a === null || b === null) return null
  const ms = Date.UTC(b.year, b.month - 1, b.day, 12) - Date.UTC(a.year, a.month - 1, a.day, 12)
  return Math.round(ms / 86_400_000)
}

// ---------------------------------------------------------------------------
// The heading and the rail
// ---------------------------------------------------------------------------

/**
 * A day group's heading — `오늘 · 9월 8일 (화)`, `Sep 15 (Tue)`.
 *
 * The two near days are named because that is what a reader scanning a schedule is actually
 * asking; everything further out is only dated, because "in 7 days" is arithmetic somebody then
 * has to do again against their own calendar.
 */
export function dayLabel(date: string, now: Date, t: Strings, tz?: string): string {
  const p = keyParts(date)
  const dated =
    p === null
      ? date
      : fill(t.schedule.day.dated, {
          month: t.months.short[p.month - 1] ?? '',
          day: String(p.day),
          weekday: t.weekdays.short[weekdayOf(date)] ?? '',
        })
  const today = dateKey(partsOf(now, tz))
  if (date === today) return fill(t.schedule.day.today, { date: dated })
  if (date === shiftDay(today, 1)) return fill(t.schedule.day.tomorrow, { date: dated })
  return dated
}

/**
 * The left rail, at exactly the precision the event has: `21:30`, `장 마감 후`, `종일`.
 *
 * The `at` of a day- or session-precision event is a real instant on the wire — it has to be, the
 * desk sorts and windows by it — and rendering it would be the app asserting a time nobody
 * published. That is the failure this function exists to make impossible, not merely to avoid.
 */
export function timeLabel(
  event: { precision: EventPrecision; session?: EventSession | null; at?: string },
  t: Strings,
  tz?: string,
): string {
  const w = t.schedule.when
  if (event.precision === 'session') {
    return event.session === 'bmo' ? w.bmo : event.session === 'amc' ? w.amc : w.allDay
  }
  if (event.precision === 'day') return w.allDay
  const at = new Date(event.at ?? '')
  if (Number.isNaN(at.getTime())) return w.allDay
  const p = partsOf(at, tz)
  return `${pad2(p.hour)}:${pad2(p.minute)}`
}

// ---------------------------------------------------------------------------
// The grouping
// ---------------------------------------------------------------------------

export interface DayGroup {
  /** `YYYY-MM-DD` in the reader's own zone. */
  date: string
  events: CalendarEvent[]
}

/**
 * The book as the screen draws it: by local day, in time order, with what is already behind the
 * reader dropped.
 *
 * **By local day.** An event at 23:00Z is tomorrow in Seoul, and filing it under today puts it
 * above a heading that says 오늘.
 *
 * **In time order, not by rank.** `rank` decided which events the agent filed; it says nothing
 * about when they happen, and a schedule sorted by importance is a schedule nobody can read
 * forwards. Rank breaks a tie only between two events at the identical instant, where the array's
 * own order would otherwise decide it.
 *
 * **Nothing behind the reader.** The desk keeps a week of past events on purpose — a print that
 * just landed is still worth showing, and the book is not rewritten the instant it does — but a
 * schedule that opens on last week is a schedule nobody refreshed. The cut is at the reader's
 * own midnight, so today's own morning stays: it is still what happened today.
 */
export function groupByDay(events: CalendarEvent[], now: Date, tz?: string): DayGroup[] {
  const today = dateKey(partsOf(now, tz))
  const byDate = new Map<string, CalendarEvent[]>()
  for (const event of events) {
    const at = new Date(event.at)
    if (Number.isNaN(at.getTime())) continue
    const key = dateKey(partsOf(at, tz))
    if (key < today) continue
    const bucket = byDate.get(key)
    if (bucket === undefined) byDate.set(key, [event])
    else bucket.push(event)
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, list]) => ({
      date,
      events: [...list].sort((a, b) => {
        const ta = Date.parse(a.at)
        const tb = Date.parse(b.at)
        return ta !== tb ? ta - tb : a.rank - b.rank
      }),
    }))
}

// ---------------------------------------------------------------------------
// One row's decisions
// ---------------------------------------------------------------------------

/**
 * An `https://` source and the domain to print beside it, or `null` for a date that needs neither.
 *
 * The authority is matched rather than parsed: `www.` comes off because it is not part of the
 * name anybody checks, a port comes off with it, and anything carrying credentials or a scheme
 * this app would not open matches nothing and draws no badge. A row with no badge still renders —
 * losing the link costs less than opening a string the desk merely stored.
 */
const HTTPS_HOST = /^https:\/\/([a-zA-Z0-9.\-]+)(?::\d+)?(?:[/?#]|$)/

export function sourceBadge(
  event: Pick<CalendarEvent, 'source'>,
): { host: string; url: string } | null {
  if (event.source === COMPUTED) return null
  const m = HTTPS_HOST.exec(event.source)
  if (m === null) return null
  const host = m[1].replace(/^www\./i, '')
  return host === '' ? null : { host, url: event.source }
}

/**
 * What this date means to this owner, over every position it reaches.
 *
 * Not the first affect's. An event that helps one holding and hurts another is exactly what
 * `both` is for, and picking either one would be a confident sentence about half the book.
 */
export function eventDirection(event: Pick<CalendarEvent, 'affects'>): AffectDirection {
  const first = event.affects[0]?.direction
  if (first === undefined) return 'both'
  return event.affects.every((a) => a.direction === first) ? first : 'both'
}

export function directionLabel(direction: AffectDirection, t: Strings): string {
  return t.schedule.direction[direction]
}

/**
 * The right rail's colour, from the theme's measured pair.
 *
 * Green is up. Korea reads red as a gain and so does every broker app on the same phone, and the
 * owner settled it anyway: the board's own `ui_chg_colour()` is this rule, and a phone that
 * disagreed with the paper about the same company would be worse than one that disagrees with the
 * country. `both` is neither, so it is text — a colour there would be direction where there is
 * none.
 */
export function directionColour(direction: AffectDirection): string {
  return direction === 'for' ? colors.up : direction === 'against' ? colors.down : colors.textDim
}

/** Shares of `symbol` held elsewhere in the book, signed — what turns a short call into a covered
 *  one, and a fact about a *different* position, which is why the desk cannot supply it. */
function stockSharesOf(book: PositionsDoc, symbol: string): number {
  return book.positions.reduce(
    (n, p) => (p.kind === 'stock' && p.symbol === symbol ? n + p.quantity : n),
    0,
  )
}

/**
 * The leg that expires first.
 *
 * A position may carry four legs and a calendar spread carries two expiries, so one number cannot
 * name them all — and the honest one to name is the NEAREST, because it is the one that acts
 * first: it is what decides whether a print lands before or after something in this position
 * stops existing.
 */
function nearestExpiry(legs: OptionLeg[]): string {
  return legs.reduce((soonest, leg) => (leg.expiry < soonest ? leg.expiry : soonest), legs[0].expiry)
}

/** Between the name of a position and its countdown. Punctuation, not copy — the same mark in both
 *  languages, which is why it is here and not in the catalogue. `positions.ts`'s `LEG_JOIN`. */
const LINE_JOIN = ' · '

/**
 * The position an affect points at, named and counted down —
 * `AAAA 11월 21일 만기 420 콜 · 만기 D-74` — or `''` when this phone's copy of the book does not
 * hold it.
 *
 * Empty rather than absent, and the row draws it or does not: the desk forgets its book whenever
 * the positions change, so a phone can legitimately hold a book from before an edit. Dropping the
 * event over it would hide a date the owner can still act on; dropping the line loses only the
 * name of a position they no longer have.
 *
 * **THE COUNTDOWN IS THE POINT OF THE LINE, not decoration on it.** Days-to-expiry is what decides
 * whether an event matters at all: an earnings print eight days before expiry and the same print
 * with eight months left are different events against the same position, and this row is where
 * that has to be visible. It is measured in whole CALENDAR days from the reader's own day to the
 * expiry day — through the same `partsOf` seam as every other date in this file, because a second
 * date path is a second answer to what day it is.
 *
 * A stock gets none: it has no expiry, and `D-` on something that never runs out would be a
 * number about nothing. An ALREADY-EXPIRED leg gets none either, and that is a decision rather
 * than a fallthrough — `D-0` on a leg that expired last week is false, `D+7` is a countdown
 * running the wrong way, and the date itself is already in the name beside it (`strategyLabel`
 * prints the expiry), so a reader can still see what happened. There is nothing left to count
 * down to.
 *
 * The join between the ticker and the shape is `confirmationLine`'s and for its reason: a space
 * there is punctuation in both languages, so a template of nothing but placeholders would be the
 * same string in both catalogues, which the parity test refuses.
 */
export function positionLine(
  book: PositionsDoc | null,
  positionId: string,
  t: Strings,
  now: Date,
  tz?: string,
): string {
  if (book === null) return ''
  const p = book.positions.find((one) => one.id === positionId)
  if (p === undefined) return ''
  const name = `${p.symbol} ${strategyLabel(p, t, { nowMs: now.getTime(), stockShares: stockSharesOf(book, p.symbol) })}`
  if (p.kind !== 'option') return name
  const days = daysBetween(dateKey(partsOf(now, tz)), nearestExpiry(p.legs))
  if (days === null || days < 0) return name
  return `${name}${LINE_JOIN}${fill(t.schedule.countdown, { n: String(days) })}`
}

// ---------------------------------------------------------------------------
// What the screen draws
// ---------------------------------------------------------------------------

/**
 * The screen's own state, decided here rather than as four conditions inside a `.tsx` — the
 * reason `deskLanguageView` is a function: this app has no screen tests, so anything argued
 * inside a component is argued only in prose.
 *
 * THE THREE EMPTIES ARE THREE DIFFERENT FACTS and each gets its own sentence, because collapsing
 * them would say something untrue about at least one:
 *
 *   - `needs_desk` — there is no desk on this phone. Nothing has been asked of anything, so any
 *     sentence about a book would be the app inventing a fact about a server it never called.
 *     This is also the only one of the three that asks the owner to do something.
 *   - `no_book` — the desk answered, and it has no book. `h_get_calendar` serves `None` until the
 *     agent has filed one, and again after the positions change, because the desk forgets a book
 *     it can no longer prune against them.
 *   - `nothing_upcoming` — there is a book and everything in it is behind us. That is not the
 *     same as never having had one: it says the research job has not run lately, which is a
 *     different thing to read and a different thing to wait for.
 *
 * A failed fetch is deliberately NOT one of these. It is an error with a retry, and drawing it as
 * an empty state would tell somebody their desk has nothing to say when the truth is that nobody
 * asked it successfully.
 *
 * WHICH IS WHY `error` RIDES ON EVERY ARM RATHER THAN ON ONE. The failure that matters here is a
 * failed REFRESH over a screen that already has an answer — and the empty screens are where it is
 * least visible and most misleading. A desk with no book answers `no_book`; the owner pulls to
 * refresh; the desk is now unreachable; without this the screen is byte-identical to the one they
 * were already looking at, and "still no book" is indistinguishable from "I could not reach the
 * desk just now". Carrying it in the state rather than beside it is what makes the invariant —
 * every view can say so — a thing a test can hold.
 */
type ScheduleState =
  | { kind: 'needs_desk' }
  | { kind: 'no_book' }
  | { kind: 'nothing_upcoming' }
  | { kind: 'book'; groups: DayGroup[]; shortfall: string | null }

export type ScheduleView = ScheduleState & {
  /** The last failure, drawn above whatever else the screen shows, or `null`. */
  error: string | null
}

export function scheduleView(input: {
  /** A desk address and an operator token are both saved on this phone. */
  ready: boolean
  /** What the desk answered, or `null` for a desk that has no book. */
  doc: CalendarDoc | null
  now: Date
  /** The last call's failure, already turned into a sentence by `humanDeskError`. */
  error?: string | null
  /** Omitted in production — see the timezone seam above. */
  tz?: string
}): ScheduleView {
  const error = input.error ?? null
  if (!input.ready) return { kind: 'needs_desk', error }
  if (input.doc === null) return { kind: 'no_book', error }
  const groups = groupByDay(input.doc.events, input.now, input.tz)
  if (groups.length === 0) return { kind: 'nothing_upcoming', error }
  return { kind: 'book', groups, shortfall: input.doc.shortfall, error }
}

// ---------------------------------------------------------------------------
// What the two additive surfaces draw
// ---------------------------------------------------------------------------

/**
 * The block at the top of Markets, and a symbol's own slice inside its Calendar section.
 *
 * `hidden` is the important arm, and it is the one three of the four outcomes reach. Both of
 * these surfaces already work today for somebody who has never configured a desk — Markets shows
 * a watchlist, `CalendarSection` shows Yahoo's dates with its own degraded card — and this
 * feature is strictly ADDITIVE: it appears when there is a book and is invisible when there is
 * not. No new empty state, no new spinner, no new error. `/schedule` is where a failure is
 * reported, because that is where the owner went looking for it.
 */
export type UpcomingView =
  | { kind: 'hidden' }
  | {
      kind: 'events'
      /** Already limited, already in the reader's own days — `ScheduleDayGroup`'s input. */
      groups: DayGroup[]
      /** Events actually in `groups`. */
      count: number
      /** Events the limit left out, so a surface can say the book is bigger than the block. */
      more: number
    }

const HIDDEN: UpcomingView = { kind: 'hidden' }

/**
 * The next few dates, or nothing.
 *
 * WHAT "NEXT" MEANS, since the desk keeps a seven-day PAST window on purpose. The cut is
 * `groupByDay`'s and nobody else's: the reader's own midnight. So a print that landed at 09:30 is
 * still at the top of Markets at 13:00 — it is the one thing the owner most wants there that
 * morning, and the book is not rewritten the instant it fires — and yesterday's is gone before it
 * can become three days of stale prints. Reusing that cut rather than inventing a second one is
 * also what makes this block the literal HEAD of `/schedule`'s own list: tapping through lands on
 * the same events in the same order, which a separate rule could not promise.
 *
 * BY TIME, NEVER BY RANK (ruling 21). `rank` is what decided which events the agent FILED and
 * `target` is what `shortfall` is measured against; neither is a display cap and neither orders
 * anything a reader sees. The `limit` here is the spec's "next three" and belongs to this block
 * alone.
 *
 * `symbol`, when given, is the symbol detail screen's slice — every event whose `symbols` name
 * it, so an event naming two companies appears under both. Matched by EXACT ticker after case
 * folding, never as a substring: a deep link may arrive as `claudepost://market/aaaa` while the
 * book carries the agent's spelling, but `AA` and `AAAA` are two companies.
 *
 * A FAILED FETCH IS NOT AN ARM OF THIS, and takes no parameter, because `doc`'s three states
 * already say everything a surface may act on: `undefined` is a call that has not produced a
 * book — one still out, or one that threw — `null` is a desk that answered and has none, and a
 * document is a book. `useEventBook` reports a failure by LEAVING THE PREVIOUS `doc` IN PLACE
 * rather than by raising a flag, so a first fetch that failed hides (nothing to show) and a
 * refresh that failed over a book keeps the book. A `failed` argument here would have documented
 * that behaviour without causing any of it.
 */
export function upcomingView(input: {
  /** A desk address and an operator token are both on this phone. `null` while storage has not
   *  answered — half-known is unknown, and this surface draws nothing either way. */
  ready: boolean | null
  /** The book; `null` for a desk that has none, `undefined` for a call that has not produced
   *  one — see the note on failure above. */
  doc: CalendarDoc | null | undefined
  now: Date
  /** The most events to draw across all days, or every one of them when omitted. */
  limit?: number
  /** One symbol's slice, or the whole book when omitted. */
  symbol?: string
  /** Omitted in production — see the timezone seam above. */
  tz?: string
}): UpcomingView {
  // The desk gate comes first and is about consent rather than about data: a phone with no desk
  // must draw no book even with one in hand, because `useEventBook` never asked for it.
  if (input.ready !== true) return HIDDEN
  if (input.doc === null || input.doc === undefined) return HIDDEN

  const symbol = input.symbol?.toUpperCase()
  const wanted =
    symbol === undefined
      ? input.doc.events
      : input.doc.events.filter((e) => e.symbols.some((s) => s.toUpperCase() === symbol))

  const groups = groupByDay(wanted, input.now, input.tz)
  const total = groups.reduce((n, g) => n + g.events.length, 0)
  if (total === 0) return HIDDEN

  let budget = input.limit ?? total
  const kept: DayGroup[] = []
  for (const group of groups) {
    if (budget <= 0) break
    const events = group.events.slice(0, budget)
    budget -= events.length
    kept.push({ date: group.date, events })
  }
  const count = kept.reduce((n, g) => n + g.events.length, 0)
  // A limit of zero or less asked for no rows, and `{kind:'events'}` with none of them would draw
  // a heading and a "See all 6" over an empty card. There is one way for this function to say
  // "draw nothing" and every road to nothing takes it.
  if (count === 0) return HIDDEN
  return { kind: 'events', groups: kept, count, more: total - count }
}

// ---------------------------------------------------------------------------
// When to ask the desk again
// ---------------------------------------------------------------------------

/**
 * How stale the book in memory has to be before a return to a screen quietly re-asks for it.
 *
 * The figure and the rule are `editionState.ts`'s `FOCUS_REFRESH_AFTER_MS`, deliberately as a
 * SECOND constant rather than an import: the edition and the event book are two documents on two
 * cadences, and one shared number would mean a change to the Today tab's throttle silently
 * changing this one. Five minutes is already far more often than a book the agent files twice a
 * day can change.
 */
export const BOOK_REFRESH_AFTER_MS = 5 * 60_000

/**
 * Whether a `load()` should actually reach the desk, or answer from the copy already in memory.
 *
 * WITHOUT THIS, EVERY FOCUS IS A FETCH. Both surfaces fire on an edge — Markets on every focus,
 * the Calendar section on every `active` false→true — so Markets → symbol → Calendar → Info →
 * Calendar → Markets is four loads and eight bearer-authed requests, for a document that changes
 * about twice a day. An in-flight guard collapses only the concurrent ones, which is a different
 * thing and was the whole of what this hook had.
 *
 * THE TWO EXEMPTIONS ARE NOT REFRESHES AT ALL, and this is the part worth getting right. A
 * different desk address, or credentials that have only just appeared, is a FIRST question about
 * something else — and throttling it would leave an owner who has this moment saved an operator
 * token in Settings looking at a blank Markets tab for five minutes with nothing to say why.
 * `cachedReady !== true` covers exactly that transition, because a phone with no token publishes
 * `ready: false` and never calls the desk at all.
 *
 * A SETTLED FAILURE IS THROTTLED LIKE A SETTLED SUCCESS, which is the one arm that looks wrong
 * and is not. These surfaces show nothing either way, so hammering an unreachable desk on every
 * focus buys the owner nothing they can see; `/schedule` is where a failure is reported, and it
 * has a pull-to-refresh that does not come through here.
 */
export function bookFetchDue(input: {
  now: number
  /** When the last call SETTLED, success or failure. `0` when none ever has. */
  fetchedAt: number
  /** The desk address the caller is about to use. */
  address: string
  /** The address the copy in memory came from, or `null` when there is no copy. */
  cachedAddress: string | null
  /** That copy's `ready` — `true` only once a desk has actually been asked. */
  cachedReady: boolean | null
}): boolean {
  if (input.address !== input.cachedAddress) return true
  if (input.cachedReady !== true) return true
  return input.now - input.fetchedAt >= BOOK_REFRESH_AFTER_MS
}
