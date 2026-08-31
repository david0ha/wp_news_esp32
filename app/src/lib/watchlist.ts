// Pure watchlist logic for the Watch tab (Task 27) — no fetch, no desk, no React. The screen reads
// `desk.ts`'s `WatchlistItem[]` through `useWatchlist()` (src/lib/queries.ts) and hands it here for
// the grade filter and the sort; this file only decides which rows show and in what order.

import { flattenSpans, parse, type Block } from './md'
import type { WatchlistGrade, WatchlistItem } from './desk'

/** The SegmentedControl's own four segments, in the order it draws them — All, Red, Yellow, Green. */
export type WatchGradeFilter = 'all' | 'red' | 'yellow' | 'green'

export const WATCH_GRADE_FILTERS: readonly WatchGradeFilter[] = ['all', 'red', 'yellow', 'green']

/** `filter`'s label for the SegmentedControl and for a filtered-empty message. */
export function watchGradeFilterLabel(filter: WatchGradeFilter): string {
  switch (filter) {
    case 'all':
      return 'All'
    case 'red':
      return 'Red'
    case 'yellow':
      return 'Yellow'
    case 'green':
      return 'Green'
  }
}

/** Only the items graded `filter` — every item, `grade: 'none'` included, when `filter` is 'all'. */
export function filterByGrade(items: readonly WatchlistItem[], filter: WatchGradeFilter): WatchlistItem[] {
  if (filter === 'all') return [...items]
  return items.filter((item) => item.grade === filter)
}

/**
 * Worst first, matching the filter's own order — a red thesis is the one a reader most needs to
 * see, and a company with no grade yet has said the least, so it sorts last rather than first.
 */
const GRADE_SORT_ORDER: Record<WatchlistGrade, number> = { red: 0, yellow: 1, green: 2, none: 3 }

/** Grade (red → yellow → green → none), then symbol A→Z. Does not mutate `items`. */
export function sortWatchlist(items: readonly WatchlistItem[]): WatchlistItem[] {
  return [...items].sort((a, b) => {
    const byGrade = GRADE_SORT_ORDER[a.grade] - GRADE_SORT_ORDER[b.grade]
    if (byGrade !== 0) return byGrade
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0
  })
}

// A heading is the note's own label ("## Thesis", "# Passed") — structure, not the argument. The
// row wants the argument, so a heading is skipped rather than shown, and the search continues past
// it to the first block that actually carries prose.
function proseOf(block: Block): string {
  switch (block.type) {
    case 'paragraph':
    case 'quote':
      return flattenSpans(block.spans).trim()
    case 'list':
      return block.items.length > 0 ? flattenSpans(block.items[0]).trim() : ''
    case 'heading':
    case 'code':
    case 'hr':
      return ''
  }
}

/**
 * The first line of argument out of a thesis note — `WatchlistItem.note`'s markdown, reduced to
 * one plain-text line for a row that has room for a summary, not a document. `''` for an empty
 * note (`grade: 'none'`'s ordinary state) or one that is only a heading with nothing under it yet.
 *
 * A whole paragraph can come back, not a single sentence — the row itself truncates it with
 * `numberOfLines={1}`, the same division of labour `formatSinceTime()` and its caller keep: this
 * file decides the text, the component decides how much of it fits.
 */
export function thesisLine(note: string): string {
  for (const block of parse(note)) {
    const text = proseOf(block)
    if (text !== '') return text
  }
  return ''
}

/**
 * The thesis note's full markdown, ready for `<Markdown>` — every block except a LEADING heading.
 * `thesisLine()`'s own reading, extended to the whole document rather than one summary line: a
 * heading at the top ("## Thesis", "# Passed") is the note's own label, not the argument, and the
 * detail page already draws its own THESIS standing head above this — printing the note's label a
 * second time under the app's own would be the label twice and the argument once.
 *
 * Only the FIRST block is ever dropped. An interior heading is part of the argument (a note
 * structured as "Watching" / "## Still watching" / body) and renders exactly as filed.
 */
export function thesisBlocks(note: string): Block[] {
  const blocks = parse(note)
  return blocks.length > 0 && blocks[0].type === 'heading' ? blocks.slice(1) : blocks
}
