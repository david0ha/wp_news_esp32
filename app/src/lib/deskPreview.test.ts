import { describe, it, expect } from '@jest/globals'
import { createDeskClient, DeskError } from './desk'

const ID = '0123456789abcdef'
const TOKEN = 'private-operator-token'

function setup(replies: Array<{ body?: unknown; status?: number; raw?: string } | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const reply = replies[calls.length - 1]
    if (reply instanceof Error) throw reply
    const status = reply.status ?? 200
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => reply.raw ?? JSON.stringify(reply.body),
    } as Response
  }) as typeof fetch
  return {
    calls,
    client: createDeskClient({ baseUrl: 'https://desk.example/', token: TOKEN, fetchFn }),
  }
}

const listing = { body: { ok: true, current: ID, staged: 'fedcba9876543210' } }
const sheets = (names: unknown) => ({
  body: { ok: true, edition: { edition_id: ID }, sheets: names },
})

describe('boardPreview', () => {
  it('reads current rather than staged and authenticates metadata and image requests without URL credentials', async () => {
    const { client, calls } = setup([listing, sheets(['02_a2_full.bmp', '01_a1_full.png'])])
    expect(await client.boardPreview()).toEqual({
      editionId: ID,
      sheets: [
        {
          page: 0,
          name: '01_a1_full.png',
          uri: `https://desk.example/api/editions/${ID}/proof/01_a1_full.png`,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
        {
          page: 1,
          name: '02_a2_full.bmp',
          uri: `https://desk.example/api/editions/${ID}/proof/02_a2_full.bmp`,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      ],
    })
    expect(calls.map((c) => c.url)).toEqual([
      'https://desk.example/api/editions',
      `https://desk.example/api/editions/${ID}`,
    ])
    calls.forEach((c) => expect(c.init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` }))
  })

  it('returns no preview when no edition is current, even with one staged', async () => {
    const { client, calls } = setup([{ body: { ok: true, current: null, staged: ID } }])
    expect(await client.boardPreview()).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('returns an empty sheet list when the current edition has no render', async () => {
    expect(await setup([listing, sheets([])]).client.boardPreview()).toEqual({
      editionId: ID,
      sheets: [],
    })
  })

  it('excludes diagnostic, unrecognized and unsafe sheets and prefers PNG to BMP', async () => {
    const result = await setup([
      listing,
      sheets([
        '09_a1_stale.png',
        '10_a1_offline.bmp',
        '03_a1_sparse.png',
        '../01_a1_full.png',
        'https://evil.example/02_a2_full.png',
        '01_a1_full.png?token=x',
        null,
        '01_a1_full.bmp',
        '01_a1_full.png',
        '01_a1_full.png',
      ]),
    ]).client.boardPreview()
    expect(result?.sheets.map((s) => s.name)).toEqual(['01_a1_full.png'])
  })

  it.each(['../secret', 'https://evil.example', '', 123, undefined])(
    'refuses invalid current id %s before constructing a second URL',
    async (current) => {
      const { client, calls } = setup([{ body: { ok: true, current } }])
      await expect(client.boardPreview()).rejects.toMatchObject({ code: 'bad_json' })
      expect(calls).toHaveLength(1)
    },
  )

  it.each([null, {}, '01_a1_full.png'])('refuses malformed sheet metadata %s', async (names) => {
    await expect(setup([listing, sheets(names)]).client.boardPreview()).rejects.toMatchObject({
      code: 'bad_json',
    })
  })

  it.each([401, 403, 404, 500])('preserves HTTP refusal %s', async (status) => {
    await expect(
      setup([listing, { status, body: { error: 'refused' } }]).client.boardPreview(),
    ).rejects.toMatchObject({
      code: status === 401 || status === 403 ? 'unauthorized' : 'http',
      status,
    })
  })

  it('refuses non-JSON metadata', async () => {
    await expect(
      setup([{ raw: '<html>error</html>' }]).client.boardPreview(),
    ).rejects.toBeInstanceOf(DeskError)
  })

  it('does not expose a token echoed by a transport or refusal', async () => {
    for (const reply of [
      new Error(`request failed ${TOKEN}`),
      { status: 400, body: { error: TOKEN, detail: `bad ${TOKEN}` } },
    ]) {
      try {
        await setup([reply]).client.boardPreview()
        throw new Error('expected refusal')
      } catch (error) {
        expect(error).toBeInstanceOf(DeskError)
        expect(JSON.stringify(error)).not.toContain(TOKEN)
        expect((error as Error).message).not.toContain(TOKEN)
      }
    }
  })
})
