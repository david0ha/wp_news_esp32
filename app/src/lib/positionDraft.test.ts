import { describe, it, expect } from '@jest/globals'
import {
  amountFault,
  commitPosition,
  confirmationLine,
  countOf,
  deskRefusal,
  dollarsToCents,
  expiryHorizon,
  fieldKey,
  isRealDate,
  legCountFor,
  maskDate,
  newDraft,
  strategyFor,
  validateDraft,
  MAX_CONTRACTS,
  SHAPES,
  type PositionDraft,
  type Shape,
} from './positionDraft'
import { createDeskClient, DeskError, type DeskClient } from './desk'
import { positionsBody, strategyLabel, type Position, type PositionsDoc } from './positions'
import { en } from '../i18n/en'
import { ko } from '../i18n/ko'

// Every date assertion is against an injected instant. The expiry horizon is three years from
// "today" and the confirmation line carries a year only when the expiry is not in this one —
// without this both would start failing on a New Year's Day for a reason unrelated to positions.
const NOW = Date.UTC(2026, 8, 8) // 2026-09-08

const stockDraft = (over: Partial<PositionDraft> = {}): PositionDraft => ({
  ...newDraft('AAAA', 'stock'),
  quantity: '200',
  price: '420.50',
  ...over,
})

const callDraft = (over: Partial<PositionDraft> = {}): PositionDraft => {
  const base = newDraft('AAAA', 'long_call')
  return {
    ...base,
    legs: [{ ...base.legs[0], expiry: '2026-11-21', strike: '420', contracts: '2', price: '11.80' }],
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Step 1: the shape decides the form
// ---------------------------------------------------------------------------

describe('the shapes', () => {
  it('opens the leg forms the chip implies, and no others', () => {
    const counts = Object.fromEntries(SHAPES.map((s) => [s, legCountFor(s)]))
    expect(counts).toEqual({
      stock: 0,
      long_call: 1,
      long_put: 1,
      short_call: 1,
      short_put: 1,
      spread: 2,
    })
    for (const shape of SHAPES) {
      expect(newDraft('AAAA', shape).legs).toHaveLength(legCountFor(shape))
    }
  })

  it('fills a single leg in from the chip that was pressed', () => {
    // The chip IS the (right, side) pair, so the leg form never asks again — a second place to
    // change one fact is a form where the chip and the leg can disagree.
    expect(newDraft('AAAA', 'short_put').legs[0]).toMatchObject({ right: 'put', side: 'short' })
    expect(newDraft('AAAA', 'long_call').legs[0]).toMatchObject({ right: 'call', side: 'long' })
  })

  it('names a single leg from the chip and leaves a spread to the desk', () => {
    expect(strategyFor('long_call')).toBe('long_call')
    expect(strategyFor('short_put')).toBe('short_put')
    // Which spread this is depends on the strikes and the expiries, which is `derive_strategy`'s
    // job on the desk. `custom` renders as the leg list until the desk answers with a name.
    expect(strategyFor('spread')).toBe('custom')
  })

  it('starts a spread as one leg bought and one sold', () => {
    const legs = newDraft('AAAA', 'spread').legs
    expect(legs.map((l) => l.side)).toEqual(['long', 'short'])
  })
})

// ---------------------------------------------------------------------------
// Step 2: dollars into cents, at the boundary
// ---------------------------------------------------------------------------

describe('dollarsToCents', () => {
  it('reads an amount as integer cents', () => {
    expect(dollarsToCents('420')).toBe(42000)
    expect(dollarsToCents('420.5')).toBe(42050)
    expect(dollarsToCents('420.55')).toBe(42055)
    expect(dollarsToCents('0')).toBe(0)
    expect(dollarsToCents('.5')).toBe(50)
    expect(dollarsToCents(' 11.80 ')).toBe(1180)
  })

  it('never lets a float carry the money', () => {
    // This is the whole reason the function exists rather than `Number(text) * 100`: an entry
    // price of $4.35 is 434.99999999999994 cents in IEEE754, and a leg priced a cent under the one
    // the owner typed is the kind of wrong that survives every test not looking for it.
    expect(Number('4.35') * 100).not.toBe(435)
    expect(Math.trunc(Number('4.35') * 100)).toBe(434)
    expect(dollarsToCents('4.35')).toBe(435)
    expect(dollarsToCents('19.99')).toBe(1999)
    expect(dollarsToCents('0.29')).toBe(29)
  })

  it('refuses what is not an amount, and says which kind of not', () => {
    expect(dollarsToCents('')).toBeNull()
    expect(dollarsToCents('abc')).toBeNull()
    expect(dollarsToCents('-5')).toBeNull()
    expect(dollarsToCents('4 2 0')).toBeNull()
    // Cents cannot carry a third decimal, and rounding one away would be the app quietly changing
    // a price somebody typed.
    expect(dollarsToCents('1.005')).toBeNull()
    expect(amountFault('')).toBe('empty')
    expect(amountFault('1.005')).toBe('precision')
    expect(amountFault('abc')).toBe('shape')
  })

  it('refuses an amount past what a JS integer can hold exactly', () => {
    expect(dollarsToCents('999999999999999')).toBeNull()
  })
})

describe('countOf', () => {
  it('takes whole numbers only', () => {
    expect(countOf('2')).toBe(2)
    expect(countOf('0')).toBe(0)
    expect(countOf('2.5')).toBeNull()
    expect(countOf('-2')).toBeNull()
    expect(countOf('')).toBeNull()
  })
})

describe('the date input', () => {
  it('lays digits into YYYY-MM-DD and drops everything else', () => {
    expect(maskDate('2026')).toBe('2026')
    expect(maskDate('202611')).toBe('2026-11')
    expect(maskDate('20261121')).toBe('2026-11-21')
    expect(maskDate('next friday')).toBe('')
    // The separators are re-inserted from the digits, so a backspace over one deletes the digit in
    // front of it rather than sticking on a dash the field itself put there.
    expect(maskDate('2026-11-2')).toBe('2026-11-2')
    expect(maskDate('2026-11-')).toBe('2026-11')
    expect(maskDate('202611211')).toBe('2026-11-21')
  })

  it('knows a day that does not exist', () => {
    expect(isRealDate('2026-11-21')).toBe(true)
    expect(isRealDate('2026-02-30')).toBe(false)
    expect(isRealDate('2026-13-01')).toBe(false)
    expect(isRealDate('2026-00-10')).toBe(false)
    expect(isRealDate('2026-11-21T00:00:00Z')).toBe(false)
  })

  it('puts the horizon three years out', () => {
    expect(expiryHorizon(NOW)).toBe('2029-09-08')
  })

  it('clamps a leap day to the 28th, the way the desk does', () => {
    // 29 February plus three whole years is not a date. `Date.UTC(y + 3, 1, 29)` rolls forward to
    // 1 March; `positions.py`'s `today.replace(...)` raises and falls back to `day=28`. The two
    // disagreed, so on one day every four years an expiry of 2031-03-01 passed validation here and
    // the confirm step and then came back 400 from the desk — a refusal the owner had been told
    // would not come. The desk's answer is the one that counts.
    const leapDay = Date.UTC(2028, 1, 29)
    expect(expiryHorizon(leapDay)).toBe('2031-02-28')
    // The 28th of a non-leap February is unremarkable and must not be clamped by accident.
    expect(expiryHorizon(Date.UTC(2027, 1, 28))).toBe('2030-02-28')
    // …and a leap day three years before another leap year is still not one: 2031 is not a leap
    // year, and neither is any year three from 2028.
    expect(expiryHorizon(Date.UTC(2024, 1, 29))).toBe('2027-02-28')
  })

  it('refuses on the far side of the leap-day horizon and accepts on the near side', () => {
    // Both sides of the exact boundary the desk enforces, through the validator the sheet calls.
    const leapDay = Date.UTC(2028, 1, 29)
    const at = (expiry: string) => {
      const base = callDraft()
      return validateDraft({ ...base, legs: [{ ...base.legs[0], expiry }] }, en, leapDay)
    }
    expect(at('2031-02-28').ok).toBe(true)
    const far = at('2031-03-01')
    expect(far.ok).toBe(false)
    expect(far.ok === false && far.errors['legs[0].expiry']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// The position that comes out
// ---------------------------------------------------------------------------

describe('validateDraft', () => {
  it('builds a stock position with the price in cents', () => {
    const out = validateDraft(stockDraft(), en, NOW)
    expect(out).toEqual({
      ok: true,
      position: {
        id: '',
        symbol: 'AAAA',
        openedAt: null,
        note: '',
        kind: 'stock',
        quantity: 200,
        entryPriceCents: 42050,
      },
    })
  })

  it('signs the quantity from the side chip', () => {
    const out = validateDraft(stockDraft({ side: 'short' }), en, NOW)
    expect(out.ok && out.position.kind === 'stock' && out.position.quantity).toBe(-200)
  })

  it('refuses a quantity of zero in the desk’s own words', () => {
    const out = validateDraft(stockDraft({ quantity: '0' }), en, NOW)
    expect(out.ok).toBe(false)
    expect(!out.ok && out.errors.quantity).toBe(en.positionSheet.errors.quantityZero)
  })

  it('builds an option position with a price on the leg', () => {
    const out = validateDraft(callDraft(), en, NOW)
    expect(out).toEqual({
      ok: true,
      position: {
        id: '',
        symbol: 'AAAA',
        openedAt: null,
        note: '',
        kind: 'option',
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
    })
  })

  it('sends the price on each leg and never on the position', () => {
    // `_leg` requires `entry_price_cents` per leg and `_position` refuses one beside `legs`,
    // naming the field. A form that collected one price per option position would be a 400.
    const out = validateDraft(callDraft(), en, NOW)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const body = positionsBody({ updatedAt: '', positions: [out.position] })
    const one = body.positions[0] as Record<string, unknown>
    expect(one.entry_price_cents).toBeUndefined()
    expect(one.quantity).toBeUndefined()
    expect((one.legs as Record<string, unknown>[])[0].entry_price_cents).toBe(1180)
    // Derived on the desk from the legs, and refused as a claim about them if sent.
    expect(one.strategy).toBeUndefined()
    expect(one.id).toBeUndefined()
  })

  it('holds the strike to the bound the desk holds it to', () => {
    const zero = validateDraft(
      { ...callDraft(), legs: [{ ...callDraft().legs[0], strike: '0' }] },
      en,
      NOW,
    )
    expect(!zero.ok && zero.errors[fieldKey(0, 'strike')]).toBe(en.positionSheet.errors.strikeRange)
    const huge = validateDraft(
      { ...callDraft(), legs: [{ ...callDraft().legs[0], strike: '99999999999' }] },
      en,
      NOW,
    )
    expect(!huge.ok && huge.errors[fieldKey(0, 'strike')]).toBe(en.positionSheet.errors.tooLarge)
  })

  it('takes an entry price of zero, which the desk does too', () => {
    const out = validateDraft(
      { ...callDraft(), legs: [{ ...callDraft().legs[0], price: '0' }] },
      en,
      NOW,
    )
    expect(out.ok).toBe(true)
  })

  it('refuses an expiry that is not a day, and one past the horizon', () => {
    const unreal = validateDraft(
      { ...callDraft(), legs: [{ ...callDraft().legs[0], expiry: '2026-02-30' }] },
      en,
      NOW,
    )
    expect(!unreal.ok && unreal.errors[fieldKey(0, 'expiry')]).toBe(
      en.positionSheet.errors.dateReal,
    )
    const far = validateDraft(
      { ...callDraft(), legs: [{ ...callDraft().legs[0], expiry: '2030-01-18' }] },
      en,
      NOW,
    )
    expect(!far.ok && far.errors[fieldKey(0, 'expiry')]).toContain('3')
    // Bounded above and NOT below: recording a position that has already expired is an ordinary
    // thing to do, and the desk deliberately declines to bound it either.
    const past = validateDraft(
      { ...callDraft(), legs: [{ ...callDraft().legs[0], expiry: '2019-01-18' }] },
      en,
      NOW,
    )
    expect(past.ok).toBe(true)
  })

  it('bounds the contracts', () => {
    const many = validateDraft(
      { ...callDraft(), legs: [{ ...callDraft().legs[0], contracts: String(MAX_CONTRACTS + 1) }] },
      en,
      NOW,
    )
    expect(!many.ok && many.errors[fieldKey(0, 'contracts')]).toContain('10,000')
    const none = validateDraft(
      { ...callDraft(), legs: [{ ...callDraft().legs[0], contracts: '0' }] },
      en,
      NOW,
    )
    expect(none.ok).toBe(false)
  })

  it('reports every bad field at once, per leg', () => {
    const base = newDraft('AAAA', 'spread')
    const out = validateDraft(base, en, NOW)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(Object.keys(out.errors).sort()).toEqual([
      'legs[0].contracts',
      'legs[0].expiry',
      'legs[0].price',
      'legs[0].strike',
      'legs[1].contracts',
      'legs[1].expiry',
      'legs[1].price',
      'legs[1].strike',
    ])
  })

  it('refuses a symbol that is not already upper-case, rather than upper-casing it', () => {
    // The desk requires it to be upper-case already, precisely so that no two implementations can
    // disagree about a position's identity. Canonicalising here would reintroduce that rule.
    const out = validateDraft(stockDraft({ symbol: 'aaaa' }), en, NOW)
    expect(!out.ok && out.errors.symbol).toBe(en.positionSheet.errors.symbol)
    expect(validateDraft(stockDraft({ symbol: '005930.KS' }), en, NOW).ok).toBe(true)
  })

  it('answers in the language it is handed', () => {
    const out = validateDraft(stockDraft({ quantity: '' }), ko, NOW)
    expect(!out.ok && out.errors.quantity).toBe(ko.positionSheet.errors.required)
  })
})

// ---------------------------------------------------------------------------
// Step 3: the app says the name back
// ---------------------------------------------------------------------------

describe('confirmationLine', () => {
  const built = (draft: PositionDraft): Position => {
    const out = validateDraft(draft, en, NOW)
    if (!out.ok) throw new Error('the draft under test does not validate')
    return out.position
  }

  it('is the symbol, the label, and how many', () => {
    const p = built(callDraft())
    expect(confirmationLine(p, ko, { nowMs: NOW })).toBe('AAAA 11월 21일 만기 420 콜 2계약')
    expect(confirmationLine(p, en, { nowMs: NOW })).toBe('AAAA Nov 21 420 Call 2 contracts')
  })

  it('takes its name from strategyLabel and adds nothing of its own', () => {
    const p = built(callDraft())
    for (const table of [en, ko]) {
      expect(confirmationLine(p, table, { nowMs: NOW })).toContain(
        strategyLabel(p, table, { nowMs: NOW }),
      )
    }
  })

  it('says one contract in the singular', () => {
    const one = built({ ...callDraft(), legs: [{ ...callDraft().legs[0], contracts: '1' }] })
    expect(confirmationLine(one, en, { nowMs: NOW })).toBe('AAAA Nov 21 420 Call 1 contract')
    expect(confirmationLine(one, ko, { nowMs: NOW })).toBe('AAAA 11월 21일 만기 420 콜 1계약')
  })

  it('carries the count for a stock in the label itself', () => {
    expect(confirmationLine(built(stockDraft()), en, { nowMs: NOW })).toBe('AAAA 200 shares')
    expect(confirmationLine(built(stockDraft({ side: 'short' })), ko, { nowMs: NOW })).toBe(
      'AAAA 200주 공매도',
    )
  })

  it('prints a spread as its legs, because the desk has not named it yet', () => {
    const spread = newDraft('AAAA', 'spread')
    const p = built({
      ...spread,
      legs: [
        { ...spread.legs[0], expiry: '2026-11-21', strike: '400', contracts: '2', price: '20' },
        { ...spread.legs[1], expiry: '2026-11-21', strike: '420', contracts: '2', price: '9' },
      ],
    })
    // Not "Call Vertical 400/420": that name is `derive_strategy`'s and arrives with the desk's
    // answer. Both strikes are on screen either way, which is what the step is for.
    expect(confirmationLine(p, en, { nowMs: NOW })).toBe(
      'AAAA Long 400 Call · Short 420 Call 2 contracts',
    )
  })

  it('leaves the count off when the legs do not share one', () => {
    const spread = newDraft('AAAA', 'spread')
    const p = built({
      ...spread,
      legs: [
        { ...spread.legs[0], expiry: '2026-11-21', strike: '400', contracts: '2', price: '20' },
        { ...spread.legs[1], expiry: '2026-11-21', strike: '420', contracts: '3', price: '9' },
      ],
    })
    expect(confirmationLine(p, en, { nowMs: NOW })).toBe('AAAA Long 400 Call · Short 420 Call')
  })
})

// ---------------------------------------------------------------------------
// Step 4: the write, and what a refusal says
// ---------------------------------------------------------------------------

const book = (positions: Position[]): PositionsDoc => ({ updatedAt: '2026-09-08T01:02:03Z', positions })

const held: Position = {
  id: 'p_aaaaaa',
  symbol: 'BBBB',
  openedAt: null,
  note: '',
  kind: 'stock',
  quantity: 10,
  entryPriceCents: 100,
}

function fakeDesk(over: Partial<DeskClient> = {}): DeskClient {
  return {
    getSettings: async () => ({ lang: 'en' }),
    putSettings: async () => ({ lang: 'en' }),
    positions: async () => book([held]),
    putPositions: async (doc) => doc,
    // Nothing in this file reads the event book or the registered phones; they are here because
    // `DeskClient` is one interface and a fake that implemented half of it would stop compiling
    // every time the desk grew a route.
    calendar: async () => null,
    pushDevices: async () => ({ devices: [] }),
    registerPushDevice: async () => ({ devices: [] }),
    forgetPushDevice: async () => undefined,
    ...over,
  }
}

describe('commitPosition', () => {
  it('appends to the book the desk holds rather than replacing it', async () => {
    // A PUT is the whole book. A sheet that sent only what it had just built would delete every
    // other position, silently, from the one document in this system that records real money.
    const sent: PositionsDoc[] = []
    const out = await validateDraft(callDraft(), en, NOW)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const result = await commitPosition(
      fakeDesk({
        putPositions: async (doc) => {
          sent.push(doc)
          return doc
        },
      }),
      out.position,
    )
    expect(result.ok).toBe(true)
    expect(sent[0].positions.map((p) => p.symbol)).toEqual(['BBBB', 'AAAA'])
  })

  it('surfaces a desk 400 under the field the desk named', async () => {
    const refusal = new DeskError(
      'http',
      'positions responded 400',
      400,
      'bad_positions',
      'positions.positions[1].legs[0].strike_cents: 0 is outside 1..1000000000000',
    )
    const out = validateDraft(callDraft(), en, NOW)
    if (!out.ok) throw new Error('unreachable')
    const result = await commitPosition(
      fakeDesk({
        putPositions: async () => {
          throw refusal
        },
      }),
      out.position,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.fieldKey).toBe('legs[0].strike')
    expect(result.refusal.reason).toBe('0 is outside 1..1000000000000')
    // And the banner quotes the desk, so nobody has to read a server log to find out what it meant.
    expect(result.refusal.message).toContain('0 is outside 1..1000000000000')
  })
})

describe('deskRefusal', () => {
  const refusal = (detail: string) =>
    new DeskError('http', 'positions responded 400', 400, 'bad_positions', detail)

  it('maps every wire field back to the box it was typed in', () => {
    expect(deskRefusal(refusal('positions.positions[0].quantity: zero'), 0).fieldKey).toBe(
      'quantity',
    )
    expect(
      deskRefusal(refusal('positions.positions[0].entry_price_cents: no'), 0).fieldKey,
    ).toBe('price')
    expect(deskRefusal(refusal('positions.positions[0].legs[1].expiry: no'), 0).fieldKey).toBe(
      'legs[1].expiry',
    )
    expect(deskRefusal(refusal('positions.positions[0].legs[1].contracts: no'), 0).fieldKey).toBe(
      'legs[1].contracts',
    )
    expect(deskRefusal(refusal('positions.positions[0].symbol: no'), 0).fieldKey).toBe('symbol')
  })

  it('pins nothing to a field when the desk refused somebody else’s row', () => {
    // The PUT carries the whole book, so index 3 may be a position entered last month. Its message
    // is still shown; putting it under a box this owner just typed into would be a lie about it.
    const r = deskRefusal(refusal('positions.positions[3].legs[0].strike_cents: bad'), 0)
    expect(r.fieldKey).toBeNull()
    expect(r.reason).toBeNull()
    expect(r.message).toContain('bad')
  })

  it('pins nothing for a refusal about the document as a whole', () => {
    const r = deskRefusal(refusal('positions: 131072 bytes serialised, at most 131072'), 0)
    expect(r.fieldKey).toBeNull()
    expect(r.message).toContain('bytes serialised')
  })

  it('still has a sentence when the desk sent no detail at all', () => {
    const r = deskRefusal(new DeskError('transport', 'network error'), 0)
    expect(r.fieldKey).toBeNull()
    expect(r.message).toBe(en.errors.desk.transport)
  })
})

describe('the operator token', () => {
  it('is in nothing this sheet can draw', async () => {
    // The token reaches one header inside `createDeskClient` and is never an argument to anything
    // here. This drives a real client into a real refusal and reads back everything the sheet has
    // to render from it.
    const TOKEN = 'op_secret_do_not_render'
    const fetchFn = (async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
      return {
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            ok: false,
            error: 'bad_positions',
            detail: 'positions.positions[0].symbol: bad',
          }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const client = createDeskClient({ baseUrl: 'https://desk.example', token: TOKEN, fetchFn })
    const out = validateDraft(stockDraft(), en, NOW)
    if (!out.ok) throw new Error('unreachable')
    const result = await commitPosition(client, out.position)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(result.refusal.message).not.toContain(TOKEN)
    expect(result.refusal.reason ?? '').not.toContain(TOKEN)
  })
})

// ---------------------------------------------------------------------------
// The catalogue this sheet draws from
// ---------------------------------------------------------------------------

describe('the sheet’s copy', () => {
  it('names every shape in both languages', () => {
    const labels: Record<Shape, [string, string]> = {
      stock: [en.positionSheet.shape.stock, ko.positionSheet.shape.stock],
      long_call: [en.positionSheet.shape.longCall, ko.positionSheet.shape.longCall],
      long_put: [en.positionSheet.shape.longPut, ko.positionSheet.shape.longPut],
      short_call: [en.positionSheet.shape.shortCall, ko.positionSheet.shape.shortCall],
      short_put: [en.positionSheet.shape.shortPut, ko.positionSheet.shape.shortPut],
      spread: [en.positionSheet.shape.spread, ko.positionSheet.shape.spread],
    }
    // Spec §8's own six chips, in its own words.
    expect(SHAPES.map((s) => labels[s][1])).toEqual([
      '주식',
      '롱 콜',
      '롱 풋',
      '숏 콜',
      '숏 풋',
      '스프레드',
    ])
    for (const shape of SHAPES) expect(labels[shape][0]).not.toBe(labels[shape][1])
  })
})
