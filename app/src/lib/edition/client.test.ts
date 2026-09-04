import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createEditionClient,
  EditionError,
  EDITION_MAX_BYTES,
  humanEditionError,
  tileUrl,
} from './client'
import { parseEdition } from './parse'
import { setActiveLanguage } from '../../i18n'

const FIXTURE = join(__dirname, '../../../../components/news_core/test/host/fixtures/news.json')
const fixtureText = (): string => readFileSync(FIXTURE, 'utf8')

const URL = 'http://desk.local:8123/news.json'

// A fake `fetch` that replays a queue of responses, or throws a queued Error to simulate the
// network refusing. Records every call so the request itself can be asserted — the point of this
// client is that it sends what the BOARD sends, and only the calls prove that.
type Reply =
  | { status?: number; text?: string; bytes?: Uint8Array; headers?: Record<string, string> }
  | Error

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = replies[Math.min(i, replies.length - 1)]
    i++
    if (r instanceof Error) throw r
    const headers = r.headers ?? {}
    const body = r.bytes ?? new TextEncoder().encode(r.text ?? '')
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k: string) => {
          const hit = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase())
          return hit === undefined ? null : headers[hit]
        },
      },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function client(replies: Reply[]) {
  const f = fakeFetch(replies)
  return { ...f, client: createEditionClient({ fetchFn: f.fetchImpl }) }
}

const header = (init: RequestInit | undefined, name: string): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.[name]

describe('editionClient.fetch — the happy path', () => {
  it('parses a 200 and carries the ETag back', async () => {
    const { client: c } = client([{ text: fixtureText(), headers: { ETag: 'W/"abc123"' } }])
    const r = await c.fetch(URL, null)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') throw new Error('unreachable')
    expect(r.etag).toBe('W/"abc123"')
    expect(r.edition.subject.symbol).toBe('SNDK')
    expect(r.edition.stories).toHaveLength(4)
    // AND THE BODY ITSELF, untouched. The disk cache stores this rather than the parsed edition,
    // because `parseEdition` reads wire names and cannot read its own output back — so what the
    // client hands over has to be the JSON as served, with its wire spellings intact.
    expect(r.wire).toEqual(JSON.parse(fixtureText()))
    expect(r.edition).toEqual(parseEdition(r.wire))
  })

  it('reads the ETag whatever case the server spelled the header in', async () => {
    // `Headers.get` is case-insensitive by the fetch spec, and this client asks for `etag`. The
    // regression this catches is reaching for `res.headers['ETag']` — an index rather than the
    // accessor — which answers undefined for two of these three and silently stops sending
    // If-None-Match, turning every poll back into a full 20 KB download.
    for (const name of ['etag', 'ETag', 'ETAG']) {
      const { client: c } = client([{ text: fixtureText(), headers: { [name]: 'W/\"z\"' } }])
      const r = await c.fetch(URL, null)
      expect(r.status === 'ok' && r.etag).toBe('W/\"z\"')
    }
  })

  it('reports a missing ETag as null rather than as an empty string', async () => {
    const { client: c } = client([{ text: fixtureText() }])
    const r = await c.fetch(URL, null)
    expect(r.status === 'ok' && r.etag).toBeNull()
  })

  it('sends a plain GET with no If-None-Match when it holds no ETag', async () => {
    const { client: c, calls } = client([{ text: fixtureText() }])
    await c.fetch(URL, null)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(URL)
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
    expect(header(calls[0].init, 'If-None-Match')).toBeUndefined()
  })

  it('sends If-None-Match when it holds one — the request the board sends', async () => {
    const { client: c, calls } = client([{ status: 304 }])
    await c.fetch(URL, 'W/"abc123"')
    expect(header(calls[0].init, 'If-None-Match')).toBe('W/"abc123"')
  })
})

describe('editionClient.fetch — the failures', () => {
  it('reads a 304 as not_modified when it asked the conditional question', async () => {
    const { client: c } = client([{ status: 304 }])
    expect(await c.fetch(URL, 'W/"abc"')).toEqual({ status: 'not_modified' })
  })

  it('refuses a 304 that answers a request carrying no If-None-Match', async () => {
    // news_service.c:51 — a 304 is confirmation only of a question this client asked. A proxy or
    // a captive portal answering 304 to an unconditional GET has confirmed nothing, and honouring
    // it leaves a cold start with no cache on `loading` for ever: the reducer's `fetched` branch
    // returns `prev` off a non-ready state, and the loading screen offers no Retry.
    const { client: c } = client([{ status: 304 }])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'http', status: 304 })
  })

  it('treats an empty ETag as no ETag on the way out AND on the way back', async () => {
    // The request already refuses to send `If-None-Match: ''`; the answer has to be read by the
    // same rule, or the one case the header is omitted is the one case an unsolicited 304 passes.
    const { client: c, calls } = client([{ status: 304 }])
    await expect(c.fetch(URL, '')).rejects.toMatchObject({ code: 'http', status: 304 })
    expect(header(calls[0].init, 'If-None-Match')).toBeUndefined()
  })

  it('refuses an empty URL without touching the network', async () => {
    const { client: c, calls } = client([{ text: fixtureText() }])
    await expect(c.fetch('', null)).rejects.toMatchObject({ code: 'no_url' })
    await expect(c.fetch('   ', null)).rejects.toMatchObject({ code: 'no_url' })
    expect(calls).toHaveLength(0)
  })

  it('carries the status on a non-2xx', async () => {
    const { client: c } = client([{ status: 500, text: 'boom' }])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'http', status: 500 })
    const { client: d } = client([{ status: 404, text: '' }])
    await expect(d.fetch(URL, null)).rejects.toMatchObject({ code: 'http', status: 404 })
  })

  it('reads a body that is not JSON as bad_json', async () => {
    const { client: c } = client([{ text: '<html>the tunnel is down</html>' }])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('reads a 200 that parses to an empty edition as bad_json', async () => {
    // A desk mid-publish serves furniture with nothing under it. Treating that as success would
    // overwrite a real cached edition with a blank sheet.
    const { client: c } = client([{ text: JSON.stringify({ dateline: 'FRIDAY', stories: [] }) }])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('refuses a body over the device’s own cap', async () => {
    const big = 'x'.repeat(EDITION_MAX_BYTES + 1)
    const { client: c } = client([{ text: big }])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'too_large' })
    expect(EDITION_MAX_BYTES).toBe(320 * 1024)
  })

  it('refuses on Content-Length alone, before reading the body', async () => {
    const { client: c } = client([
      { text: '{}', headers: { 'Content-Length': String(EDITION_MAX_BYTES + 1) } },
    ])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'too_large' })
  })

  it('caps on the bytes that actually arrived, not on what Content-Length claimed', async () => {
    // The header is advisory — a chunked response carries none at all — so it can only ever be
    // an early refusal, never the decision. Deleting the byteLength check after the read would
    // let a 400 KB body through behind a `Content-Length: 12` and hand the parser a payload the
    // board itself would have refused.
    const big = 'x'.repeat(EDITION_MAX_BYTES + 1)
    const { client: c } = client([{ text: big, headers: { 'Content-Length': '12' } }])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'too_large' })
  })

  it('reads a thrown fetch as transport', async () => {
    const { client: c } = client([new TypeError('Network request failed')])
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'transport' })
  })

  it('reads its own deadline as transport, and aborts the request', async () => {
    // The fetch never settles; only the AbortController ends it. `timeoutMs: 1` keeps the test
    // instant, and the assertion is on the signal actually firing, not on elapsed time.
    let signal: AbortSignal | undefined
    const fetchFn = ((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')))
      })
    }) as unknown as typeof fetch
    const c = createEditionClient({ fetchFn, timeoutMs: 1 })
    await expect(c.fetch(URL, null)).rejects.toMatchObject({ code: 'transport' })
    expect(signal?.aborted).toBe(true)
  })
})

describe('humanEditionError', () => {
  it('writes one sentence per failure, in the interface’s voice', () => {
    expect(humanEditionError(new EditionError('no_url', 'x'))).toBe(
      'No edition URL yet. Add one in Settings.',
    )
    // A typographic apostrophe, like every other sentence in the catalogue. These two lines were
    // the app's only two ASCII ones until the copy moved into `i18n/en.ts`.
    expect(humanEditionError(new EditionError('transport', 'x'))).toBe(
      'Couldn’t reach the edition server. Check the connection, then pull to refresh.',
    )
    expect(humanEditionError(new EditionError('http', 'x', 503))).toBe(
      'The edition server answered 503.',
    )
    expect(humanEditionError(new EditionError('too_large', 'x'))).toBe(
      'The edition is too large to read here.',
    )
    expect(humanEditionError(new EditionError('bad_json', 'x'))).toBe(
      'The edition didn’t parse. The desk may be mid-publish; pull to refresh in a minute.',
    )
  })

  it('says something true about a status it does not have', () => {
    expect(humanEditionError(new EditionError('http', 'x'))).toBe(
      'The edition server answered with an error.',
    )
  })

  it('has a sentence for something that is not an EditionError at all', () => {
    expect(humanEditionError(new Error('nope'))).toBe('Something went wrong reading the edition.')
    expect(humanEditionError(undefined)).toBe('Something went wrong reading the edition.')
  })

  it('writes them in the app’s language, the status still a status', () => {
    setActiveLanguage('ko')
    try {
      expect(humanEditionError(new EditionError('no_url', 'x'))).toMatch(/[가-힣]/)
      expect(humanEditionError(new EditionError('bad_json', 'x'))).toMatch(/[가-힣]/)
      // The HTTP status is the server's, not the app's, and it survives the translation.
      expect(humanEditionError(new EditionError('http', 'x', 503))).toMatch(/503/)
      expect(humanEditionError(undefined)).toMatch(/[가-힣]/)
    } finally {
      setActiveLanguage('en')
    }
  })
})

describe('tileUrl', () => {
  it('resolves beside the payload', () => {
    expect(tileUrl('http://desk.local:8123/news.json', 'sndk_fab')).toBe(
      'http://desk.local:8123/tiles/sndk_fab.bin',
    )
    expect(tileUrl('https://claudepost.example.dev/edition/news.json', 'x')).toBe(
      'https://claudepost.example.dev/edition/tiles/x.bin',
    )
  })

  it('drops the query and the fragment', () => {
    expect(tileUrl('http://d/news.json?v=2#top', 'a')).toBe('http://d/tiles/a.bin')
    expect(tileUrl('http://d/sub/news.json#frag', 'a')).toBe('http://d/sub/tiles/a.bin')
  })

  it('percent-encodes an id that would otherwise change the path', () => {
    expect(tileUrl('http://d/news.json', '../secret')).toBe('http://d/tiles/..%2Fsecret.bin')
  })

  it('answers the empty string for a URL it cannot resolve beside', () => {
    expect(tileUrl('', 'a')).toBe('')
    expect(tileUrl('news.json', 'a')).toBe('')
  })

  // A bare authority — no path at all — has slashes of its own: the scheme's `//`. Naively
  // cutting at the LAST slash finds one of those and drops the host, producing
  // `http://tiles/x.bin`. The directory of a URL with no path is the authority itself.
  it('resolves against a bare authority with no path (the scheme-slash trap)', () => {
    expect(tileUrl('http://host.local:8123', 'x')).toBe('http://host.local:8123/tiles/x.bin')
    expect(tileUrl('https://claudepost.example', 'x')).toBe(
      'https://claudepost.example/tiles/x.bin',
    )
  })

  it('drops the query and the fragment on a bare authority too', () => {
    expect(tileUrl('http://host?a=1#f', 'x')).toBe('http://host/tiles/x.bin')
  })
})

describe('editionClient.fetchTile', () => {
  it('returns the body when it weighs exactly w*h/2', async () => {
    const bytes = new Uint8Array((2 * 2) / 2).fill(0x11)
    const { client: c, calls } = client([{ bytes }])
    const got = await c.fetchTile('http://d/tiles/a.bin', 2, 2)
    expect(Array.from(got)).toEqual([0x11, 0x11])
    expect(calls[0].url).toBe('http://d/tiles/a.bin')
  })

  it('rejects a body of the wrong length rather than drawing half a picture', async () => {
    const { client: c } = client([{ bytes: new Uint8Array(1) }])
    await expect(c.fetchTile('http://d/tiles/a.bin', 4, 2)).rejects.toMatchObject({
      code: 'bad_json',
    })
  })

  it('rejects a tile body one byte too long as firmly as one too short', async () => {
    // A tile has no header of its own, so `w*h/2` is the whole contract: a body that is not
    // exactly that is not this picture. Over-length is refused as `too_large` because the cap
    // handed to the body reader IS the exact size — there is no separate ceiling for a tile.
    const want = (4 * 2) / 2
    const { client: c } = client([{ bytes: new Uint8Array(want + 1) }])
    await expect(c.fetchTile('http://d/tiles/a.bin', 4, 2)).rejects.toBeInstanceOf(EditionError)
    const { client: d } = client([{ bytes: new Uint8Array(want + 1) }])
    await expect(d.fetchTile('http://d/tiles/a.bin', 4, 2)).rejects.toMatchObject({
      code: 'too_large',
    })
  })

  it('carries the status on a non-2xx and the code on a thrown fetch', async () => {
    const { client: a } = client([{ status: 404 }])
    await expect(a.fetchTile('http://d/tiles/a.bin', 2, 2)).rejects.toMatchObject({
      code: 'http',
      status: 404,
    })
    const { client: b } = client([new TypeError('Network request failed')])
    await expect(b.fetchTile('http://d/tiles/a.bin', 2, 2)).rejects.toMatchObject({
      code: 'transport',
    })
  })

  it('refuses an empty URL without touching the network', async () => {
    const { client: c, calls } = client([{ bytes: new Uint8Array(2) }])
    await expect(c.fetchTile('', 2, 2)).rejects.toMatchObject({ code: 'no_url' })
    expect(calls).toHaveLength(0)
  })
})
