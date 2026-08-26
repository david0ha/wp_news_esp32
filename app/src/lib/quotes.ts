// Pure quote arithmetic — no fetch, no desk. `src/lib/desk.ts`'s `getQuotes()` already hands back
// a `changeBp` the desk computed; this is for the app's own comparisons (a bar against the one
// before it, a watchlist item's price against a moment that is not `prevClose`) where the same
// question has to be answered client-side, in the same units the desk's wire already uses:
// integer basis points, `docs/desk-server.md` § Quotes.

/**
 * The change from `prevCloseCents` to `lastCents`, in basis points — `server/claudepost/quotes.py`'s
 * `_basis_points()`, mirrored so the two agree on the same pair of prices.
 *
 * `prevCloseCents === 0` returns `null`, not `0`. The desk itself answers `0` for that case — "no
 * change" is the honest reading when there is nothing to compare against — but `0` on THIS wire
 * means a specific thing elsewhere in the app (`NewsFigure.changeBp`, CLAUDE.md's colour rule):
 * present-and-zero draws a flat ▲▼ mark, absent draws no mark and no colour. A listing with no
 * previous close has no change to show a mark for, so `null` is the reading that keeps those two
 * cases apart on a client that draws both.
 */
export function changeBpFrom(lastCents: number, prevCloseCents: number): number | null {
  if (prevCloseCents === 0) return null
  return Math.round(((lastCents - prevCloseCents) * 10000) / prevCloseCents)
}
