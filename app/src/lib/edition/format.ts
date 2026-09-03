// Display formatting for the edition's numbers.
//
// A THIRD formatter module, and deliberately so. `lib/format.ts` renders the device API's
// integer cents and basis points; `lib/market/format.ts` renders Yahoo's floats. The edition's
// wire carries decimals (`last: 1631.47`, `change_pct: 4.21`), so pointing `formatCents` at one
// divides a real price by a hundred and shows it, which is the kind of wrong that looks right.
//
// Every '—' below is the same em dash, so an absent value looks identical on every surface.

export const DASH = '—'

export type ChangeTone = 'up' | 'down' | 'flat'

function isFiniteNumber(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * `1,631.47`. Two decimals with thousands separators at or above 1 (and at exactly zero); four
 * below, because a sub-dollar price rounded to two decimals is a price the reader cannot act on.
 * Zero is pinned to the two-decimal branch rather than falling through to `0.0000` — a price of
 * exactly nothing has no extra precision to show, wherever it fell from.
 */
export function formatPrice(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return DASH
  if (Math.abs(n) >= 1 || n === 0) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return n.toFixed(4)
}

/**
 * `2.41%`, from a number ALREADY scaled to percent — no ×100 in here. Unsigned, because the
 * arrow and the direction colour beside it already say which way, and a `▼ -0.74%` says it
 * twice with two different marks.
 */
export function formatPct(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return DASH
  const a = Math.abs(n)
  if (a < 0.0001) return '0.00%'
  return `${a.toFixed(2)}%`
}

/**
 * The direction a change carries, as a token rather than a colour — `lib/` holds no colours and
 * the theme holds no market semantics. `components/edition/tone.ts` is the one place the two
 * meet, and it maps this to the text pair or the graphics pair depending on the duty.
 *
 * Zero is `flat`, not `up`. Green on an unchanged price spends the colour reserved for movement
 * on its absence, which is the firmware's rule (`ui_chg_colour()`) carried into the app.
 */
export function changeTone(n: number | null | undefined): ChangeTone {
  if (!isFiniteNumber(n) || n === 0) return 'flat'
  return n > 0 ? 'up' : 'down'
}

/** The mark beside a change. Empty at zero and at absence — see `changeTone`. */
export function changeArrow(n: number | null | undefined): '▲' | '▼' | '' {
  if (!isFiniteNumber(n) || n === 0) return ''
  return n > 0 ? '▲' : '▼'
}
