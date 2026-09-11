// The paper list, fetched once for the two surfaces that read it.
//
// ONE COPY, ONE CLOCK, EVERY READER ON THE SAME SNAPSHOT — `lib/useEventBook.ts`'s shape, for
// `useEventBook`'s reason. Today's pager and the Board tab's section can be mounted at the same
// moment, and a `useState` apiece would give them a fetch apiece and let them disagree about which
// paper is on the board — which is exactly the fact one of them draws a tick beside.
//
// THE ONE RULE THAT IS NOT ABOUT RENDERING: a phone with no desk address and no operator token
// never calls `/api/papers` at all. Not "calls it and hides the failure" — never calls it. A
// request built out of a missing address is a request to somebody.
//
// A FAILURE LEAVES THE LIST ALONE. `ready` moves, because the desk WAS asked, and `doc` keeps
// whatever it had. Dropping the list on a failed refresh would collapse a five-page pager to the
// single-page reader mid-read, on a phone whose only problem is a tunnel that blinked.
//
// The token is read for the call and gone with the frame — `useEventBook`'s rule and `desk.ts`'s:
// it lives in the keychain, reaches exactly one header inside `createDeskClient`, and is in nothing
// this module keeps.

import { useCallback, useSyncExternalStore } from 'react'
import { createDeskClient, type PapersDoc } from '../desk'
import { getDeskToken } from '../deskToken'
import { getDeskBaseUrl } from '../store'
import { FOCUS_REFRESH_AFTER_MS } from '../edition/editionState'
import { takePapersStale } from '../edition/invalidate'

export interface PapersState {
  /** A desk address and an operator token are both saved. `null` while storage has not answered. */
  ready: boolean | null
  /** The list, or `null` for a call that has not produced one. A THROW LEAVES THIS ALONE. */
  doc: PapersDoc | null
}

/**
 * The same five minutes Today already waits on, imported rather than cloned: the spec says the
 * list is refetched on focus "with the same throttle Today uses now", and a second constant that
 * happens to equal this one is exactly the drift that instruction forbids. If the two ever need to
 * move apart, that is a decision to make at the import, not a difference to discover later between
 * two literals nobody is comparing.
 */
export const PAPERS_REFRESH_AFTER_MS = FOCUS_REFRESH_AFTER_MS

/**
 * Whether to ask again. Pure, and the whole cadence.
 *
 * `forced` is the mark from `invalidate.ts`. Everything else is `bookFetchDue`'s shape and for its
 * reasons: a changed desk address invalidates the copy outright, and a copy that was never really
 * fetched (`cachedReady !== true`) is not a copy to throttle against.
 */
export function papersFetchDue(input: {
  now: number
  fetchedAt: number
  address: string
  cachedAddress: string | null
  cachedReady: boolean | null
  forced: boolean
}): boolean {
  if (input.forced) return true
  if (input.address !== input.cachedAddress) return true
  if (input.cachedReady !== true) return true
  return input.now - input.fetchedAt >= PAPERS_REFRESH_AFTER_MS
}

// ---------------------------------------------------------------------------
// The one copy
// ---------------------------------------------------------------------------

const IDLE: PapersState = { ready: null, doc: null }

let current: PapersState = IDLE
let cachedAddress: string | null = null
let fetchedAt = 0
let inFlight: Promise<void> | null = null

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): PapersState {
  return current
}

/** Swap the copy and tell every subscriber, over a COPY of the set — a listener may unsubscribe
 *  while being notified, which a component unmounting inside a re-render does. */
function publish(next: PapersState): void {
  current = next
  for (const listener of [...listeners]) listener()
}

/**
 * The remembered page, for THIS SESSION ONLY.
 *
 * Module scope and not AsyncStorage, and the spec says so: "page position is remembered for the
 * session, not persisted". A persisted index would open tomorrow's app on the page a reader left
 * yesterday, over a watchlist that may have moved under it — and the page worth opening on is
 * always the board's, which is page 0 by construction.
 */
let rememberedIndex = 0

export function rememberPaperIndex(index: number): void {
  rememberedIndex = index
}

export function lastPaperIndex(): number {
  return rememberedIndex
}

/**
 * Ask the desk, or answer from the copy in memory. Never throws: both callers are focus effects
 * and neither is equipped to catch anything.
 */
export async function loadPapers(): Promise<void> {
  if (inFlight !== null) return inFlight

  const run = (async () => {
    const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])

    if (!address || !token) {
      // No desk on this phone. PUBLISHED rather than merely not-fetched, because forgetting the
      // token in Settings must take the pager down at once — and dropping `doc` here is what stops
      // a list outliving the credential it was fetched with. Guarded so a repeated focus on a
      // deskless phone is not a re-render apiece.
      cachedAddress = null
      fetchedAt = 0
      if (current.ready !== false || current.doc !== null) publish({ ready: false, doc: null })
      return
    }

    // TAKEN BEFORE THE DUE CHECK, not inside it, and unconditionally: a mark is one refetch, and
    // leaving it set because this pass was already due would spend a second one on the next focus.
    const forced = takePapersStale()
    const due = papersFetchDue({
      now: Date.now(),
      fetchedAt,
      address,
      cachedAddress,
      cachedReady: current.ready,
      forced,
    })
    if (!due) return

    try {
      const doc = await createDeskClient({ baseUrl: address, token }).papers()
      publish({ ready: true, doc })
    } catch {
      // Whatever was in hand survives; only `ready` moves, because the desk WAS asked. A pager
      // that collapsed to one page because a tunnel blinked is worse than one showing a list a few
      // minutes old, and the header on each page says how old the paper itself is anyway.
      publish({ ...current, ready: true })
    } finally {
      // Stamped on BOTH arms. A settled failure is throttled exactly like a settled success, or a
      // desk that is down becomes a request every time the tab is touched.
      cachedAddress = address
      fetchedAt = Date.now()
    }
  })()

  inFlight = run
  try {
    await run
  } finally {
    inFlight = null
  }
}

export function usePapers(): PapersState & { load: () => Promise<void> } {
  // Third argument is the server snapshot, which react-native-web's static render asks for; it is
  // the same store, so it is the same function.
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  const load = useCallback(() => loadPapers(), [])
  return { ...state, load }
}

/** Test hook: forget the copy, the clock and the remembered page. */
export function __resetPapersForTests(): void {
  current = IDLE
  cachedAddress = null
  fetchedAt = 0
  inFlight = null
  rememberedIndex = 0
}
