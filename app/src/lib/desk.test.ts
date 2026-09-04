import { describe, it, expect } from '@jest/globals'
import {
  createDeskClient,
  deskLanguageView,
  DeskError,
  EDITION_LANGUAGES,
  humanDeskError,
} from './desk'
import { setActiveLanguage } from '../i18n'

const BASE = 'https://desk.example.dev'
const TOKEN = 'operator-token-for-tests'

// A fake `fetch` that replays a queue of responses, or throws a queued Error for a refused
// connection. Every call is recorded, because the things this client has to get right are all
// properties of the REQUEST: the method, the path, the bearer header and the exact body.
type Reply = { status?: number; text?: string } | Error

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = replies[Math.min(i, replies.length - 1)]
    i++
    if (r instanceof Error) throw r
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => r.text ?? '',
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
          detail: 'lang is two or three lowercase letters, not "Korean"',
        }),
      },
    ])
    const e = await c.putSettings({ lang: 'Korean' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(DeskError)
    expect(e).toMatchObject({ code: 'http', status: 400, error: 'bad_settings' })
    expect((e as DeskError).detail).toBe('lang is two or three lowercase letters, not "Korean"')
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
})

describe('deskLanguageView — what the Settings selector draws', () => {
  const view = (over: Partial<Parameters<typeof deskLanguageView>[0]> = {}) =>
    deskLanguageView({ address: BASE, token: TOKEN, lang: 'en', busy: false, ...over })

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
    // A desk set to French is a real state — `lang` is any BCP-47 primary subtag. Highlighting
    // English for it would be a lie about the paper, and highlighting nothing without a word of
    // explanation looks like a bug.
    expect(view({ lang: 'fr' })).toEqual({ selectedIndex: -1, disabled: false, note: 'unsupported' })
  })

  it('says nothing at all while the desk has not answered yet', () => {
    expect(view({ lang: null, busy: true })).toEqual({
      selectedIndex: -1,
      disabled: true,
      note: null,
    })
  })
})
