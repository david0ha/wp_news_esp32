// WHERE AN EDITION LIVES — the type, the two builders, and the address the Today tab reads.
//
// `EditionSource` below is the seam: one value carrying a payload address, a tile-address rule and
// the headers both need, so a reader can be handed an edition without being told which plane it
// arrived on. `editionUrl` further down answers the older and narrower question this file started
// as — which of the two addresses a phone may hold the DEVICE plane should read.
//
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
 * WHERE ONE EDITION LIVES, as a value.
 *
 * Three facts and no behaviour: the address of the payload, how to turn a producer's tile id into
 * an address, and what headers both need. It exists because there are now TWO planes an edition
 * can arrive on and the reader must not know which it is looking at:
 *
 *   - the device plane — `GET /news.json` and `<its directory>/tiles/<id>.bin`, no credential,
 *     open to anything that can reach the desk; and
 *   - one paper — `GET /api/editions/<eid>/news.json` and `/api/editions/<eid>/tiles/<id>.bin`,
 *     behind the operator bearer.
 *
 * A STRING CANNOT EXPRESS THE SECOND. The old context carried the news URL and `PhotoTile` derived
 * the picture's address from it by string surgery; a paper's picture is not beside its payload in
 * any sense a directory join can reach, and it needs a header besides. So the resolution moves
 * from the consumer to the producer of the address, and every consumer asks rather than derives.
 *
 * `headers` is held IN MEMORY ONLY. `store.ts`'s write path persists four keys and this is not one
 * of them — see its header, and `store.test.ts`'s "NEVER reaches the disk".
 */
export interface EditionSource {
  /** The document to GET. `''` when there is nothing to fetch, which is what draws the demo. */
  payloadUrl: string
  /** That edition's tile, by the producer's id. `''` when there is nowhere to resolve against. */
  tileUrl(id: string): string
  /** Sent on the payload AND on every tile. `{}` on the device plane, and that is the point. */
  headers: Readonly<Record<string, string>>
}

/**
 * Where a DEVICE-PLANE photo tile lives: the news URL's DIRECTORY plus `tiles/<id>.bin`.
 *
 * Moved here from `client.ts` unchanged, because it is now one of two addressing rules and they
 * belong beside each other. The query and the fragment are removed first — a `?v=2` on the payload
 * does not belong on a picture, and a URL that carried one would 404 on every tile. The id is
 * percent-encoded because it is the producer's string and a `../` in it would resolve to a path
 * this app never meant to ask for.
 *
 * Returns `''` for anything with no directory to resolve beside; the caller treats that as "no
 * picture", which is the same outcome as a failed fetch and needs no second branch.
 */
export function deviceTileUrl(newsUrl: string, id: string): string {
  const path = newsUrl.split('#')[0].split('?')[0]
  const cut = path.lastIndexOf('/')
  // A bare `news.json` with no slash at all, or an empty string: nothing to resolve against.
  if (cut < 0) return ''
  // THE TRAP: a URL with no path at all — a bare authority like `http://host.local:8123` — still
  // has slashes, the scheme's own `//`. `lastIndexOf('/')` finds the second one of those, and
  // cutting there drops the host entirely: `http://tiles/id.bin`. Detect that case by checking
  // whether the cut point falls inside the scheme separator itself (index of '://', +2 for its
  // two slashes) rather than in an actual path segment, and resolve directly after the authority.
  const schemeEnd = path.indexOf('://')
  if (schemeEnd >= 0 && cut === schemeEnd + 2) {
    return `${path}/tiles/${encodeURIComponent(id)}.bin`
  }
  return `${path.slice(0, cut + 1)}tiles/${encodeURIComponent(id)}.bin`
}

/** The open plane. No credential, ever: this address is whatever the reader typed in Settings. */
export function deviceSource(newsUrl: string): EditionSource {
  return {
    payloadUrl: newsUrl,
    tileUrl: (id: string) => deviceTileUrl(newsUrl, id),
    headers: {},
  }
}

/**
 * One paper, on the desk's control plane.
 *
 * Both segments are percent-encoded even though the desk's own ids are 16 hex characters and a
 * producer's tile ids pass `TILE_ID_RE`: the edition id arrives over the network in a JSON field,
 * and a client that trusts a remote string to be path-safe is a client that can be told to ask for
 * a path it never meant to.
 */
export function paperSource(opts: {
  deskBaseUrl: string
  editionId: string
  token: string
}): EditionSource {
  const base = opts.deskBaseUrl.replace(/\/+$/, '')
  const dir = `${base}/api/editions/${encodeURIComponent(opts.editionId)}`
  return {
    payloadUrl: `${dir}/news.json`,
    tileUrl: (id: string) => `${dir}/tiles/${encodeURIComponent(id)}.bin`,
    headers: { Authorization: `Bearer ${opts.token}` },
  }
}

/** A source that can fetch nothing. The default outside a provider, and the demo's own. */
export const NO_SOURCE: EditionSource = deviceSource('')

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
