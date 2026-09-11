import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createDeskClient,
  deskLanguageView,
  DeskError,
  EDITION_LANGUAGES,
  humanDeskError,
  redactPushTokens,
} from './desk'
import { setActiveLanguage } from '../i18n'

const BASE = 'https://desk.example.dev'
const TOKEN = 'operator-token-for-tests'

const EDITION_FIXTURE = join(
  __dirname,
  '../../../components/news_core/test/host/fixtures/news.json',
)

// A fake `fetch` that replays a queue of responses, or throws a queued Error for a refused
// connection. Every call is recorded, because the things this client has to get right are all
// properties of the REQUEST: the method, the path, the bearer header and the exact body.
//
// `headers` and `arrayBuffer` are here for `editionClient`'s sake — `editionPayload` reads one
// through `edition/client.ts`, which needs `res.headers.get()` (case-insensitively, for the ETag)
// and `res.arrayBuffer()` rather than `res.text()`. Widened in place rather than duplicated: two
// fakes in this file would be two answers to "what does a response look like here".
type Reply = { status?: number; text?: string; headers?: Record<string, string> } | Error

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = replies[Math.min(i, replies.length - 1)]
    i++
    if (r instanceof Error) throw r
    const status = r.status ?? 200
    const headers = r.headers ?? {}
    const text = r.text ?? ''
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k: string) => {
          const hit = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase())
          return hit === undefined ? null : headers[hit]
        },
      },
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function client(replies: Reply[], token = TOKEN) {
  const f = fakeFetch(replies)
  return { ...f, client: createDeskClient({ baseUrl: BASE, token, fetchFn: f.fetchImpl }) }
}

const okBody = (lang: string) =>
  JSON.stringify({ ok: true, source: 'file', settings: { lang } })

const header = (init: RequestInit | undefined, name: string): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.[name]

describe('deskClient.getSettings', () => {
  it('GETs /api/settings with the operator token as a bearer', async () => {
    const { client: c, calls } = client([{ text: okBody('ko') }])
    expect(await c.getSettings()).toEqual({ lang: 'ko' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://desk.example.dev/api/settings')
    expect(calls[0].init?.method).toBe('GET')
    expect(header(calls[0].init, 'Authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('trims a trailing slash off the desk address rather than doubling it', async () => {
    const f = fakeFetch([{ text: okBody('en') }])
    const c = createDeskClient({ baseUrl: `${BASE}/`, token: TOKEN, fetchFn: f.fetchImpl })
    await c.getSettings()
    expect(f.calls[0].url).toBe('https://desk.example.dev/api/settings')
  })

  it('reads a language this app does not offer without inventing one', async () => {
    // The selector shows no segment for it, which is the honest draw. Substituting 'en' here
    // would tell the operator their paper is in English when the desk says it is in French.
    const { client: c } = client([{ text: okBody('fr') }])
    expect(await c.getSettings()).toEqual({ lang: 'fr' })
  })
})

describe('deskClient.putSettings', () => {
  it('PUTs exactly {"lang":"ko"} and answers with the desk’s settings', async () => {
    const { client: c, calls } = client([{ text: okBody('ko') }])
    expect(await c.putSettings({ lang: 'ko' })).toEqual({ lang: 'ko' })
    expect(calls[0].init?.method).toBe('PUT')
    // The body is asserted as bytes, not as a parsed object: the desk refuses an unknown key
    // whole (`bad_settings`), so a client that helpfully sent `source` back would be refused.
    expect(calls[0].init?.body).toBe('{"lang":"ko"}')
    expect(header(calls[0].init, 'Content-Type')).toBe('application/json')
    expect(header(calls[0].init, 'Authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('answers with what the desk put in force, not with what was asked for', async () => {
    const { client: c } = client([{ text: okBody('en') }])
    expect(await c.putSettings({ lang: 'ko' })).toEqual({ lang: 'en' })
  })
})

describe('the failures', () => {
  it('reads a 401 as unauthorized', async () => {
    const { client: c } = client([
      { status: 401, text: JSON.stringify({ ok: false, error: 'unauthorized' }) },
    ])
    await expect(c.getSettings()).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
  })

  it('reads a 403 as unauthorized too', async () => {
    // A producer token is a real credential of the wrong scope. The distinction is the desk's
    // business; to the person holding the phone both mean "this token cannot do that".
    const { client: c } = client([
      { status: 403, text: JSON.stringify({ ok: false, error: 'forbidden' }) },
    ])
    await expect(c.putSettings({ lang: 'ko' })).rejects.toMatchObject({
      code: 'unauthorized',
      status: 403,
    })
  })

  it('surfaces the detail the desk sent with a bad_settings 400', async () => {
    const { client: c } = client([
      {
        status: 400,
        text: JSON.stringify({
          ok: false,
          error: 'bad_settings',
          detail: "lang: must be one of: en, ko -- got 'Korean'",
        }),
      },
    ])
    const e = await c.putSettings({ lang: 'Korean' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(DeskError)
    expect(e).toMatchObject({ code: 'http', status: 400, error: 'bad_settings' })
    expect((e as DeskError).detail).toBe("lang: must be one of: en, ko -- got 'Korean'")
  })

  it('reads a 500 with no envelope as an http failure carrying the status', async () => {
    const { client: c } = client([{ status: 500, text: '<html>gateway</html>' }])
    await expect(c.getSettings()).rejects.toMatchObject({ code: 'http', status: 500 })
  })

  it('reads a refused connection as transport', async () => {
    const { client: c } = client([new Error('Network request failed')])
    await expect(c.getSettings()).rejects.toMatchObject({ code: 'transport' })
  })

  it('reads a 200 that is not JSON as bad_json', async () => {
    const { client: c } = client([{ text: 'not json at all' }])
    await expect(c.getSettings()).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('reads a 200 with no language in it as bad_json', async () => {
    // A desk that answers 200 without `settings.lang` is not speaking this contract. Defaulting
    // to English would draw a confident answer out of a desk that gave none.
    const { client: c } = client([{ text: JSON.stringify({ ok: true, settings: {} }) }])
    await expect(c.getSettings()).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('never puts the token in the message of anything it throws', async () => {
    // The one rule this file exists to keep. An error is shown on screen and copied into bug
    // reports; a token that reaches either is a token to be revoked.
    const { client: c } = client([new Error(`connect to ${BASE} failed`)])
    const e = await c.getSettings().catch((x: unknown) => x)
    expect(String((e as Error).message)).not.toContain(TOKEN)
  })
})

describe('humanDeskError', () => {
  it('names the scope for an unauthorized, in the language in force', () => {
    setActiveLanguage('en')
    const en = humanDeskError(new DeskError('unauthorized', 'unauthorized', 403))
    expect(en).toMatch(/operator/i)
    setActiveLanguage('ko')
    expect(humanDeskError(new DeskError('unauthorized', 'unauthorized', 403))).not.toBe(en)
    setActiveLanguage('en')
  })

  it('quotes the desk’s own detail when there is one', () => {
    const e = new DeskError('http', 'settings responded 400', 400, 'bad_settings', 'lang is bad')
    expect(humanDeskError(e)).toContain('lang is bad')
  })

  it('falls back to the status when the desk sent no detail', () => {
    expect(humanDeskError(new DeskError('http', 'settings responded 502', 502))).toContain('502')
  })

  it('has a sentence for anything that is not a DeskError at all', () => {
    expect(humanDeskError(new Error('boom'))).toBeTruthy()
  })

  it('redacts a push token out of the desk’s own detail', () => {
    // `/api/push/devices` refuses a token BY QUOTING IT — `push._token`'s message is
    // `'<the token>' is not an Expo push token` — so the one function in this app whose job is to
    // pass the desk's words through is also the one place a capability can reach the screen and
    // the clipboard. The desk redacts what it logs; this redacts what it says.
    const e = new DeskError(
      'http',
      'push responded 400',
      400,
      'bad_push',
      "push.devices[0].token: 'ExponentPushToken[0000000000AAAAAAAAAA]' is not an Expo push token",
    )
    const said = humanDeskError(e)
    expect(said).not.toContain('0000000000AAAAAAAAAA')
    expect(said).toContain('<redacted>')
    // The reason still gets through — swallowing the detail would leave "the desk answered 400".
    expect(said).toContain('is not an Expo push token')
  })

  it('redacts both spellings, and leaves the shape hint alone', () => {
    // `ExpoPushToken[...]` has been issued alongside the longer spelling since the beginning, so
    // a redaction that knew only one would leak the other. The bracketed ellipsis at the end of
    // the desk's message is a statement of what a token LOOKS like — it carries nothing, and it is
    // the only useful half of that sentence for somebody who pasted the wrong string.
    const said = redactPushTokens(
      "'ExpoPushToken[abc-123_x]' and 'ExponentPushToken[QQQ]' are not ExponentPushToken[...]",
    )
    expect(said).toBe("'<redacted>' and '<redacted>' are not ExponentPushToken[...]")
  })
})

describe('deskLanguageView — what the Settings selector draws', () => {
  const view = (over: Partial<Parameters<typeof deskLanguageView>[0]> = {}) =>
    deskLanguageView({
      address: BASE,
      token: TOKEN,
      lang: 'en',
      busy: false,
      loaded: true,
      ...over,
    })

  it('offers English and Korean, in that order', () => {
    expect([...EDITION_LANGUAGES]).toEqual(['en', 'ko'])
  })

  it('highlights the language the desk reported', () => {
    expect(view({ lang: 'ko' })).toEqual({ selectedIndex: 1, disabled: false, note: null })
  })

  it('is disabled with nothing selected until a token is saved', () => {
    // The address alone reads nothing: every call on this plane carries a credential.
    expect(view({ token: null, lang: null })).toEqual({
      selectedIndex: -1,
      disabled: true,
      note: 'needs_setup',
    })
  })

  it('is disabled without a desk address, for the same reason', () => {
    expect(view({ address: null, lang: null })).toEqual({
      selectedIndex: -1,
      disabled: true,
      note: 'needs_setup',
    })
  })

  it('is disabled while a call is in flight, keeping the language on screen', () => {
    // The selector stays where it is rather than clearing: a tap that is still travelling must not
    // make the paper's language look unknown for the length of a round trip.
    expect(view({ busy: true, lang: 'ko' })).toEqual({
      selectedIndex: 1,
      disabled: true,
      note: null,
    })
  })

  it('highlights nothing, and says so, for a language this app does not offer', () => {
    // A desk set to French is a real state: a current desk refuses `fr` at the door, and a
    // `settings.json` written by hand before it did — or a desk on an older release — holds one
    // perfectly legally. Highlighting English for it would be a lie about the paper, and
    // highlighting nothing without a word of explanation looks like a bug.
    expect(view({ lang: 'fr' })).toEqual({ selectedIndex: -1, disabled: false, note: 'unsupported' })
  })

  it('says nothing at all while the desk has not answered yet', () => {
    expect(view({ lang: null, busy: true })).toEqual({
      selectedIndex: -1,
      disabled: true,
      note: null,
    })
  })

  it('says nothing before storage has answered, rather than flashing "add a token"', () => {
    // Both fields start null behind an async read of AsyncStorage and the keychain, so every
    // open of Settings would otherwise show "Add the desk's address and an operator token" for a
    // frame — to the operator who has already saved both. The control is still disabled, which is
    // true: there is nothing to call with yet.
    expect(deskLanguageView({ address: null, token: null, lang: null, busy: false, loaded: false }))
      .toEqual({ selectedIndex: -1, disabled: true, note: null })
  })

  it('says it once storage has answered and there really is nothing saved', () => {
    expect(deskLanguageView({ address: null, token: null, lang: null, busy: false, loaded: true }))
      .toEqual({ selectedIndex: -1, disabled: true, note: 'needs_setup' })
  })
})

// The house placeholder, and the only push token in this repository. A token is a capability to
// write on somebody's lock screen, so a plausible-looking fixture is one nobody could tell from a
// real one in a paste.
const PUSH = 'ExponentPushToken[0000000000AAAAAAAAAA]'

const pushBody = (devices: unknown[]) => JSON.stringify({ ok: true, push: { devices } })

const oneDevice = {
  token: PUSH,
  platform: 'ios',
  tz: 'Asia/Seoul',
  prefs: { earnings: true, expiry: true, dividend: true, econ: false, researched: true },
  lead: { earnings: ['P1D'], expiry: ['P7D', 'P1D'], dividend: ['P1D'], econ: [], researched: ['P1D'] },
  last_seen: '2026-09-08T05:00:00Z',
}

describe('deskClient.pushDevices', () => {
  it('GETs the household at operator scope', async () => {
    const { client: c, calls } = client([{ text: pushBody([oneDevice]) }])
    const doc = await c.pushDevices()
    expect(calls[0].url).toBe('https://desk.example.dev/api/push/devices')
    expect(calls[0].init?.method).toBe('GET')
    expect(header(calls[0].init, 'Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(doc.devices).toHaveLength(1)
    expect(doc.devices[0].token).toBe(PUSH)
  })

  it('reads a desk that has never been registered with as an empty household', async () => {
    // `h_get_push_devices` serves `self.desk.push_devices` straight, and that is `None` until a
    // phone has registered. It is not a failure and not a state with a sentence: a desk with no
    // file and a desk with an empty list both send to nobody, and the next act on either is the
    // same POST.
    const { client: c } = client([{ text: JSON.stringify({ ok: true, push: null }) }])
    expect(await c.pushDevices()).toEqual({ devices: [] })
  })

  it('drops an entry it cannot read rather than refusing the household', async () => {
    // The list may hold another phone entirely — an Android, a release ahead of this one. Refusing
    // the document over somebody else's entry would take this phone's own switch down with it.
    const { client: c } = client([{ text: pushBody([{ token: 42 }, oneDevice]) }])
    expect((await c.pushDevices()).devices).toHaveLength(1)
  })

  it('refuses a body that is not this document at all', async () => {
    const { client: c } = client([{ text: JSON.stringify({ ok: true, push: { devices: 'no' } }) }])
    await expect(c.pushDevices()).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('turns a 403 into the unauthorized code, like every other route', async () => {
    const { client: c } = client([{ status: 403, text: '{"ok":false,"error":"forbidden"}' }])
    await expect(c.pushDevices()).rejects.toMatchObject({ code: 'unauthorized', status: 403 })
  })
})

describe('deskClient.registerPushDevice', () => {
  it('POSTs the one device it was given, and nothing else', async () => {
    const { client: c, calls } = client([{ text: pushBody([oneDevice]) }])
    await c.registerPushDevice({
      token: PUSH,
      platform: 'ios',
      tz: 'Asia/Seoul',
      prefs: { econ: true },
      lead: { econ: ['PT3H'] },
    })
    expect(calls[0].init?.method).toBe('POST')
    // As bytes: `push._no_extra_keys` refuses the whole document over one key it does not know,
    // and `last_seen` — which a GET carries and the desk stamps itself — is the one a client that
    // echoed a read straight back would send.
    expect(calls[0].init?.body).toBe(
      '{"token":"ExponentPushToken[0000000000AAAAAAAAAA]","platform":"ios","tz":"Asia/Seoul","prefs":{"econ":true},"lead":{"econ":["PT3H"]}}',
    )
  })

  it('surfaces the desk’s own reason for refusing a preference', async () => {
    const { client: c } = client([
      {
        status: 400,
        text: '{"ok":false,"error":"bad_push","detail":"push.devices[0].lead.econ[0]: no"}',
      },
    ])
    await expect(
      c.registerPushDevice({ token: PUSH, platform: 'ios', tz: 'UTC', prefs: {}, lead: {} }),
    ).rejects.toMatchObject({
      code: 'http',
      error: 'bad_push',
      detail: 'push.devices[0].lead.econ[0]: no',
    })
  })
})

describe('deskClient.forgetPushDevice', () => {
  it('DELETEs the token, percent-encoded into the path', async () => {
    const { client: c, calls } = client([{ text: pushBody([]) }])
    await c.forgetPushDevice(PUSH)
    expect(calls[0].init?.method).toBe('DELETE')
    expect(calls[0].url).toBe(
      'https://desk.example.dev/api/push/devices/ExponentPushToken%5B0000000000AAAAAAAAAA%5D',
    )
  })

  it('takes a 404 as the answer it wanted', async () => {
    // "No such device" is exactly the state the owner asked for by turning the switch off. Reading
    // it as a failure would leave the switch reporting on — which is a promise that the desk is
    // still sending, when it is not.
    const { client: c } = client([{ status: 404, text: '{"ok":false,"error":"not_found"}' }])
    await expect(c.forgetPushDevice(PUSH)).resolves.toBeUndefined()
  })

  it('does not swallow a refusal that is not a 404', async () => {
    const { client: c } = client([{ status: 401, text: '{"ok":false,"error":"unauthorized"}' }])
    await expect(c.forgetPushDevice(PUSH)).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

const commandRow = (over: Record<string, unknown> = {}) => ({
  id: 'c0ffee00',
  kind: 'ask',
  text: 'why did it move?',
  status: 'pending',
  result: null,
  reply_to: null,
  lang: 'ko',
  source: 'app',
  created_at: '2026-09-10T01:02:03Z',
  has_notes: false,
  ...over,
})

const commandBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: true, command: commandRow(over) })

describe('deskClient.postCommand', () => {
  it('POSTs exactly the four fields the desk takes, and reads the row back', async () => {
    const { client: c, calls } = client([{ text: commandBody() }])
    const row = await c.postCommand({ text: 'why did it move?', lang: 'ko' })
    expect(calls[0].url).toBe('https://desk.example.dev/api/commands')
    expect(calls[0].init?.method).toBe('POST')
    expect(header(calls[0].init, 'Authorization')).toBe(`Bearer ${TOKEN}`)
    // As bytes, like every other body in this file: the desk refuses an unknown key whole, and
    // `reply_to` is ABSENT rather than null on a first turn — a null reply_to is a claim about a
    // previous command, and there is not one.
    expect(calls[0].init?.body).toBe(
      '{"kind":"ask","text":"why did it move?","lang":"ko","source":"app"}',
    )
    expect(row).toEqual({
      id: 'c0ffee00',
      kind: 'ask',
      text: 'why did it move?',
      status: 'pending',
      result: null,
      replyTo: null,
      lang: 'ko',
      source: 'app',
      createdAt: '2026-09-10T01:02:03Z',
      hasNotes: false,
    })
  })

  it('carries reply_to when this is a follow-up', async () => {
    const { client: c, calls } = client([{ text: commandBody({ reply_to: 'deadbeef' }) }])
    await c.postCommand({ text: 'and the CFO?', lang: 'en', replyTo: 'deadbeef' })
    expect(calls[0].init?.body).toBe(
      '{"kind":"ask","text":"and the CFO?","lang":"en","reply_to":"deadbeef","source":"app"}',
    )
  })

  it('surfaces the desk’s own reason for refusing a message', async () => {
    const { client: c } = client([
      { status: 400, text: '{"ok":false,"error":"bad_command","detail":"text: too long"}' },
    ])
    await expect(c.postCommand({ text: 'x'.repeat(3000), lang: 'en' })).rejects.toMatchObject({
      code: 'http',
      error: 'bad_command',
      detail: 'text: too long',
    })
  })
})

describe('deskClient.command', () => {
  it('GETs one command and maps the wire names to the app’s', async () => {
    const { client: c, calls } = client([
      { text: commandBody({ status: 'done', result: 'revised abc123', has_notes: true }) },
    ])
    const row = await c.command('c0ffee00')
    expect(calls[0].url).toBe('https://desk.example.dev/api/commands/c0ffee00')
    expect(calls[0].init?.method).toBe('GET')
    expect(row).toMatchObject({ status: 'done', result: 'revised abc123', hasNotes: true })
  })

  it('reads a 404 as “the desk no longer has this”, not as a failure', async () => {
    // A command the desk has forgotten is a state the thread renders. Throwing would put a
    // network error card over a turn whose only real problem is that it is gone.
    const { client: c } = client([{ status: 404, text: '{"ok":false,"error":"not_found"}' }])
    expect(await c.command('c0ffee00')).toBeNull()
  })

  it('refuses a status this app cannot classify', async () => {
    // The poll stops on `done` or `failed` and on nothing else, so a status it does not know is
    // one it would wait on forever.
    const { client: c } = client([{ text: commandBody({ status: 'reticulating' }) }])
    await expect(c.command('c0ffee00')).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('percent-encodes the id into the path', async () => {
    const { client: c, calls } = client([{ text: commandBody() }])
    await c.command('a/b')
    expect(calls[0].url).toBe('https://desk.example.dev/api/commands/a%2Fb')
  })
})

describe('deskClient.commandNotes', () => {
  it('GETs the markdown as text, not as JSON', async () => {
    const { client: c, calls } = client([{ text: '# Why it moved\n\nThe guide.\n' }])
    expect(await c.commandNotes('c0ffee00')).toBe('# Why it moved\n\nThe guide.\n')
    expect(calls[0].url).toBe('https://desk.example.dev/api/commands/c0ffee00/notes.md')
  })

  it('reads a 404 as “no answer was written”', async () => {
    const { client: c } = client([{ status: 404, text: '{"ok":false,"error":"not_found"}' }])
    expect(await c.commandNotes('c0ffee00')).toBeNull()
  })

  it('does not swallow a refusal that is not a 404', async () => {
    const { client: c } = client([{ status: 403, text: '{"ok":false,"error":"forbidden"}' }])
    await expect(c.commandNotes('c0ffee00')).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

describe('deskClient.publishNow', () => {
  it('POSTs /api/publish with no body at all', async () => {
    const { client: c, calls } = client([{ text: '{"ok":true,"edition":"abc123"}' }])
    expect(await c.publishNow()).toBe('published')
    expect(calls[0].url).toBe('https://desk.example.dev/api/publish')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.body).toBeUndefined()
  })

  it('reads “nothing is staged” as an outcome rather than an error', async () => {
    // The staged edition went out some other way — the owner's own tooling, or a second phone.
    // The paper still changed, which is the fact the screen is about to act on.
    const { client: c } = client([{ status: 404, text: '{"ok":false,"error":"nothing is staged"}' }])
    expect(await c.publishNow()).toBe('nothing_staged')
  })

  it('turns a 403 into unauthorized, like every other route', async () => {
    const { client: c } = client([{ status: 403, text: '{"ok":false,"error":"forbidden"}' }])
    await expect(c.publishNow()).rejects.toMatchObject({ code: 'unauthorized', status: 403 })
  })
})

const paperRow = (over: Record<string, unknown> = {}) => ({
  symbol: 'SNDK',
  name: 'SanDisk',
  edition_id: 'a1b2c3d4e5f60718',
  created_at: 1_757_000_000,
  lang: 'en',
  headline: 'The guide, not the buyback',
  on_board: true,
  stale: false,
  ...over,
})

const papersBody = (papers: unknown[], board: unknown = 'a1b2c3d4e5f60718') =>
  JSON.stringify({ ok: true, papers, board })

describe('deskClient.papers', () => {
  it('GETs /api/papers with the bearer and reads the rows in the order given', async () => {
    const { client: c, calls } = client([
      {
        text: papersBody([
          paperRow(),
          paperRow({ symbol: 'TSLA', name: 'Tesla', on_board: false }),
        ]),
      },
    ])
    const doc = await c.papers()
    expect(calls[0].url).toBe('https://desk.example.dev/api/papers')
    expect(calls[0].init?.method).toBe('GET')
    expect(header(calls[0].init, 'Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(doc.board).toBe('a1b2c3d4e5f60718')
    expect(doc.papers.map((p) => p.symbol)).toEqual(['SNDK', 'TSLA'])
    expect(doc.papers[0]).toEqual({
      symbol: 'SNDK',
      name: 'SanDisk',
      editionId: 'a1b2c3d4e5f60718',
      // SECONDS ON THE WIRE, MILLISECONDS IN THE MODEL. Everything else this app holds as a
      // number is a millisecond stamp, and one that is not renders as 1970.
      createdAt: 1_757_000_000_000,
      lang: 'en',
      headline: 'The guide, not the buyback',
      onBoard: true,
      stale: false,
    })
  })

  it('reads a symbol with no paper as a row of nulls, not as an absent row', async () => {
    // The pager draws a page for it saying the desk has not written one yet. Skipping it would
    // make a company disappear from the phone because it is new to the watchlist.
    const { client: c } = client([
      {
        text: papersBody([
          paperRow({
            symbol: 'MU',
            name: 'Micron',
            edition_id: null,
            created_at: null,
            lang: null,
            headline: null,
            on_board: false,
            stale: true,
          }),
        ]),
      },
    ])
    const doc = await c.papers()
    expect(doc.papers[0]).toMatchObject({
      symbol: 'MU',
      editionId: null,
      createdAt: null,
      headline: null,
      onBoard: false,
      stale: true,
    })
  })

  it('drops a row it cannot type instead of refusing the whole list', async () => {
    // Four companies must not vanish because the fifth has a broken row. `pushOf`'s rule.
    const { client: c } = client([
      { text: papersBody([{ name: 'no symbol here' }, paperRow({ symbol: 'TSLA' })]) },
    ])
    expect((await c.papers()).papers.map((p) => p.symbol)).toEqual(['TSLA'])
  })

  it('reads a desk with no current edition as board: null', async () => {
    const { client: c } = client([{ text: papersBody([paperRow({ on_board: false })], null) }])
    expect((await c.papers()).board).toBeNull()
  })

  it('refuses a 200 that carries no papers array at all', async () => {
    // A captive portal answering 200 for everything, or a desk not speaking this contract. An
    // empty pager drawn from it would say "no companies" about a watchlist with five.
    const { client: c } = client([{ text: '{"ok":true}' }])
    await expect(c.papers()).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('passes a refusal through with the desk’s own reason', async () => {
    const { client: c } = client([{ status: 403, text: '{"ok":false,"error":"forbidden"}' }])
    await expect(c.papers()).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

describe('deskClient.publishPaper', () => {
  it('POSTs to the symbol’s publish route and reads what was promoted', async () => {
    const { client: c, calls } = client([
      { text: '{"ok":true,"edition_id":"a1b2c3d4e5f60718","state":"published"}' },
    ])
    expect(await c.publishPaper('SNDK')).toEqual({
      kind: 'published',
      editionId: 'a1b2c3d4e5f60718',
      state: 'published',
    })
    expect(calls[0].url).toBe('https://desk.example.dev/api/papers/SNDK/publish')
    expect(calls[0].init?.method).toBe('POST')
  })

  it('reads “that paper is already on the board” without inventing a failure', async () => {
    const { client: c } = client([{ text: '{"ok":true,"edition_id":"e1","state":"unchanged"}' }])
    expect(await c.publishPaper('SNDK')).toEqual({
      kind: 'published',
      editionId: 'e1',
      state: 'unchanged',
    })
  })

  it('reads a 404 as “there is no paper for this symbol”, a state and not a failure', async () => {
    const { client: c } = client([{ status: 404, text: '{"ok":false,"error":"no_paper"}' }])
    expect(await c.publishPaper('MU')).toEqual({ kind: 'no_paper' })
  })

  it('percent-encodes the symbol into the path', async () => {
    // 'BRK.B' has no character `encodeURIComponent` touches, and the desk's own symbol charset
    // (`[A-Z0-9.-]`) never produces one either — this only proves the dot survives untouched. The
    // real proof of encoding is the next test, over a character the desk never validated (R-4).
    const { client: c, calls } = client([
      { text: '{"ok":true,"edition_id":"e","state":"published"}' },
    ])
    await c.publishPaper('BRK.B')
    expect(calls[0].url).toBe('https://desk.example.dev/api/papers/BRK.B/publish')
  })

  it('percent-encodes a symbol carrying a character the desk never validated', async () => {
    const { client: c, calls } = client([
      { text: '{"ok":true,"edition_id":"e","state":"published"}' },
    ])
    await c.publishPaper('AB/CD')
    expect(calls[0].url).toBe('https://desk.example.dev/api/papers/AB%2FCD/publish')
  })

  it('refuses a 200 with no edition id — there is nothing to say went on the glass', async () => {
    const { client: c } = client([{ text: '{"ok":true,"state":"published"}' }])
    await expect(c.publishPaper('SNDK')).rejects.toMatchObject({ code: 'bad_json' })
  })
})

describe('deskClient.editionSource', () => {
  it('addresses one edition, payload and pictures, with the bearer on both', () => {
    const { client: c } = client([])
    const s = c.editionSource('a1b2c3d4e5f60718')
    expect(s.payloadUrl).toBe(
      'https://desk.example.dev/api/editions/a1b2c3d4e5f60718/news.json',
    )
    expect(s.tileUrl('sndk_fab')).toBe(
      'https://desk.example.dev/api/editions/a1b2c3d4e5f60718/tiles/sndk_fab.bin',
    )
    expect(s.headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
  })
})

describe('deskClient.editionPayload', () => {
  it('GETs the edition through the edition client, bearer and Accept together', async () => {
    const { client: c, calls } = client([
      { text: readFileSync(EDITION_FIXTURE, 'utf8'), headers: { ETag: '"e1"' } },
    ])
    const got = await c.editionPayload('a1b2c3d4e5f60718')
    expect(calls[0].url).toBe(
      'https://desk.example.dev/api/editions/a1b2c3d4e5f60718/news.json',
    )
    expect(header(calls[0].init, 'Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(header(calls[0].init, 'Accept')).toBe('application/json')
    expect(got.status).toBe('ok')
    if (got.status !== 'ok') throw new Error('unreachable')
    expect(got.etag).toBe('"e1"')
    // THE SAME PARSE THE DEVICE PLANE GETS, and the same wire body carried beside it — the cache
    // stores wire bodies, not parsed editions (`edition/store.ts`'s header). A paper read by a
    // second parser would be a second newspaper maintained as one.
    expect(got.edition.subject.symbol).not.toBe('')
    expect(got.wire).toEqual(JSON.parse(readFileSync(EDITION_FIXTURE, 'utf8')))
  })

  it('asks the conditional question when it holds a tag, and reads the 304', async () => {
    const { client: c, calls } = client([{ status: 304 }])
    expect(await c.editionPayload('e1', '"e1"')).toEqual({ status: 'not_modified' })
    expect(header(calls[0].init, 'If-None-Match')).toBe('"e1"')
  })

  it('fails as an EditionError, not a DeskError — Today already draws those sentences', async () => {
    const { client: c } = client([{ status: 404, text: '{"ok":false,"error":"not_found"}' }])
    await expect(c.editionPayload('gone')).rejects.toMatchObject({
      name: 'EditionError',
      code: 'http',
      status: 404,
    })
  })
})
