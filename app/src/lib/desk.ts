// Client for the desk — the server behind the URL the board polls (server/claudepost/, and
// docs/desk-server.md for why it looks the way it does). This is the TypeScript mirror of its
// wire, and the only place in the app that knows one of its field names; the names themselves
// come from server/claudepost/http.py's `_ROUTES` and the handlers under it, which write the
// bytes.
//
// THE DESK HAS TWO PLANES AND THERE IS NO ROUTE FROM ONE TO THE OTHER, so this file has two
// kinds of call:
//
// [1] The device plane — anonymous, GET only. The phone fetches it exactly as the board does.
//   GET /news.json    -> the current edition (docs/news-contract.md), policy block spliced in
//
// [2] The control plane — everything under /api/*, behind `Authorization: Bearer`, two scopes.
//   `producer` reads; `operator` additionally changes what the desk does with no gate in front
//   of it. A phone carrying only a producer token can see everything and ask for work; it
//   cannot change the rules, and a 403 is the answer it gets — which is why `forbidden` has its
//   own sentence naming the operator token rather than being folded into "not allowed".
//
//   GET    /api/state                          what the desk is doing
//   GET    /api/editions                       the editorial history + the two pointers
//   GET    /api/editions/<eid>                 one edition, with its sheets and note flag
//   GET    /api/editions/<eid>/proof/<name>    a proof sheet (an image component fetches this)
//   GET    /api/editions/<eid>/notes.md        the dossier filed with it, or 404
//   POST   /api/editions/<eid>/promote         [operator] replay an old edition as current
//   GET    /api/commands  · POST /api/commands the queue, and asking it for something
//   DELETE /api/commands/<cid>                 [operator] cancel a pending instruction
//   GET    /api/commands/<cid>/notes.md        what came of one instruction, or 404
//   GET    /api/directives                     the standing rules in force
//   POST   /api/directives                     [operator] add one
//   DELETE /api/directives/<did>               [operator] remove one
//   GET    /api/schedule · PUT /api/schedule   [operator to write] when the desk may publish
//   GET    /api/schedule/next                  the next transitions, in local time and UTC
//   POST   /api/publish · POST /api/hold       [operator] force the staged edition up, or hold
//   GET    /api/audit                          the desk's own record of what it has done
//
// THE TOKEN NEVER REACHES A STRING THAT LEAVES THIS MODULE. Nothing here formats it into a
// message on purpose; what `redact()` catches is the desk — or the tunnel in front of it —
// quoting the request back in an error body, which would put a bearer token into a banner, a
// crash report or a screenshot. The same rule, and the same one-line implementation, as
// `agent/deskclient.py`'s `_redact`. The failure messages also name the ROUTE and never the
// address, because the address is where a pasted token would be.
//
// TWO NAMING RULES, and between them they decide every field name below.
//
//   1. A parsed field is named exactly as the wire names it. The desk mixes cases on purpose —
//      its own answers are camelCase (`lastPublishAt`, `scheduleSource`) and the documents it
//      stores and hands back are snake_case (`min_gap_minutes`, `tile_count`, `has_notes`) —
//      and following the wire rather than tidying it is what makes `grep created_at` find both
//      ends of the contract.
//   2. Except where the parser changes a number's UNITS, in which case the name carries the
//      unit: `lastCents`, `changeBp`. `news.json` sends money and percentages as JSON floats;
//      `news_parse.c` turns them into int32 cents and basis points before anything on the board
//      sees them, and the phone is describing the sheet the board printed. A phone that kept
//      the float would round `241.605` its own way and print a price the paper beside it does
//      not carry. So the conversion is mirrored here, rounding included — see `wireScaled()` —
//      and the resulting fields are named the way the board's own /api/state names them
//      (src/lib/esp32.ts's `NewsSubject`, which this one matches field for field on purpose:
//      the same company, whether it arrived via the board or straight off the desk).
//
// Every function takes an injectable fetch so it can be unit-tested without a desk. The client
// takes its base URL and token as arguments and never reads storage itself — src/lib/settings.ts
// owns those, and a client that read them would be a second place that decides what "configured"
// means.

// ---------------------------------------------------------------------------
// Errors. The desk's envelope is `{"ok":false,"error":"<code>","detail":"..."}` with a 4xx —
// deliberately the same envelope components/device_api/device_api.c uses, so a client that
// speaks to the board speaks to the desk.
// ---------------------------------------------------------------------------

export type DeskErrorCode =
  // From the status the desk answered with. `status` and the envelope's `error` are one fact on
  // the desk (errors.py gives each exception class both), so the status is what is read here.
  | 'unauthorized' // 401 — no token, or one the desk does not know
  | 'forbidden' // 403 — a real token, of the wrong scope
  | 'not_found' // 404 — no such edition, command, directive or note
  | 'conflict' // 409 — legal, but the desk's current state will not have it
  | 'too_large' // 413 — over a transport limit
  | 'bad_request' // 400 and any other 4xx
  | 'server' // 5xx, upstream included
  // Client-side, and the first two are a distinction worth keeping.
  | 'timeout' // our own deadline fired
  | 'network' // the fetch itself refused
  | 'parse' // a 2xx whose body this app cannot read

export class DeskError extends Error {
  code: DeskErrorCode
  /** HTTP status of the failed response, when there was one. */
  status?: number
  constructor(code: DeskErrorCode, message?: string, status?: number) {
    super(message ?? code)
    this.name = 'DeskError'
    this.code = code
    this.status = status
  }
}

/**
 * A sentence per failure, saying what to go and do.
 *
 * Two of them carry the whole reason this list is not generic. A **403** is not "not allowed":
 * it means the token works and is the wrong one of the two, so the sentence names the other.
 * And a **timeout** is a statement about the tunnel, not about the phone's Wi-Fi — a desk is
 * reachable from anywhere by construction, so "check your connection" would send its owner to
 * look for a fault at the wrong end of the wire.
 */
export function deskHumanError(e: DeskError): string {
  switch (e.code) {
    case 'unauthorized':
      return 'The desk didn’t accept that token. Check it in Settings.'
    case 'forbidden':
      return 'That token can read the desk but not change it. The operator token is the one that can.'
    case 'timeout':
      return 'The desk didn’t answer in time. It sits behind a tunnel — if the tunnel is down, nothing here is current.'
    case 'network':
      return 'Couldn’t reach the desk. Check the address in Settings.'
    case 'not_found':
      return 'The desk has no record of that.'
    case 'server':
      return 'The desk answered with an error. Try again in a moment.'
    case 'parse':
      return 'The desk sent something this app couldn’t read. Update the app.'
    case 'conflict':
      return 'The desk won’t take that as things stand. Pull to refresh and have another look.'
    case 'too_large':
      return 'That was too long for the desk to accept.'
    case 'bad_request':
      return 'The desk couldn’t use that. This is a bug in the app, not something you did.'
    default:
      return 'That didn’t work. Please try again.'
  }
}

// ---------------------------------------------------------------------------
// Coercers. Same posture as src/lib/esp32.ts: the desk's JSON is trusted and normalized anyway,
// so a missing or garbage field renders as nothing rather than crashing a screen.
// ---------------------------------------------------------------------------

/**
 * A string, or ''. STRINGS ONLY — a number or an object is the default, not `String(v)`.
 *
 * That is `news_parse.c`'s `jstr()` exactly ("the key is missing" and "the key holds the wrong
 * type" go to the same place), and it is also the only rule that keeps `[object Object]` out of
 * a headline slot on a page a reader is looking at.
 */
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function asNum(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function asBool(v: unknown): boolean {
  return Boolean(v)
}

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** The objects out of an array, in order. Anything else in it is not a row. */
function asRows(v: unknown): Record<string, unknown>[] {
  return asArr(v).filter(
    (r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r),
  )
}

/** One of a fixed set, or the fallback — so an unknown value lands in a case the UI handles. */
function asEnum<T extends string>(v: unknown, allowed: readonly string[], fallback: T): T {
  const s = asStr(v)
  return (allowed.includes(s) ? s : fallback) as T
}

/**
 * An id, or null. An id the desk minted is a hex string; anything else names nothing, and
 * building a path out of it would address something that does not exist.
 */
function asIdOrNull(v: unknown): string | null {
  const s = asStr(v)
  return s === '' ? null : s
}

/**
 * An instant in epoch seconds, or null.
 *
 * `null` and `0` are different answers and the desk is careful about it — `state()` sends
 * `hold: null` for "not held" and `watchlist.updatedAt: null` for "nobody has said", precisely
 * because `0` on this wire is 1 January 1970. A client that folded the two would draw a desk as
 * held since the epoch.
 */
function asInstant(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// ---------------------------------------------------------------------------
// The control plane's documents.
// ---------------------------------------------------------------------------

export interface QuietWindow {
  from: string
  to: string
}

/** One wake instant. `days` is '' for all seven — the form an operator writes. */
export interface WakeTime {
  at: string
  days: string
}

export type PublishPolicy = 'immediate' | 'on_wake' | 'manual'

const PUBLISH_POLICIES: readonly string[] = ['immediate', 'on_wake', 'manual']

/**
 * The one document that says both when the worker runs and what the device is told to do
 * (docs/desk-server.md § The schedule). They are on one document because they are one decision
 * from the owner's side — what happens at six — and splitting them would let them disagree.
 */
export interface Schedule {
  timezone: string
  /** When nothing new becomes current. A commit inside one stages and goes up at the boundary. */
  quiet: QuietWindow[]
  /** When the WORKER runs. */
  wake: WakeTime[]
  publish: {
    policy: PublishPolicy
    /** The most valuable knob on this document: the floor under how often the wall may flash. */
    min_gap_minutes: number
  }
  /** What the DEVICE is told to do, as `policy.poll_seconds` on the wire it polls. */
  poll: {
    active_seconds: number
    quiet_seconds: number
  }
}

export type ScheduleEvent = 'quiet_start' | 'quiet_end' | 'wake' | 'unknown'

const SCHEDULE_EVENTS: readonly string[] = ['quiet_start', 'quiet_end', 'wake']

/**
 * One row of `GET /api/schedule/next` — the same instant in three spellings.
 *
 * Time-zone arithmetic is what everybody gets wrong, so the desk prints it rather than being
 * trusted, `ambiguous` included: true for a local time that happens twice on the day the clocks
 * go back.
 */
export interface ScheduleTransition {
  at: number
  local: string
  utc: string
  what: ScheduleEvent
  ambiguous: boolean
}

export type CommandStatus =
  | 'pending'
  | 'claimed'
  | 'done'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'unknown'

const COMMAND_STATUSES: readonly string[] = [
  'pending',
  'claimed',
  'done',
  'failed',
  'expired',
  'cancelled',
]

/**
 * One row of the queue. *"Research NVDA now"* — consumed once and forgotten.
 *
 * The distinction from a `Directive` is the one most easily got wrong, and getting it wrong is
 * silent: a standing rule put in the queue applies to exactly one edition, after which the desk
 * forgets it and its owner concludes the system ignored them.
 */
export interface Command {
  id: string
  kind: string
  text: string
  priority: number
  status: CommandStatus
  source: string
  created_at: number
  deadline_at: number | null
  claimed_by: string
  claimed_at: number | null
  finished_at: number | null
  attempts: number
  result: string
  /** Whether a worker filed a note about what came of it. Fetch it with `getNotes('commands', id)`. */
  has_notes: boolean
}

export type DirectiveScope = 'always' | 'until'

const DIRECTIVE_SCOPES: readonly string[] = ['always', 'until']

/** A standing rule. *"Never print TSLA"* — must hold forever, so it is not a `Command`. */
export interface Directive {
  id: string
  rule: string
  scope: DirectiveScope
  expires_at: number | null
  source: string
  created_at: number
}

/**
 * One edition's publication record.
 *
 * `sheets` and `has_notes` are only carried by `GET /api/editions/<eid>`, which reads them off
 * disk per request because the row is the record and the files are what `prune()` can take away.
 * A row from a LIST therefore parses with `sheets: []` and `has_notes: false`, and those mean
 * "not known from here" rather than "there are none" — a screen that wants to say an edition has
 * no dossier has to fetch the edition first. (The wire also carries `source`, `validate` and
 * `render`: the draft it came from and the two gates' clipped output. The phone shows the paper,
 * not the gate transcript, so they are not parsed.)
 */
export interface EditionMeta {
  id: string
  created_at: number
  /** When it reached the glass, or null while it is only staged. */
  published_at: number | null
  tile_count: number
  bytes: number
  /** The desk stripped a `policy` block the producer filed; the desk owns that block. */
  dropped_producer_policy: boolean
  sheets: string[]
  has_notes: boolean
}

/** What became of an edition, in the one shape a commit, a promotion and a publish all answer in. */
export interface CommitResult {
  edition_id: string
  state: 'published' | 'staged' | 'unchanged'
  /** Prose for a person — an agent told "quiet" can decide to wait rather than file again. */
  reason: string
}

const COMMIT_STATES: readonly string[] = ['published', 'staged', 'unchanged']

/**
 * One row of the desk's own record of what it has done — a publish, a hold, a schedule edit.
 * Not the editorial history, which is `listEditions()`.
 *
 * `seq` is the audit table's own AUTOINCREMENT, carried through because `at` alone cannot order
 * two events that land in the same clock tick.
 */
export interface AuditEntry {
  seq: number
  at: number
  event: string
  detail: Record<string, unknown>
}

/** The live snapshot the dashboard polls (`GET /api/state`). */
export interface DeskState {
  /** The desk's own clock. Every other instant here is to be read against this one, not the phone's. */
  now: number
  current: string | null
  staged: string | null
  lastPublishAt: number | null
  /** Publishing is held until this instant; null when it is not held. */
  hold: number | null
  /** Who wrote the schedule in force — 'file' or 'default'. */
  scheduleSource: string
  schedule: Schedule
  /** The cadence the device is being told RIGHT NOW, and whether that is because it is quiet. */
  policy: {
    pollSeconds: number
    quiet: boolean
  }
  nextTransition: { at: number; what: ScheduleEvent } | null
  /**
   * A summary, never the document: the watchlist carries thesis notes, and a client checking
   * whether the desk has one yet should not be sent them. `getWatchlist()` is Task 19's.
   */
  watchlist: {
    updatedAt: number | null
    count: number
  }
  queue: {
    pending: number
    recent: Command[]
  }
  editions: EditionMeta[]
}

// ---------------------------------------------------------------------------
// The device plane's document: news.json, the edition itself.
// ---------------------------------------------------------------------------

/**
 * Round-half-away-from-zero into a scaled integer — dollars to cents, percent to basis points.
 *
 * `components/news_core/news_parse.c`'s `sround()`, line for line, saturation included. It is
 * mirrored rather than approximated because the phone and the sheet on the wall are describing
 * the same edition: truncating instead of rounding would let a price differ by a cent between
 * the two, and a reader standing in front of both would be right to trust the paper.
 *
 * A value that is not a JSON number takes the default, which is `jscaled()`'s rule and not an
 * oversight — a producer that sent `"241.60"` prints as nothing on the board, so it must print
 * as nothing here too.
 */
function wireScaled(v: unknown, mul: number, fallback = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  const x = v * mul
  if (!(x > -2147483000)) return -2147483000
  if (!(x < 2147483000)) return 2147483000
  return Math.trunc(x >= 0 ? x + 0.5 : x - 0.5)
}

/** The latest instant this wire admits: 9999-12-31T23:59:59Z, `news_parse.c`'s NEXT_CHANGE_MAX. */
const NEXT_CHANGE_MAX = 253402300799

/**
 * An absolute instant in epoch seconds — `news_parse.c`'s `parse_policy` arm, and deliberately
 * NOT `wireScaled()`.
 *
 * That saturates at about 2.1e9, which is January 2038, and a field whose whole point is to
 * survive being a date must not be clamped to the year an int32 runs out. A negative goes to 0
 * rather than to a bound, which is the other half of the same argument: a cadence of -5 is a
 * number the desk meant to be positive, but an instant before the epoch is not an instant at
 * all, and "absent" is the only honest reading of it.
 */
function wireInstant(v: unknown): number {
  if (typeof v !== 'number' || !(v > 0)) return 0 // negated, so a NaN lands here too
  if (!(v < NEXT_CHANGE_MAX)) return NEXT_CHANGE_MAX
  return Math.trunc(v + 0.5)
}

/** `cJSON_IsTrue`: only a real `true`. A `1` here is not a boolean on this wire. */
function wireBool(v: unknown): boolean {
  return v === true
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/** The company the edition is about. Matches src/lib/esp32.ts's `NewsSubject` field for field. */
export interface NewsSubject {
  symbol: string
  name: string
  exchange: string
  sector: string
  lastCents: number
  changeBp: number
  prevCloseCents: number
  openCents: number
  highCents: number
  lowCents: number
  /** 0 means UNKNOWN, not a price of nothing. Draw an unknown bound as absent. */
  wk52HighCents: number
  wk52LowCents: number
}

export interface NewsPhoto {
  id: string
  w: number
  h: number
  caption: string
  credit: string
}

export interface NewsStory {
  /** The desk's editorial judgement, and the only thing the payload says about geometry. */
  rank: number
  kicker: string
  headline: string
  deck: string
  byline: string
  body: string
  /**
   * An index into the payload's top-level `charts[]`, or -1. Passed through as filed: `charts[]`
   * is not parsed here (the phone shows the sheet, which is where a chart is looked at), so this
   * client cannot range-check the index the way the board does.
   */
  chart: number
  photo: NewsPhoto | null
}

export interface NewsFigure {
  group: string
  label: string
  /** Preformatted by the producer — `"$241.6B"`, `"22.4x"`, `"—"`. Never a number. */
  value: string
  /**
   * null when the figure has no change at all, which is NOT the same as a change of zero: absent
   * prints with no mark and no colour, present-and-zero prints a flat mark. A P/E tinted green
   * would be decoration, and colour on this sheet is data.
   */
  changeBp: number | null
  /** A hero. Two to four across the rail; a page where everything is emphasised has emphasised nothing. */
  emph: boolean
  /** Where the value sits in a range the producer chose, 0..1000. -1 is "no bar", and 0 is not. */
  bar: number
}

export interface NewsBrief {
  date: string
  kicker: string
  text: string
}

export interface NewsPeer {
  symbol: string
  name: string
  /** Preformatted. */
  per: string
  /** Preformatted. */
  cap: string
  lastCents: number
  changeBp: number
  is_subject: boolean
}

export interface NewsIndex {
  symbol: string
  name: string
  lastCents: number
  changeBp: number
  /** Already normalised to 0..1000 by the producer — the device has the pixels but not the units. */
  spark: number[]
}

/**
 * How often to come back. The only block on this wire that is not about the paper, and absent is
 * the normal case: the demo edition carries none and the committed fixture carries none. The desk
 * splices it in at serve time, which is why it is here and not in the fixture.
 */
export interface NewsPolicy {
  /** 30..86400, or **0 for "the desk said nothing about cadence"** — not a cadence of zero. */
  poll_seconds: number
  /** Epoch seconds, as a JSON number. 0 = none known. */
  next_change: number
}

/**
 * The edition, as the app reads it.
 *
 * The slices the phone renders, and deliberately not the whole contract: `tables[]`, `charts[]`
 * and `thumbs[]` are drawn rather than read, and the phone has the proof sheets for that. A
 * screen that wants to look at a chart looks at the sheet the desk already rendered with the
 * real typesetter.
 */
export interface NewsPayload {
  edition: string
  dateline: string
  session: string
  as_of: string
  generated_at: string
  subject: NewsSubject
  /** Sorted by `rank` ascending, so `stories[0]` is the lead however they arrived. */
  stories: NewsStory[]
  figures: NewsFigure[]
  briefs: NewsBrief[]
  peers: NewsPeer[]
  indices: NewsIndex[]
  policy: NewsPolicy | null
}

// The device's own capacities (components/news_core/include/news_model.h and the tables in
// docs/news-contract.md). Clamping again here means a desk that somehow sent more cannot make a
// phone list disagree with the sheet it is standing next to.
export const NEWS_STORIES_MAX = 5
export const NEWS_FIGURES_MAX = 28
export const NEWS_BRIEFS_MAX = 8
export const NEWS_PEERS_MAX = 6
export const NEWS_INDICES_MAX = 5
const NEWS_SPARK_MAX = 24
const PHOTO_W_MAX = 1200
const PHOTO_H_MAX = 1600
const RANK_MAX = 99
/** Deliberately larger than the array holds: an unranked story must sort below every ranked one. */
const RANK_DEFAULT = 9
const POLL_SECONDS_MIN = 30
const POLL_SECONDS_MAX = 86400

// ---------------------------------------------------------------------------
// Parsers. One per documented payload, and none of them throws.
// ---------------------------------------------------------------------------

function parseQuiet(raw: unknown): QuietWindow[] {
  return asRows(raw)
    .map((w) => ({ from: asStr(w.from), to: asStr(w.to) }))
    // A window missing an end is not a window. Filling one in would draw a quiet period the desk
    // is not keeping, which is worse than showing none.
    .filter((w) => w.from !== '' && w.to !== '')
}

function parseWake(raw: unknown): WakeTime[] {
  const out: WakeTime[] = []
  for (const w of asArr(raw)) {
    // A wake on all seven days is written as the bare "HH:MM" string — the form a human wrote it
    // in, and the form schedule_to_dict() writes back.
    if (typeof w === 'string') {
      if (w !== '') out.push({ at: w, days: '' })
      continue
    }
    const o = asObj(w)
    const at = asStr(o.at)
    if (at !== '') out.push({ at, days: asStr(o.days) })
  }
  return out
}

function parseSchedule(raw: unknown): Schedule {
  const s = asObj(raw)
  const publish = asObj(s.publish)
  const poll = asObj(s.poll)
  return {
    timezone: asStr(s.timezone),
    quiet: parseQuiet(s.quiet),
    wake: parseWake(s.wake),
    publish: {
      // 'manual' is the fallback because it is the policy that changes nothing on its own: a
      // client that misread the document must not draw a desk as about to publish by itself.
      policy: asEnum<PublishPolicy>(publish.policy, PUBLISH_POLICIES, 'manual'),
      min_gap_minutes: asNum(publish.min_gap_minutes),
    },
    poll: {
      active_seconds: asNum(poll.active_seconds),
      quiet_seconds: asNum(poll.quiet_seconds),
    },
  }
}

/** Back to the document form. A wake on all seven days goes back as the bare string it arrived as. */
function scheduleToWire(s: Schedule): Record<string, unknown> {
  return {
    timezone: s.timezone,
    quiet: s.quiet.map((w) => ({ from: w.from, to: w.to })),
    wake: s.wake.map((w) => (w.days === '' ? w.at : { at: w.at, days: w.days })),
    publish: { policy: s.publish.policy, min_gap_minutes: s.publish.min_gap_minutes },
    poll: { active_seconds: s.poll.active_seconds, quiet_seconds: s.poll.quiet_seconds },
  }
}

function parseTransition(raw: Record<string, unknown>): ScheduleTransition {
  return {
    at: asNum(raw.at),
    local: asStr(raw.local),
    utc: asStr(raw.utc),
    what: asEnum<ScheduleEvent>(raw.what, SCHEDULE_EVENTS, 'unknown'),
    ambiguous: asBool(raw.ambiguous),
  }
}

function parseCommand(raw: Record<string, unknown>): Command {
  return {
    id: asStr(raw.id),
    kind: asStr(raw.kind),
    text: asStr(raw.text),
    priority: asNum(raw.priority),
    status: asEnum<CommandStatus>(raw.status, COMMAND_STATUSES, 'unknown'),
    source: asStr(raw.source),
    // NOT NULL on the desk's own table, so a number or nothing — unlike the three below, where
    // null is the ordinary state of a command nobody has claimed yet.
    created_at: asNum(raw.created_at),
    deadline_at: asInstant(raw.deadline_at),
    claimed_by: asStr(raw.claimed_by),
    claimed_at: asInstant(raw.claimed_at),
    finished_at: asInstant(raw.finished_at),
    attempts: asNum(raw.attempts),
    result: asStr(raw.result),
    has_notes: asBool(raw.has_notes),
  }
}

/** Rows with no id are dropped: the desk never mints one, and nothing can be done to such a row. */
function parseCommands(raw: unknown): Command[] {
  return asRows(raw)
    .map(parseCommand)
    .filter((c) => c.id !== '')
}

function parseDirective(raw: Record<string, unknown>): Directive {
  return {
    id: asStr(raw.id),
    rule: asStr(raw.rule),
    // 'always' rather than 'until': a rule whose scope this app could not read is still in force,
    // and drawing it as one that expires would show an end date the desk is not keeping.
    scope: asEnum<DirectiveScope>(raw.scope, DIRECTIVE_SCOPES, 'always'),
    expires_at: asInstant(raw.expires_at),
    source: asStr(raw.source),
    created_at: asNum(raw.created_at),
  }
}

function parseDirectives(raw: unknown): Directive[] {
  return asRows(raw)
    .map(parseDirective)
    .filter((d) => d.id !== '')
}

function parseEdition(raw: Record<string, unknown>): EditionMeta {
  return {
    id: asStr(raw.id),
    created_at: asNum(raw.created_at),
    published_at: asInstant(raw.published_at),
    tile_count: asNum(raw.tile_count),
    bytes: asNum(raw.bytes),
    dropped_producer_policy: asBool(raw.dropped_producer_policy),
    // Only GET /api/editions/<eid> carries these; getEdition() folds them on afterwards.
    sheets: asArr(raw.sheets).filter((n): n is string => typeof n === 'string'),
    has_notes: asBool(raw.has_notes),
  }
}

function parseEditions(raw: unknown): EditionMeta[] {
  return asRows(raw)
    .map(parseEdition)
    .filter((e) => e.id !== '')
}

function parseCommitResult(doc: Record<string, unknown>): CommitResult {
  return {
    edition_id: asStr(doc.edition_id),
    // 'unchanged' is the fallback because it is the state that claims nothing happened. Reading
    // an unknown state as 'published' would tell an operator the wall flashed when it did not.
    state: asEnum<CommitResult['state']>(doc.state, COMMIT_STATES, 'unchanged'),
    reason: asStr(doc.reason),
  }
}

function parseAudit(raw: unknown): AuditEntry[] {
  return asRows(raw).map((e) => ({
    seq: asNum(e.seq),
    at: asNum(e.at),
    event: asStr(e.event),
    detail: asObj(e.detail),
  }))
}

function parseDeskState(doc: Record<string, unknown>): DeskState {
  const policy = asObj(doc.policy)
  const watchlist = asObj(doc.watchlist)
  const queue = asObj(doc.queue)
  const next = asObj(doc.nextTransition)
  return {
    now: asNum(doc.now),
    current: asIdOrNull(doc.current),
    staged: asIdOrNull(doc.staged),
    lastPublishAt: asInstant(doc.lastPublishAt),
    hold: asInstant(doc.hold),
    scheduleSource: asStr(doc.scheduleSource),
    schedule: parseSchedule(doc.schedule),
    policy: { pollSeconds: asNum(policy.pollSeconds), quiet: asBool(policy.quiet) },
    nextTransition:
      asStr(next.what) === ''
        ? null
        : { at: asNum(next.at), what: asEnum<ScheduleEvent>(next.what, SCHEDULE_EVENTS, 'unknown') },
    watchlist: { updatedAt: asInstant(watchlist.updatedAt), count: asNum(watchlist.count) },
    queue: { pending: asNum(queue.pending), recent: parseCommands(queue.recent) },
    editions: parseEditions(doc.editions),
  }
}

// -- news.json --------------------------------------------------------------

function parseSubject(raw: unknown): NewsSubject {
  const s = asObj(raw)
  return {
    symbol: asStr(s.symbol),
    name: asStr(s.name),
    exchange: asStr(s.exchange),
    sector: asStr(s.sector),
    lastCents: wireScaled(s.last, 100),
    changeBp: wireScaled(s.change_pct, 100),
    prevCloseCents: wireScaled(s.prev_close, 100),
    openCents: wireScaled(s.open, 100),
    highCents: wireScaled(s.high, 100),
    lowCents: wireScaled(s.low, 100),
    wk52HighCents: wireScaled(s.wk52_high, 100),
    wk52LowCents: wireScaled(s.wk52_low, 100),
  }
}

/**
 * A photograph, or null.
 *
 * Three ways to lose it and all three are the board's, applied here for one reason: this client
 * describes the page that PRINTED. A photo the board dropped is not on that page, so a phone
 * that drew it would show a reader a picture the sheet beside them does not carry.
 *
 *  - no `id` — the model's single test for "no photo"
 *  - `w` or `h` missing or not positive — an id without both is a GET that cannot be made
 *  - `w` odd — a tile packs two pixels to a byte, tested on the DECLARED width before the clamp
 */
function parsePhoto(raw: unknown): NewsPhoto | null {
  const p = asObj(raw)
  const id = asStr(p.id)
  // Rounded before the evenness test, because `jint()` rounds: a declared 557.6 is 558 to the
  // board, and a phone that truncated it to 557 would drop a photograph the sheet carries.
  const w = wireScaled(p.w, 1, 0)
  const h = wireScaled(p.h, 1, 0)
  if (id === '' || w <= 0 || h <= 0 || w % 2 !== 0) return null
  return {
    id,
    w: clamp(w, 0, PHOTO_W_MAX),
    h: clamp(h, 0, PHOTO_H_MAX),
    caption: asStr(p.caption),
    credit: asStr(p.credit),
  }
}

/**
 * The stories, sorted by rank, keeping the five LOWEST ranks rather than the first five.
 *
 * The array's order is the producer's and not a ranking, so truncating at the head would lose
 * the lead the day somebody appends it. The sort is stable, so a payload where every rank is the
 * same lays out in the order it arrived — the only ordering left, and the one the producer most
 * likely meant.
 */
function parseStories(raw: unknown): NewsStory[] {
  return asRows(raw)
    .filter((s) => asStr(s.headline) !== '') // a story without one is not a story
    .map((s) => ({
      rank: clamp(wireScaled(s.rank, 1, RANK_DEFAULT), 0, RANK_MAX),
      kicker: asStr(s.kicker),
      headline: asStr(s.headline),
      deck: asStr(s.deck),
      byline: asStr(s.byline),
      body: asStr(s.body),
      chart: wireScaled(s.chart, 1, -1),
      photo: parsePhoto(s.photo),
    }))
    .map((s, i) => ({ s, i })) // Array.prototype.sort is stable in ES2019+, but say so anyway
    .sort((a, b) => a.s.rank - b.s.rank || a.i - b.i)
    .slice(0, NEWS_STORIES_MAX)
    .map(({ s }) => s)
}

function parseFigures(raw: unknown): NewsFigure[] {
  return asRows(raw)
    // A rail line is a label AND a value; half a row under a standing head reads as a rendering
    // fault rather than as a figure the producer did not have.
    .filter((f) => asStr(f.label) !== '' && asStr(f.value) !== '')
    .slice(0, NEWS_FIGURES_MAX)
    .map((f) => ({
      group: asStr(f.group),
      label: asStr(f.label),
      value: asStr(f.value),
      changeBp: typeof f.change_pct === 'number' ? wireScaled(f.change_pct, 100) : null,
      // bool or 0/1 — the one field on this wire that takes both, because news_parse.c does.
      emph: wireBool(f.emph) || wireScaled(f.emph, 1) !== 0,
      // Out of range clamps rather than dropping: a producer that computed 1004 has the right
      // figure and the wrong rounding, and a bar pinned to the end says that better than none.
      bar: typeof f.bar === 'number' ? clamp(wireScaled(f.bar, 1), 0, 1000) : -1,
    }))
}

function parseBriefs(raw: unknown): NewsBrief[] {
  return asRows(raw)
    .filter((b) => asStr(b.text) !== '') // a date and a kicker over nothing is furniture with no news under it
    .slice(0, NEWS_BRIEFS_MAX)
    .map((b) => ({ date: asStr(b.date), kicker: asStr(b.kicker), text: asStr(b.text) }))
}

function parsePeers(raw: unknown): NewsPeer[] {
  return asRows(raw)
    .filter((p) => asStr(p.symbol) !== '')
    .slice(0, NEWS_PEERS_MAX)
    .map((p) => ({
      symbol: asStr(p.symbol),
      name: asStr(p.name),
      per: asStr(p.per),
      cap: asStr(p.cap),
      lastCents: wireScaled(p.last, 100),
      changeBp: wireScaled(p.change_pct, 100),
      is_subject: wireBool(p.is_subject),
    }))
}

function parseIndices(raw: unknown): NewsIndex[] {
  return asRows(raw)
    .filter((c) => asStr(c.symbol) !== '')
    .slice(0, NEWS_INDICES_MAX)
    .map((c) => ({
      symbol: asStr(c.symbol),
      name: asStr(c.name),
      lastCents: wireScaled(c.last, 100),
      changeBp: wireScaled(c.change_pct, 100),
      // Over-long loses its OLDEST samples: a sparkline that dropped its newest would draw a
      // series that stops before today.
      spark: asArr(c.spark)
        .map((v) => clamp(wireScaled(v, 1), 0, 1000))
        .slice(-NEWS_SPARK_MAX),
    }))
}

/**
 * The policy block, or null when there is none — and absent is the normal case.
 *
 * It clamps and never rejects, which is a rule the firmware holds and this mirrors: a bad policy
 * block must not be able to cost a page. `next_change` sent as an ISO-8601 string is the mistake
 * worth catching loudest, because it looks MORE correct than the number that works; it lands on
 * 0, which is "none known".
 */
function parsePolicy(raw: unknown): NewsPolicy | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  return {
    // Absent stays 0 — "the desk said nothing about cadence", which is what the board reads it as
    // (power_policy.h: `0 = the desk said nothing`). Defaulting it to the floor instead would tell
    // a reader the desk had asked for a poll every thirty seconds when it had asked for nothing.
    poll_seconds:
      typeof p.poll_seconds === 'number'
        ? clamp(wireScaled(p.poll_seconds, 1), POLL_SECONDS_MIN, POLL_SECONDS_MAX)
        : 0,
    next_change: wireInstant(p.next_change),
  }
}

function parseNews(doc: Record<string, unknown>): NewsPayload {
  return {
    edition: asStr(doc.edition),
    dateline: asStr(doc.dateline),
    session: asStr(doc.session),
    as_of: asStr(doc.as_of),
    generated_at: asStr(doc.generated_at),
    subject: parseSubject(doc.subject),
    stories: parseStories(doc.stories),
    figures: parseFigures(doc.figures),
    briefs: parseBriefs(doc.briefs),
    peers: parsePeers(doc.peers),
    indices: parseIndices(doc.indices),
    policy: parsePolicy(doc.policy),
  }
}

// ---------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------

export interface DeskClientOptions {
  /** Base URL of the desk, e.g. https://claudepost.example. From src/lib/settings.ts. */
  baseUrl: string
  /** The bearer token. '' sends no header at all, and the desk's 401 says so in one sentence. */
  token?: string
  /** Injectable fetch (RN global by default). */
  fetchImpl?: typeof fetch
  /** Per-request timeout in ms (RN fetch has none by default). */
  timeoutMs?: number
}

// A LAN device answers in milliseconds; a desk answers through a Cloudflare tunnel to a cold
// origin, which is a second or two more on a first request. The desk's own socket timeout is 120
// seconds, so this deadline — not the server's — is what decides how long a phone waits.
const DEFAULT_TIMEOUT_MS = 15000

export interface PostCommandInput {
  text: string
  /** Free-form on the desk; 'custom' is what it defaults to. */
  kind?: string
  /** 0..9, lower first. 5 is the middle and the desk's own default. */
  priority?: number
  source?: string
  /** Epoch seconds past which a pending command expires rather than surfacing three days late. */
  deadlineAt?: number
}

export interface AddDirectiveInput {
  rule: string
  /** 'until' needs an `expiresAt` and 'always' must not have one — the desk refuses either mistake. */
  scope?: DirectiveScope
  expiresAt?: number
}

/** Which of the two note trees to read from. Editions and commands keep theirs separately. */
export type NotesKind = 'editions' | 'commands'

export function createDeskClient(opts: DeskClientOptions) {
  const baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '')
  const token = opts.token ?? ''
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  /**
   * Blank the bearer token out of anything that becomes a message.
   *
   * Defensive rather than necessary — nothing here formats the token into a string on purpose.
   * What this catches is the desk, or the tunnel in front of it, quoting the request back in an
   * error body, which would put the token into a banner the user can screenshot. Same rule and
   * same one line as `agent/deskclient.py`'s `_redact`.
   */
  function redact(text: string): string {
    return token === '' ? text : text.split(token).join('<token>')
  }

  function authHeaders(): Record<string, string> {
    return token === '' ? {} : { Authorization: `Bearer ${token}` }
  }

  // Our own deadline firing is a different fact from the network refusing us, and the two need
  // different sentences — see deskHumanError(). `signal.aborted` is the only thing that tells
  // them apart reliably: RN, Hermes and Node all name the thrown error differently.
  function transportFailure(controller: AbortController, e: unknown, label: string): DeskError {
    if (controller.signal.aborted) {
      return new DeskError('timeout', redact(`${label} did not answer in time`))
    }
    return new DeskError('network', redact(e instanceof Error ? e.message : 'network error'))
  }

  function codeForStatus(status: number): DeskErrorCode {
    if (status === 401) return 'unauthorized'
    if (status === 403) return 'forbidden'
    if (status === 404) return 'not_found'
    if (status === 409) return 'conflict'
    if (status === 413) return 'too_large'
    if (status >= 500) return 'server'
    return 'bad_request'
  }

  /**
   * The desk's refusal, as a typed error.
   *
   * The STATUS decides the code, not the envelope's `error` string: on the desk those are one
   * fact (errors.py gives each exception class both), and the status is the half that survives a
   * proxy answering on the desk's behalf with an HTML page. The envelope's code and detail go
   * into the message, where they are prose for a person — never something to branch on.
   */
  async function httpFailure(res: Response, label: string): Promise<DeskError> {
    let detail = ''
    try {
      const doc = asObj(await res.json())
      detail = [asStr(doc.error), asStr(doc.detail)].filter((s) => s !== '').join(': ')
    } catch {
      // A tunnel with nothing behind it answers HTML. The status still classifies it.
    }
    return new DeskError(
      codeForStatus(res.status),
      redact(`${label} answered ${res.status}${detail === '' ? '' : ` — ${detail}`}`),
      res.status,
    )
  }

  async function request(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...((init.headers as Record<string, string>) ?? {}), ...(auth ? authHeaders() : {}) },
        signal: controller.signal,
      })
    } catch (e) {
      throw transportFailure(controller, e, path)
    } finally {
      clearTimeout(timer)
    }
  }

  /** A 2xx body, as an object. Anything else is `parse` — the app is behind the desk, not broken. */
  async function jsonOf(res: Response, label: string): Promise<Record<string, unknown>> {
    let doc: unknown
    try {
      doc = await res.json()
    } catch {
      throw new DeskError('parse', `${label} answered with something that is not JSON`, res.status)
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new DeskError('parse', `${label} answered with ${Array.isArray(doc) ? 'an array' : typeof doc}, not an object`, res.status)
    }
    return doc as Record<string, unknown>
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<Record<string, unknown>> {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const res = await request(path, init, auth)
    if (!res.ok) throw await httpFailure(res, path)
    return jsonOf(res, path)
  }

  // ----- the device plane -----

  /**
   * The edition itself, off the anonymous plane and with no token on it.
   *
   * The same bytes the board polls, so what the phone reads and what the wall prints cannot
   * disagree. No conditional GET here: the board sends an ETag because a 304 is what lets it
   * sleep, and a phone that is looking at the page has nothing to save.
   */
  async function getNews(): Promise<NewsPayload> {
    return parseNews(await call('GET', '/news.json', undefined, false))
  }

  // ----- the control plane -----

  async function getState(): Promise<DeskState> {
    return parseDeskState(await call('GET', '/api/state'))
  }

  async function listEditions(): Promise<{
    editions: EditionMeta[]
    current: string | null
    staged: string | null
  }> {
    const doc = await call('GET', '/api/editions')
    return {
      editions: parseEditions(doc.editions),
      current: asIdOrNull(doc.current),
      staged: asIdOrNull(doc.staged),
    }
  }

  /** One edition's record, with the sheets and the note flag the list rows do not carry. */
  async function getEdition(eid: string): Promise<EditionMeta> {
    const doc = await call('GET', `/api/editions/${encodeURIComponent(eid)}`)
    return parseEdition({ ...asObj(doc.edition), sheets: doc.sheets, has_notes: doc.has_notes })
  }

  /**
   * The address of one proof sheet, for a component that fetches its own bytes.
   *
   * A URL and a header rather than a method returning bytes, because expo-image wants a source
   * it can cache and decode itself; `sheetHeaders()` is the other half. The names come from
   * `getEdition().sheets` — the gate leaves two PNGs on a pass and a BMP where the render died
   * before conversion, so a client asks for what is there rather than guessing.
   */
  function sheetUrl(eid: string, name: string): string {
    return `${baseUrl}/api/editions/${encodeURIComponent(eid)}/proof/${encodeURIComponent(name)}`
  }

  function sheetHeaders(): Record<string, string> {
    return authHeaders()
  }

  /**
   * The dossier filed beside an edition, or beside a command — markdown, or null.
   *
   * A 404 is null rather than an error, because "there is not one" is an ordinary condition here:
   * the same answer a missing tile gets, and the reader shows the page without a dossier. Every
   * other refusal still throws — a 401 is not "there is not one".
   */
  async function getNotes(kind: NotesKind, id: string): Promise<string | null> {
    const path = `/api/${kind}/${encodeURIComponent(id)}/notes.md`
    const res = await request(path)
    if (res.status === 404) return null
    if (!res.ok) throw await httpFailure(res, path)
    try {
      return await res.text()
    } catch {
      throw new DeskError('parse', `${path} answered with a body this app could not read`, res.status)
    }
  }

  async function listCommands(status?: string): Promise<Command[]> {
    const q = status === undefined ? '' : `?status=${encodeURIComponent(status)}`
    return parseCommands((await call('GET', `/api/commands${q}`)).commands)
  }

  /**
   * Ask the desk for something. `producer` scope: pushing an instruction is the whole point of
   * the queue, and it still has to clear all five gates before it reaches paper.
   *
   * `deadline_at` is sent only when there is one. The desk refuses a string or a negative and
   * takes an absent field as "no deadline", so sending `null` would be a second spelling of the
   * same thing for the desk to have an opinion about.
   */
  async function postCommand(input: PostCommandInput): Promise<Command> {
    const body: Record<string, unknown> = {
      text: input.text,
      kind: input.kind ?? 'custom',
      priority: input.priority ?? 5,
      source: input.source ?? 'app',
    }
    if (input.deadlineAt !== undefined) body.deadline_at = input.deadlineAt
    return parseCommand(asObj((await call('POST', '/api/commands', body)).command))
  }

  /** [operator] Cancel a PENDING instruction. A claimed one is the worker's to finish. */
  async function cancelCommand(id: string): Promise<void> {
    await call('DELETE', `/api/commands/${encodeURIComponent(id)}`)
  }

  async function listDirectives(): Promise<Directive[]> {
    return parseDirectives((await call('GET', '/api/directives')).directives)
  }

  /** [operator] Add a standing rule — one that outlives every gate, which is why it is operator. */
  async function addDirective(input: AddDirectiveInput): Promise<Directive> {
    const scope = input.scope ?? 'always'
    const body: Record<string, unknown> = { rule: input.rule, scope, source: 'app' }
    // The desk refuses 'until' without one and 'always' with one, rather than interpreting
    // either — both are somebody's surprise. Sending the field only when the scope takes it
    // keeps this side from making that mistake in the first place.
    if (scope === 'until' && input.expiresAt !== undefined) body.expires_at = input.expiresAt
    return parseDirective(asObj((await call('POST', '/api/directives', body)).directive))
  }

  /** [operator] Remove one. Expired rules are excluded from the list rather than deleted. */
  async function deleteDirective(id: string): Promise<void> {
    await call('DELETE', `/api/directives/${encodeURIComponent(id)}`)
  }

  async function getSchedule(): Promise<{ source: string; schedule: Schedule }> {
    const doc = await call('GET', '/api/schedule')
    return { source: asStr(doc.source), schedule: parseSchedule(doc.schedule) }
  }

  /**
   * [operator] Replace the whole document. There is no partial schedule: one that fails the
   * desk's validation is refused whole and leaves the one in force untouched, so an operator
   * never has to work out which half of an edit landed.
   */
  async function putSchedule(doc: Schedule): Promise<{ source: string; schedule: Schedule }> {
    const answer = await call('PUT', '/api/schedule', scheduleToWire(doc))
    return { source: asStr(answer.source), schedule: parseSchedule(answer.schedule) }
  }

  /** The next transitions in local time, UTC and epoch seconds. The desk clamps `count` to 1..50. */
  async function getScheduleNext(count = 10): Promise<ScheduleTransition[]> {
    const doc = await call('GET', `/api/schedule/next?count=${count}`)
    return asRows(doc.transitions).map(parseTransition)
  }

  /** [operator] Hold publishing until an instant; null clears it. Returns the hold in force. */
  async function hold(until: number | null): Promise<number | null> {
    return asInstant((await call('POST', '/api/hold', { until })).hold)
  }

  /**
   * [operator] Put the staged edition up now — quiet window and minimum gap included.
   *
   * Deliberately absolute: a rule you cannot override is a rule somebody ends up editing at
   * midnight. `not_found` means nothing is staged.
   */
  async function publish(): Promise<CommitResult> {
    return parseCommitResult(await call('POST', '/api/publish'))
  }

  /** [operator] Replay an old edition as current. Free, because every edition is still a directory. */
  async function promote(eid: string): Promise<CommitResult> {
    return parseCommitResult(await call('POST', `/api/editions/${encodeURIComponent(eid)}/promote`))
  }

  /** The desk's own record of what it has done, newest first. The desk clamps `limit` to 1..200. */
  async function getAudit(limit = 50): Promise<AuditEntry[]> {
    return parseAudit((await call('GET', `/api/audit?limit=${limit}`)).events)
  }

  return {
    baseUrl,
    // the device plane
    getNews,
    // the control plane — reads
    getState,
    listEditions,
    getEdition,
    sheetUrl,
    sheetHeaders,
    getNotes,
    listCommands,
    listDirectives,
    getSchedule,
    getScheduleNext,
    getAudit,
    // producer writes
    postCommand,
    // operator writes
    cancelCommand,
    addDirective,
    deleteDirective,
    putSchedule,
    hold,
    publish,
    promote,
  }
}

export type DeskClient = ReturnType<typeof createDeskClient>
