// One paper's payload, fetched once per edition and kept for the session.
//
// KEYED ON THE EDITION ID AND NOT ON THE SYMBOL. A paper IS "the newest edition about S", so the
// identity moves under the symbol; an entry filed under `SNDK` would be handed to a refreshed paper
// that is a different document. The id is also what makes an entry safe to keep without
// revalidating: on this desk an edition id IS a content fingerprint (`editions.py`), so the same id
// is the same bytes. A cached edition cannot go stale — it can only stop being the newest, and
// `list.ts` is what says so.
//
// MEMORY ONLY. `edition/store.ts` writes ONE edition to disk, the device plane's, and that is the
// whole of what belongs there. Five companies' newspapers behind a credential do not: it would be
// a hundred kilobytes of somebody's watchlist on the phone's disk to save a fetch the reader makes
// over the connection that just delivered the list.

import { useEffect, useState } from 'react'
import { createDeskClient, type Paper } from '../desk'
import { getDeskToken } from '../deskToken'
import { getDeskBaseUrl } from '../store'
import { humanEditionError } from '../edition/client'
import { type CachedEdition } from '../edition/store'

/** What one page of the pager is showing. */
export type PaperPageState =
  | { status: 'placeholder' }
  | { status: 'loading' }
  | { status: 'ready'; cached: CachedEdition }
  | { status: 'error'; error: string }

/**
 * One more than today's watchlist, so a full pager fits with room for the board's own edition to
 * be a sixth. Beyond that the oldest INSERTION goes: a reader who has paged through everything has
 * seen the early pages longest ago, and re-entering one costs a conditional GET the desk answers
 * quickly.
 */
export const MAX_CACHED_PAPERS = 6

const byEdition = new Map<string, CachedEdition>()

export function readPaperCache(editionId: string): CachedEdition | null {
  return byEdition.get(editionId) ?? null
}

export function putPaperCache(editionId: string, entry: CachedEdition): void {
  // Delete first, so re-filing an edition refreshes its position rather than counting twice — a
  // `Map` keeps insertion order and `set` on an existing key does not move it.
  byEdition.delete(editionId)
  byEdition.set(editionId, entry)
  while (byEdition.size > MAX_CACHED_PAPERS) {
    const oldest = byEdition.keys().next()
    if (oldest.done === true) break
    byEdition.delete(oldest.value)
  }
}

/**
 * What to draw, from the three facts a page has. Pure, because this is the decision worth arguing
 * about and `PaperPage.tsx` is layout.
 *
 * THE ORDER OF THE ARMS IS THE ARGUMENT. `placeholder` comes first because a symbol with no edition
 * has nothing to fetch, so neither a spinner nor an error about it is ever true. `ready` comes
 * before `error` because a page is a whole newspaper and a failed refresh is not grounds for taking
 * it away — `board.tsx`'s rule, read on another screen.
 */
export function paperPageOf(input: {
  paper: Paper
  cached: CachedEdition | null
  error: string | null
}): PaperPageState {
  if (input.paper.editionId === null) return { status: 'placeholder' }
  if (input.cached !== null) return { status: 'ready', cached: input.cached }
  if (input.error !== null) return { status: 'error', error: input.error }
  return { status: 'loading' }
}

/**
 * One page's data.
 *
 * `active` is "this page is the one on screen, or next to it". A pager mounts several pages at once
 * and fetching all five at a focus would be five authenticated requests for four pages nobody is
 * looking at; the screen passes `true` for the current index and its immediate neighbours, which is
 * what makes a swipe land on a page that is already there.
 *
 * THE SETTLED ENTRY LIVES IN THIS HOOK'S OWN STATE, in `{status: 'ready', cached}` — not read back
 * out of the module `Map` by a caller. A caller that wants to know what the whole app is currently
 * showing (`setCurrentEdition`, for the tile-detail route) reports IT UPWARD from this return value
 * when the page is active, rather than re-deriving it from `readPaperCache` on a timer: on first
 * load the entry is not filed yet at the moment a reader would need it, and a read keyed on
 * `[papers, index]` finds nothing and notifies nobody.
 *
 * The fetch is skipped outright when the cache already holds this edition — see the header: an
 * edition id is a content fingerprint, so there is nothing a revalidation could learn.
 */
export function usePaperPage(paper: Paper, active: boolean): PaperPageState {
  const editionId = paper.editionId
  const [cached, setCached] = useState<CachedEdition | null>(() =>
    editionId === null ? null : readPaperCache(editionId),
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (editionId === null) {
      setCached(null)
      setError(null)
      return
    }
    const hit = readPaperCache(editionId)
    // Set on BOTH a hit and a miss. A miss must still publish `null`: `editionId` may just have
    // changed to one this cache has never held, and the entry sitting in state belongs to whatever
    // this hook was showing a moment ago — a different company's front page under the new one's
    // header, if nothing here cleared it. That is R-13, and the fix is exactly this one line the
    // original draft left out: the hit branch called `setCached`, the miss branch did not.
    setCached(hit)
    setError(null)
    if (hit !== null || !active) return

    let alive = true
    void (async () => {
      const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
      if (!alive) return
      if (!address || !token) {
        // The credential went while this page was mounted — Settings forgot the token. The pager
        // itself comes down on the next list load; there is nothing useful to say on one page.
        return
      }
      const client = createDeskClient({ baseUrl: address, token })
      try {
        const got = await client.editionPayload(editionId)
        if (!alive) return
        if (got.status !== 'ok') return
        const source = client.editionSource(editionId)
        const entry: CachedEdition = {
          url: source.payloadUrl,
          etag: got.etag,
          fetchedAt: Date.now(),
          wire: got.wire,
          edition: got.edition,
          // THE SOURCE CARRIES THE BEARER, and this entry is never written down — see
          // `edition/store.ts`'s `source` field and its test pinning the four-key disk write.
          source,
        }
        putPaperCache(editionId, entry)
        setCached(entry)
        setError(null)
      } catch (e) {
        if (!alive) return
        // The edition client's own vocabulary, which the Today screen already draws.
        setError(humanEditionError(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [editionId, active])

  return paperPageOf({ paper, cached, error })
}

/** Test hook: empty the cache. */
export function __resetPaperCacheForTests(): void {
  byEdition.clear()
}
