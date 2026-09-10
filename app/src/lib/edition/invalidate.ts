// One bit: "the paper changed underneath us; the next load must actually go".
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

let stale = false

/** Say the edition on screen is out of date. Called after a `revised` or a successful publish. */
export function markEditionStale(): void {
  stale = true
}

/** Read and clear. The caller is `useEdition`'s `load`, and it is the only one. */
export function takeEditionStale(): boolean {
  const was = stale
  stale = false
  return was
}

export function __resetEditionStaleForTests(): void {
  stale = false
}
