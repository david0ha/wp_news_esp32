// The desk's control plane, as the phone speaks it.
//
// This is the app's FIRST authenticated call to the desk. Everything the phone did with a desk
// before this file went through the device plane — `GET /news.json` and `/tiles/<id>.bin`, open to
// anything that can reach the desk, no credential at all (see `edition/client.ts`). The control
// plane is the other half of `docs/desk-server.md`'s "two planes": `Authorization: Bearer <token>`
// on every request, two scopes, and the same `{"ok": false, "error": ...}` envelope the board
// itself answers refusals in.
//
// The routes:
//
//   GET  /api/settings   (producer) -> { ok, source: 'file'|'default', settings: { lang } }
//   PUT  /api/settings   (operator) { lang } -> the same shape, with what is now in force
//   GET  /api/positions  (producer) -> { ok, positions: { updated_at, positions: [...] } }
//   PUT  /api/positions  (operator) { positions: [...] } -> the same shape, now in force
//   GET  /api/calendar   (producer) -> { ok, calendar: { generated_at, events: [...] } | null }
//   GET  /api/push/devices          (operator) -> { ok, push: { devices: [...] } | null }
//   POST /api/push/devices          (operator) one device -> the same shape, now in force
//   DELETE /api/push/devices/<token> (operator) -> the same shape, or 404 for a token it never had
//
// The two scopes on `/api/positions` are not symmetric and the asymmetry is the point: the agent
// READS the book to reason about it, but only the owner SAYS what they hold. An agent that could
// rewrite the positions could arrange for the reasoning to be about a position nobody owns.
//
// `/api/calendar` has a PUT and this client does not have one, which is the same asymmetry read
// from the other end: the event book is `producer` on BOTH verbs because the AGENT files it. It
// is the output of a research run rather than a statement about the owner's money, so the phone
// is a reader of it and nothing here can write one.
//
// `/api/push/devices` is the only document on this desk whose READ is operator-only, and the
// reason is not privacy in the ordinary sense: an Expo push token is a *capability*. Whoever holds
// one can put a line of text on the owner's lock screen from anywhere, with no further credential.
// So the three methods below hold to the same rule this file already holds for the operator token —
// it goes into a body or a path and nowhere else, and it is in the message of nothing thrown.
//
// `lang` is the language the NEWSPAPER is written in — not the app's own chrome, which is
// `src/i18n/` and never leaves the phone. The desk's setting is what makes the producing agent
// write Korean; the edition then carries `lang` itself, so a phone reads a Korean edition
// correctly whatever this is set to. See docs/superpowers/specs/2026-09-04-edition-language-design.md.
//
// THE TOKEN IS THE OPERATOR'S OWN and this file is built around not leaking it. It is passed in,
// never read from storage here (`deskToken.ts` owns the keychain), it goes into exactly one header,
// and it never appears in the message of anything thrown — an error sentence is drawn on screen and
// pasted into bug reports, and a token that reaches either is a token to be revoked.

import { fill, strings } from '../i18n'
import { parsePositionsDoc, positionsBody, type PositionsDoc } from './positions'
import { parseCalendarDoc, type CalendarDoc } from './schedule'

/** Long enough for a cold tunnel, short enough that a tap on a selector still feels like one. */
export const DESK_TIMEOUT_MS = 15_000

/** The desk's settings document, as this app uses it. One field today; the route owns the shape. */
export interface DeskSettings {
  /** BCP-47 primary subtag — `en`, `ko`, or anything else the desk has been set to. */
  lang: string
}

/**
 * One registered phone, as `push.parse_devices` normalises it.
 *
 * Typed at the WIRE's width rather than at the app's: `prefs` and `lead` are keyed by whatever the
 * desk sent, not by this app's five switches. A desk one release ahead can carry a sixth kind, and
 * a client that typed it as a closed record would have to either drop it or refuse the document —
 * both of which are this app deciding something about a phone it does not own. `notify.ts` narrows
 * it, for THIS phone's entry only, and leaves the rest alone.
 */
export interface PushDevice {
  token: string
  platform: string
  tz: string
  prefs: Record<string, boolean>
  lead: Record<string, string[]>
  /** ABSENT for a device with no quiet hours — `push._device` omits the key rather than nulling it. */
  quiet?: { from: string; to: string } | null
}

/** Every phone the desk will send to. Empty for a desk that has never been registered with. */
export interface PushDoc {
  devices: PushDevice[]
}

/** One device, as `POST /api/push/devices` takes it. Built field by field — see `deviceBody`. */
export interface PushDeviceBody {
  token: string
  platform: string
  tz: string
  prefs: Record<string, boolean>
  lead: Record<string, string[]>
  quiet?: { from: string; to: string }
}

/**
 * The whole failure vocabulary, four codes, because the SCREEN acts differently on each.
 *
 * `unauthorized` covers both 401 and 403, and folding them is deliberate. The desk keeps them
 * apart for a good reason of its own (`auth.py`: a malformed credential and a real one of the
 * wrong scope are different facts about the token file). To the person holding the phone they are
 * one fact — this token cannot do that — and the sentence names the operator scope either way,
 * because a producer token pasted in by mistake is by far the likelier of the two.
 */
export type DeskErrorCode = 'unauthorized' | 'transport' | 'http' | 'bad_json'

export class DeskError extends Error {
  constructor(
    public readonly code: DeskErrorCode,
    message: string,
    /** HTTP status, when the desk answered at all. */
    public readonly status?: number,
    /** The desk's own wire code from the envelope — `bad_settings`, `forbidden`, … */
    public readonly error?: string,
    /** The desk's `detail`: prose for a human, never something to branch on. */
    public readonly detail?: string,
  ) {
    super(message)
    this.name = 'DeskError'
  }
}

/**
 * Every spelling of an Expo push token, wherever one turns up in prose.
 *
 * `push.py` holds this rule on the desk and calls it `_redact`; this is the same rule read from the
 * other end, and it is needed for the same reason. A push token is a capability, and the desk's own
 * refusals QUOTE what they refused — `push._token`'s message is `'<the token>' is not an Expo push
 * token`, which arrives in `detail` and would otherwise be drawn on screen and pasted into a bug
 * report. The desk redacts what it logs; this redacts what it says.
 *
 * The pattern is `push.TOKEN_RE`'s, both spellings, unanchored so it finds one inside a sentence.
 */
const PUSH_TOKEN = /Expo(?:nent)?PushToken\[[A-Za-z0-9_-]*\]/g

/** `<redacted>`, the same word the desk writes, so a bug report reads alike from both ends. */
export function redactPushTokens(text: string): string {
  return text.replace(PUSH_TOKEN, '<redacted>')
}

/**
 * One sentence per failure, in the language the app is drawn in.
 *
 * The `http` arm is the only one that quotes the desk. `detail` is prose the desk wrote for
 * whoever sent the request, and on the one refusal this screen can actually provoke — a `lang` the
 * desk will not take — it is the only thing that says what was wrong with it. Passing it through
 * inside a catalogue sentence is better than swallowing it: the alternative is "the desk answered
 * 400", which sends the operator to read a server log they may not be able to reach.
 *
 * It goes through `redactPushTokens` on the way, and that is not belt-and-braces: `/api/push/devices`
 * refuses a token BY QUOTING IT, so the one sentence in this app that exists to pass the desk's own
 * words through is also the one place a capability can reach the screen. The redaction lives here
 * rather than at the notification call site because `detail` is the desk's prose on every route,
 * and nothing drawn anywhere in this app ever needs to show a push token.
 */
export function humanDeskError(e: unknown): string {
  const m = strings().errors.desk
  if (e instanceof DeskError) {
    switch (e.code) {
      case 'unauthorized':
        return m.unauthorized
      case 'transport':
        return m.transport
      case 'http':
        if (e.detail) return fill(m.refused, { detail: redactPushTokens(e.detail) })
        return e.status === undefined ? m.http : fill(m.httpStatus, { status: String(e.status) })
      case 'bad_json':
        return m.badJson
    }
  }
  return m.unknown
}

// ---------------------------------------------------------------------------
// What the Settings selector draws. A rule rather than four conditions inside a component, for the
// reason `newsurlsync.ts`'s `decideNewsUrlSave` is one: this app has no screen tests, so anything
// argued inside a `.tsx` is argued only in prose.
// ---------------------------------------------------------------------------

/**
 * The languages the phone can put a desk into, in the order the segments are drawn.
 *
 * NOT the same list as the app's own `APP_LANGUAGES`, which carries `system` — a paper has no
 * system to ask.
 *
 * It is the same list a current desk validates against (`settings.LANGS`), and it is still not
 * safe to assume the desk answers with one of them: a `settings.json` hand-edited before that
 * validation existed, or a desk on an older release, can hold `fr` perfectly legally. That is a
 * state this screen has to draw honestly rather than one it can refuse to have — see
 * `deskLanguageView`'s `unsupported` note.
 */
export const EDITION_LANGUAGES = ['en', 'ko'] as const

export type DeskLanguageNote = 'needs_setup' | 'unsupported' | null

export interface DeskLanguageView {
  /** Index into `EDITION_LANGUAGES`, or `-1` for "no segment is the answer". */
  selectedIndex: number
  disabled: boolean
  /** The line under the control, when there is something to say. */
  note: DeskLanguageNote
}

export function deskLanguageView(input: {
  /** The saved desk address, or `null`. */
  address: string | null
  /** The saved operator token, or `null`. */
  token: string | null
  /** What the desk last said it is set to, or `null` for "not read yet". */
  lang: string | null
  /** A read or a write is in flight. */
  busy: boolean
  /**
   * The phone's own storage has answered about both fields.
   *
   * Until it has, `address` and `token` are `null` because nothing has been read yet — not because
   * nothing is saved. The two are indistinguishable in the state and completely different to the
   * reader, which is why this is a separate input rather than something inferred: without it the
   * section tells an operator who saved both to go and add them, for one frame, on every open.
   */
  loaded: boolean
}): DeskLanguageView {
  const ready = Boolean(input.address) && Boolean(input.token)
  const selectedIndex =
    input.lang === null ? -1 : (EDITION_LANGUAGES as readonly string[]).indexOf(input.lang)
  return {
    selectedIndex,
    // Disabled while unloaded too, and that one IS inferable: there is nothing to call with yet,
    // whichever reason there is nothing.
    disabled: !ready || input.busy,
    // Not knowing the language yet says nothing — the desk has simply not answered. The two notes
    // are for the states that would otherwise look like a bug: a dead control, and a control with
    // no segment lit under a desk that answered perfectly well.
    note: !input.loaded
      ? null
      : !ready
        ? 'needs_setup'
        : selectedIndex < 0 && input.lang !== null
          ? 'unsupported'
          : null,
  }
}

/**
 * The queue's six statuses, exactly as `store.py` spells them.
 *
 * A closed union and not a string, unlike `PushDevice`'s `prefs`, and the asymmetry is
 * deliberate. A foreign push preference belongs to another phone and can be left alone; this row
 * is the one being waited on, and the poll stops on `done` or `failed` and on nothing else — so a
 * status this app cannot classify is one it would sit on forever, with a spinner and no reason.
 */
export const COMMAND_STATUSES = [
  'pending',
  'claimed',
  'done',
  'failed',
  'expired',
  'cancelled',
] as const
export type CommandStatus = (typeof COMMAND_STATUSES)[number]

/** `MAX_COMMAND_TEXT` on the desk. The composer refuses at this length rather than posting a 400. */
export const MAX_COMMAND_TEXT = 2000

/**
 * One row of the desk's command queue, in the app's own spelling.
 *
 * The wire is snake_case and the model is camelCase, which is `edition/parse.ts`'s rule and is
 * worth keeping for the reason that file's header gives: a record stored under wire names and read
 * back through a camelCase reader loses every field whose two spellings differ, silently.
 */
export interface Command {
  id: string
  kind: string
  text: string
  status: CommandStatus
  /** `answered`, `revised <eid>`, `staged <eid>`, or the worker's message on a failure. */
  result: string | null
  /** The previous turn of the same thread, or `null` for the first. */
  replyTo: string | null
  lang: string | null
  source: string
  createdAt: string
  /** Whether `notes.md` is there to be fetched. */
  hasNotes: boolean
}

/** A message from the phone. `kind` and `source` are this client's, not the caller's. */
export interface AskBody {
  text: string
  /** Absent, never null: a null `reply_to` is a claim about a previous command that is not there. */
  replyTo?: string
  lang: string
}

/** What `POST /api/publish` did. A 404 is a state, not a failure — see `publishNow`. */
export type PublishOutcome = 'published' | 'nothing_staged'

function isCommandStatus(v: unknown): v is CommandStatus {
  return typeof v === 'string' && (COMMAND_STATUSES as readonly string[]).includes(v)
}

/**
 * One row, or `null` for a body this client cannot read.
 *
 * The id and the status are required because everything downstream is keyed on one and branches
 * on the other; the rest defaults, because a row missing its `created_at` is still a row worth
 * showing the answer of.
 */
function parseCommand(raw: unknown): Command | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return null
  if (!isCommandStatus(o.status)) return null
  return {
    id: o.id,
    kind: typeof o.kind === 'string' ? o.kind : '',
    text: typeof o.text === 'string' ? o.text : '',
    status: o.status,
    result: typeof o.result === 'string' ? o.result : null,
    replyTo: typeof o.reply_to === 'string' ? o.reply_to : null,
    lang: typeof o.lang === 'string' ? o.lang : null,
    source: typeof o.source === 'string' ? o.source : '',
    createdAt: typeof o.created_at === 'string' ? o.created_at : '',
    hasNotes: o.has_notes === true,
  }
}

export interface DeskClientOptions {
  /** The desk's base address, e.g. `https://desk.example.dev`. A trailing slash is fine. */
  baseUrl: string
  /** An operator token. Held for the life of the client and put in one header. */
  token: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export interface DeskClient {
  getSettings(): Promise<DeskSettings>
  putSettings(settings: DeskSettings): Promise<DeskSettings>
  /** The book of positions the desk holds. */
  positions(): Promise<PositionsDoc>
  /** Put a whole book in force. There is no partial write — see `putPositions`. */
  putPositions(doc: PositionsDoc): Promise<PositionsDoc>
  /**
   * The event book, or `null` for a desk that has none. Read-only: the agent files this one.
   *
   * `null` is a STATE and not a failure, which is the one place this method does not mirror
   * `positions()`. `h_get_calendar` serves `self.desk.calendar` straight and that field is `None`
   * until an agent has filed a book — and again afterwards, whenever the positions change, because
   * the desk forgets a book it can no longer prune against them. Reading a perfectly good answer
   * as `bad_json` would put "the desk answered something this app cannot read" in front of
   * somebody whose desk is simply new.
   */
  calendar(): Promise<CalendarDoc | null>
  /** Every phone the desk will send to. A desk with no file at all answers an empty household. */
  pushDevices(): Promise<PushDoc>
  /** Register or replace ONE phone, by its token. Idempotent — the desk replaces, never appends. */
  registerPushDevice(body: PushDeviceBody): Promise<PushDoc>
  /** Forget one phone. Answers nothing: what matters is that the desk no longer holds the token. */
  forgetPushDevice(token: string): Promise<void>
  /** Put a message on the desk's queue. Answers the row the desk created. */
  postCommand(body: AskBody): Promise<Command>
  /** One row, or `null` for an id the desk has never held under any status. */
  command(id: string): Promise<Command | null>
  /** The worker's answer, as markdown — or `null` for a command that finished without writing one. */
  commandNotes(id: string): Promise<string | null>
  /** Force the staged edition out. `nothing_staged` is an outcome; see the implementation. */
  publishNow(): Promise<PublishOutcome>
}

export function createDeskClient(opts: DeskClientOptions): DeskClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const fetchFn = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? DESK_TIMEOUT_MS

  // Our own deadline firing and the network refusing are one code here, unlike `esp32.ts` where a
  // timeout is a statement about a sleeping board. A desk is a server that is meant to be awake,
  // so both mean the same thing to the reader: it did not answer, check the address.
  async function send(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetchFn(`${baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${opts.token}` },
        signal: controller.signal,
      })
    } catch (e) {
      // The thrown message is the transport's, and a transport that names the URL names no
      // credential — the token travels in a header, which is why this can be quoted at all.
      throw new DeskError('transport', e instanceof Error ? e.message : 'network error')
    } finally {
      clearTimeout(timer)
    }
  }

  // A refusal, turned into the error the screen will draw. The envelope is best-effort: a proxy or
  // a tunnel in front of the desk answers HTML, and a 502 with no `error` field is still a 502.
  //
  // `route` is the second route's doing, as the note this replaces said it would be. It names the
  // document in the thrown message and nowhere else — the error the screen DRAWS comes from the
  // catalogue via `humanDeskError` — so what it is for is a bug report: "positions responded 400"
  // and "settings responded 400" are the same fact about two entirely different screens.
  async function refusal(res: Response, route: string): Promise<DeskError> {
    let code: string | undefined
    let detail: string | undefined
    try {
      const body = JSON.parse(await res.text()) as { error?: unknown; detail?: unknown }
      if (typeof body?.error === 'string') code = body.error
      if (typeof body?.detail === 'string') detail = body.detail
    } catch {
      // Not the desk's envelope. The status is what is left to say.
    }
    const kind: DeskErrorCode = res.status === 401 || res.status === 403 ? 'unauthorized' : 'http'
    return new DeskError(kind, `${route} responded ${res.status}`, res.status, code, detail)
  }

  // Every 2xx on this route answers the same document, so one reader serves both calls.
  async function settingsOf(res: Response): Promise<DeskSettings> {
    if (!res.ok) throw await refusal(res, 'settings')
    let lang: unknown
    try {
      const body = JSON.parse(await res.text()) as { settings?: { lang?: unknown } }
      lang = body?.settings?.lang
    } catch {
      throw new DeskError('bad_json', 'settings did not answer JSON', res.status)
    }
    // A 200 with no `settings.lang` in it is a desk not speaking this contract — an older build,
    // or a captive portal answering 200 for everything. Falling back to `en` here would put a
    // confident English in front of an operator whose desk never said so, and the selector would
    // then offer to "change" it to the value it already claims.
    if (typeof lang !== 'string' || lang === '') {
      throw new DeskError('bad_json', 'settings answered without a language', res.status)
    }
    return { lang }
  }

  // The same job for the other document, and the same reason it is one function rather than two:
  // a GET and a PUT answer the identical envelope, so a client that read them apart would have
  // two chances to disagree with itself about what the desk said.
  //
  // A body this app cannot read is `bad_json` rather than an empty book, and that is the whole
  // care in this function. A book drawn as empty is indistinguishable, on screen, from an owner
  // who holds nothing — and the next PUT from that screen would make it true.
  async function positionsOf(res: Response): Promise<PositionsDoc> {
    if (!res.ok) throw await refusal(res, 'positions')
    let payload: unknown
    try {
      payload = JSON.parse(await res.text())
    } catch {
      throw new DeskError('bad_json', 'positions did not answer JSON', res.status)
    }
    const envelope = payload as { positions?: unknown } | null
    const doc = parsePositionsDoc(envelope?.positions)
    if (doc === null) {
      throw new DeskError('bad_json', 'positions answered a book this app cannot read', res.status)
    }
    return doc
  }

  // The event book, read the same way and refused the same way, with one arm the positions
  // document has no equivalent of: an envelope whose `calendar` is explicitly `null`.
  //
  // That arm is narrow on purpose. A MISSING key still fails — a 200 with no `calendar` at all is
  // a desk not speaking this contract, the same fact `settingsOf` refuses a missing `lang` for —
  // and only an explicit `null`, which is exactly what `h_get_calendar` serves for a desk with no
  // book, reads as "no book". The two look alike in JavaScript and are completely different
  // sentences on screen.
  async function calendarOf(res: Response): Promise<CalendarDoc | null> {
    if (!res.ok) throw await refusal(res, 'calendar')
    let payload: unknown
    try {
      payload = JSON.parse(await res.text())
    } catch {
      throw new DeskError('bad_json', 'calendar did not answer JSON', res.status)
    }
    const envelope = payload as { calendar?: unknown } | null
    if (envelope !== null && typeof envelope === 'object' && envelope.calendar === null) return null
    const doc = parseCalendarDoc(envelope?.calendar)
    if (doc === null) {
      throw new DeskError('bad_json', 'calendar answered a book this app cannot read', res.status)
    }
    return doc
  }

  // The household, read the same way. `push: null` is a desk that has never been registered with,
  // and it reads as an EMPTY household rather than as an absent one — unlike `calendar`, where the
  // difference is a sentence on screen. Here there is nothing to say: a desk with no file and a
  // desk with an empty list will both send to nobody, and the phone's next act on either is the
  // same POST.
  //
  // A device the desk sent that this reader cannot type is dropped rather than refused. The list
  // may hold another phone entirely — an Android, an old handset, a release ahead of this one —
  // and refusing the document over somebody else's entry would take this phone's own switch down
  // with it.
  async function pushOf(res: Response): Promise<PushDoc> {
    if (!res.ok) throw await refusal(res, 'push')
    let payload: unknown
    try {
      payload = JSON.parse(await res.text())
    } catch {
      throw new DeskError('bad_json', 'push did not answer JSON', res.status)
    }
    const envelope = payload as { push?: unknown } | null
    const push = envelope?.push
    if (push === null || push === undefined) return { devices: [] }
    if (typeof push !== 'object') {
      throw new DeskError('bad_json', 'push answered a document this app cannot read', res.status)
    }
    const raw = (push as { devices?: unknown }).devices
    if (!Array.isArray(raw)) {
      throw new DeskError('bad_json', 'push answered a document this app cannot read', res.status)
    }
    return { devices: raw.filter(isPushDevice) }
  }

  // The command envelope, read once for both routes that answer one — the same reason `settingsOf`
  // serves a GET and a PUT: two readers are two chances to disagree about what the desk said.
  async function commandOf(res: Response, route: string): Promise<Command> {
    if (!res.ok) throw await refusal(res, route)
    let payload: unknown
    try {
      payload = JSON.parse(await res.text())
    } catch {
      throw new DeskError('bad_json', `${route} did not answer JSON`, res.status)
    }
    const row = parseCommand((payload as { command?: unknown } | null)?.command)
    if (row === null) {
      throw new DeskError('bad_json', `${route} answered a row this app cannot read`, res.status)
    }
    return row
  }

  return {
    async getSettings(): Promise<DeskSettings> {
      return settingsOf(await send('/api/settings', { method: 'GET' }))
    },

    async putSettings(settings: DeskSettings): Promise<DeskSettings> {
      // The body is built field by field rather than forwarded: the desk refuses a document
      // carrying a key it does not know, whole, with `bad_settings` — so echoing back the `source`
      // and `ok` that came with a read would be refused, and passing a caller's object through
      // would make that failure depend on where the object had been.
      const res = await send('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: settings.lang }),
      })
      // The answer is what is IN FORCE, which is not always what was asked for — the desk
      // normalises, and a later release may refuse a value while keeping the old one. The caller
      // draws this, never its own argument.
      return settingsOf(res)
    },

    async positions(): Promise<PositionsDoc> {
      return positionsOf(await send('/api/positions', { method: 'GET' }))
    },

    async putPositions(doc: PositionsDoc): Promise<PositionsDoc> {
      // The body is built by `positionsBody` field by field, for the reason `putSettings` builds
      // its own: the desk refuses an unknown key whole with `bad_positions`, and `strategy` — the
      // field a GET puts on every option position — is refused *by name*, because it is derived
      // and a supplied one could contradict the legs beside it. Echoing back what was read is
      // therefore not a shortcut, it is a 400.
      const res = await send('/api/positions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(positionsBody(doc)),
      })
      // What is in force, not what was asked for — and here that is more than a formality: the
      // desk re-derives every `id` and every `strategy` from the legs it accepted, so this answer
      // is the only place the app learns what its own write became.
      return positionsOf(res)
    },

    async calendar(): Promise<CalendarDoc | null> {
      return calendarOf(await send('/api/calendar', { method: 'GET' }))
    },

    async pushDevices(): Promise<PushDoc> {
      return pushOf(await send('/api/push/devices', { method: 'GET' }))
    },

    async registerPushDevice(body: PushDeviceBody): Promise<PushDoc> {
      // Field by field again, and here the refused key has a name worth knowing: `last_seen` is
      // in the document a GET hands back and is stamped by the desk on the entry it just took, so
      // a client that echoed a read straight back would be refused by the clock rather than by
      // anything the owner touched. `deviceBody` is the only builder; nothing forwards a device.
      const res = await send('/api/push/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return pushOf(res)
    },

    async forgetPushDevice(token: string): Promise<void> {
      // The token is a path segment, so it is percent-encoded on the way out: Expo's spelling
      // carries brackets, and the desk unquotes the path before it matches. It reaches the
      // handler as the string the phone owns and is compared, never parsed.
      const res = await send(`/api/push/devices/${encodeURIComponent(token)}`, { method: 'DELETE' })
      // A 404 IS THE ANSWER THIS CALL WANTED. The desk says "no such device" for a token it does
      // not hold, and a token it does not hold is exactly the state the owner asked for by
      // turning the switch off. Treating it as a failure would leave the switch reporting on —
      // and reporting on is a promise that the desk is still sending, which it is not.
      if (!res.ok && res.status !== 404) throw await refusal(res, 'push')
    },

    async postCommand(body: AskBody): Promise<Command> {
      // Field by field, in the order the desk's own document lists them, for the reason every
      // other body in this file is built by hand: an unknown key is refused whole. `reply_to` is
      // spread in only when there is one — see `AskBody`.
      const wire = {
        kind: 'ask',
        text: body.text,
        lang: body.lang,
        ...(body.replyTo === undefined ? {} : { reply_to: body.replyTo }),
        source: 'app',
      }
      const res = await send('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wire),
      })
      return commandOf(res, 'commands')
    },

    async command(id: string): Promise<Command | null> {
      const res = await send(`/api/commands/${encodeURIComponent(id)}`, { method: 'GET' })
      // A 404 IS AN ANSWER, and not the one an earlier version of this comment claimed. Rows are
      // never deleted — `reap()` only ever UPDATEs a command's status, and an expired one still
      // answers 200 with `status: "expired"`. So a 404 here means exactly one thing: an id the
      // desk never held at all, not one that lapsed away. A state the turn renders either way, not
      // a transport failure that a retry would fix. `forgetPushDevice` takes a 404 the same way
      // and for the same reason: the status describes the world, not the request.
      if (res.status === 404) return null
      return commandOf(res, 'commands')
    },

    async commandNotes(id: string): Promise<string | null> {
      const res = await send(`/api/commands/${encodeURIComponent(id)}/notes.md`, { method: 'GET' })
      // The same 404 rule, over a narrower fact: a command that finished and wrote no answer.
      // The worker treats that as a failure on its own side; the phone still has to draw the turn.
      if (res.status === 404) return null
      if (!res.ok) throw await refusal(res, 'notes')
      // `text/markdown`, not JSON — the only route in this client that is not an envelope.
      return res.text()
    },

    async publishNow(): Promise<PublishOutcome> {
      const res = await send('/api/publish', { method: 'POST' })
      // "Nothing is staged" is not this phone failing to publish; it is the staged edition
      // already being out — published by the owner's own tooling, or by a second phone answering
      // the same push. The caller's next act is identical either way: go and refetch the paper.
      if (res.status === 404) return 'nothing_staged'
      if (!res.ok) throw await refusal(res, 'publish')
      return 'published'
    },
  }
}

/**
 * One entry from the desk's household, or nothing.
 *
 * A predicate rather than a parser because there is nothing to normalise: `push.parse_devices`
 * has already refused anything malformed on the way IN, so an entry that fails this check is a
 * desk speaking a contract this app does not know, and the honest thing is to leave it out of
 * this phone's reckoning rather than to guess at it.
 */
function isPushDevice(v: unknown): v is PushDevice {
  if (v === null || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  return (
    typeof d.token === 'string' &&
    typeof d.platform === 'string' &&
    typeof d.tz === 'string' &&
    typeof d.prefs === 'object' &&
    d.prefs !== null &&
    typeof d.lead === 'object' &&
    d.lead !== null
  )
}
