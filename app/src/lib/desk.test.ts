import { describe, it, expect } from '@jest/globals'
import {
  createDeskClient,
  deskHumanError,
  DeskError,
  NEWS_BRIEFS_MAX,
  NEWS_FIGURES_MAX,
  NEWS_INDICES_MAX,
  NEWS_PEERS_MAX,
  NEWS_STORIES_MAX,
} from './desk'

// ---------------------------------------------------------------------------
// A fake desk. Replays a queue of answers and records every call, so a test can
// assert the path, the verb, the body and — the one that matters most here —
// which requests carried the bearer token and which did not.
// ---------------------------------------------------------------------------

type Reply =
  | {
      ok?: boolean
      status?: number
      /** JSON body. */
      body?: unknown
      /** text/markdown body, for the notes routes. */
      text?: string
      /** Make .json() throw, the way a tunnel's HTML error page does. */
      jsonThrows?: boolean
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
    const status = r.status ?? 200
    return {
      ok: r.ok ?? status < 400,
      status,
      json: async () => {
        if (r.jsonThrows) throw new SyntaxError('Unexpected token < in JSON at position 0')
        return r.body
      },
      text: async () => r.text ?? '',
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

// A desk that never answers, so the client's own AbortController is what ends the request. This
// is what a tunnel with nothing behind it looks like from the phone.
const silentFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const e = new Error('Aborted')
      e.name = 'AbortError'
      reject(e)
    })
  })) as unknown as typeof fetch

const BASE = 'https://desk.example'
const TOKEN = 'op_5f3a9c1e77b24d80'

function client(replies: Reply[], extra: Record<string, unknown> = {}) {
  const f = fakeFetch(replies)
  return {
    ...f,
    client: createDeskClient({ baseUrl: BASE, token: TOKEN, fetchImpl: f.fetchImpl, ...extra }),
  }
}

function bearerOf(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}'))
}

/** The DeskError a call rejected with. Fails the test if the call resolved instead. */
async function failureOf(p: Promise<unknown>): Promise<DeskError> {
  try {
    await p
  } catch (e) {
    return e as DeskError
  }
  throw new Error('expected the call to reject with a DeskError; it resolved')
}

// =====================================================================================
// The Errors copy. One sentence per failure, and each says what to go and do.
// =====================================================================================

describe('deskHumanError', () => {
  const say = (code: string, status?: number) =>
    deskHumanError(new DeskError(code as never, 'raw detail', status))

  it('names the token on a 401 and the operator token on a 403', () => {
    expect(say('unauthorized', 401)).toBe(
      'The desk didn’t accept that token. Check it in Settings.',
    )
    expect(say('forbidden', 403)).toBe(
      'That token can read the desk but not change it. The operator token is the one that can.',
    )
  })

  it('blames the tunnel on a timeout and the address on a network failure', () => {
    expect(say('timeout')).toBe(
      'The desk didn’t answer in time. It sits behind a tunnel — if the tunnel is down, nothing here is current.',
    )
    expect(say('network')).toBe('Couldn’t reach the desk. Check the address in Settings.')
  })

  it('has a sentence for not_found, server and parse', () => {
    expect(say('not_found', 404)).toBe('The desk has no record of that.')
    expect(say('server', 500)).toBe('The desk answered with an error. Try again in a moment.')
    expect(say('parse')).toBe('The desk sent something this app couldn’t read. Update the app.')
  })

  it('never returns the raw detail, whatever the code', () => {
    for (const code of [
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'too_large',
      'bad_request',
      'timeout',
      'network',
      'parse',
      'server',
    ]) {
      const sentence = say(code)
      expect(sentence).not.toContain('raw detail')
      expect(sentence.length).toBeGreaterThan(0)
    }
  })
})

// =====================================================================================
// The bearer token: on every /api/* call, on none of /news.json, and never in an error.
// =====================================================================================

describe('desk client — the bearer token', () => {
  it('sends Authorization: Bearer on /api/state', async () => {
    const { client: c, calls } = client([{ body: { ok: true } }])
    await c.getState()
    expect(calls[0].url).toBe(`${BASE}/api/state`)
    expect(bearerOf(calls[0].init)).toBe(`Bearer ${TOKEN}`)
  })

  it('sends no Authorization at all on /news.json — that plane is anonymous', async () => {
    const { client: c, calls } = client([{ body: { edition: 'SEMICONDUCTORS' } }])
    await c.getNews()
    expect(calls[0].url).toBe(`${BASE}/news.json`)
    expect(bearerOf(calls[0].init)).toBeUndefined()
  })

  it('sends no Authorization when no token is configured — the desk answers 401 and says so', async () => {
    const f = fakeFetch([{ status: 401, ok: false, body: { ok: false, error: 'unauthorized' } }])
    const c = createDeskClient({ baseUrl: BASE, token: '', fetchImpl: f.fetchImpl })
    await expect(c.getState()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(bearerOf(f.calls[0].init)).toBeUndefined()
  })

  it('keeps the token out of the message when the desk echoes it in `detail`', async () => {
    const { client: c } = client([
      {
        status: 401,
        ok: false,
        body: { ok: false, error: 'unauthorized', detail: `unknown token ${TOKEN}` },
      },
    ])
    const err = await failureOf(c.getState())
    expect(err).toBeInstanceOf(DeskError)
    expect(err.message).not.toContain(TOKEN)
    expect(String(err)).not.toContain(TOKEN)
    expect(err.message).toContain('<token>')
  })

  it('keeps the token out of the message when the base URL carries it', async () => {
    // A desk address pasted with a query string on it. The client's messages name the ROUTE and
    // never the address, so this holds structurally today — the test is here to keep it holding
    // the day somebody puts the whole URL in a message to make a bug easier to find.
    const f = fakeFetch([{ status: 404, ok: false, body: { ok: false, error: 'not_found' } }])
    const c = createDeskClient({
      baseUrl: `${BASE}/?t=${TOKEN}`,
      token: TOKEN,
      fetchImpl: f.fetchImpl,
    })
    const err = await failureOf(c.getState())
    expect(err.message).not.toContain(TOKEN)
    expect(String(err)).not.toContain(TOKEN)
  })

  it('keeps the token out of the message when the transport error quotes the URL', async () => {
    const boom = new Error(`request to ${BASE}/api/state?t=${TOKEN} failed`)
    const { client: c } = client([boom])
    const err = await failureOf(c.getState())
    expect(err.code).toBe('network')
    expect(err.message).not.toContain(TOKEN)
    expect(String(err)).not.toContain(TOKEN)
  })

  it('offers the same header for a sheet fetched by an image component', () => {
    const { client: c } = client([])
    expect(c.sheetHeaders()).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect(c.sheetUrl('a1b2c3d4', 'A1.png')).toBe(
      `${BASE}/api/editions/a1b2c3d4/proof/A1.png`,
    )
  })
})

// =====================================================================================
// The desk's {"ok":false,"error":...} envelope, and the three failures that have no envelope.
// =====================================================================================

describe('desk client — failures', () => {
  const cases: Array<[number, string]> = [
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [413, 'too_large'],
    [500, 'server'],
    [502, 'server'],
  ]

  it.each(cases)('maps %i to %s', async (status, code) => {
    const { client: c } = client([{ status, ok: false, body: { ok: false, error: code } }])
    const err = await failureOf(c.getState())
    expect(err.code).toBe(code)
    expect(err.status).toBe(status)
  })

  it('still classifies a refusal whose body is not JSON at all', async () => {
    // A tunnel that is up with nothing behind it answers HTML, not the desk's envelope.
    const { client: c } = client([{ status: 502, ok: false, jsonThrows: true }])
    const err = await failureOf(c.getState())
    expect(err.code).toBe('server')
    expect(err.status).toBe(502)
  })

  it('reports timeout, not network, when our own deadline fired', async () => {
    const c = createDeskClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl: silentFetch,
      timeoutMs: 10,
    })
    await expect(c.getState()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('reports network when the fetch itself rejects', async () => {
    const { client: c } = client([new TypeError('Network request failed')])
    await expect(c.getState()).rejects.toMatchObject({ code: 'network' })
  })

  it('reports parse when a 200 carries something that is not JSON', async () => {
    const { client: c } = client([{ jsonThrows: true }])
    await expect(c.getState()).rejects.toMatchObject({ code: 'parse' })
  })

  it('reports parse when a 200 carries JSON that is not an object', async () => {
    const { client: c } = client([{ body: 'a string' }])
    await expect(c.getState()).rejects.toMatchObject({ code: 'parse' })
  })
})

// =====================================================================================
// GET /api/state — the whole document, then the same document as garbage.
// =====================================================================================

const STATE = {
  ok: true,
  now: 1755702000,
  current: 'a1b2c3d4e5f6',
  staged: null,
  lastPublishAt: 1755701000,
  hold: null,
  scheduleSource: 'file',
  schedule: {
    timezone: 'Asia/Seoul',
    quiet: [{ from: '00:30', to: '06:00' }],
    wake: ['06:00', { at: '12:40', days: 'mon,tue' }],
    publish: { policy: 'on_wake', min_gap_minutes: 60 },
    poll: { active_seconds: 900, quiet_seconds: 3600 },
  },
  policy: { pollSeconds: 900, quiet: false },
  nextTransition: { at: 1755720000, what: 'wake' },
  watchlist: { updatedAt: 1755702000, count: 3 },
  queue: {
    pending: 2,
    recent: [
      {
        id: 'c0ffee00',
        kind: 'research',
        text: 'Look into SNDK',
        priority: 5,
        status: 'done',
        source: 'api',
        created_at: 1755700000,
        deadline_at: null,
        claimed_by: 'worker',
        claimed_at: 1755700100,
        finished_at: 1755700900,
        attempts: 1,
        result: 'filed',
        has_notes: true,
      },
    ],
  },
  editions: [
    {
      id: 'a1b2c3d4e5f6',
      created_at: 1755701000,
      published_at: 1755701000,
      tile_count: 2,
      bytes: 41234,
      dropped_producer_policy: false,
    },
  ],
}

describe('desk client — getState', () => {
  it('parses the documented state', async () => {
    const { client: c } = client([{ body: STATE }])
    const s = await c.getState()
    expect(s.now).toBe(1755702000)
    expect(s.current).toBe('a1b2c3d4e5f6')
    expect(s.staged).toBeNull()
    expect(s.lastPublishAt).toBe(1755701000)
    expect(s.hold).toBeNull()
    expect(s.scheduleSource).toBe('file')
    expect(s.schedule.timezone).toBe('Asia/Seoul')
    expect(s.schedule.quiet).toEqual([{ from: '00:30', to: '06:00' }])
    expect(s.schedule.wake).toEqual([
      { at: '06:00', days: '' },
      { at: '12:40', days: 'mon,tue' },
    ])
    expect(s.schedule.publish).toEqual({ policy: 'on_wake', min_gap_minutes: 60 })
    expect(s.schedule.poll).toEqual({ active_seconds: 900, quiet_seconds: 3600 })
    expect(s.policy).toEqual({ pollSeconds: 900, quiet: false })
    expect(s.nextTransition).toEqual({ at: 1755720000, what: 'wake' })
    expect(s.watchlist).toEqual({ updatedAt: 1755702000, count: 3 })
    expect(s.queue.pending).toBe(2)
    expect(s.queue.recent[0].id).toBe('c0ffee00')
    expect(s.queue.recent[0].has_notes).toBe(true)
    expect(s.queue.recent[0].claimed_by).toBe('worker')
    expect(s.editions[0].tile_count).toBe(2)
    expect(s.editions[0].dropped_producer_policy).toBe(false)
  })

  it('keeps null apart from a number on every instant', async () => {
    // `hold: null` is "not held" and `hold: 0` would be 1 January 1970. A client that folded the
    // two would draw a desk as held since the epoch.
    const { client: c } = client([
      { body: { ...STATE, hold: 0, lastPublishAt: null, watchlist: { updatedAt: null, count: 0 } } },
    ])
    const s = await c.getState()
    expect(s.hold).toBe(0)
    expect(s.lastPublishAt).toBeNull()
    expect(s.watchlist.updatedAt).toBeNull()
  })

  it('coerces an empty document without throwing', async () => {
    const { client: c } = client([{ body: {} }])
    const s = await c.getState()
    expect(s.now).toBe(0)
    expect(s.current).toBeNull()
    expect(s.schedule.quiet).toEqual([])
    expect(s.schedule.wake).toEqual([])
    expect(s.queue).toEqual({ pending: 0, recent: [] })
    expect(s.editions).toEqual([])
    expect(s.watchlist).toEqual({ updatedAt: null, count: 0 })
    expect(s.nextTransition).toBeNull()
  })

  it('coerces a document made entirely of the wrong types', async () => {
    const { client: c } = client([
      {
        body: {
          now: 'soon',
          current: 42,
          staged: [],
          lastPublishAt: 'never',
          hold: {},
          scheduleSource: 99,
          schedule: 'nope',
          policy: [1, 2],
          nextTransition: 'wake',
          watchlist: 7,
          queue: { pending: 'two', recent: [null, 3, 'x', { id: 'ok' }] },
          editions: 'none',
          extraKeyNobodyKnows: { deeply: { nested: true } },
        },
      },
    ])
    const s = await c.getState()
    expect(s.now).toBe(0)
    expect(s.current).toBeNull()
    expect(s.staged).toBeNull()
    expect(s.lastPublishAt).toBeNull()
    expect(s.hold).toBeNull()
    expect(s.scheduleSource).toBe('')
    expect(s.schedule.timezone).toBe('')
    expect(s.policy).toEqual({ pollSeconds: 0, quiet: false })
    expect(s.nextTransition).toBeNull()
    expect(s.queue.pending).toBe(0)
    expect(s.queue.recent).toHaveLength(1) // only the one object survives
    expect(s.queue.recent[0].id).toBe('ok')
    expect(s.editions).toEqual([])
  })
})

// =====================================================================================
// Editions, sheets and notes.
// =====================================================================================

describe('desk client — editions', () => {
  it('GETs the list with its two pointers', async () => {
    const { client: c, calls } = client([
      { body: { ok: true, editions: STATE.editions, current: 'a1b2c3d4e5f6', staged: null } },
    ])
    const r = await c.listEditions()
    expect(calls[0].url).toBe(`${BASE}/api/editions`)
    expect(r.current).toBe('a1b2c3d4e5f6')
    expect(r.staged).toBeNull()
    expect(r.editions).toHaveLength(1)
    // A LIST row carries neither of these — only GET /api/editions/<id> does.
    expect(r.editions[0].sheets).toEqual([])
    expect(r.editions[0].has_notes).toBe(false)
  })

  it('GETs one edition and folds its sheets and note flag onto the row', async () => {
    const { client: c, calls } = client([
      {
        body: {
          ok: true,
          edition: STATE.editions[0],
          sheets: ['A1.png', 'A2.png'],
          has_notes: true,
        },
      },
    ])
    const e = await c.getEdition('a1b2c3d4e5f6')
    expect(calls[0].url).toBe(`${BASE}/api/editions/a1b2c3d4e5f6`)
    expect(e.id).toBe('a1b2c3d4e5f6')
    expect(e.sheets).toEqual(['A1.png', 'A2.png'])
    expect(e.has_notes).toBe(true)
  })

  it('drops sheet names that are not strings rather than rendering an <img src="[object Object]">', async () => {
    const { client: c } = client([
      { body: { ok: true, edition: { id: 'x' }, sheets: ['A1.png', 3, null, {}], has_notes: 'yes' } },
    ])
    const e = await c.getEdition('x')
    expect(e.sheets).toEqual(['A1.png'])
    expect(e.has_notes).toBe(true)
  })

  it('escapes the id and the sheet name into the URL', async () => {
    const { client: c } = client([])
    expect(c.sheetUrl('a b/c', 'A 1.png')).toBe(
      `${BASE}/api/editions/a%20b%2Fc/proof/A%201.png`,
    )
  })

  it('POSTs a promotion and reads back the commit result', async () => {
    const { client: c, calls } = client([
      { body: { ok: true, edition_id: 'a1b2', state: 'published', reason: 'forced' } },
    ])
    const r = await c.promote('a1b2')
    expect(calls[0].url).toBe(`${BASE}/api/editions/a1b2/promote`)
    expect(calls[0].init?.method).toBe('POST')
    expect(r).toEqual({ edition_id: 'a1b2', state: 'published', reason: 'forced' })
  })

  it('takes an unknown commit state to "unchanged" rather than passing it through', async () => {
    const { client: c } = client([{ body: { ok: true, edition_id: 'a1b2', state: 'exploded' } }])
    const r = await c.promote('a1b2')
    expect(r.state).toBe('unchanged')
    expect(r.reason).toBe('')
  })
})

describe('desk client — notes', () => {
  it('GETs an edition note as markdown', async () => {
    const { client: c, calls } = client([{ text: '# Why SNDK\n\nBecause NAND.' }])
    const note = await c.getNotes('editions', 'a1b2')
    expect(calls[0].url).toBe(`${BASE}/api/editions/a1b2/notes.md`)
    expect(bearerOf(calls[0].init)).toBe(`Bearer ${TOKEN}`)
    expect(note).toBe('# Why SNDK\n\nBecause NAND.')
  })

  it('GETs a command note from the other tree', async () => {
    const { client: c, calls } = client([{ text: 'done' }])
    await c.getNotes('commands', 'c0ffee00')
    expect(calls[0].url).toBe(`${BASE}/api/commands/c0ffee00/notes.md`)
  })

  it('answers null on a 404 — "there is not one" is an ordinary condition here', async () => {
    const { client: c } = client([{ status: 404, ok: false, body: { ok: false, error: 'not_found' } }])
    await expect(c.getNotes('editions', 'a1b2')).resolves.toBeNull()
  })

  it('still throws on a 401, which is not "there is not one"', async () => {
    const { client: c } = client([{ status: 401, ok: false, body: { ok: false, error: 'unauthorized' } }])
    await expect(c.getNotes('editions', 'a1b2')).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

// =====================================================================================
// The queue and the standing directives.
// =====================================================================================

describe('desk client — commands', () => {
  it('GETs the queue, and filters by status when asked', async () => {
    const { client: c, calls } = client([{ body: { ok: true, commands: STATE.queue.recent } }])
    const all = await c.listCommands()
    expect(calls[0].url).toBe(`${BASE}/api/commands`)
    expect(all).toHaveLength(1)

    await c.listCommands('pending')
    expect(calls[1].url).toBe(`${BASE}/api/commands?status=pending`)
  })

  it('coerces a row of garbage into a renderable command', async () => {
    const { client: c } = client([
      {
        body: {
          ok: true,
          commands: [
            {
              id: 'c0ffee00',
              kind: null,
              text: { not: 'a string' },
              priority: 'high',
              status: 'ascendant',
              created_at: '2026-08-24',
              deadline_at: 'tomorrow',
              claimed_at: 0,
              attempts: 1.5,
              has_notes: 1,
            },
          ],
        },
      },
    ])
    const [cmd] = await c.listCommands()
    expect(cmd.id).toBe('c0ffee00')
    expect(cmd.kind).toBe('')
    expect(cmd.text).toBe('')
    expect(cmd.priority).toBe(0)
    expect(cmd.status).toBe('unknown') // not passed through — the UI switches on it
    expect(cmd.created_at).toBe(0)
    expect(cmd.deadline_at).toBeNull()
    expect(cmd.claimed_at).toBe(0) // a real instant, distinct from null
    expect(cmd.attempts).toBe(1.5)
    expect(cmd.has_notes).toBe(true)
  })

  it('drops a row with no id — the desk never mints one, and nothing can be done to such a row', async () => {
    const { client: c } = client([
      { body: { ok: true, commands: [{ id: 7, text: 'numeric id' }, { text: 'no id' }, { id: 'c0ffee00' }] } },
    ])
    const cmds = await c.listCommands()
    expect(cmds.map((x) => x.id)).toEqual(['c0ffee00'])
  })

  it('POSTs a command with its defaults and returns the row the desk minted', async () => {
    const { client: c, calls } = client([
      { body: { ok: true, command: { ...STATE.queue.recent[0], status: 'pending' } } },
    ])
    const cmd = await c.postCommand({ text: 'Look into SNDK' })
    expect(calls[0].url).toBe(`${BASE}/api/commands`)
    expect(calls[0].init?.method).toBe('POST')
    expect(bodyOf(calls[0].init)).toEqual({
      text: 'Look into SNDK',
      kind: 'custom',
      priority: 5,
      source: 'app',
    })
    expect(cmd.status).toBe('pending')
  })

  it('sends deadline_at only when there is one — absent keeps the desk from parsing a null', async () => {
    const { client: c, calls } = client([{ body: { ok: true, command: {} } }])
    await c.postCommand({ text: 'x', kind: 'research', priority: 1, source: 'phone', deadlineAt: 99 })
    expect(bodyOf(calls[0].init)).toEqual({
      text: 'x',
      kind: 'research',
      priority: 1,
      source: 'phone',
      deadline_at: 99,
    })
  })

  it('DELETEs a cancellation', async () => {
    const { client: c, calls } = client([{ body: { ok: true } }])
    await c.cancelCommand('c0ffee00')
    expect(calls[0].url).toBe(`${BASE}/api/commands/c0ffee00`)
    expect(calls[0].init?.method).toBe('DELETE')
  })
})

describe('desk client — directives', () => {
  it('GETs the rules in force', async () => {
    const { client: c, calls } = client([
      {
        body: {
          ok: true,
          directives: [
            {
              id: 'd1',
              rule: 'Never print TSLA',
              scope: 'always',
              expires_at: null,
              source: 'api',
              created_at: 1755700000,
            },
            { id: 'd2', rule: 'Quiet week', scope: 'sideways', expires_at: 1755999999 },
          ],
        },
      },
    ])
    const ds = await c.listDirectives()
    expect(calls[0].url).toBe(`${BASE}/api/directives`)
    expect(ds[0].scope).toBe('always')
    expect(ds[0].expires_at).toBeNull()
    expect(ds[1].scope).toBe('always') // an unknown scope lands in the case the UI handles
    expect(ds[1].expires_at).toBe(1755999999)
  })

  it('POSTs a rule and omits expires_at unless the scope has one', async () => {
    const { client: c, calls } = client([{ body: { ok: true, directive: { id: 'd3' } } }])
    await c.addDirective({ rule: 'Never print TSLA' })
    expect(calls[0].init?.method).toBe('POST')
    expect(bodyOf(calls[0].init)).toEqual({ rule: 'Never print TSLA', scope: 'always', source: 'app' })

    await c.addDirective({ rule: 'Quiet week', scope: 'until', expiresAt: 1755999999 })
    expect(bodyOf(calls[1].init)).toEqual({
      rule: 'Quiet week',
      scope: 'until',
      expires_at: 1755999999,
      source: 'app',
    })
  })

  it('DELETEs one by id', async () => {
    const { client: c, calls } = client([{ body: { ok: true } }])
    await c.deleteDirective('d1')
    expect(calls[0].url).toBe(`${BASE}/api/directives/d1`)
    expect(calls[0].init?.method).toBe('DELETE')
  })
})

// =====================================================================================
// The schedule, the hold and the forced publish.
// =====================================================================================

describe('desk client — schedule', () => {
  it('GETs the document and who wrote it', async () => {
    const { client: c, calls } = client([
      { body: { ok: true, source: 'file', schedule: STATE.schedule } },
    ])
    const r = await c.getSchedule()
    expect(calls[0].url).toBe(`${BASE}/api/schedule`)
    expect(r.source).toBe('file')
    expect(r.schedule.publish.policy).toBe('on_wake')
  })

  it('takes an unknown publish policy to manual — the one that changes nothing on its own', async () => {
    const { client: c } = client([
      {
        body: {
          ok: true,
          source: 'default',
          schedule: { ...STATE.schedule, publish: { policy: 'whenever', min_gap_minutes: 'lots' } },
        },
      },
    ])
    const r = await c.getSchedule()
    expect(r.schedule.publish).toEqual({ policy: 'manual', min_gap_minutes: 0 })
  })

  it('drops a quiet window that is missing an end, rather than drawing one to midnight', async () => {
    const { client: c } = client([
      {
        body: {
          ok: true,
          schedule: { ...STATE.schedule, quiet: [{ from: '00:30' }, { from: '1:00', to: '2:00' }, 7] },
        },
      },
    ])
    const r = await c.getSchedule()
    expect(r.schedule.quiet).toEqual([{ from: '1:00', to: '2:00' }])
  })

  it('PUTs the whole document and reads back what the desk stored', async () => {
    const { client: c, calls } = client([
      { body: { ok: true, source: 'file', schedule: STATE.schedule } },
    ])
    const doc = {
      timezone: 'Asia/Seoul',
      quiet: [{ from: '00:30', to: '06:00' }],
      wake: [{ at: '06:00', days: '' }],
      publish: { policy: 'on_wake' as const, min_gap_minutes: 60 },
      poll: { active_seconds: 900, quiet_seconds: 3600 },
    }
    await c.putSchedule(doc)
    expect(calls[0].init?.method).toBe('PUT')
    // A wake on all seven days goes back as the bare string the operator wrote.
    expect(bodyOf(calls[0].init)).toEqual({ ...doc, wake: ['06:00'] })
  })

  it('GETs the next transitions, clamped the way the desk clamps them', async () => {
    const { client: c, calls } = client([
      {
        body: {
          ok: true,
          transitions: [
            {
              at: 1755720000,
              local: '2026-08-24 06:00 KST',
              utc: '2026-08-23T21:00:00Z',
              what: 'wake',
              ambiguous: false,
            },
            { what: 'quiet_start' },
          ],
        },
      },
    ])
    const ts = await c.getScheduleNext(3)
    expect(calls[0].url).toBe(`${BASE}/api/schedule/next?count=3`)
    expect(ts[0].local).toBe('2026-08-24 06:00 KST')
    expect(ts[1]).toEqual({ at: 0, local: '', utc: '', what: 'quiet_start', ambiguous: false })
  })
})

describe('desk client — hold, publish', () => {
  it('POSTs a hold until an instant and reads the instant back', async () => {
    const { client: c, calls } = client([{ body: { ok: true, hold: 1755999999 } }])
    const until = await c.hold(1755999999)
    expect(calls[0].url).toBe(`${BASE}/api/hold`)
    expect(bodyOf(calls[0].init)).toEqual({ until: 1755999999 })
    expect(until).toBe(1755999999)
  })

  it('POSTs an explicit null to clear one', async () => {
    const { client: c, calls } = client([{ body: { ok: true, hold: null } }])
    await expect(c.hold(null)).resolves.toBeNull()
    expect(bodyOf(calls[0].init)).toEqual({ until: null })
  })

  it('POSTs a forced publish and reads the commit result', async () => {
    const { client: c, calls } = client([
      { body: { ok: true, edition_id: 'a1b2', state: 'published', reason: 'forced' } },
    ])
    const r = await c.publish()
    expect(calls[0].url).toBe(`${BASE}/api/publish`)
    expect(calls[0].init?.method).toBe('POST')
    expect(r.state).toBe('published')
  })

  it('reports "nothing is staged" as not_found rather than as success', async () => {
    const { client: c } = client([
      { status: 404, ok: false, body: { ok: false, error: 'not_found', detail: 'nothing is staged' } },
    ])
    await expect(c.publish()).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('desk client — audit', () => {
  it('GETs the log newest first, with the detail object intact', async () => {
    const { client: c, calls } = client([
      {
        body: {
          ok: true,
          events: [
            { seq: 12, at: 1755702000, event: 'publish', detail: { edition: 'a1b2', forced: true } },
            { seq: 11, at: 1755701000, event: 'hold', detail: null },
            'not an event',
          ],
        },
      },
    ])
    const evs = await c.getAudit(25)
    expect(calls[0].url).toBe(`${BASE}/api/audit?limit=25`)
    expect(evs).toHaveLength(2)
    expect(evs[0]).toEqual({
      seq: 12,
      at: 1755702000,
      event: 'publish',
      detail: { edition: 'a1b2', forced: true },
    })
    expect(evs[1].detail).toEqual({})
  })
})

// =====================================================================================
// GET /api/watchlist — the vault's document, or null when nobody has said.
// =====================================================================================

describe('desk client — watchlist', () => {
  it('answers null on a desk nobody has told', async () => {
    const { client: c, calls } = client([{ body: { ok: true, watchlist: null } }])
    await expect(c.getWatchlist()).resolves.toBeNull()
    expect(calls[0].url).toBe(`${BASE}/api/watchlist`)
  })

  it('parses the documented shape', async () => {
    const { client: c } = client([
      {
        body: {
          ok: true,
          watchlist: {
            updated_at: 1755702000,
            source: 'vault',
            items: [
              {
                symbol: 'SNDK',
                name: 'Sandisk Corp.',
                market: 'NASDAQ',
                grade: 'yellow',
                reasons: ['guidance cut', 'inventory glut'],
                thesis_status: 'watching',
                note: 'markdown, up to 16 KiB',
                printable: true,
                last_printed: '2026-08-19',
                events: ['2026-09-03'],
                held: false,
              },
            ],
            universe: ['SNDK', 'MU', 'WDC'],
          },
        },
      },
    ])
    const wl = await c.getWatchlist()
    expect(wl).not.toBeNull()
    expect(wl!.updated_at).toBe(1755702000)
    expect(wl!.source).toBe('vault')
    expect(wl!.universe).toEqual(['SNDK', 'MU', 'WDC'])
    expect(wl!.items).toHaveLength(1)
    expect(wl!.items[0]).toEqual({
      symbol: 'SNDK',
      name: 'Sandisk Corp.',
      market: 'NASDAQ',
      grade: 'yellow',
      reasons: ['guidance cut', 'inventory glut'],
      thesis_status: 'watching',
      note: 'markdown, up to 16 KiB',
      printable: true,
      last_printed: '2026-08-19',
      events: ['2026-09-03'],
      held: false,
    })
  })

  it('defaults missing fields and turns an unknown grade into "none"', async () => {
    const { client: c } = client([
      {
        body: {
          ok: true,
          watchlist: {
            items: [{ symbol: 'ACME', grade: 'purple' }, { name: 'no symbol, dropped' }],
          },
        },
      },
    ])
    const wl = await c.getWatchlist()
    expect(wl!.updated_at).toBeNull()
    expect(wl!.source).toBe('')
    expect(wl!.universe).toEqual([])
    expect(wl!.items).toHaveLength(1)
    expect(wl!.items[0]).toEqual({
      symbol: 'ACME',
      name: '',
      market: '',
      grade: 'none',
      reasons: [],
      thesis_status: '',
      note: '',
      printable: false,
      last_printed: null,
      events: [],
      held: false,
    })
  })

  it('sends the bearer token, same as any other control-plane read', async () => {
    const { client: c, calls } = client([{ body: { ok: true, watchlist: null } }])
    await c.getWatchlist()
    expect(bearerOf(calls[0].init)).toBe(`Bearer ${TOKEN}`)
  })
})

// =====================================================================================
// GET /api/quotes — last price, change and bars, or null when the desk has no Alpaca key.
// =====================================================================================

describe('desk client — quotes', () => {
  it('joins symbols into the query string', async () => {
    const { client: c, calls } = client([{ body: { ok: true, asOf: 1, feed: 'iex', quotes: {} } }])
    await c.getQuotes(['acme', 'sndk'])
    expect(calls[0].url).toBe(`${BASE}/api/quotes?symbols=ACME%2CSNDK`)
  })

  it('parses the documented shape, every number an integer', async () => {
    const { client: c } = client([
      {
        body: {
          ok: true,
          asOf: 1755702000,
          feed: 'iex',
          quotes: {
            ACME: {
              lastCents: 24160,
              prevCloseCents: 23184,
              changeBp: 421,
              bars: [{ t: '2026-08-01', c: 24000 }],
            },
          },
        },
      },
    ])
    const qs = await c.getQuotes(['ACME'])
    expect(qs).not.toBeNull()
    expect(qs!.asOf).toBe(1755702000)
    expect(qs!.feed).toBe('iex')
    expect(qs!.quotes.ACME).toEqual({
      lastCents: 24160,
      prevCloseCents: 23184,
      changeBp: 421,
      bars: [{ t: '2026-08-01', c: 24000 }],
    })
  })

  it('truncates a garbage numeric field to an integer rather than passing a float through', async () => {
    const { client: c } = client([
      {
        body: {
          ok: true,
          asOf: 1755702000.9,
          feed: 'iex',
          quotes: {
            ACME: {
              lastCents: 24160.7,
              prevCloseCents: '23184',
              changeBp: null,
              bars: [{ t: '2026-08-01', c: 24000.4 }],
            },
          },
        },
      },
    ])
    const qs = await c.getQuotes(['ACME'])
    expect(qs!.asOf).toBe(1755702000)
    expect(qs!.quotes.ACME.lastCents).toBe(24160)
    expect(qs!.quotes.ACME.prevCloseCents).toBe(0)
    expect(qs!.quotes.ACME.changeBp).toBe(0)
    expect(qs!.quotes.ACME.bars[0].c).toBe(24000)
  })

  it('resolves null on a 404 no_quotes — a tab to hide, not an error to explain', async () => {
    const { client: c } = client([
      { status: 404, ok: false, body: { ok: false, error: 'no_quotes' } },
    ])
    await expect(c.getQuotes(['ACME'])).resolves.toBeNull()
  })

  it('still throws on any other refusal, 404 included', async () => {
    const { client: c } = client([
      { status: 404, ok: false, body: { ok: false, error: 'not_found' } },
    ])
    await expect(c.getQuotes(['ACME'])).rejects.toMatchObject({ code: 'not_found' })

    const { client: c2 } = client([
      { status: 502, ok: false, body: { ok: false, error: 'upstream' } },
    ])
    await expect(c2.getQuotes(['ACME'])).rejects.toMatchObject({ code: 'server' })
  })
})

// =====================================================================================
// GET /news.json — the edition itself, off the anonymous plane.
// =====================================================================================

const NEWS = {
  edition: 'SEMICONDUCTORS',
  dateline: 'FRIDAY, AUGUST 14, 2026',
  session: 'U.S. MARKETS CLOSED — AUG 13',
  as_of: 'AS OF 05:12 KST',
  generated_at: '2026-08-14T05:12:00Z',
  subject: {
    symbol: 'SNDK',
    name: 'Sandisk Corp.',
    exchange: 'NASDAQ',
    sector: 'Semiconductors',
    last: 241.6,
    change_pct: 4.21,
    prev_close: 231.84,
    open: 233.0,
    high: 245.05,
    low: 231.1,
    wk52_high: 269.0,
    wk52_low: 88.0,
  },
  stories: [
    { rank: 2, headline: 'Third', body: 'c' },
    { rank: 0, kicker: 'MEMORY', headline: 'The lead', deck: 'd', byline: 'By CLAUDE', body: 'a', chart: 0 },
    { rank: 1, headline: 'Second', body: 'b' },
  ],
  figures: [
    { group: 'VALUATION', label: '52-week range', value: '$88–$269', emph: 1, bar: 812 },
    { group: 'THE STREET', label: 'Target', value: '$268.00', emph: true, change_pct: -12.5 },
    { group: 'VALUATION', label: 'P/E', value: '22.4x' },
  ],
  briefs: [{ date: 'AUG 13', kicker: 'SUPPLY', text: 'Kioxia lifts its capital plan.' }],
  peers: [
    { symbol: 'MU', name: 'Micron', per: '18.1x', cap: '$142.0B', last: 128.44, change_pct: 2.1 },
    { symbol: 'SNDK', name: 'Sandisk', per: '22.4x', cap: '$241.6B', last: 241.6, change_pct: 4.21, is_subject: true },
  ],
  indices: [{ symbol: 'SPX', name: 'S&P 500', last: 6412.83, change_pct: 0.62, spark: [402, 418] }],
  policy: { poll_seconds: 900, next_change: 1755561000 },
}

describe('desk client — getNews', () => {
  it('parses the reference payload', async () => {
    const { client: c } = client([{ body: NEWS }])
    const n = await c.getNews()
    expect(n.edition).toBe('SEMICONDUCTORS')
    expect(n.as_of).toBe('AS OF 05:12 KST')
    expect(n.generated_at).toBe('2026-08-14T05:12:00Z')
    expect(n.subject.symbol).toBe('SNDK')
    expect(n.policy).toEqual({ poll_seconds: 900, next_change: 1755561000 })
  })

  it('turns money into cents and a percentage into basis points, the way news_parse.c does', async () => {
    const { client: c } = client([{ body: NEWS }])
    const n = await c.getNews()
    expect(n.subject.lastCents).toBe(24160)
    expect(n.subject.changeBp).toBe(421)
    expect(n.subject.prevCloseCents).toBe(23184)
    expect(n.subject.openCents).toBe(23300)
    expect(n.subject.highCents).toBe(24505)
    expect(n.subject.lowCents).toBe(23110)
    expect(n.subject.wk52HighCents).toBe(26900)
    expect(n.subject.wk52LowCents).toBe(8800)
    expect(n.peers[0].lastCents).toBe(12844)
    expect(n.peers[0].changeBp).toBe(210)
    expect(n.indices[0].lastCents).toBe(641283)
    expect(n.indices[0].changeBp).toBe(62)
  })

  it('rounds half away from zero, and saturates rather than wrapping', async () => {
    const { client: c } = client([
      {
        body: {
          subject: { last: 1.005, change_pct: -0.125, prev_close: 1e12, open: -1e12 },
        },
      },
    ])
    const n = await c.getNews()
    // 1.005 * 100 is 100.49999999999999 in IEEE 754, on x86 and on Xtensa alike.
    expect(n.subject.lastCents).toBe(100)
    expect(n.subject.changeBp).toBe(-13)
    expect(n.subject.prevCloseCents).toBe(2147483000)
    expect(n.subject.openCents).toBe(-2147483000)
  })

  it('takes a number sent as a string to the default, because the board does', async () => {
    // A phone that parsed "241.60" would print a price the sheet beside it does not carry.
    const { client: c } = client([{ body: { subject: { last: '241.60', change_pct: null } } }])
    const n = await c.getNews()
    expect(n.subject.lastCents).toBe(0)
    expect(n.subject.changeBp).toBe(0)
  })

  it('sorts stories by rank so stories[0] is the lead, whatever order they arrived in', async () => {
    const { client: c } = client([{ body: NEWS }])
    const n = await c.getNews()
    expect(n.stories.map((s) => s.headline)).toEqual(['The lead', 'Second', 'Third'])
    expect(n.stories[0].kicker).toBe('MEMORY')
    expect(n.stories[0].chart).toBe(0)
  })

  it('sorts stably, so equal ranks keep the order the producer filed them in', async () => {
    const { client: c } = client([
      {
        body: {
          stories: [
            { headline: 'first filed' },
            { headline: 'second filed' },
            { headline: 'third filed' },
          ],
        },
      },
    ])
    const n = await c.getNews()
    expect(n.stories.map((s) => s.headline)).toEqual(['first filed', 'second filed', 'third filed'])
    expect(n.stories[0].rank).toBe(9) // the default, larger than the array holds
  })

  it('keeps the lowest ranks when more than five arrive, rather than the first five', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      rank: 8 - i,
      headline: `rank ${8 - i}`,
    }))
    const { client: c } = client([{ body: { stories: many } }])
    const n = await c.getNews()
    expect(n.stories).toHaveLength(NEWS_STORIES_MAX)
    expect(n.stories.map((s) => s.headline)).toEqual([
      'rank 1',
      'rank 2',
      'rank 3',
      'rank 4',
      'rank 5',
    ])
  })

  it('skips entries missing the one field that makes them an entry', async () => {
    const { client: c } = client([
      {
        body: {
          stories: [{ headline: '' }, { deck: 'no headline' }, { headline: 'kept' }],
          figures: [{ label: 'no value' }, { value: 'no label' }, { label: 'P/E', value: '22.4x' }],
          briefs: [{ date: 'AUG 13' }, { text: 'kept' }],
          peers: [{ name: 'no symbol' }, { symbol: 'MU' }],
          indices: [{ name: 'no symbol' }, { symbol: 'SPX' }],
        },
      },
    ])
    const n = await c.getNews()
    expect(n.stories.map((s) => s.headline)).toEqual(['kept'])
    expect(n.figures.map((f) => f.label)).toEqual(['P/E'])
    expect(n.briefs.map((b) => b.text)).toEqual(['kept'])
    expect(n.peers.map((p) => p.symbol)).toEqual(['MU'])
    expect(n.indices.map((i) => i.symbol)).toEqual(['SPX'])
  })

  it('keeps an absent figure change apart from a change of zero', async () => {
    const { client: c } = client([
      {
        body: {
          figures: [
            { label: 'P/E', value: '22.4x' },
            { label: 'Target', value: '$268', change_pct: 0 },
          ],
        },
      },
    ])
    const n = await c.getNews()
    expect(n.figures[0].changeBp).toBeNull() // no mark, no colour
    expect(n.figures[1].changeBp).toBe(0) // a flat mark
  })

  it('reads emph as the wire spells it and clamps bar, keeping -1 for "no bar"', async () => {
    const { client: c } = client([{ body: NEWS }])
    const n = await c.getNews()
    expect(n.figures.map((f) => f.emph)).toEqual([true, true, false])
    expect(n.figures.map((f) => f.bar)).toEqual([812, -1, -1])

    const { client: d } = client([
      { body: { figures: [{ label: 'a', value: 'b', bar: 1004 }, { label: 'c', value: 'd', bar: 0 }] } },
    ])
    const m = await d.getNews()
    expect(m.figures[0].bar).toBe(1000) // clamped, not dropped
    expect(m.figures[1].bar).toBe(0) // a real position, not "no bar"
  })

  it('drops a photo the board would drop, so the phone describes the page that printed', async () => {
    const { client: c } = client([
      {
        body: {
          stories: [
            { headline: 'no id', photo: { w: 558, h: 300 } },
            { headline: 'odd width', photo: { id: 'a', w: 557, h: 300 } },
            { headline: 'no height', photo: { id: 'b', w: 558, h: 0 } },
            {
              // Oversized but even: clamped to the panel rather than dropped.
              headline: 'kept',
              photo: { id: 'c', w: 99998, h: 99999, caption: 'cap', credit: 'REUTERS' },
            },
          ],
        },
      },
    ])
    const n = await c.getNews()
    expect(n.stories.map((s) => s.photo)).toEqual([
      null,
      null,
      null,
      { id: 'c', w: 1200, h: 1600, caption: 'cap', credit: 'REUTERS' },
    ])
  })

  it('rounds a photo dimension before testing it for evenness, the way jint() does', async () => {
    // 557.6 is 558 to the board — even, and kept. A phone that truncated it to 557 would drop a
    // photograph the sheet beside it carries.
    const { client: c } = client([
      { body: { stories: [{ headline: 'a', photo: { id: 'p', w: 557.6, h: 300.4 } }] } },
    ])
    const n = await c.getNews()
    expect(n.stories[0].photo).toEqual({ id: 'p', w: 558, h: 300, caption: '', credit: '' })
  })

  it('rounds a rank rather than truncating it', async () => {
    const { client: c } = client([
      { body: { stories: [{ headline: 'b', rank: 1.6 }, { headline: 'a', rank: 1.4 }] } },
    ])
    const n = await c.getNews()
    expect(n.stories.map((s) => [s.headline, s.rank])).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })

  it('keeps the chart index as filed and takes a non-number to -1, which is "none"', async () => {
    // charts[] is not parsed here, so this client cannot range-check the index the way the board
    // does — it passes the producer's number through and defaults anything that is not one.
    const { client: c } = client([
      { body: { stories: [{ headline: 'a', chart: 4 }, { headline: 'b', chart: 'x' }] } },
    ])
    const n = await c.getNews()
    expect(n.stories.map((s) => s.chart)).toEqual([4, -1])
  })

  it('reads is_subject as cJSON_IsTrue does — a 1 is not a boolean on this wire', async () => {
    const { client: c } = client([
      { body: { peers: [{ symbol: 'A', is_subject: 1 }, { symbol: 'B', is_subject: true }] } },
    ])
    const n = await c.getNews()
    expect(n.peers.map((p) => p.is_subject)).toEqual([false, true])
  })

  it('clamps a sparkline to its box and loses its oldest samples, not its newest', async () => {
    const { client: c } = client([
      {
        body: {
          indices: [
            { symbol: 'SPX', spark: [...Array.from({ length: 26 }, (_, i) => i), 2000, -5] },
          ],
        },
      },
    ])
    const n = await c.getNews()
    expect(n.indices[0].spark).toHaveLength(24)
    expect(n.indices[0].spark[23]).toBe(0) // -5 clamped up
    expect(n.indices[0].spark[22]).toBe(1000) // 2000 clamped down
    expect(n.indices[0].spark[0]).toBe(4) // 0..3 were the oldest and went
  })

  it('caps every list at what one page can hold', async () => {
    const fill = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i))
    const { client: c } = client([
      {
        body: {
          figures: fill(40, (i) => ({ label: `l${i}`, value: 'v' })),
          briefs: fill(20, (i) => ({ text: `t${i}` })),
          peers: fill(20, (i) => ({ symbol: `P${i}` })),
          indices: fill(20, (i) => ({ symbol: `I${i}` })),
        },
      },
    ])
    const n = await c.getNews()
    expect(n.figures).toHaveLength(NEWS_FIGURES_MAX)
    expect(n.briefs).toHaveLength(NEWS_BRIEFS_MAX)
    expect(n.peers).toHaveLength(NEWS_PEERS_MAX)
    expect(n.indices).toHaveLength(NEWS_INDICES_MAX)
  })

  it('reads a payload with nothing in it as an empty edition, not as a crash', async () => {
    const { client: c } = client([{ body: {} }])
    const n = await c.getNews()
    expect(n.edition).toBe('')
    expect(n.subject.lastCents).toBe(0)
    expect(n.stories).toEqual([])
    expect(n.figures).toEqual([])
    expect(n.briefs).toEqual([])
    expect(n.peers).toEqual([])
    expect(n.indices).toEqual([])
    expect(n.policy).toBeNull() // absent is the normal case
  })

  it('reads a payload made of the wrong types as an empty edition too', async () => {
    const { client: c } = client([
      {
        body: {
          edition: 7,
          subject: 'SNDK',
          stories: 'one',
          figures: { label: 'x' },
          briefs: null,
          peers: 3,
          indices: [null, 'x', 5],
          policy: 'later',
          thumbs: [{ id: 'unused' }],
        },
      },
    ])
    const n = await c.getNews()
    expect(n.edition).toBe('') // a number is not a string, so it goes to the default — jstr()'s rule
    expect(n.subject.symbol).toBe('')
    expect(n.stories).toEqual([])
    expect(n.figures).toEqual([])
    expect(n.briefs).toEqual([])
    expect(n.peers).toEqual([])
    expect(n.indices).toEqual([])
    expect(n.policy).toBeNull()
  })

  it('drops a policy block that names an instant as a string', async () => {
    // The one mistake worth catching loudest: an ISO-8601 next_change looks more correct than the
    // number that works. The board clamps it away; so does this.
    const { client: c } = client([
      { body: { policy: { poll_seconds: 10, next_change: '2026-08-19T00:00:00Z' } } },
    ])
    const n = await c.getNews()
    expect(n.policy).toEqual({ poll_seconds: 30, next_change: 0 }) // clamped to the floor
  })

  it('leaves poll_seconds at 0 when the block said nothing about cadence', async () => {
    // 0 is "the desk said nothing" (power_policy.h), not a cadence of zero. Defaulting it to the
    // floor would tell a reader the desk asked for a poll every thirty seconds when it asked for
    // nothing at all.
    const { client: c } = client([{ body: { policy: { next_change: 1755561000 } } }])
    const n = await c.getNews()
    expect(n.policy).toEqual({ poll_seconds: 0, next_change: 1755561000 })
  })

  it('lets next_change name a date past 2038 — it is an instant, not a scaled int32', async () => {
    const { client: c } = client([
      { body: { policy: { poll_seconds: 900, next_change: 4102444800 } } },
    ])
    const n = await c.getNews()
    expect(n.policy?.next_change).toBe(4102444800) // 2100-01-01, not saturated to 2.147e9

    const { client: d } = client([{ body: { policy: { next_change: 1e18 } } }])
    const m = await d.getNews()
    expect(m.policy?.next_change).toBe(253402300799) // 9999-12-31, the wire's own ceiling
  })

  it('reads a negative next_change as absent rather than as a bound', async () => {
    const { client: c } = client([{ body: { policy: { next_change: -5 } } }])
    const n = await c.getNews()
    expect(n.policy?.next_change).toBe(0)
  })
})
