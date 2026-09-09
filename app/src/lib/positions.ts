// What the owner holds, as the phone reads and writes it.
//
// The desk's `server/claudepost/positions.py` is the contract and this file is its mirror: the
// same document, the same exclusive halves (a stock has a quantity, an option has legs, and
// neither has the other's field), the same nine strategy names. Read that module's docstring
// before changing anything here — several of the rules below are only sensible in the light of
// the reasons it gives.
//
// THE ONE DIVISION WORTH STATING: **the desk owns the enum, this file owns the words.**
// `derive_strategy` in Python turns legs into a name; nothing in TypeScript re-derives it,
// because a second derivation is a second thing that can disagree with the agent about what a
// spread is called, and the owner would have no way to tell which of the two was wrong.
// `strategyLabel` reads `position.strategy` off the wire and spends its effort on rendering it.
//
// The exception, and it is the interesting one: **`covered_call` is named here and nowhere
// else.** `derive_strategy` is handed legs, and a short call is only covered by the shares
// sitting in a different position — a fact it cannot see. That pairing is a decision made with
// the whole book in hand, which is to say at display time, which is to say here. The same
// argument is why `cash_secured_put` is named nowhere at all: collateral is a fact about an
// account neither end can see, so a lone short put stays a short put.
//
// Reading is STRICT, unlike `edition/parse.ts` which clamps everything it is given. The reason is
// the write half: this app reads the book, lets the owner edit one row, and PUTs the whole thing
// back. A lenient parser that dropped a position it did not understand would make the next PUT
// *delete* it — silently, and from the one document in this system that records real money. A
// desk answering something this app cannot read is a refusal to show the book, never a shorter
// book.

import { fill, type Strings } from '../i18n'
import { formatCents, formatCount } from './format'

/** Every name `derive_strategy` can return, and nothing else. `covered_call` is deliberately
 *  absent — see the module docstring, and `positions.py`'s `derive_strategy`. */
export const STRATEGIES = [
  'long_call',
  'long_put',
  'short_call',
  'short_put',
  'vertical',
  'calendar',
  'straddle',
  'strangle',
  'custom',
] as const

export type Strategy = (typeof STRATEGIES)[number]

export type PositionKind = 'stock' | 'option'
export type OptionRight = 'call' | 'put'
export type OptionSide = 'long' | 'short'

/**
 * One **US** equity option contract, and the number that decides whether shares cover a short
 * call.
 *
 * It is the app's own constant: nothing in `positions.py` knows a contract multiplier, because
 * nothing on the desk needs one. That makes it an assumption rather than a fact, and it is only
 * true of US-listed equity options — a KOSPI 200 contract is not a hundred of anything, and
 * `SYMBOL_RE`'s docstring puts numeric KR tickers explicitly in scope.
 *
 * So `coversShortCall` refuses to answer where the multiplier is unknown, rather than assuming a
 * hundred and calling something a covered call that is not one. Mislabelling here is a wrong
 * sentence about what the owner is exposed to, which is the one kind of wrong this feature cannot
 * afford; an unlabelled short call is merely less helpful.
 */
export const SHARES_PER_CONTRACT = 100

/**
 * Whether `shares` of `symbol` cover `contracts` short calls — `false` when that cannot be known.
 *
 * A numeric ticker is a KR listing, where `SHARES_PER_CONTRACT` does not hold. This is a
 * deliberately narrow test: it does not try to be a multiplier table, it only declines to guess.
 */
export function coversShortCall(symbol: string, shares: number, contracts: number): boolean {
  if (/^\d/.test(symbol)) return false
  return shares >= contracts * SHARES_PER_CONTRACT
}

/** `positions.py`'s `MAX_LEGS`: four covers every shape the app offers. */
export const MAX_LEGS = 4

export interface OptionLeg {
  right: OptionRight
  side: OptionSide
  /** Integer cents, as the wire carries it. `strikeText` is the only place it becomes a price. */
  strikeCents: number
  /** `YYYY-MM-DD`. */
  expiry: string
  contracts: number
  entryPriceCents: number
}

interface PositionCommon {
  /** The desk's derived `p_xxxxxx`. Hash material, never a counter — the event book's
   *  `affects[].position_id` points at it. */
  id: string
  /** A ticker as it arrived. NOT upper-cased here: the desk requires it to be upper-case already
   *  rather than canonicalising, precisely so that no two implementations can disagree about a
   *  position's identity. Upper-casing it on this side would reintroduce the rule it refused. */
  symbol: string
  /** `YYYY-MM-DD`, or `null` for a position whose opening day was never recorded. */
  openedAt: string | null
  note: string
}

export interface StockPosition extends PositionCommon {
  kind: 'stock'
  /** Signed: negative is a short. Never zero — that is the absence of a position. */
  quantity: number
  entryPriceCents: number
}

export interface OptionPosition extends PositionCommon {
  kind: 'option'
  legs: OptionLeg[]
  /** Derived by the desk on every write. Read, never computed. */
  strategy: Strategy
}

/** A discriminated union rather than one struct with four optional fields, because the desk's two
 *  halves are exclusive *both ways* — it refuses a stock carrying legs and an option carrying a
 *  quantity — and a type that allowed both would let this app build a body the desk must reject. */
export type Position = StockPosition | OptionPosition

export interface PositionsDoc {
  /** The desk's own stamp, `YYYY-MM-DDTHH:MM:SSZ`, or `''` when it sent none. Never written by
   *  this app: the desk stamps with its own clock so that every reader sees one instant. */
  updatedAt: string
  positions: Position[]
}

// ---------------------------------------------------------------------------
// The wire, inbound
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** A finite integer, and nothing else. A numeric string is a field misread, not a number. */
function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseLeg(v: unknown): OptionLeg | null {
  if (!isObj(v)) return null
  const right = oneOf<OptionRight>(v.right, ['call', 'put'])
  const side = oneOf<OptionSide>(v.side, ['long', 'short'])
  const strikeCents = int(v.strike_cents)
  const contracts = int(v.contracts)
  const entryPriceCents = int(v.entry_price_cents)
  const expiry = str(v.expiry)
  if (right === null || side === null) return null
  if (strikeCents === null || contracts === null || entryPriceCents === null) return null
  if (!DATE_RE.test(expiry)) return null
  return { right, side, strikeCents, expiry, contracts, entryPriceCents }
}

function parsePosition(v: unknown): Position | null {
  if (!isObj(v)) return null
  const kind = oneOf<PositionKind>(v.kind, ['stock', 'option'])
  const symbol = str(v.symbol)
  if (kind === null || symbol === '') return null
  const openedAt = DATE_RE.test(str(v.opened_at)) ? str(v.opened_at) : null
  const common = { id: str(v.id), symbol, openedAt, note: str(v.note) }

  if (kind === 'stock') {
    const quantity = int(v.quantity)
    const entryPriceCents = int(v.entry_price_cents)
    if (quantity === null || quantity === 0 || entryPriceCents === null) return null
    return { ...common, kind, quantity, entryPriceCents }
  }

  if (!Array.isArray(v.legs) || v.legs.length === 0 || v.legs.length > MAX_LEGS) return null
  const legs: OptionLeg[] = []
  for (const one of v.legs) {
    const leg = parseLeg(one)
    if (leg === null) return null
    legs.push(leg)
  }
  // A strategy this build has no name for is `custom`, which renders as the leg list. That is the
  // honest answer for a desk a release ahead of the phone, and the only alternative — refusing the
  // whole book — would hide every position over one unrecognised word.
  return { ...common, kind, legs, strategy: oneOf(v.strategy, STRATEGIES) ?? 'custom' }
}

/**
 * The positions document, or `null` when what arrived is not one.
 *
 * Total and never throwing — the caller (`desk.ts`) is the one that knows how to refuse — but
 * strict: one position it cannot read fails the whole document, for the reason in the module
 * docstring. Refusing to draw the book is recoverable; PUTting back a book with a row missing is
 * not.
 *
 * Two spellings are accepted, and the tolerance is deliberate rather than defensive clutter. The
 * desk's envelope nests the document under its own name (`{"ok": …, "positions": {"updated_at":
 * …, "positions": […]}}`, following `h_get_watchlist`), so the value handed here is either that
 * document or — from a desk that flattened the duplicated word — the bare list. Both say exactly
 * the same thing and neither can be mistaken for the other.
 */
export function parsePositionsDoc(v: unknown): PositionsDoc | null {
  const raw = Array.isArray(v) ? { positions: v } : v
  if (!isObj(raw)) return null
  if (!Array.isArray(raw.positions)) return null
  const positions: Position[] = []
  for (const one of raw.positions) {
    const pos = parsePosition(one)
    if (pos === null) return null
    positions.push(pos)
  }
  return { updatedAt: str(raw.updated_at), positions }
}

// ---------------------------------------------------------------------------
// The wire, outbound
// ---------------------------------------------------------------------------

function legBody(leg: OptionLeg): Record<string, unknown> {
  return {
    right: leg.right,
    side: leg.side,
    strike_cents: leg.strikeCents,
    expiry: leg.expiry,
    contracts: leg.contracts,
    entry_price_cents: leg.entryPriceCents,
  }
}

/**
 * One position as the desk's `PUT` will take it — built field by field, never forwarded.
 *
 * Three omissions, each of them a refusal on the other side rather than tidiness:
 *
 * `strategy` and `id` are both **accepted and then ignored** — `_POSITION_KEYS` lists them so a
 * client that GETs this document and PUTs it straight back is not refused whole, and `_position`
 * re-derives each anyway, the strategy from the legs and the id from the hash material. Sending
 * either would put a field in the body that looks authoritative and decides nothing, and a
 * supplied `strategy` is worse than useless: it is a claim about legs that could contradict them.
 * Ruling 14 settled this — an earlier desk refused `strategy` by name and stripped it again on
 * load, and the round trip a phone actually makes was the thing that broke. Do not add a strip
 * back; there is nothing to strip.
 *
 * `legs` on a stock and `quantity` / `entry_price_cents` on an option are each refused, naming the
 * field: a document written against the wrong half of the schema. The union type is what keeps
 * this branch honest.
 */
function positionBody(p: Position): Record<string, unknown> {
  const common = {
    symbol: p.symbol,
    kind: p.kind,
    opened_at: p.openedAt,
    note: p.note,
  }
  if (p.kind === 'stock') {
    return { ...common, quantity: p.quantity, entry_price_cents: p.entryPriceCents }
  }
  return { ...common, legs: p.legs.map(legBody) }
}

/**
 * The whole document as a `PUT` body.
 *
 * `updated_at` is left off although the desk would accept one: it stamps with its own clock, so a
 * phone's instant would be a second answer to a question that already has one — and the phone's
 * clock is the less trustworthy of the two.
 */
export function positionsBody(doc: PositionsDoc): { positions: Record<string, unknown>[] } {
  return { positions: doc.positions.map(positionBody) }
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/** Integer cents as a strike reads on a chain: `42000` → `420`, `42050` → `420.50`.
 *
 *  `formatCents` is the app's one money formatter and this does not become a second one — it
 *  drops a whole-dollar's `.00`, which is the only difference between a price and a strike, and
 *  it does it after the integer arithmetic rather than instead of it. */
export function strikeText(cents: number): string {
  return formatCents(cents).replace(/\.00$/, '')
}

/**
 * An expiry as a date, in the catalogue it is handed.
 *
 * Not `market/format.ts`'s `formatDateShort`: that one takes epoch seconds and reads the *global*
 * catalogue, and `strategyLabel` is pure in the table passed to it so a caller can render both
 * languages without touching the app's own language. The year appears only when it is not this
 * year, the same rule and the same two templates.
 */
function expiryText(iso: string, t: Strings, nowMs: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (m === null) return iso
  const month = t.months.short[Number(m[2]) - 1]
  if (month === undefined) return iso
  const vars = { month, day: String(Number(m[3])), year: m[1] }
  const thisYear = Number(m[1]) === new Date(nowMs).getUTCFullYear()
  return fill(thisYear ? t.format.dateShort : t.format.dateShortYear, vars)
}

/** Between the legs of a shape that has no name. Punctuation, not copy: the same mark in both
 *  languages, which is why it is here and not in the catalogue. */
const LEG_JOIN = ' · '

function legText(leg: OptionLeg, t: Strings): string {
  const s = t.positions.strategy
  return fill(s.leg, {
    right: t.positions.right[leg.right],
    strike: strikeText(leg.strikeCents),
    side: t.positions.side[leg.side],
  })
}

/** Every leg, in the order the owner entered them. The answer for `custom`, and the fallback for
 *  any named shape whose legs are not the shape the name promises. */
function legList(legs: OptionLeg[], t: Strings): string {
  return legs.map((leg) => legText(leg, t)).join(LEG_JOIN)
}

function strikesAscending(legs: OptionLeg[]): { low: string; high: string } {
  const sorted = [...legs].sort((a, b) => a.strikeCents - b.strikeCents)
  return { low: strikeText(sorted[0].strikeCents), high: strikeText(sorted[1].strikeCents) }
}

export interface StrategyLabelContext {
  /**
   * Shares of the same symbol the owner holds elsewhere in the book, signed.
   *
   * The whole reason this argument exists: it is what turns a `short_call` into a covered call,
   * and it is a fact about a *different* position, which is why the desk cannot supply it. A short
   * stock holding covers nothing, so the sign is read rather than dropped.
   */
  stockShares?: number
  /** For the expiry's year rule. Injected so no label depends on the day the test runs. */
  nowMs?: number
}

/**
 * What to call this position, in the catalogue it is handed.
 *
 * The display half of the desk's `derive_strategy`, and the only place `covered_call` is named.
 * It never invents a name: a shape whose legs do not match what its strategy promises falls back
 * to listing the legs, which is the same answer `custom` gets and for the same reason — a
 * mislabelled spread is worse than an unlabelled one, because the owner stops reading the legs.
 */
export function strategyLabel(
  p: Position,
  t: Strings,
  ctx: StrategyLabelContext = {},
): string {
  const s = t.positions.strategy

  if (p.kind === 'stock') {
    // Four templates for two facts, because English agrees its noun with the count and a holding
    // of exactly one share is a real position: "1 shares" is what this branch exists to avoid.
    // Korean carries the same string under both halves of each pair, which is the same shape
    // `confirmationLine` already uses for `contract` / `contracts`.
    const shares = Math.abs(p.quantity)
    const one = shares === 1
    const short = p.quantity < 0
    const template = short ? (one ? s.stockShortOne : s.stockShort) : one ? s.stockOne : s.stock
    return fill(template, { n: formatCount(shares) })
  }

  const legs = p.legs
  const one = legs[0]
  const nowMs = ctx.nowMs ?? Date.now()

  switch (p.strategy) {
    case 'long_call':
    case 'long_put':
    case 'short_call':
    case 'short_put': {
      if (legs.length !== 1) break
      const right = t.positions.right[one.right]
      const strike = strikeText(one.strikeCents)
      // The one name the desk cannot reach: a short call against enough shares of the same symbol.
      // `stockShares` is the owner's whole book speaking, which is a thing only this side holds.
      if (
        p.strategy === 'short_call' &&
        coversShortCall(p.symbol, ctx.stockShares ?? 0, one.contracts)
      ) {
        return fill(s.covered, { strike })
      }
      const vars = { expiry: expiryText(one.expiry, t, nowMs), strike, right }
      return fill(one.side === 'short' ? s.singleShort : s.single, vars)
    }

    case 'vertical': {
      if (legs.length !== 2) break
      return fill(s.vertical, {
        right: t.positions.right[one.right],
        ...strikesAscending(legs),
      })
    }

    case 'calendar': {
      if (legs.length !== 2) break
      return fill(s.calendar, {
        right: t.positions.right[one.right],
        strike: strikeText(one.strikeCents),
      })
    }

    case 'straddle': {
      if (legs.length !== 2) break
      // Both legs are the same side by construction, so the side is the position's own.
      return fill(s.straddle, {
        strike: strikeText(one.strikeCents),
        side: t.positions.side[one.side],
      })
    }

    case 'strangle': {
      if (legs.length !== 2) break
      return fill(s.strangle, {
        ...strikesAscending(legs),
        side: t.positions.side[one.side],
      })
    }

    case 'custom':
      break
  }

  return legList(legs, t)
}
