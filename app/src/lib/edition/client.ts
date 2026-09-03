// The edition, fetched by the phone.
//
// The desk serves `GET /news.json` unauthenticated on its device plane — the same URL, the same
// bytes, the same conditional request the board makes (docs/desk-server.md, "The two planes").
// So this client sends what the board sends and applies the board's own limits: a 15-second
// deadline, a 320 KB cap, an `If-None-Match` whenever it holds an ETag. A payload this refuses
// is a payload the board would refuse too, which keeps the phone from showing an edition the
// glass could never print.
//
// The five error codes are the whole failure vocabulary and each one has exactly one sentence
// (`humanEditionError`). They are separate codes rather than one string because the SCREEN acts
// differently on them: `no_url` is a settings problem, `transport` is a pull-to-refresh problem,
// and `bad_json` is somebody else's problem that fixes itself in a minute.

import { isEmptyEdition, parseEdition } from './parse'
import { type Edition } from './types'

/** The device's own body cap (`news_service.c`). A payload over it is one the board rejects. */
export const EDITION_MAX_BYTES = 320 * 1024

/** The device's own deadline. Long enough for a cold tunnel, short enough to be a refresh. */
export const EDITION_TIMEOUT_MS = 15_000

export type EditionErrorCode = 'no_url' | 'transport' | 'http' | 'too_large' | 'bad_json'

export class EditionError extends Error {
  constructor(
    public readonly code: EditionErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'EditionError'
  }
}

/**
 * One sentence per failure, written for a reader rather than for a log.
 *
 * Every one of them says what the reader can do next, or says plainly that there is nothing to
 * do. "The desk may be mid-publish" is the honest reading of a 200 that will not parse: the
 * common cause is a file being written while it is being served, and it resolves itself.
 */
export function humanEditionError(e: unknown): string {
  if (e instanceof EditionError) {
    switch (e.code) {
      case 'no_url':
        return 'No edition URL yet. Add one in Settings.'
      case 'transport':
        return "Couldn't reach the edition server. Check the connection, then pull to refresh."
      case 'http':
        return e.status === undefined
          ? 'The edition server answered with an error.'
          : `The edition server answered ${e.status}.`
      case 'too_large':
        return 'The edition is too large to read here.'
      case 'bad_json':
        return "The edition didn't parse. The desk may be mid-publish; pull to refresh in a minute."
    }
  }
  return 'Something went wrong reading the edition.'
}

export type EditionFetch =
  | { status: 'ok'; edition: Edition; etag: string | null }
  | { status: 'not_modified' }

export interface EditionClientOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export interface EditionClient {
  fetch(url: string, etag: string | null): Promise<EditionFetch>
  fetchTile(url: string, w: number, h: number): Promise<Uint8Array>
}

/**
 * Where a photo tile lives: the news URL's DIRECTORY plus `tiles/<id>.bin`.
 *
 * The directory is everything up to and including the last `/`, with the query and the fragment
 * removed first — a `?v=2` on the payload does not belong on a picture, and a URL that carried
 * one would 404 on every tile. The id is percent-encoded because it is the producer's string and
 * a `../` in it would resolve to a path this app never meant to ask for.
 *
 * Returns `''` for anything with no directory to resolve beside; the caller treats that as "no
 * picture", which is the same outcome as a failed fetch and needs no second branch.
 */
export function tileUrl(newsUrl: string, id: string): string {
  const path = newsUrl.split('#')[0].split('?')[0]
  const cut = path.lastIndexOf('/')
  // A bare `news.json` with no slash at all, or an empty string: nothing to resolve against.
  if (cut < 0) return ''
  // THE TRAP: a URL with no path at all — a bare authority like `http://host.local:8123` — still
  // has slashes, the scheme's own `//`. `lastIndexOf('/')` finds the second one of those, and
  // cutting there drops the host entirely: `http://tiles/id.bin`. Detect that case by checking
  // whether the cut point falls inside the scheme separator itself (index of '://' , +2 for its
  // two slashes) rather than in an actual path segment, and resolve directly after the authority.
  const schemeEnd = path.indexOf('://')
  if (schemeEnd >= 0 && cut === schemeEnd + 2) {
    return `${path}/tiles/${encodeURIComponent(id)}.bin`
  }
  return `${path.slice(0, cut + 1)}tiles/${encodeURIComponent(id)}.bin`
}

export function createEditionClient(opts: EditionClientOptions = {}): EditionClient {
  const fetchFn = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? EDITION_TIMEOUT_MS

  // GET with the deadline attached. Our own abort and the network refusing both read transport —
  // the sentence ("check the connection, then pull to refresh") is right for either.
  async function get(url: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetchFn(url, { method: 'GET', headers, signal: controller.signal })
    } catch (e) {
      throw new EditionError('transport', e instanceof Error ? e.message : 'network error')
    } finally {
      clearTimeout(timer)
    }
  }

  async function bodyBytes(res: Response, cap: number): Promise<Uint8Array> {
    // Content-Length first, so an oversize payload is refused before it is downloaded. It is
    // advisory (a chunked response carries none), which is why the length is checked again below.
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > cap) {
      throw new EditionError('too_large', `content-length ${declared} over the ${cap}-byte cap`)
    }
    let buf: ArrayBuffer
    try {
      buf = await res.arrayBuffer()
    } catch (e) {
      throw new EditionError('transport', e instanceof Error ? e.message : 'body read failed')
    }
    if (buf.byteLength > cap) {
      throw new EditionError('too_large', `${buf.byteLength} bytes over the ${cap}-byte cap`)
    }
    return new Uint8Array(buf)
  }

  async function fetchEdition(url: string, etag: string | null): Promise<EditionFetch> {
    if (url.trim() === '') throw new EditionError('no_url', 'no edition URL configured')

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (etag !== null && etag !== '') headers['If-None-Match'] = etag

    const res = await get(url, headers)

    // 304 before the ok check: `res.ok` is false for a 304, and reading it as an HTTP failure
    // would turn the most common answer a healthy desk gives into an error banner.
    if (res.status === 304) return { status: 'not_modified' }
    if (!res.ok) throw new EditionError('http', `edition server answered ${res.status}`, res.status)

    const bytes = await bodyBytes(res, EDITION_MAX_BYTES)

    let json: unknown
    try {
      json = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new EditionError('bad_json', 'the body is not JSON')
    }

    const edition = parseEdition(json)
    // The parser is total, so "it parsed" is not the same question as "there is an edition here".
    // A desk writing the file while serving it answers 200 with furniture and no content; taking
    // that as success would replace a real cached edition with a blank sheet.
    if (isEmptyEdition(edition)) {
      throw new EditionError('bad_json', 'the payload carries no subject and no stories')
    }

    return { status: 'ok', edition, etag: res.headers.get('etag') }
  }

  async function fetchTile(url: string, w: number, h: number): Promise<Uint8Array> {
    if (url.trim() === '') throw new EditionError('no_url', 'no tile URL')
    const res = await get(url, {})
    if (!res.ok) throw new EditionError('http', `tile server answered ${res.status}`, res.status)
    const want = (w * h) / 2
    // A tile has no header and no length of its own, so the geometry from the payload is the
    // only thing that can check it. A short body drawn as a whole picture is an image the reader
    // cannot tell from the real one.
    const bytes = await bodyBytes(res, Math.max(want, 1))
    if (bytes.length !== want) {
      throw new EditionError(
        'bad_json',
        `tile: expected ${want} bytes for ${w}x${h}, got ${bytes.length}`,
      )
    }
    return bytes
  }

  return { fetch: fetchEdition, fetchTile }
}

/**
 * The app-wide client, the same singleton idiom as `lib/market/yahoo.ts`'s `yahoo`. Screens and
 * tiles take this; tests build their own with an injected `fetchFn`.
 */
export const editionClient: EditionClient = createEditionClient()
