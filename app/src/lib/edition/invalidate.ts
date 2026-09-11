// ONE WRITER, TWO READERS, AND THAT IS DELIBERATE. "The paper changed underneath us" is one fact
// and two screens act on it: the Today reader must defeat its five-minute throttle and refetch the
// edition, and — since the papers feature — the pager's LIST must refetch too, because a revision
// moves that company's `created_at` and can move which edition is on the board. A second mark
// beside this one would be two facts to keep in step by hand, and the first place they would drift
// is the third caller somebody adds next.
//
// A FLAG AND NOT A CACHE WIPE. `useEdition`'s focus re-check is throttled to five minutes and
// carries the cached ETag; a revised edition has different content, so the ETag misses and the desk
// answers 200 with the new paper. The only thing between the reader and it is the throttle — so
// defeating the throttle once is the whole of what invalidation has to do. Deleting the cache
// instead would blank Today to a spinner for the length of a fetch, over an edition that is still
// perfectly good until its replacement lands.
//
// MODULE SCOPE, LIKE `edition/store.ts`'s `current` and `useEventBook`'s snapshot. The writer is
// the ask screen, the reader is the Today tab, and the two are never mounted in the same tree at
// the same moment — there is nothing here for React state to subscribe to.
//
// Two bits and not one, because the two readers take theirs at different moments and neither may
// rob the other: Today's pager can be unmounted when the edition reader consumes its own.

let editionStale = false
let papersStale = false

/** Say the paper changed. Called after a `revised`, a successful publish, and a board publish. */
export function markEditionStale(): void {
  editionStale = true
  papersStale = true
}

/** Read and clear. The caller is `useEdition`'s `load`, and it is the only one. */
export function takeEditionStale(): boolean {
  const was = editionStale
  editionStale = false
  return was
}

/** Read and clear. The caller is `lib/papers/list.ts`'s `loadPapers`, and it is the only one. */
export function takePapersStale(): boolean {
  const was = papersStale
  papersStale = false
  return was
}

export function __resetEditionStaleForTests(): void {
  editionStale = false
  papersStale = false
}
