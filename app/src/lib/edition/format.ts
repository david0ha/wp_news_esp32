// Display formatting for the edition's numbers — the market tab's formatters, re-exported, plus
// the one thing the edition adds.
//
// ONE FORMATTER SERVES BOTH TABS, and the reason is the wire and not the screen. `lib/format.ts`
// renders the device API's integer cents and basis points; the edition's JSON carries decimals
// (`last: 1631.47`, `change_pct: 4.21`) and so does Yahoo's, which is what `lib/market/format.ts`
// was written for. Same units in, same string out — so a second implementation was never a second
// decision, only a second place to drift. It had already drifted: `formatPrice(0)` answered
// '0.00' here and '0.0000' there, each pinned by its own test, which meant a price of exactly
// nothing was printed one way on the Markets tab and another way on Today. The market module's
// behaviour wins, because it is the one with the older callers.
//
// What is edition-specific stays here: `changeTone`, which is a direction as a TOKEN rather than
// as a colour, because `lib/` holds no colours (see `components/edition/tone.ts` for the mapping).

/**
 * The em dash for an absent value, the price and the percentage — from `lib/market/format.ts`,
 * unchanged. `arrow` is what the edition used to call `changeArrow`; it was the same function.
 */
export { arrow, DASH, formatPct, formatPrice } from '../market/format'

export type ChangeTone = 'up' | 'down' | 'flat'

/**
 * The direction a change carries, as a token rather than a colour — `lib/` holds no colours and
 * the theme holds no market semantics. `components/edition/tone.ts` is the one place the two
 * meet, and it maps this to the text pair or the graphics pair depending on the duty.
 *
 * Zero is `flat`, not `up`. Green on an unchanged price spends the colour reserved for movement
 * on its absence, which is the firmware's rule (`ui_chg_colour()`) carried into the app.
 */
export function changeTone(n: number | null | undefined): ChangeTone {
  if (typeof n !== 'number' || !Number.isFinite(n) || n === 0) return 'flat'
  return n > 0 ? 'up' : 'down'
}
