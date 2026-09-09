// The position sheet's brain: what the owner typed, on its way to a position the desk will take.
//
// `components/PositionSheet.tsx` is chips, fields and a Save button; every decision it makes is
// here. That split is this app's own convention rather than taste — there is no screen-test
// library in `package.json`, so anything argued inside a `.tsx` is argued only in prose, which is
// the reason `newsurlsync.ts`'s `decideNewsUrlSave` and `desk.ts`'s `deskLanguageView` are
// functions rather than conditions inside a component.
//
// THE MONEY BOUNDARY IS `dollarsToCents`, and it is the whole point of this file existing.
// "420.55" becomes 42055 by integer arithmetic over the two halves of the string, never
// `Math.round(Number(text) * 100)` — that expression is 42054.999999999996 before the rounding,
// and a strike a cent under the one the owner typed is the kind of wrong that survives every test
// that is not looking for it. Global Constraint 2 says money is integer cents on the wire; this
// function is where the rule is actually kept, and it is called from exactly one place.
//
// THE BOUNDS MIRROR `server/claudepost/positions.py`, deliberately and with the same numbers. Not
// because the desk cannot be trusted to refuse — it refuses first and it is authoritative — but
// because a refusal that arrives after a round trip lands on a sheet the owner has already left,
// and the message it carries is a JSON path. A bound checked here says "a strike is more than
// zero" under the strike field, in the owner's own language, before anything is sent. The desk's
// refusal still renders (`deskRefusal`), because the two can disagree and the desk wins.

import { fill, type Strings } from '../i18n'
import { DeskError, humanDeskError, type DeskClient } from './desk'
import { formatCount } from './format'
import {
  strategyLabel,
  type OptionLeg,
  type OptionRight,
  type OptionSide,
  type Position,
  type PositionsDoc,
  type Strategy,
} from './positions'

// ---------------------------------------------------------------------------
// The desk's numbers, as this form knows them
// ---------------------------------------------------------------------------

/** `positions.py`'s `MAX_CENTS`: ten billion dollars, in cents. */
export const MAX_CENTS = 1_000_000_000_000

/** `positions.py`'s `MAX_CONTRACTS`. */
export const MAX_CONTRACTS = 10_000

/** `positions.py`'s `MAX_QUANTITY`, signed: a negative quantity is a short. */
export const MAX_QUANTITY = 1_000_000

/**
 * `positions.py`'s `MAX_EXPIRY_YEARS`.
 *
 * Bounded above and **not** below, which is the care in the desk's rule and is copied here rather
 * than improved on: an upper bound moves outward as today does, so a document accepted today is
 * still accepted next year, while a lower bound would make `load` start refusing a file the day an
 * option in it expired. A form that refused an expiry in the past would also be refusing the
 * ordinary act of recording a position that has already been closed out.
 */
export const MAX_EXPIRY_YEARS = 3

/** `positions.py`'s `SYMBOL_RE`. Digits are deliberate — a KR symbol is numeric (`005930`). */
export const SYMBOL_RE = /^[A-Z0-9.\-]{1,12}$/

// ---------------------------------------------------------------------------
// The shapes, and what each one implies
// ---------------------------------------------------------------------------

/**
 * The six chips, in the order spec §8 draws them.
 *
 * They are **shapes**, not strategies. `spread` is not one of the desk's nine names and cannot be:
 * which spread it turns out to be — vertical, calendar, straddle, strangle — is decided by the
 * legs, by `derive_strategy`, on the desk. See `strategyFor`.
 */
export const SHAPES = [
  'stock',
  'long_call',
  'long_put',
  'short_call',
  'short_put',
  'spread',
] as const

export type Shape = (typeof SHAPES)[number]

/** How many leg forms this shape opens. A stock has none; a spread has two. */
export function legCountFor(shape: Shape): number {
  if (shape === 'stock') return 0
  return shape === 'spread' ? 2 : 1
}

/** The contract a single-leg chip names. `null` where the chip does not name one. */
function contractFor(shape: Shape): { right: OptionRight; side: OptionSide } | null {
  switch (shape) {
    case 'long_call':
      return { right: 'call', side: 'long' }
    case 'long_put':
      return { right: 'put', side: 'long' }
    case 'short_call':
      return { right: 'call', side: 'short' }
    case 'short_put':
      return { right: 'put', side: 'short' }
    default:
      return null
  }
}

/**
 * What to call this shape *before the desk has seen it*, and the one place in the app that names
 * a strategy at all.
 *
 * This is not a second `derive_strategy`, and the difference is worth stating because
 * `positions.ts` forbids exactly that. `derive_strategy` reads **legs** and works out a name; this
 * reads the **chip the owner pressed**, which for the four single-leg shapes *is* the (right,
 * side) pair and nothing else — the leg's right and side are filled in from it, so there is one
 * source and no second thing that can disagree. The desk re-derives on every write regardless, so
 * this value never survives a save: it exists for the length of the confirmation step.
 *
 * A spread is `custom` on purpose. Which spread it is depends on the two legs' strikes and
 * expiries, which is a derivation, which is the desk's. `strategyLabel` renders `custom` as its
 * leg list — the honest answer, and the one that catches a mistyped strike better than a name
 * would, since the strikes are what it prints.
 */
export function strategyFor(shape: Shape): Strategy {
  const contract = contractFor(shape)
  if (contract === null) return 'custom'
  return `${contract.side}_${contract.right}` as Strategy
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/** One leg, as text fields hold it. Every money field is dollars here and cents nowhere else. */
export interface LegDraft {
  right: OptionRight
  side: OptionSide
  /** `YYYY-MM-DD`, laid out by `maskDate` as the digits arrive. */
  expiry: string
  strike: string
  contracts: string
  price: string
}

export interface PositionDraft {
  symbol: string
  shape: Shape
  /**
   * Long or short, for a **stock**. The desk's `quantity` is signed and a number pad has no minus
   * key, so the sign is a two-chip choice inside the form rather than a character the owner has to
   * find. Options carry their side on each leg.
   */
  side: OptionSide
  quantity: string
  price: string
  legs: LegDraft[]
}

function newLeg(shape: Shape, index: number): LegDraft {
  // A spread's first leg is the one that was bought, which is what somebody describing a vertical
  // says first. Both are editable; this is only where the chips start.
  const contract = contractFor(shape) ?? {
    right: 'call' as OptionRight,
    side: (index === 0 ? 'long' : 'short') as OptionSide,
  }
  return { ...contract, expiry: '', strike: '', contracts: '', price: '' }
}

/** An empty draft for a symbol and a shape. Called again on every chip press. */
export function newDraft(symbol: string, shape: Shape): PositionDraft {
  return {
    symbol,
    shape,
    side: 'long',
    quantity: '',
    price: '',
    legs: Array.from({ length: legCountFor(shape) }, (_, i) => newLeg(shape, i)),
  }
}

// ---------------------------------------------------------------------------
// Text into numbers
// ---------------------------------------------------------------------------

/** A whole-dollar amount with at most two decimals. `.5` is allowed; `5.` is still being typed. */
const AMOUNT_RE = /^(\d*)(?:\.(\d{1,2}))?$/

/**
 * Dollars as typed → integer cents, or `null` for anything that is not an amount.
 *
 * `null` covers three different mistakes and the caller separates them (`amountFault`): an empty
 * field, three decimal places — which cents cannot carry, so rounding it silently would be the app
 * quietly changing a price the owner typed — and everything else.
 */
export function dollarsToCents(text: string): number | null {
  const m = AMOUNT_RE.exec(text.trim())
  if (m === null) return null
  if (m[1] === '' && m[2] === undefined) return null
  const whole = m[1] === '' ? 0 : Number(m[1])
  const cents = whole * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}

export type AmountFault = 'empty' | 'precision' | 'shape'

/** Why `dollarsToCents` said no, so the field can say which. */
export function amountFault(text: string): AmountFault {
  const trimmed = text.trim()
  if (trimmed === '') return 'empty'
  if (/^\d*\.\d{3,}$/.test(trimmed)) return 'precision'
  return 'shape'
}

/** A count as typed → a non-negative integer, or `null`. No sign, no decimal point. */
export function countOf(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,9}$/.test(trimmed)) return null
  return Number(trimmed)
}

// ---------------------------------------------------------------------------
// The date
// ---------------------------------------------------------------------------

/**
 * Digits laid into `YYYY-MM-DD` as they are typed — the date *input*, rather than a free-text
 * field somebody can put "next friday" into.
 *
 * Every non-digit is dropped, including the separators this function itself inserts, so a
 * backspace over a `-` deletes the digit in front of it and the field never sticks.
 */
export function maskDate(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 8)
  if (digits.length <= 4) return digits
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * A `YYYY-MM-DD` that is also a real day — `positions.py`'s `_date`, whose docstring names the
 * value this catches: `2026-02-30` passes the pattern and survives every later check until
 * something works out how many days are left until it.
 */
export function isRealDate(iso: string): boolean {
  const m = DATE_RE.exec(iso)
  if (m === null) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

function isoUTC(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`
}

/**
 * The furthest expiry the desk will take, as `YYYY-MM-DD`.
 *
 * ISO dates compare correctly as strings, which is why nothing here parses the owner's expiry into
 * a `Date` to compare it.
 *
 * 29 FEBRUARY IS THE WHOLE REASON THIS IS NOT ONE LINE, and the bug it caused is the kind only a
 * duplicated constant produces. The same day three years on does not exist, and the two sides
 * disagreed about what to do instead: `Date.UTC(y + 3, 1, 29)` rolls over to 1 March, while
 * `positions.py`'s `today.replace(...)` raises and falls back to `day=28`. So on one day every
 * four years the phone accepted an expiry of 2031-03-01 through `validateDraft` AND through the
 * confirm step, and the desk answered 400 — a refusal the owner had already been told would not
 * come. The desk's answer is the one that counts, because the desk is the one that refuses; 28
 * February is the conventional clamp and the horizon is a bound, not a date anybody reads.
 *
 * The overflow test is general rather than a check for February: `Date.UTC` rolls the month
 * forward only when the day-of-month does not exist in the target month, and 29 February is the
 * only way three whole years can produce that.
 */
export function expiryHorizon(todayMs: number): string {
  const d = new Date(todayMs)
  const year = d.getUTCFullYear() + MAX_EXPIRY_YEARS
  const month = d.getUTCMonth()
  const rolled = new Date(Date.UTC(year, month, d.getUTCDate()))
  if (rolled.getUTCMonth() !== month) return isoUTC(Date.UTC(year, month, 28))
  return isoUTC(rolled.getTime())
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type DraftField = 'symbol' | 'quantity' | 'price' | 'expiry' | 'strike' | 'contracts'

/**
 * Where a message goes: a field name, or `legs[1].strike` for a field inside a leg form.
 *
 * One spelling for the errors this file raises and for the ones `deskRefusal` reads back out of a
 * JSON path, so the sheet has one map to look a message up in.
 */
export function fieldKey(leg: number | null, field: DraftField): string {
  return leg === null ? field : `legs[${leg}].${field}`
}

export type DraftErrors = Record<string, string>

export type DraftResult =
  | { ok: true; position: Position }
  | { ok: false; errors: DraftErrors }

/**
 * Every field at once, and the position when they all pass.
 *
 * All of them, not the first failure: a form that reports one problem per attempt makes somebody
 * press Continue four times to learn four things, and each press is a round of reading a form they
 * have already read.
 *
 * `todayMs` is injected for the reason `parse_positions` takes a `today` — the expiry horizon is
 * three years from now, and a test that read the clock would be a test that changes meaning on a
 * Wednesday in 2029.
 */
export function validateDraft(
  draft: PositionDraft,
  t: Strings,
  todayMs: number,
): DraftResult {
  const m = t.positionSheet.errors
  const errors: DraftErrors = {}
  const fail = (leg: number | null, field: DraftField, why: string) => {
    errors[fieldKey(leg, field)] = why
  }

  // The symbol is checked and never canonicalised. `positions.py`'s `_symbol` refuses rather than
  // upper-casing, precisely so that no two implementations can disagree about a position's
  // identity — and a `.toUpperCase()` here would be this app quietly reintroducing the rule the
  // desk deleted. It arrives from a search result, so this fires only on a listing whose symbol is
  // not a ticker shape, which is a thing to say rather than a thing to fix silently.
  const symbol = draft.symbol.trim()
  if (!SYMBOL_RE.test(symbol)) fail(null, 'symbol', m.symbol)

  const cents = (text: string, leg: number | null, field: DraftField, low: number): number | null => {
    const value = dollarsToCents(text)
    if (value === null) {
      const fault = amountFault(text)
      fail(leg, field, fault === 'empty' ? m.required : fault === 'precision' ? m.precision : m.notAmount)
      return null
    }
    if (value < low) {
      fail(leg, field, m.strikeRange)
      return null
    }
    if (value > MAX_CENTS) {
      fail(leg, field, m.tooLarge)
      return null
    }
    return value
  }

  if (draft.shape === 'stock') {
    const quantity = countOf(draft.quantity)
    const price = cents(draft.price, null, 'price', 0)
    if (quantity === null) {
      fail(null, 'quantity', draft.quantity.trim() === '' ? m.required : m.notCount)
    } else if (quantity === 0) {
      // The desk's own sentence, in the owner's language: zero is not a small position.
      fail(null, 'quantity', m.quantityZero)
    } else if (quantity > MAX_QUANTITY) {
      fail(null, 'quantity', fill(m.quantityRange, { max: formatCount(MAX_QUANTITY) }))
    }
    if (Object.keys(errors).length > 0 || quantity === null || price === null) {
      return { ok: false, errors }
    }
    return {
      ok: true,
      position: {
        id: '',
        symbol,
        // Not recorded, and not guessed at either: `opened_at` is hash material, and today is the
        // day this was *typed*, which is only sometimes the day it was bought. `null` is the
        // document's own word for "never recorded".
        openedAt: null,
        note: '',
        kind: 'stock',
        quantity: draft.side === 'short' ? -quantity : quantity,
        entryPriceCents: price,
      },
    }
  }

  const horizon = expiryHorizon(todayMs)
  const legs: OptionLeg[] = []
  draft.legs.forEach((leg, i) => {
    const expiry = leg.expiry.trim()
    let expiryOk = true
    if (expiry === '') {
      fail(i, 'expiry', m.required)
      expiryOk = false
    } else if (!DATE_RE.test(expiry)) {
      fail(i, 'expiry', m.dateShape)
      expiryOk = false
    } else if (!isRealDate(expiry)) {
      fail(i, 'expiry', m.dateReal)
      expiryOk = false
    } else if (expiry > horizon) {
      fail(i, 'expiry', fill(m.expiryFar, { years: String(MAX_EXPIRY_YEARS) }))
      expiryOk = false
    }

    // A strike of zero is refused by the desk (`1..MAX_CENTS`); an entry price of zero is not, and
    // is a real thing to record — a leg assigned at no cost, or one whose price the owner does not
    // have to hand.
    const strike = cents(leg.strike, i, 'strike', 1)
    const price = cents(leg.price, i, 'price', 0)

    const contracts = countOf(leg.contracts)
    let contractsOk = true
    if (contracts === null) {
      fail(i, 'contracts', leg.contracts.trim() === '' ? m.required : m.notCount)
      contractsOk = false
    } else if (contracts < 1 || contracts > MAX_CONTRACTS) {
      fail(i, 'contracts', fill(m.contractsRange, { max: formatCount(MAX_CONTRACTS) }))
      contractsOk = false
    }

    if (expiryOk && strike !== null && price !== null && contractsOk && contracts !== null) {
      legs.push({
        right: leg.right,
        side: leg.side,
        strikeCents: strike,
        expiry,
        contracts,
        entryPriceCents: price,
      })
    }
  })

  if (Object.keys(errors).length > 0 || legs.length !== draft.legs.length) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    position: {
      id: '',
      symbol,
      openedAt: null,
      note: '',
      kind: 'option',
      legs,
      strategy: strategyFor(draft.shape),
    },
  }
}

// ---------------------------------------------------------------------------
// Saying it back
// ---------------------------------------------------------------------------

/** The size on the name line, when every leg carries the same one. Empty when they differ. */
function contractsText(legs: OptionLeg[], t: Strings): string {
  const n = legs[0]?.contracts
  if (n === undefined || legs.some((leg) => leg.contracts !== n)) return ''
  const s = t.positionSheet
  return fill(n === 1 ? s.contract : s.contracts, { n: formatCount(n) })
}

/**
 * The confirmation line — "AAAA Nov 21 420 Call 2 contracts", "AAAA 11월 21일 만기 420 콜 2계약".
 *
 * The step spec §8 puts between typing and saving, and the reason it is a step rather than a toast:
 * it is where a strike typed as 42 instead of 420 is caught, by somebody reading a sentence rather
 * than re-reading their own form. The name itself is `strategyLabel`'s — this adds only the two
 * things a label about a *shape* has no business carrying: which company, and how many.
 *
 * The joining space is punctuation rather than copy, like `positions.ts`'s ` · `. Spec §8's own
 * Korean example puts the ticker first and the size last exactly as the English one does, so there
 * is no word order here for a catalogue template to arrange — and a template that was nothing but
 * placeholders would be the same string in both tables, which `i18n/index.test.ts` refuses.
 */
export function confirmationLine(
  p: Position,
  t: Strings,
  ctx: { nowMs?: number; stockShares?: number } = {},
): string {
  // A stock's own count is already in `strategyLabel`'s answer ("200 shares"), so only an option
  // needs the size added.
  const size = p.kind === 'stock' ? '' : contractsText(p.legs, t)
  return [p.symbol, strategyLabel(p, t, ctx), size].filter((part) => part !== '').join(' ')
}

// ---------------------------------------------------------------------------
// The write, and the refusal
// ---------------------------------------------------------------------------

/** A field name on the wire, and the form field that holds it. */
const WIRE_FIELDS: Record<string, DraftField> = {
  symbol: 'symbol',
  quantity: 'quantity',
  entry_price_cents: 'price',
  strike_cents: 'strike',
  expiry: 'expiry',
  contracts: 'contracts',
}

const REFUSAL_PATH = /^positions\.positions\[(\d+)\](?:\.legs\[(\d+)\])?\.(\w+)/

export interface DeskRefusal {
  /** The sentence for the banner, from the catalogue — never the token, never a stack. */
  message: string
  /** The field the desk named, when it named one of this sheet's own. */
  fieldKey: string | null
  /** The desk's reason with its JSON path taken off, to draw under that field. */
  reason: string | null
}

/**
 * A failed write, as the sheet draws it.
 *
 * `positions.py`'s `_bad` writes `"<json path>: <why>"` and its docstring says who the readers
 * are: "the phone's position sheet -- which renders it under the field the owner typed". This is
 * that rendering. The path is `positions.positions[3].legs[1].strike_cents`, so it carries which
 * position and which leg, and both matter — the sheet PUTs the **whole book**, so index 3 may be a
 * row somebody entered last month. A refusal about a different row is shown as a sentence and
 * pinned to no field, because pinning it would put a stranger's message under a box this owner
 * just typed into.
 *
 * `ours` is the index the new position was appended at.
 */
export function deskRefusal(e: unknown, ours: number): DeskRefusal {
  const message = humanDeskError(e)
  const detail = e instanceof DeskError ? e.detail : undefined
  if (detail === undefined) return { message, fieldKey: null, reason: null }

  const m = REFUSAL_PATH.exec(detail)
  const reason = detail.includes(': ') ? detail.slice(detail.indexOf(': ') + 2) : detail
  if (m === null || Number(m[1]) !== ours) return { message, fieldKey: null, reason: null }

  const field = WIRE_FIELDS[m[3]]
  if (field === undefined) return { message, fieldKey: null, reason: null }
  return { message, fieldKey: fieldKey(m[2] === undefined ? null : Number(m[2]), field), reason }
}

export type CommitResult =
  | { ok: true; doc: PositionsDoc }
  | { ok: false; refusal: DeskRefusal }

/**
 * Add one position to the book the desk holds.
 *
 * **Read, append, write the whole thing.** There is no partial write on `/api/positions` — a PUT
 * is the book — so a sheet that sent only the position it had just built would delete every other
 * one, silently, from the one document in this system that records real money. The GET is not a
 * courtesy; it is what makes the PUT safe.
 *
 * The client is passed in rather than built here, and that is the token rule made structural: this
 * function never sees a credential, so no sentence it returns can carry one.
 */
export async function commitPosition(
  client: DeskClient,
  position: Position,
): Promise<CommitResult> {
  // Where our row will land, and what a refusal's JSON path is compared against. Set before the
  // PUT so the `catch` can use it whichever call threw — a GET that fails leaves it at 0, which
  // names no row of ours, which is exactly right: nothing had been sent yet.
  let ours = 0
  try {
    const book = await client.positions()
    ours = book.positions.length
    return {
      ok: true,
      doc: await client.putPositions({
        ...book,
        positions: [...book.positions, position],
      }),
    }
  } catch (e) {
    return { ok: false, refusal: deskRefusal(e, ours) }
  }
}
