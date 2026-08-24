import { describe, it, expect } from '@jest/globals'
import { createEsp32Client, humanError, Esp32Error, PAGE_COUNT, SLEEP_SECONDS_MAX, SLEEP_SECONDS_MIN } from './esp32'
import { FB_SIZE, SCREEN_FORMAT } from './screen'

// A fake `fetch` that replays a queue of responses (or throws a queued Error to simulate the
// SoftAP dropping). Records every call so we can assert URLs/methods/bodies.
type Reply =
  | {
      ok?: boolean
      status?: number
      body?: unknown
      jsonThrows?: boolean
      /** Binary body for /api/screen. */
      bytes?: Uint8Array
      /** Response headers, looked up case-insensitively like the real Headers. */
      headers?: Record<string, string>
    }
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
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      headers: {
        get: (k: string) => {
          const hit = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase())
          return hit === undefined ? null : headers[hit]
        },
      },
      json: async () => {
        if (r.jsonThrows) throw new SyntaxError('Unexpected token in JSON')
        return r.body
      },
      arrayBuffer: async () => {
        const b = r.bytes ?? new Uint8Array(0)
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      },
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

// Controllable clock so waitForConnected's polling is deterministic and instant.
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

const BASE = 'http://192.168.4.1'

function client(replies: Reply[], extra: Record<string, unknown> = {}) {
  const f = fakeFetch(replies)
  return { ...f, client: createEsp32Client({ baseUrl: BASE, fetchImpl: f.fetchImpl, ...extra }) }
}

// =====================================================================================
// Provisioning surface
// =====================================================================================

describe('esp32 client — getInfo', () => {
  it('parses device identity and trims the base URL', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { deviceId: '9F3A', model: 'Claude Post', apSsid: 'Claude Post-AB12' } },
    ])
    const c = createEsp32Client({ baseUrl: 'http://192.168.4.1/', fetchImpl })
    const info = await c.getInfo()
    expect(info).toEqual({
      deviceId: '9F3A',
      model: 'Claude Post',
      apSsid: 'Claude Post-AB12',
      fw: '',
      ip: '',
    })
    expect(calls[0].url).toBe('http://192.168.4.1/api/info')
  })

  it('parses the STA-mode info (fw + ip present, apSsid empty)', async () => {
    const { client: c } = client([
      { body: { deviceId: '9F3A', model: 'Claude Post', fw: '0.1.0', ip: '192.168.0.42' } },
    ])
    expect(await c.getInfo()).toEqual({
      deviceId: '9F3A',
      model: 'Claude Post',
      apSsid: '',
      fw: '0.1.0',
      ip: '192.168.0.42',
    })
  })

  it('defaults missing fields to empty strings', async () => {
    const { client: c } = client([{ body: {} }])
    expect(await c.getInfo()).toEqual({ deviceId: '', model: '', apSsid: '', fw: '', ip: '' })
  })

  it('tolerates a null JSON body', async () => {
    const { client: c } = client([{ body: null }])
    expect(await c.getInfo()).toEqual({ deviceId: '', model: '', apSsid: '', fw: '', ip: '' })
  })

  it('rejects with http_error (carrying status) on a non-ok response', async () => {
    const { client: c } = client([{ ok: false, status: 500, body: {} }])
    await expect(c.getInfo()).rejects.toMatchObject({ code: 'http_error', status: 500 })
  })
})

describe('esp32 client — scanNetworks', () => {
  it('maps secure->secured, coerces rssi, and drops empty SSIDs', async () => {
    const { client: c } = client([
      {
        body: {
          networks: [
            { ssid: 'Home', rssi: -54, secure: true },
            { ssid: 'Cafe', rssi: -77, secure: false },
            { ssid: '', rssi: -90, secure: true },
          ],
        },
      },
    ])
    expect(await c.scanNetworks()).toEqual([
      { ssid: 'Home', rssi: -54, secured: true },
      { ssid: 'Cafe', rssi: -77, secured: false },
    ])
  })

  it('returns [] when the payload has no networks array', async () => {
    const { client: c } = client([{ body: {} }])
    expect(await c.scanNetworks()).toEqual([])
  })

  it('rejects with http_error on a non-ok response', async () => {
    const { client: c } = client([{ ok: false, status: 503, body: {} }])
    await expect(c.scanNetworks()).rejects.toMatchObject({ code: 'http_error' })
  })
})

describe('esp32 client — provision', () => {
  it('POSTs url-encoded ssid+password+news_url and resolves on 202', async () => {
    const { client: c, calls } = client([{ status: 202, body: { ok: true, state: 'connecting' } }])
    await c.provision('My Wi-Fi', 'p@ss&w/rd', 'http://mac.local:8123/news.json')
    expect(calls[0].url).toBe(`${BASE}/api/provision`)
    expect(calls[0].init?.method).toBe('POST')
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(calls[0].init?.body).toBe(
      'ssid=My%20Wi-Fi&password=p%40ss%26w%2Frd' +
        '&news_url=http%3A%2F%2Fmac.local%3A8123%2Fnews.json',
    )
  })

  it('sends exactly the three field names prov_portal.c reads', async () => {
    // components/provisioning/prov_portal.c:435-438 — the JSON /api/provision handler, not the
    // browser form's /save at :289-292 — reads ssid / ssid_manual / password /
    // news_url and nothing else, and sleep_seconds is deliberately ABSENT here: an absent field
    // keeps whatever interval is already stored (prov_portal.c:243-259), where an empty one
    // would clear it. Onboarding must not silently reset an interval set from the app.
    const { client: c, calls } = client([{ status: 202, body: { ok: true } }])
    await c.provision('Home', 'pw', 'http://mac.local:8123/news.json')
    const fields = String(calls[0].init?.body)
      .split('&')
      .map((p) => p.split('=')[0])
    expect(fields).toEqual(['ssid', 'password', 'news_url'])
  })

  it('still sends an empty news_url when none was given', async () => {
    // Provisioning REWRITES the whole stored config on the board, so omitting the field would
    // clear the URL regardless. Sending '' states that intent instead of relying on it.
    const { client: c, calls } = client([{ status: 202, body: { ok: true } }])
    await c.provision('Home', 'pw')
    expect(calls[0].init?.body).toBe('ssid=Home&password=pw&news_url=')
  })

  it('throws an Esp32Error carrying the firmware error code on 400', async () => {
    const { client: c } = client([{ ok: false, status: 400, body: { ok: false, error: 'pass_too_long' } }])
    await expect(c.provision('Home', 'x')).rejects.toMatchObject({
      name: 'Esp32Error',
      code: 'pass_too_long',
    })
  })

  it('surfaces news_url_invalid from the provisioning endpoint', async () => {
    const { client: c } = client([
      { ok: false, status: 400, body: { ok: false, error: 'news_url_invalid' } },
    ])
    await expect(c.provision('Home', 'pw', 'ftp://nope')).rejects.toMatchObject({
      code: 'news_url_invalid',
    })
  })

  it('falls back to http_error when the 4xx body lacks an error field', async () => {
    const { client: c } = client([{ ok: false, status: 400, body: { ok: false } }])
    await expect(c.provision('Home', 'x')).rejects.toMatchObject({ code: 'http_error' })
  })

  it('falls back to http_error when the error body is not JSON (e.g. 413 plain text)', async () => {
    const { client: c } = client([{ ok: false, status: 413, jsonThrows: true }])
    await expect(c.provision('Home', 'x')).rejects.toMatchObject({ code: 'http_error', status: 413 })
  })

  it('maps a thrown fetch (AP dropped) to a network_error', async () => {
    const { client: c } = client([new TypeError('Network request failed')])
    await expect(c.provision('Home', 'x')).rejects.toMatchObject({ code: 'network_error' })
  })
})

describe('esp32 client — getStatus parsing', () => {
  it('defaults a missing state to idle', async () => {
    const { client: c } = client([{ body: {} }])
    expect(await c.getStatus()).toEqual({ state: 'idle', ssid: undefined, reason: undefined })
  })

  it('drops non-string ssid/reason', async () => {
    const { client: c } = client([{ body: { state: 'connecting', ssid: 123, reason: null } }])
    expect(await c.getStatus()).toEqual({ state: 'connecting', ssid: undefined, reason: undefined })
  })
})

describe('esp32 client — waitForConnected', () => {
  it('resolves connected once the board reports it', async () => {
    const clock = fakeClock()
    const { client: c } = client(
      [
        { body: { state: 'connecting' } },
        { body: { state: 'connecting' } },
        { body: { state: 'connected', ssid: 'Home' } },
      ],
      { now: clock.now, sleep: clock.sleep },
    )
    const res = await c.waitForConnected({ intervalMs: 1000, timeoutMs: 45000 })
    expect(res.outcome).toBe('connected')
    expect(res.ssid).toBe('Home')
  })

  it('resolves failed with the firmware reason', async () => {
    const clock = fakeClock()
    const { client: c } = client([{ body: { state: 'failed', ssid: 'Home', reason: 'auth_failed' } }], {
      now: clock.now,
      sleep: clock.sleep,
    })
    const res = await c.waitForConnected()
    expect(res.outcome).toBe('failed')
    expect(res.reason).toBe('auth_failed')
  })

  it('tolerates transient fetch failures (channel-hop AP drop) then succeeds', async () => {
    const clock = fakeClock()
    const { client: c } = client(
      [
        new TypeError('Network request failed'),
        new TypeError('Network request failed'),
        { body: { state: 'connected', ssid: 'Home' } },
      ],
      { now: clock.now, sleep: clock.sleep },
    )
    const res = await c.waitForConnected({ intervalMs: 1000 })
    expect(res.outcome).toBe('connected')
  })

  it('gives up with outcome=timeout once the overall deadline passes', async () => {
    const clock = fakeClock()
    const { client: c } = client([{ body: { state: 'connecting' } }], {
      now: clock.now,
      sleep: clock.sleep,
    })
    const res = await c.waitForConnected({ intervalMs: 1000, timeoutMs: 5000 })
    expect(res.outcome).toBe('timeout')
  })

  it('carries the last observed status on timeout and polls the expected number of times', async () => {
    const clock = fakeClock()
    const { client: c, calls } = client([{ body: { state: 'connecting', ssid: 'Home' } }], {
      now: clock.now,
      sleep: clock.sleep,
    })
    const res = await c.waitForConnected({ intervalMs: 1000, timeoutMs: 3000 })
    expect(res.outcome).toBe('timeout')
    expect(res.ssid).toBe('Home') // proves it returns the last status, not the {state:'connecting'} seed
    expect(calls.length).toBe(3) // polls at t=0,1000,2000 then exits at t=3000
  })
})

// =====================================================================================
// Control surface — the contract in docs/app-control.md, serialized by
// components/news_core/device_api_json.c
// =====================================================================================

describe('esp32 client — getState', () => {
  // The documented payload from docs/app-control.md, verbatim.
  const FULL = {
    deviceId: '1A2B',
    model: 'Claude Post',
    fw: '0.1.0',
    ip: '192.168.0.42',
    page: 0,
    pageTitle: 'FRONT PAGE',
    news: {
      valid: true,
      demo: false,
      edition: 'SEMICONDUCTORS',
      generatedAt: '2026-08-14T05:12:00Z',
      subject: {
        symbol: 'SNDK',
        name: 'Sandisk Corp.',
        exchange: 'NASDAQ',
        sector: 'Semiconductors',
        lastCents: 24160,
        changeBp: 421,
        prevCloseCents: 23184,
        openCents: 23300,
        highCents: 24505,
        lowCents: 23110,
        wk52HighCents: 26900,
        wk52LowCents: 8800,
      },
      counts: {
        stories: 4,
        figures: 22,
        briefs: 6,
        peers: 5,
        tables: 1,
        charts: 2,
        indices: 3,
        thumbs: 2,
      },
      headlines: [
        { rank: 0, headline: "Sandisk's memory squeeze finally shows up in the price" },
        { rank: 1, headline: 'The whole tape moved, but not this far' },
        { rank: 2, headline: 'Yokkaichi runs flat out into a fourth quarter of shortage' },
        { rank: 3, headline: 'The street raises its targets, quietly' },
      ],
      indices: [
        { symbol: 'SPX', lastCents: 641283, changeBp: 62 },
        { symbol: 'SOX', lastCents: 582014, changeBp: 187 },
        { symbol: 'VIX', lastCents: 1432, changeBp: -530 },
      ],
    },
    source: {
      url: 'http://mac.local:8123/news.json',
      lastResult: 'ok',
      pollSeconds: 300,
      pollSource: 'config',
      ageSeconds: 42,
      stale: false,
    },
    battery: { present: true, percent: 84, millivolts: 4012 },
    panel: { refreshMs: 24810 },
    power: {
      deepSleep: true,
      sleepSeconds: 900,
      sleepSource: 'policy',
      wakes: 96,
      quietWakes: 94,
      meanAwakeMs: 3140,
      estMahPerDay: 6,
    },
  }

  it('parses the documented payload', async () => {
    const { client: c, calls } = client([{ body: FULL }])
    const s = await c.getState()
    expect(calls[0].url).toBe(`${BASE}/api/state`)
    expect(s.deviceId).toBe('1A2B')
    expect(s.page).toBe(0)
    expect(s.pageTitle).toBe('FRONT PAGE')
    expect(s.news.edition).toBe('SEMICONDUCTORS')
    expect(s.news.generatedAt).toBe('2026-08-14T05:12:00Z')
    expect(s.news.subject.symbol).toBe('SNDK')
    expect(s.news.subject.name).toBe('Sandisk Corp.')
    expect(s.news.subject.lastCents).toBe(24160)
    expect(s.news.subject.changeBp).toBe(421)
    expect(s.news.counts.figures).toBe(22)
    expect(s.news.counts.thumbs).toBe(2)
    expect(s.news.headlines).toHaveLength(4)
    expect(s.news.headlines[0]).toEqual({
      rank: 0,
      headline: "Sandisk's memory squeeze finally shows up in the price",
    })
    expect(s.news.indices[2]).toEqual({ symbol: 'VIX', lastCents: 1432, changeBp: -530 })
    expect(s.source.lastResult).toBe('ok')
    expect(s.source.pollSource).toBe('config')
    expect(s.source.ageSeconds).toBe(42)
    expect(s.battery).toEqual({ present: true, percent: 84, millivolts: 4012 })
    expect(s.panel).toEqual({ refreshMs: 24810 })
    expect(s.power).toEqual({
      deepSleep: true,
      sleepSeconds: 900,
      sleepSource: 'policy',
      wakes: 96,
      quietWakes: 94,
      meanAwakeMs: 3140,
      estMahPerDay: 6,
    })
  })

  it('keeps a UTF-8 headline byte for byte', async () => {
    // Headlines come off a copy desk that emits em dashes and curly quotes, and the firmware cuts
    // them on a character boundary precisely so they arrive intact.
    const { client: c } = client([
      { body: { news: { headlines: [{ rank: 0, headline: 'Sandisk — “the squeeze” — priced in' }] } } },
    ])
    const s = await c.getState()
    expect(s.news.headlines[0].headline).toBe('Sandisk — “the squeeze” — priced in')
  })

  it('renders an empty object as an empty edition, not a crash', async () => {
    const { client: c } = client([{ body: {} }])
    const s = await c.getState()
    expect(s.news.valid).toBe(false)
    expect(s.news.edition).toBe('')
    expect(s.news.subject.symbol).toBe('')
    expect(s.news.subject.lastCents).toBe(0)
    expect(s.news.counts.stories).toBe(0)
    expect(s.news.headlines).toEqual([])
    expect(s.news.indices).toEqual([])
    expect(s.battery.present).toBe(false)
    expect(s.panel.refreshMs).toBe(0)
    expect(s.power.deepSleep).toBe(false)
    expect(s.power.sleepSource).toBe('default')
  })

  it('defaults a MISSING ageSeconds to -1, not 0', async () => {
    // -1 is "no poll has ever succeeded". Defaulting to 0 would draw a board that had just
    // synced when in fact it never has — the single most misleading thing this parser could do.
    const { client: c } = client([{ body: { source: { url: 'http://x/', lastResult: 'transport' } } }])
    const s = await c.getState()
    expect(s.source.ageSeconds).toBe(-1)
  })

  it('preserves an explicit ageSeconds of 0', async () => {
    const { client: c } = client([{ body: { source: { ageSeconds: 0 } } }])
    expect((await c.getState()).source.ageSeconds).toBe(0)
  })

  it('maps an unrecognised lastResult to "unknown" rather than passing it through', async () => {
    // A future firmware may add a code. The UI switches on this value, so an unknown one has to
    // land in a case the UI already handles.
    const { client: c } = client([{ body: { source: { lastResult: 'quantum_failure' } } }])
    expect((await c.getState()).source.lastResult).toBe('unknown')
  })

  it('keeps every documented lastResult value, not_modified included', async () => {
    // not_modified is a 304 and a SUCCESS — on a board polling all day it is the most common
    // outcome, so it has to survive the parser and reach the UI as itself.
    for (const r of ['ok', 'no_url', 'transport', 'http_status', 'bad_payload', 'not_modified']) {
      const { client: c } = client([{ body: { source: { lastResult: r } } }])
      expect((await c.getState()).source.lastResult).toBe(r)
    }
  })

  it('maps an unrecognised pollSource to "config" and keeps "policy"', async () => {
    const { client: c } = client([{ body: { source: { pollSource: 'astrology' } } }])
    expect((await c.getState()).source.pollSource).toBe('config')
    const { client: d } = client([{ body: { source: { pollSource: 'policy' } } }])
    expect((await d.getState()).source.pollSource).toBe('policy')
  })

  it('keeps all four sleepSource values and defaults an unknown one to "default"', async () => {
    for (const s of ['policy', 'api', 'nvs', 'default']) {
      const { client: c } = client([{ body: { power: { sleepSource: s } } }])
      expect((await c.getState()).power.sleepSource).toBe(s)
    }
    const { client: c } = client([{ body: { power: { sleepSource: 'vibes' } } }])
    expect((await c.getState()).power.sleepSource).toBe('default')
  })

  it('clamps the arrays to what the firmware can serialise', async () => {
    // DEV_STORY_MAX and DEV_INDEX_MAX are both 5 (device_api_model.h:80-81). A longer array is a
    // contract violation, and a phone list is the wrong place to discover it.
    const many = Array.from({ length: 9 }, (_, i) => ({ rank: i, headline: `h${i}` }))
    const cells = Array.from({ length: 9 }, (_, i) => ({ symbol: `S${i}`, lastCents: i, changeBp: i }))
    const { client: c } = client([{ body: { news: { headlines: many, indices: cells } } }])
    const s = await c.getState()
    expect(s.news.headlines).toHaveLength(5)
    expect(s.news.indices).toHaveLength(5)
  })

  it('drops a headline entry that is not an object', async () => {
    const { client: c } = client([
      { body: { news: { headlines: [null, 'nope', { rank: 1, headline: 'real' }] } } },
    ])
    expect((await c.getState()).news.headlines).toEqual([{ rank: 1, headline: 'real' }])
  })

  it('coerces garbage numbers to 0 instead of NaN', async () => {
    const { client: c } = client([
      {
        body: {
          page: 'two',
          news: { subject: { lastCents: 'lots', changeBp: null }, counts: { figures: {} } },
          battery: { percent: {} },
          power: { wakes: 'many' },
        },
      },
    ])
    const s = await c.getState()
    expect(s.page).toBe(0)
    expect(s.news.subject.lastCents).toBe(0)
    expect(s.news.subject.changeBp).toBe(0)
    expect(s.news.counts.figures).toBe(0)
    expect(s.battery.percent).toBe(0)
    expect(s.power.wakes).toBe(0)
  })

  it('rejects with http_error on a non-ok response', async () => {
    const { client: c } = client([{ ok: false, status: 500, body: {} }])
    await expect(c.getState()).rejects.toMatchObject({ code: 'http_error', status: 500 })
  })
})

describe('esp32 client — pages', () => {
  it('knows there are two pages, A1 and A2', () => {
    // docs/app-control.md: page is 0 for A1, the front page, and 1 for A2, the accounts.
    // Anything else is page_range. The four-page notes board this forked from is gone.
    expect(PAGE_COUNT).toBe(2)
  })

  it('POSTs the page as JSON', async () => {
    const { client: c, calls } = client([{ body: { ok: true } }])
    await c.setPage(1)
    expect(calls[0].url).toBe(`${BASE}/api/page`)
    expect(calls[0].init?.method).toBe('POST')
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(calls[0].init?.body).toBe('{"page":1}')
  })

  it('throws page_range on a 400 body', async () => {
    const { client: c } = client([{ ok: false, status: 400, body: { ok: false, error: 'page_range' } }])
    await expect(c.setPage(9)).rejects.toMatchObject({ code: 'page_range', status: 400 })
  })
})

describe('esp32 client — setNewsUrl', () => {
  it('POSTs the url as JSON', async () => {
    const { client: c, calls } = client([{ body: { ok: true } }])
    await c.setNewsUrl('http://mac.local:8123/news.json')
    expect(calls[0].url).toBe(`${BASE}/api/news`)
    expect(calls[0].init?.body).toBe('{"url":"http://mac.local:8123/news.json"}')
  })

  it('sends an empty string through — that is the "use demo data" request', async () => {
    const { client: c, calls } = client([{ body: { ok: true } }])
    await c.setNewsUrl('')
    expect(calls[0].init?.body).toBe('{"url":""}')
  })

  it('throws news_url_invalid on a 400 body', async () => {
    const { client: c } = client([
      { ok: false, status: 400, body: { ok: false, error: 'news_url_invalid' } },
    ])
    await expect(c.setNewsUrl('nope')).rejects.toMatchObject({ code: 'news_url_invalid' })
  })
})

describe('esp32 client — setSleep', () => {
  it('POSTs the interval as JSON', async () => {
    const { client: c, calls } = client([{ body: { ok: true } }])
    await c.setSleep(1800)
    expect(calls[0].url).toBe(`${BASE}/api/sleep`)
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.body).toBe('{"seconds":1800}')
  })

  it('sends 0 through — that is the "use the build-time default" request', async () => {
    // 0 is a documented value, not an empty field, so it must not be filtered out on the way.
    const { client: c, calls } = client([{ body: { ok: true } }])
    await c.setSleep(0)
    expect(calls[0].init?.body).toBe('{"seconds":0}')
  })

  it('exposes the board clamp so a caller can offer values it will actually get', async () => {
    expect(SLEEP_SECONDS_MIN).toBe(60)
    expect(SLEEP_SECONDS_MAX).toBe(86400)
  })

  it('sends a value outside the clamp anyway — the board clamps, it does not reject', async () => {
    // docs/app-control.md: `{"seconds":5}` succeeds and yields 60. Rejecting locally would make
    // the app disagree with the device about what is legal.
    const { client: c, calls } = client([{ body: { ok: true } }])
    await c.setSleep(5)
    expect(calls[0].init?.body).toBe('{"seconds":5}')
  })

  it('throws sleep_seconds_invalid on a negative the board refused', async () => {
    const { client: c } = client([
      { ok: false, status: 400, body: { ok: false, error: 'sleep_seconds_invalid' } },
    ])
    await expect(c.setSleep(-1)).rejects.toMatchObject({ code: 'sleep_seconds_invalid', status: 400 })
  })

  it('throws bad_json when the board could not read the number', async () => {
    const { client: c } = client([{ ok: false, status: 400, body: { ok: false, error: 'bad_json' } }])
    await expect(c.setSleep(60)).rejects.toMatchObject({ code: 'bad_json' })
  })
})

describe('esp32 client — refresh and displayTest', () => {
  it('POSTs /api/refresh with no body', async () => {
    const { client: c, calls } = client([{ body: { ok: true } }])
    await c.refresh()
    expect(calls[0].url).toBe(`${BASE}/api/refresh`)
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.body).toBeUndefined()
  })

  it('POSTs /api/display/test with no body', async () => {
    const { client: c, calls } = client([{ body: { ok: true } }])
    await c.displayTest()
    expect(calls[0].url).toBe(`${BASE}/api/display/test`)
    expect(calls[0].init?.body).toBeUndefined()
  })

  it('surfaces busy — the board is mid-refresh and the command was not queued', async () => {
    const { client: c } = client([{ ok: false, status: 400, body: { ok: false, error: 'busy' } }])
    await expect(c.refresh()).rejects.toMatchObject({ code: 'busy' })
    const { client: d } = client([{ ok: false, status: 400, body: { ok: false, error: 'busy' } }])
    await expect(d.displayTest()).rejects.toMatchObject({ code: 'busy' })
  })

  it('maps a dropped connection to network_error', async () => {
    const { client: c } = client([new TypeError('Network request failed')])
    await expect(c.refresh()).rejects.toMatchObject({ code: 'network_error' })
  })
})

// A fetch that never answers, so the client's own AbortController is what ends the request.
// This is what a sleeping board looks like from the phone: the socket goes nowhere.
const silentFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const e = new Error('Aborted')
      e.name = 'AbortError'
      reject(e)
    })
  })) as unknown as typeof fetch

describe('esp32 client — a board that never answers', () => {
  it('reports timeout, not network_error, when our own deadline fired', async () => {
    // The two need different sentences: network_error is "wrong Wi-Fi / board off", and a timeout
    // against a board that was reachable a minute ago is almost always deep sleep.
    const c = createEsp32Client({ baseUrl: BASE, fetchImpl: silentFetch, timeoutMs: 10 })
    await expect(c.getState()).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('esp32 client — fetchScreen', () => {
  const page = () => new Uint8Array(FB_SIZE).fill(0x11)

  it('GETs /api/screen and returns the framebuffer bytes', async () => {
    const { client: c, calls } = client([
      { bytes: page(), headers: { 'X-Screen-Format': SCREEN_FORMAT } },
    ])
    const fb = await c.fetchScreen()
    expect(calls[0].url).toBe(`${BASE}/api/screen`)
    expect(fb).toBeInstanceOf(Uint8Array)
    expect(fb.length).toBe(FB_SIZE)
    expect(fb[0]).toBe(0x11)
  })

  it('accepts a response with no X-Screen-Format header', async () => {
    // The header describes the body; a proxy that strips it has not changed the bytes.
    const { client: c } = client([{ bytes: page() }])
    expect((await c.fetchScreen()).length).toBe(FB_SIZE)
  })

  it('rejects a format token it does not know', async () => {
    // The token is the contract's version handle. Decoding a v2 framebuffer with a v1 palette
    // would draw a plausible, wrong page — worse than refusing.
    const { client: c } = client([
      { bytes: page(), headers: { 'X-Screen-Format': 'claudepost-6ink-v2' } },
    ])
    await expect(c.fetchScreen()).rejects.toMatchObject({ code: 'screen_format' })
  })

  it('rejects a body that is not exactly EPD6_FB_SIZE', async () => {
    // The response is streamed CHUNKED and carries no Content-Length, so a transfer cut short
    // arrives here as a shorter body under a 200 — not as an error status. Counting is the only
    // check there is, and without it a truncated page decodes as a valid one.
    const { client: c } = client([{ bytes: new Uint8Array(FB_SIZE - 1) }])
    await expect(c.fetchScreen()).rejects.toMatchObject({ code: 'screen_size' })
  })

  it('rejects a TRUNCATED page — a device timeout mid-transfer, with a 200 on it', async () => {
    // The realistic shape of this failure: the board stopped sending three quarters of the way
    // through, every header was already correct, and the status is 200 because the status went out
    // before the body did. A decoder that trusted the status would draw a page whose bottom
    // quarter is whatever the buffer held.
    const { client: c } = client([
      {
        bytes: new Uint8Array(Math.floor(FB_SIZE * 0.75)),
        headers: {
          'X-Screen-Width': '1200',
          'X-Screen-Height': '1600',
          'X-Screen-Stride': '600',
          'X-Screen-Bpp': '4',
          'X-Screen-Format': SCREEN_FORMAT,
        },
      },
    ])
    await expect(c.fetchScreen()).rejects.toMatchObject({ code: 'screen_size' })
  })

  it('does not believe a Content-Length, in either direction', async () => {
    // This route is chunked and declares no length at all, so any Content-Length reaching this
    // client came from something in between. Gating on one would make a proxy's bookkeeping
    // decide whether a good page is drawn — and would let a short body through whenever the
    // header happened to agree with itself.
    const { client: good } = client([
      { bytes: page(), headers: { 'Content-Length': '17' } },
    ])
    expect((await good.fetchScreen()).length).toBe(FB_SIZE)

    const { client: bad } = client([
      { bytes: new Uint8Array(FB_SIZE - 4096), headers: { 'Content-Length': String(FB_SIZE) } },
    ])
    await expect(bad.fetchScreen()).rejects.toMatchObject({ code: 'screen_size' })
  })

  it('checks the assembled length against the GEOMETRY THE HEADERS DECLARE', async () => {
    // docs/app-control.md: a client's only two sources for the expected length are
    // X-Screen-Width × X-Screen-Height ÷ 2 and the count of bytes it assembled — check that those
    // agree. Here they do not: the headers describe a 1600 × 1200 LANDSCAPE panel, which is the
    // orientation this project deliberately removed, and the body is nonetheless the right number
    // of bytes for the portrait one. Length alone cannot catch that; the two dimensions multiply
    // to the same 960,000 either way, and the page would come out sideways and shredded.
    const { client: c } = client([
      {
        bytes: page(),
        headers: {
          'X-Screen-Width': '1600',
          'X-Screen-Height': '1200',
          'X-Screen-Format': SCREEN_FORMAT,
        },
      },
    ])
    await expect(c.fetchScreen()).rejects.toMatchObject({ code: 'screen_format' })
  })

  it('accepts the five headers the device actually sends', async () => {
    const { client: c } = client([
      {
        bytes: page(),
        headers: {
          'X-Screen-Width': '1200',
          'X-Screen-Height': '1600',
          'X-Screen-Stride': '600',
          'X-Screen-Bpp': '4',
          'X-Screen-Format': SCREEN_FORMAT,
        },
      },
    ])
    expect((await c.fetchScreen()).length).toBe(FB_SIZE)
  })

  it('still accepts a response whose geometry headers a proxy stripped', async () => {
    // Absent is not a disagreement. The compiled-in geometry is then the only expectation there
    // is, and the byte count is still checked against it.
    const { client: c } = client([{ bytes: page(), headers: { 'X-Screen-Format': SCREEN_FORMAT } }])
    expect((await c.fetchScreen()).length).toBe(FB_SIZE)
  })

  it('surfaces no_framebuffer from a 503', async () => {
    const { client: c } = client([
      { ok: false, status: 503, body: { ok: false, error: 'no_framebuffer' } },
    ])
    await expect(c.fetchScreen()).rejects.toMatchObject({ code: 'no_framebuffer', status: 503 })
  })

  it('reports a timeout as timeout, so the screen can explain the awake window', async () => {
    const c = createEsp32Client({ baseUrl: BASE, fetchImpl: silentFetch, screenTimeoutMs: 10 })
    await expect(c.fetchScreen()).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('humanError', () => {
  it('explains the awake window on a timeout rather than calling it a fault', async () => {
    // docs/app-control.md: "a request that times out against a sleeping board is the feature
    // working". The sentence has to say what to DO — press a button on the board.
    const msg = humanError(new Esp32Error('timeout'))
    expect(msg).toMatch(/asleep/i)
    expect(msg).toMatch(/button/i)
  })

  it('has a sentence for every code the board can send back', () => {
    const codes = [
      'bad_json',
      'too_large',
      'read_error',
      'page_range',
      'news_url_invalid',
      'sleep_seconds_invalid',
      'busy',
      'no_framebuffer',
      'screen_size',
      'screen_format',
      'timeout',
      'network_error',
      'http_error',
    ] as const
    const seen = new Set<string>()
    for (const code of codes) {
      const msg = humanError(new Esp32Error(code))
      expect(msg.length).toBeGreaterThan(0)
      expect(msg).not.toBe(code) // a code is not a sentence
      seen.add(msg)
    }
    // Every code says something different; a shared fallback sentence would hide which failed.
    expect(seen.size).toBe(codes.length)
  })

  it('names the sleep bounds when the board refused an interval', () => {
    expect(humanError(new Esp32Error('sleep_seconds_invalid'))).toMatch(/60/)
  })
})
