// Which address the Today tab reads, given the two the phone may hold.
//
// THE READER SHOULD NOT HAVE TO SAY THE SAME HOST TWICE. A phone that has been given a desk
// address already knows where the paper is: `news.json` is served from that same host, on the open
// device plane, with no token and no board (docs/desk-server.md, "The two planes"). Requiring a
// second, longer address before Today will show anything meant that a reader who had set the desk
// up correctly — token saved, edition language answering — still got the bundled demo and a
// dateline weeks old, with nothing on screen connecting the two facts.
//
// The explicit edition address still wins when there is one. It is the only thing the BOARD is
// ever told, it can point somewhere other than the desk, and a reader who typed one meant it.
// This fallback exists for the case where they typed nothing at all.
//
// Pure, and separate from `useEdition` for the reason every other decision in this directory is:
// there is no component test runner in this app, so anything left inside a hook body is untested by
// construction.

/** The document the desk serves its edition at, relative to its base address. */
export const EDITION_PATH = '/news.json'

/**
 * The address to fetch, from the phone's own edition setting and its desk address.
 *
 * Returns `''` for "there is no address", which is what puts the bundled demo on screen — the same
 * value `''` has everywhere else in this directory.
 *
 * Both inputs are `null` when storage has not answered rather than when nothing is stored, and both
 * fold to the same answer here: with nothing to read from, there is nothing to fetch. The caller
 * runs again on the next focus.
 */
export function editionUrl(newsUrl: string | null, deskBaseUrl: string | null): string {
  const explicit = (newsUrl ?? '').trim()
  if (explicit !== '') return explicit
  const desk = (deskBaseUrl ?? '').trim()
  if (desk === '') return ''
  // `saveDeskBaseUrl` normalises through `normalizeBaseUrl`, which strips the path and any trailing
  // slash — so the desk address is an origin and this is a join, not a guess. The slash is trimmed
  // anyway rather than trusted: a value written by an older build of this app, or by hand, is still
  // a string somebody typed.
  return desk.replace(/\/+$/, '') + EDITION_PATH
}

/**
 * Whether the address in force was derived rather than typed. The Today tab has nothing to say
 * about it, but Settings does: the edition field is empty and the paper is still arriving, which
 * without a word on screen reads as the field being ignored.
 */
export function isDerived(newsUrl: string | null, deskBaseUrl: string | null): boolean {
  return (newsUrl ?? '').trim() === '' && editionUrl(newsUrl, deskBaseUrl) !== ''
}
