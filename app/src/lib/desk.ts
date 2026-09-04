// The desk's control plane, as the phone speaks it.
//
// This is the app's FIRST authenticated call to the desk. Everything the phone did with a desk
// before this file went through the device plane — `GET /news.json` and `/tiles/<id>.bin`, open to
// anything that can reach the desk, no credential at all (see `edition/client.ts`). The control
// plane is the other half of `docs/desk-server.md`'s "two planes": `Authorization: Bearer <token>`
// on every request, two scopes, and the same `{"ok": false, "error": ...}` envelope the board
// itself answers refusals in.
//
// One route, for now:
//
//   GET  /api/settings   (producer) -> { ok, source: 'file'|'default', settings: { lang } }
//   PUT  /api/settings   (operator) { lang } -> the same shape, with what is now in force
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

/** Long enough for a cold tunnel, short enough that a tap on a selector still feels like one. */
export const DESK_TIMEOUT_MS = 15_000

/** The desk's settings document, as this app uses it. One field today; the route owns the shape. */
export interface DeskSettings {
  /** BCP-47 primary subtag — `en`, `ko`, or anything else the desk has been set to. */
  lang: string
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
 * One sentence per failure, in the language the app is drawn in.
 *
 * The `http` arm is the only one that quotes the desk. `detail` is prose the desk wrote for
 * whoever sent the request, and on the one refusal this screen can actually provoke — a `lang` the
 * desk will not take — it is the only thing that says what was wrong with it. Passing it through
 * inside a catalogue sentence is better than swallowing it: the alternative is "the desk answered
 * 400", which sends the operator to read a server log they may not be able to reach.
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
        if (e.detail) return fill(m.refused, { detail: e.detail })
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
  // The route names itself in the message rather than arriving as an argument. There is one route
  // here, so a parameter would be a knob with a single setting that a reader has to check both
  // call sites to rule out; the second route can add it back, and will say what it is for.
  async function refusal(res: Response): Promise<DeskError> {
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
    return new DeskError(kind, `settings responded ${res.status}`, res.status, code, detail)
  }

  // Every 2xx on this route answers the same document, so one reader serves both calls.
  async function settingsOf(res: Response): Promise<DeskSettings> {
    if (!res.ok) throw await refusal(res)
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
  }
}
