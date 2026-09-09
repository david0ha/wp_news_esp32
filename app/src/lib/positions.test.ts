import { describe, it, expect } from '@jest/globals'
import {
  parsePositionsDoc,
  positionsBody,
  strategyLabel,
  strikeText,
  type OptionLeg,
  type OptionPosition,
  type Position,
  type PositionsDoc,
  type Strategy,
} from './positions'
import { createDeskClient, DeskError } from './desk'
import { en } from '../i18n/en'
import { ko } from '../i18n/ko'

// Every label test injects `nowMs`, because the expiry carries a year only when it is not this
// year. Without it these assertions would start failing on 1 January for a reason that has
// nothing to do with positions.
const NOW = Date.UTC(2026, 8, 8)

const leg = (over: Partial<OptionLeg> = {}): OptionLeg => ({
  right: 'call',
  side: 'long',
  strikeCents: 42000,
  expiry: '2026-11-21',
  contracts: 1,
  entryPriceCents: 1180,
  ...over,
})

const option = (strategy: Strategy, legs: OptionLeg[]): OptionPosition => ({
  id: 'p_1f05f8',
  symbol: 'AAAA',
  openedAt: '2026-08-19',
  note: '',
  kind: 'option',
  legs,
  strategy,
})

describe('strategyLabel', () => {
  it('names a single leg with its strike and expiry', () => {
    const longCall = option('long_call', [leg()])
    expect(strategyLabel(longCall, ko, { nowMs: NOW })).toBe('11월 21일 만기 420 콜')
    expect(strategyLabel(longCall, en, { nowMs: NOW })).toBe('Nov 21 420 Call')
  })

  it('names a vertical by both strikes', () => {
    const vertical = option('vertical', [
      leg({ side: 'long', strikeCents: 40000 }),
      leg({ side: 'short', strikeCents: 42000 }),
    ])
    expect(strategyLabel(vertical, ko, { nowMs: NOW })).toBe('콜 버티컬 400/420')
    expect(strategyLabel(vertical, en, { nowMs: NOW })).toBe('Call Vertical 400/420')
  })

  it('reads the strikes low first, however the legs were entered', () => {
    // The owner types the leg they bought first, which is not always the lower strike. A vertical
    // written 420/400 reads as a different spread to anyone scanning a list of them.
    const written = option('vertical', [
      leg({ side: 'short', strikeCents: 42000 }),
      leg({ side: 'long', strikeCents: 40000 }),
    ])
    expect(strategyLabel(written, ko, { nowMs: NOW })).toBe('콜 버티컬 400/420')
  })

  it('pairs a short call against stock as a covered call', () => {
    // The one strategy `derive_strategy` cannot see, because it needs the stock position beside
    // the option one — which is why this argument exists at all.
    const shortCall = option('short_call', [leg({ side: 'short', contracts: 2 })])
    expect(strategyLabel(shortCall, ko, { stockShares: 200, nowMs: NOW })).toBe('커버드 콜 420')
    expect(strategyLabel(shortCall, en, { stockShares: 200, nowMs: NOW })).toBe('Covered Call 420')
  })

  it('will not call it covered when the shares do not cover it', () => {
    // 199 shares against two contracts is a covered call on one of them and a naked call on the
    // other, which is a completely different risk. The honest name is the one the desk derived.
    const shortCall = option('short_call', [leg({ side: 'short', contracts: 2 })])
    expect(strategyLabel(shortCall, ko, { stockShares: 199, nowMs: NOW })).toBe(
      '11월 21일 만기 420 콜 숏',
    )
    expect(strategyLabel(shortCall, ko, { nowMs: NOW })).toBe('11월 21일 만기 420 콜 숏')
  })

  it('will not call it covered on a listing where a contract is not a hundred shares', () => {
    // SHARES_PER_CONTRACT is the app's own assumption and holds only for US-listed equity
    // options. A numeric ticker is a KR listing, where it does not — and mislabelling here is a
    // wrong sentence about what the owner is exposed to, where declining to label is merely less
    // helpful.
    const krShortCall = {
      ...option('short_call', [leg({ side: 'short', contracts: 2 })]),
      symbol: '005930',
    }
    expect(strategyLabel(krShortCall, ko, { stockShares: 200, nowMs: NOW })).toBe(
      '11월 21일 만기 420 콜 숏',
    )
  })

  it('will not call it covered when the stock leg is itself short', () => {
    // A short stock holding covers nothing. Reading the sign is the whole difference between a
    // covered call and two short positions in the same direction.
    const shortCall = option('short_call', [leg({ side: 'short', contracts: 1 })])
    expect(strategyLabel(shortCall, ko, { stockShares: -400, nowMs: NOW })).toBe(
      '11월 21일 만기 420 콜 숏',
    )
  })

  it('falls back to the leg list rather than inventing a name', () => {
    const custom = option('custom', [
      leg({ right: 'call', side: 'long', strikeCents: 40000 }),
      leg({ right: 'put', side: 'short', strikeCents: 38000 }),
      leg({ right: 'call', side: 'short', strikeCents: 44000 }),
    ])
    expect(strategyLabel(custom, ko, { nowMs: NOW })).toBe('400 콜 롱 · 380 풋 숏 · 440 콜 숏')
    expect(strategyLabel(custom, en, { nowMs: NOW })).toBe(
      'Long 400 Call · Short 380 Put · Short 440 Call',
    )
  })

  it('falls back to the leg list when a named shape does not have the legs for it', () => {
    // A desk that named this `vertical` and sent one leg is a desk this app disagrees with, and
    // the right answer to that is the legs — never a "400/undefined" built out of a missing one.
    const wrong = option('vertical', [leg({ strikeCents: 40000 })])
    expect(strategyLabel(wrong, ko, { nowMs: NOW })).toBe('400 콜 롱')
  })

  it('names the other five shapes the desk can derive', () => {
    const put = option('long_put', [leg({ right: 'put', strikeCents: 38000 })])
    expect(strategyLabel(put, ko, { nowMs: NOW })).toBe('11월 21일 만기 380 풋')

    const shortPut = option('short_put', [leg({ right: 'put', side: 'short', strikeCents: 38000 })])
    // NOT "cash-secured": whether it is secured is a fact about collateral neither end can see.
    expect(strategyLabel(shortPut, ko, { nowMs: NOW })).toBe('11월 21일 만기 380 풋 숏')

    const calendar = option('calendar', [
      leg({ side: 'long', expiry: '2026-12-18' }),
      leg({ side: 'short', expiry: '2026-11-21' }),
    ])
    expect(strategyLabel(calendar, ko, { nowMs: NOW })).toBe('콜 캘린더 420')

    const straddle = option('straddle', [leg({ right: 'call' }), leg({ right: 'put' })])
    expect(strategyLabel(straddle, ko, { nowMs: NOW })).toBe('420 스트래들 롱')

    const strangle = option('strangle', [
      leg({ right: 'call', strikeCents: 44000 }),
      leg({ right: 'put', strikeCents: 38000 }),
    ])
    expect(strategyLabel(strangle, ko, { nowMs: NOW })).toBe('380/440 스트랭글 롱')
  })

  it('spells an expiry in another year with its year', () => {
    // A LEAP two years out is not "Nov 21". The rule is `formatDateShort`'s, in the catalogue the
    // caller passed rather than the app's current one.
    const leap = option('long_call', [leg({ expiry: '2028-01-21' })])
    expect(strategyLabel(leap, en, { nowMs: NOW })).toBe('Jan 21, 2028 420 Call')
    expect(strategyLabel(leap, ko, { nowMs: NOW })).toBe('2028년 1월 21일 만기 420 콜')
  })

  it('is pure in the catalogue it is handed, not in the app’s current language', () => {
    // Every other sentence function in `src/lib` reads `strings()`. This one takes the table, so a
    // screen can render a label in a language the app is not drawn in — and so that no test here
    // has to reach for the module-level global to assert one.
    const p = option('long_call', [leg()])
    expect(strategyLabel(p, ko, { nowMs: NOW })).not.toBe(strategyLabel(p, en, { nowMs: NOW }))
  })

  it('names a stock holding by its share count, and a short one as short', () => {
    const long: Position = {
      id: 'p_3e3267',
      symbol: 'BBBB',
      openedAt: '2026-07-02',
      note: '',
      kind: 'stock',
      quantity: 1400,
      entryPriceCents: 158300,
    }
    expect(strategyLabel(long, ko)).toBe('1,400주')
    expect(strategyLabel(long, en)).toBe('1,400 shares')
    expect(strategyLabel({ ...long, quantity: -40 }, ko)).toBe('40주 공매도')
    expect(strategyLabel({ ...long, quantity: -40 }, en)).toBe('40 shares short')
  })

  it('agrees the English noun with the count, both ways round', () => {
    // One share is a real position — a single share of an expensive listing, or what is left of a
    // larger one — and "1 shares" is the reading the singular templates exist to prevent. Korean
    // does not inflect a counted noun, so both halves of each pair are the same string there and
    // this test is what says that is deliberate rather than a copy-paste.
    const one: Position = {
      id: 'p_9ac114',
      symbol: 'BBBB',
      openedAt: '2026-07-02',
      note: '',
      kind: 'stock',
      quantity: 1,
      entryPriceCents: 158300,
    }
    expect(strategyLabel(one, en)).toBe('1 share')
    expect(strategyLabel({ ...one, quantity: 2 }, en)).toBe('2 shares')
    expect(strategyLabel({ ...one, quantity: -1 }, en)).toBe('1 share short')
    expect(strategyLabel({ ...one, quantity: -2 }, en)).toBe('2 shares short')

    expect(strategyLabel(one, ko)).toBe('1주')
    expect(strategyLabel({ ...one, quantity: 2 }, ko)).toBe('2주')
    expect(strategyLabel({ ...one, quantity: -1 }, ko)).toBe('1주 공매도')
    expect(strategyLabel({ ...one, quantity: -2 }, ko)).toBe('2주 공매도')
  })
})

describe('strikeText', () => {
  it('drops a whole dollar’s cents and keeps the rest', () => {
    // The wire carries integer cents and a chain prints strikes both ways. This is the one place
    // the app turns the one into the other.
    expect(strikeText(42000)).toBe('420')
    expect(strikeText(42050)).toBe('420.50')
    expect(strikeText(42005)).toBe('420.05')
    expect(strikeText(120000000)).toBe('1,200,000')
  })
})

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

// `server/positions.example.json`, exactly as it goes over the wire — the same two positions, so
// that a change to the desk's example is a failing test here rather than a surprise on a phone.
const WIRE = {
  updated_at: '2026-09-08T05:00:00Z',
  positions: [
    {
      id: 'p_1f05f8',
      symbol: 'AAAA',
      kind: 'option',
      opened_at: '2026-08-19',
      note: '',
      legs: [
        {
          right: 'call',
          side: 'long',
          strike_cents: 42000,
          expiry: '2026-11-21',
          contracts: 2,
          entry_price_cents: 1180,
        },
      ],
      strategy: 'long_call',
    },
    {
      id: 'p_3e3267',
      symbol: 'BBBB',
      kind: 'stock',
      opened_at: '2026-07-02',
      note: '',
      quantity: 40,
      entry_price_cents: 158300,
    },
  ],
}

const wireCopy = () => JSON.parse(JSON.stringify(WIRE)) as Record<string, unknown>

describe('parsePositionsDoc', () => {
  it('reads the desk’s example document into the app’s spelling', () => {
    const doc = parsePositionsDoc(WIRE)
    expect(doc).toEqual({
      updatedAt: '2026-09-08T05:00:00Z',
      positions: [
        {
          id: 'p_1f05f8',
          symbol: 'AAAA',
          kind: 'option',
          openedAt: '2026-08-19',
          note: '',
          strategy: 'long_call',
          legs: [
            {
              right: 'call',
              side: 'long',
              strikeCents: 42000,
              expiry: '2026-11-21',
              contracts: 2,
              entryPriceCents: 1180,
            },
          ],
        },
        {
          id: 'p_3e3267',
          symbol: 'BBBB',
          kind: 'stock',
          openedAt: '2026-07-02',
          note: '',
          quantity: 40,
          entryPriceCents: 158300,
        },
      ],
    })
  })

  it('reads a bare list as a book with no stamp', () => {
    // The desk's envelope nests the document under its own name, so the value handed here is
    // either `{updated_at, positions}` or the list itself. Both say the same thing.
    const doc = parsePositionsDoc(WIRE.positions)
    expect(doc?.positions).toHaveLength(2)
    expect(doc?.updatedAt).toBe('')
  })

  it('reads an empty book', () => {
    expect(parsePositionsDoc({ updated_at: '', positions: [] })).toEqual({
      updatedAt: '',
      positions: [],
    })
  })

  it('refuses the whole book over one position it cannot read', () => {
    // THE RULE THIS FILE EXISTS FOR. Dropping the row instead would draw a book missing a
    // position, and the next PUT from that screen would delete it from the desk.
    const bad = wireCopy()
    ;(bad.positions as Record<string, unknown>[])[1].quantity = '40'
    expect(parsePositionsDoc(bad)).toBeNull()
  })

  it('refuses a stock with no position in it', () => {
    const bad = wireCopy()
    ;(bad.positions as Record<string, unknown>[])[1].quantity = 0
    expect(parsePositionsDoc(bad)).toBeNull()
  })

  it('refuses an option with no legs, and one with too many', () => {
    const none = wireCopy()
    ;(none.positions as Record<string, unknown>[])[0].legs = []
    expect(parsePositionsDoc(none)).toBeNull()

    const many = wireCopy()
    const one = (WIRE.positions[0] as { legs: unknown[] }).legs[0]
    ;(many.positions as Record<string, unknown>[])[0].legs = [one, one, one, one, one]
    expect(parsePositionsDoc(many)).toBeNull()
  })

  it('refuses a leg whose expiry is not a date', () => {
    const bad = wireCopy()
    ;((bad.positions as Record<string, unknown>[])[0].legs as Record<string, unknown>[])[0].expiry =
      'November'
    expect(parsePositionsDoc(bad)).toBeNull()
  })

  it('refuses anything that is not a document at all', () => {
    expect(parsePositionsDoc(null)).toBeNull()
    expect(parsePositionsDoc('positions')).toBeNull()
    expect(parsePositionsDoc({ updated_at: '' })).toBeNull()
  })

  it('takes a strategy it has no name for as custom rather than refusing the book', () => {
    // A desk one release ahead. The label falls back to the legs, which is the honest answer —
    // hiding every position over one unrecognised word is not.
    const ahead = wireCopy()
    ;(ahead.positions as Record<string, unknown>[])[0].strategy = 'iron_condor'
    const doc = parsePositionsDoc(ahead)
    expect((doc?.positions[0] as OptionPosition).strategy).toBe('custom')
    expect(strategyLabel(doc!.positions[0], ko, { nowMs: NOW })).toBe('420 콜 롱')
  })

  it('does not upper-case a symbol on the way in', () => {
    // The desk REFUSES a lower-case symbol rather than canonicalising it, because the symbol is
    // hash material — a canonicalisation rule here would be a second implementation of a rule the
    // desk deliberately does not have, and the two would disagree about a position's identity.
    const odd = wireCopy()
    ;(odd.positions as Record<string, unknown>[])[1].symbol = 'bbbb'
    expect(parsePositionsDoc(odd)?.positions[1].symbol).toBe('bbbb')
  })
})

describe('positionsBody', () => {
  const doc = parsePositionsDoc(WIRE) as PositionsDoc

  it('sends neither a strategy nor an id — both are the desk’s to derive', () => {
    const body = positionsBody(doc)
    expect(body.positions[0]).toEqual({
      symbol: 'AAAA',
      kind: 'option',
      opened_at: '2026-08-19',
      note: '',
      legs: [
        {
          right: 'call',
          side: 'long',
          strike_cents: 42000,
          expiry: '2026-11-21',
          contracts: 2,
          entry_price_cents: 1180,
        },
      ],
    })
    // `strategy` is refused BY NAME in a body (`bad_positions`), so echoing back a read would be
    // a 400. `id` is accepted and then ignored, which is worse: a field that looks authoritative
    // and decides nothing.
    expect(JSON.stringify(body)).not.toContain('strategy')
    expect(JSON.stringify(body)).not.toContain('p_1f05f8')
  })

  it('sends a stock’s quantity and no legs, and an option’s legs and no quantity', () => {
    // The desk's two halves are exclusive both ways and it names the field it refuses.
    const body = positionsBody(doc)
    expect(body.positions[0]).not.toHaveProperty('quantity')
    expect(body.positions[0]).not.toHaveProperty('entry_price_cents')
    expect(body.positions[1]).not.toHaveProperty('legs')
    expect(body.positions[1]).toMatchObject({ quantity: 40, entry_price_cents: 158300 })
  })

  it('sends no updated_at — the desk stamps with its own clock', () => {
    expect(positionsBody(doc)).not.toHaveProperty('updated_at')
  })

  it('round-trips: what the desk answers is what this app would send back', () => {
    const again = parsePositionsDoc(positionsBody(doc))
    expect(again?.positions.map((p) => p.symbol)).toEqual(['AAAA', 'BBBB'])
  })
})

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

const BASE = 'https://desk.example.dev'
const TOKEN = 'operator-token-for-tests'

type Reply = { status?: number; text?: string } | Error

function client(replies: Reply[]) {
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
  return { calls, client: createDeskClient({ baseUrl: BASE, token: TOKEN, fetchFn: fetchImpl }) }
}

const envelope = JSON.stringify({ ok: true, positions: WIRE })

describe('deskClient.positions', () => {
  it('GETs /api/positions with the operator token as a bearer', async () => {
    const { client: c, calls } = client([{ text: envelope }])
    const doc = await c.positions()
    expect(doc.positions).toHaveLength(2)
    expect(calls[0].url).toBe('https://desk.example.dev/api/positions')
    expect(calls[0].init?.method).toBe('GET')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    )
  })

  it('reads a book the desk sent as a bare list too', async () => {
    const { client: c } = client([
      { text: JSON.stringify({ ok: true, positions: WIRE.positions }) },
    ])
    expect((await c.positions()).positions).toHaveLength(2)
  })

  it('refuses a 200 that is not this contract, rather than drawing an empty book', async () => {
    // An empty book and a book that failed to arrive look identical on screen, and a PUT from
    // that screen would make the empty one true.
    const { client: c } = client([{ text: JSON.stringify({ ok: true }) }])
    await expect(c.positions()).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('refuses a 200 carrying one unreadable position', async () => {
    const bad = wireCopy()
    ;(bad.positions as Record<string, unknown>[])[1].quantity = null
    const { client: c } = client([{ text: JSON.stringify({ ok: true, positions: bad }) }])
    await expect(c.positions()).rejects.toMatchObject({ code: 'bad_json' })
  })

  it('reads a 403 as unauthorized, naming the route in the message', async () => {
    const { client: c } = client([
      { status: 403, text: JSON.stringify({ ok: false, error: 'forbidden' }) },
    ])
    const e = await c.positions().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(DeskError)
    expect(e).toMatchObject({ code: 'unauthorized', status: 403 })
    expect((e as DeskError).message).toContain('positions')
  })

  it('surfaces the field the desk named in a bad_positions 400', async () => {
    // `_bad()` writes "<json path>: <why>", and the path is the only part of it the owner can act
    // on — it is the field they typed.
    const { client: c } = client([
      {
        status: 400,
        text: JSON.stringify({
          ok: false,
          error: 'bad_positions',
          detail: "positions.positions[0].legs[0].strike_cents: 0 is outside 1..1000000000000",
        }),
      },
    ])
    const e = await c.positions().catch((x: unknown) => x)
    expect((e as DeskError).detail).toContain('strike_cents')
    expect(e).toMatchObject({ code: 'http', status: 400, error: 'bad_positions' })
  })

  it('never puts the token in the message of anything it throws', async () => {
    const { client: c } = client([new Error(`connect to ${BASE} failed`)])
    const e = await c.positions().catch((x: unknown) => x)
    expect(String((e as Error).message)).not.toContain(TOKEN)
  })
})

describe('deskClient.putPositions', () => {
  it('PUTs a body carrying only what the desk will take', async () => {
    const { client: c, calls } = client([{ text: envelope }])
    const doc = parsePositionsDoc(WIRE) as PositionsDoc
    await c.putPositions(doc)
    expect(calls[0].init?.method).toBe('PUT')
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    )
    // Asserted as bytes, like `putSettings`: the desk refuses an unknown key whole, so what
    // matters is exactly which keys left the phone.
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['positions'])
    expect(String(calls[0].init?.body)).not.toContain('strategy')
  })

  it('answers with the book the desk put in force, not with the one it was given', async () => {
    // The desk re-derives every id and every strategy, so this answer is the only place the app
    // learns what its own write became.
    const { client: c } = client([{ text: envelope }])
    const doc = parsePositionsDoc({ updated_at: '', positions: [] }) as PositionsDoc
    expect((await c.putPositions(doc)).updatedAt).toBe('2026-09-08T05:00:00Z')
  })

  it('sends an empty book as an empty list rather than as nothing', async () => {
    // Clearing the book is a real operation — the owner closed everything — and it must not be
    // indistinguishable from a document that forgot its own field.
    const { client: c, calls } = client([{ text: envelope }])
    await c.putPositions({ updatedAt: '', positions: [] })
    expect(String(calls[0].init?.body)).toBe('{"positions":[]}')
  })
})
