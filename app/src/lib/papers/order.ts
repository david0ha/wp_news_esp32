// What the pager shows, and in what order.
//
// Four decisions, all pure, all here rather than inside `edition.tsx`, for the reason every other
// `lib/` file in this app gives: there is no component test runner, so a rule argued inside a
// `.tsx` is argued only in prose. The spec's App test row names three of these by name.

import { formatAge } from '../format'
import { type Paper, type PapersDoc } from '../desk'

/**
 * Pager order: the board's paper first, then the desk's order untouched.
 *
 * ONE MOVE, NOT A SORT. The desk answers in WATCHLIST order, which is the owner's own sequence and
 * the one they see on every other surface in this app; the only thing that outranks it is "the one
 * that is actually on the glass, which is what you came to look at". A comparator would be free to
 * reorder rows that tie, and there is nothing else here worth sorting by — `stale` is the desk's
 * judgement about refresh, not about what the reader wants first.
 *
 * Exactly one row moves even if the desk marked two. Two `on_board` rows cannot happen against a
 * correct desk (`current` is one pointer), and if one ever arrives, promoting both would reorder
 * the list a second way and make the pager jump on a refetch for a reason nothing on screen
 * explains.
 */
export function orderPapers(doc: PapersDoc): Paper[] {
  const at = doc.papers.findIndex((p) => p.onBoard)
  if (at <= 0) return [...doc.papers]
  const rows = [...doc.papers]
  const [board] = rows.splice(at, 1)
  return [board, ...rows]
}

/**
 * Whether Today is a pager at all, and over what.
 *
 * THE PAGER IS A LAYER OVER THE SINGLE-PAGE READER, NOT A REPLACEMENT FOR IT. Every state that is
 * not "the desk answered with at least one paper" answers `pager: false`, and the screen then draws
 * exactly what it draws today: one page, `editionUrl(newsUrl, deskBaseUrl)`, `useEdition`. That
 * covers a phone with no desk, a desk that refused, a desk one release behind that has no
 * `/api/papers` at all, an empty watchlist, and the first frame of every cold launch before storage
 * has answered — and it is what makes "without a token, Today is unchanged" a property of one
 * function rather than a promise.
 *
 * `ready` is `null` while storage has not answered about the address and the token. It is folded in
 * with `false` here because the outcome is the same; it is a separate state to the CALLER, which
 * must not start a fetch on it.
 */
export function papersPagerView(input: {
  ready: boolean | null
  doc: PapersDoc | null
}): { pager: boolean; papers: Paper[] } {
  if (input.ready !== true || input.doc === null) return { pager: false, papers: [] }
  const papers = orderPapers(input.doc)
  return { pager: papers.length > 0, papers }
}

/**
 * How long ago the desk wrote this paper — `6h ago`, `6시간 전` — or `null`.
 *
 * `formatAge` and not `freshnessLabel`, and the difference matters: `freshnessLabel` answers null
 * under five minutes because an edition confirmed a moment ago should read as current with no
 * label. This line answers a different question — how old is this company's paper, against a
 * cadence measured in HOURS — and a page whose header went blank for five minutes after a refresh
 * would look like the header had failed.
 *
 * In the APP's language, not the edition's. This row is the app talking about a paper; the paper's
 * own language governs the type below it (`typeRamp.tsx`) and nothing up here.
 *
 * `null` for a symbol with no paper, and `null` for a stamp in the future — a desk whose clock is
 * ahead. `-1h ago` is worse than silence, which is `freshnessLabel`'s rule and holds here too.
 */
export function paperAgeLabel(createdAt: number | null, now: number): string | null {
  if (createdAt === null || !Number.isFinite(createdAt) || createdAt <= 0) return null
  const ageMs = now - createdAt
  if (ageMs < 0) return null
  return formatAge(ageMs / 1000)
}

/**
 * A remembered page index, held against a list that may have changed under it.
 *
 * The watchlist is the desk's and moves without the phone asking: a symbol added is a page
 * inserted, a symbol removed is a page gone. The index is remembered for the session (see
 * `list.ts`), so it has to survive both.
 */
export function clampPaperIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0
  return Math.min(Math.max(Math.trunc(index), 0), count - 1)
}

/**
 * The identity of a page, for React's key and for nothing else.
 *
 * SYMBOL AND EDITION TOGETHER. The symbol alone would keep a page mounted across a refresh that
 * gave that company a NEW edition, and `PhotoTile`'s effect keys on the tile URL — which contains
 * the edition id, so it would in fact refetch — but `editionToTiles` would be re-cut under a
 * mounted masonry rather than remounted, which is exactly the "yesterday's photograph under
 * today's caption" failure `feedLayout.ts`'s `editionKey` exists to prevent. The edition alone
 * would collide across the symbols that have no edition at all.
 */
export function paperKey(paper: Paper): string {
  return `${paper.symbol}:${paper.editionId ?? ''}`
}
