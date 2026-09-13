import { it, expect, jest } from '@jest/globals'
import { createAlpacaClient } from './alpaca'

const desk = { baseUrl: 'https://desk.example/', token: 'test-token' }
const expiry = 1792108800
const result = {
  symbol: 'AAAA', source: 'alpaca', feed: 'indicative', spot: 100,
  expiration: expiry, expirationDates: [expiry], puts: [],
  calls: [{ symbol: 'AAAA261016C00100000', strike: 100, bid: 3, ask: 3.2,
    lastPrice: 3.1, delta: 0.55, gamma: 0.02, multiplier: 100,
    quoteTimestamp: '2026-09-12T20:00:00Z', inTheMoney: false }],
}
function setup(body: unknown = { ok: true, result }, status = 200) {
  const fetchFn = jest.fn(async () => ({ ok: status === 200, status, json: async () => body }))
  return { fetchFn, client: createAlpacaClient({ fetchFn: fetchFn as unknown as typeof fetch, desk: async () => desk }) }
}

it('requests the authenticated desk endpoint and preserves prices, Greeks and feed', async () => {
  const { client, fetchFn } = setup()
  const chain = await client.options(' aaaa ', expiry)
  expect(fetchFn.mock.calls[0]).toEqual([
    `https://desk.example/api/market/options/alpaca?symbol=AAAA&date=${expiry}`,
    expect.objectContaining({ headers: { Authorization: 'Bearer test-token', Accept: 'application/json' } }),
  ])
  expect(chain.feed).toBe('indicative')
  expect(chain.calls[0]).toMatchObject({ bid: 3, ask: 3.2, delta: 0.55, gamma: 0.02, multiplier: 100, theta: null, volume: null })
})

it('does not fetch when the phone has no paired desk', async () => {
  const fetchFn = jest.fn<typeof fetch>()
  const client = createAlpacaClient({ fetchFn, desk: async () => null })
  await expect(client.options('AAAA')).rejects.toMatchObject({ code: 'no_desk' })
  expect(fetchFn).not.toHaveBeenCalled()
})

it('keeps absent Greeks and invalid prices unavailable and sorts strikes', async () => {
  const { client } = setup({ ok: true, result: { ...result, calls: [
    { strike: 110, ask: -1, bid: '3', gamma: Infinity }, { strike: 90, ask: 0, bid: 0 },
  ] } })
  const chain = await client.options('AAAA')
  expect(chain.calls.map(c => c.strike)).toEqual([90, 110])
  expect(chain.calls[1]).toMatchObject({ ask: null, bid: null, gamma: null, delta: null, multiplier: null })
  expect(chain.calls[0].ask).toBe(0)
})

it.each([{}, { result: {} }, { result: { ...result, feed: 'unknown' } },
  { result: { ...result, symbol: 'BBBB' } }, { result: { ...result, expiration: 0 } },
])('rejects invalid envelopes instead of drawing a fabricated chain', async body => {
  await expect(setup(body).client.options('AAAA')).rejects.toMatchObject({ code: 'parse' })
})

it('rejects a mismatched expiration', async () => {
  await expect(setup().client.options('AAAA', expiry + 86400)).rejects.toMatchObject({ code: 'parse' })
})

it.each([[429, 'rate_limited'], [404, 'not_found'], [503, 'http']])('maps HTTP %s without leaking provider messages', async (status, code) => {
  await expect(setup({ error: 'secret upstream detail' }, status as number).client.options('AAAA'))
    .rejects.toMatchObject({ code })
})

it('maps network failures to a safe transport error', async () => {
  const client = createAlpacaClient({ desk: async () => desk, fetchFn: (async () => { throw Error('secret') }) as typeof fetch })
  await expect(client.options('AAAA')).rejects.toMatchObject({ code: 'transport', message: 'Options request failed' })
})

it('keeps its deadline active while reading the response body', async () => {
  jest.useFakeTimers()
  try {
    const client = createAlpacaClient({ desk: async () => desk, fetchFn: (async (_url, init) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Error('aborted')))),
    })) as typeof fetch })
    const pending = client.options('AAAA')
    const assertion = expect(pending).rejects.toMatchObject({ code: 'transport' })
    await jest.advanceTimersByTimeAsync(30_000)
    await assertion
  } finally { jest.useRealTimers() }
})

it.each([null, [], 'invalid', {}, { strike: 0 }, { strike: -1 }, { strike: '100' }, { strike: Infinity }])(
  'rejects a mixed chain containing malformed contract %p', async invalid => {
    await expect(setup({ ok: true, result: { ...result, calls: [result.calls[0], invalid] } }).client.options('AAAA'))
      .rejects.toMatchObject({ code: 'parse' })
  },
)

it('rejects an entirely malformed put chain rather than reporting no contracts', async () => {
  await expect(setup({ ok: true, result: { ...result, calls: [], puts: [null, { strike: NaN }] } }).client.options('AAAA'))
    .rejects.toMatchObject({ code: 'parse' })
})
