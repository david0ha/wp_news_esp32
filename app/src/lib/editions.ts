// Pure display logic for the editions list and detail screens (Task 30) — no fetch, no desk, no
// React. `desk.ts`'s `EditionMeta` and the two pointers off `listEditions()` / `DeskState` are what
// these read.

import type { CommitResult, EditionMeta } from './desk'
import { formatWhen } from './format'

/**
 * "published 06:04" once an edition has reached the glass, "filed 22:01" while it is only staged
 * or has since been superseded — `published_at` is the fact a reader actually wants ("when did
 * this go up"), and `created_at` is the one instant every edition is guaranteed to carry
 * (`desk.ts`'s own comment on `EditionMeta`).
 *
 * `nowSeconds` is the desk's own clock (`useDeskNow()`), for `formatWhen()`'s own reason: this
 * list can span days, and a bare clock reading is only unambiguous on the day it falls.
 */
export function editionWhen(edition: EditionMeta, nowSeconds: number): string {
  const published = edition.published_at
  const at = published ?? edition.created_at
  const when = formatWhen(at, nowSeconds)
  if (when === '') return ''
  return published !== null ? `published ${when}` : `filed ${when}`
}

/** Which of the desk's two pointers — if either — names this edition, for the list's stamps. */
export type EditionPointer = 'current' | 'staged' | null

export function editionPointer(
  id: string,
  current: string | null,
  staged: string | null,
): EditionPointer {
  if (current !== null && id === current) return 'current'
  if (staged !== null && id === staged) return 'staged'
  return null
}

/**
 * What to say once a promote answers — honestly, for all three states `CommitResult.state` can
 * carry. `desk.ts`'s own comment: promote is a publish of an older edition, so it inherits every
 * outcome a publish can have, "unchanged" included when the edition promoted was already current
 * (`editions.py`'s `promote()`; `mock-desk.js` carries the same edge case, no pointer write and no
 * audit row). Surfacing that honestly rather than a blanket "Promoted!" is the point — a reader who
 * taps Promote on the edition already on the wall should be told nothing moved, not congratulated
 * for a publish that did not happen.
 */
export function promoteResultLine(result: CommitResult): string {
  switch (result.state) {
    case 'published':
      return 'Promoted — this edition is current now.'
    case 'staged':
      return 'Staged. It reaches the glass at the next boundary.'
    case 'unchanged':
      return 'Already current. Nothing changed.'
  }
}
