// The event book, fetched once for every surface that is only allowed to ADD.
//
// `/schedule` reads the book with its own effects, and reads it loudly: it has a spinner, three
// empty states and an error with a retry, because somebody who opened that screen asked a
// question and is owed an answer. The two surfaces this module exists for — the block at the top
// of Markets and a symbol's slice inside its Calendar section — asked nothing. They were complete
// before this feature and must stay complete after it, so every failure here is silent by design
// and `upcomingView` turns all of them into the same `hidden`.
//
// THE ONE RULE THAT IS NOT ABOUT RENDERING: a phone with no desk address and no operator token
// never calls `calendar()` at all. Not "calls it and hides the failure" — never calls it. There
// is nothing to call, and a request built out of a missing address is a request to somebody.
//
// ONE BOOK IN MEMORY, ONE CLOCK OVER IT, EVERY CONSUMER READING THE SAME COPY. The state below is
// module scope rather than per-hook, and that is the whole design rather than an optimisation.
// Both surfaces can be mounted at once — the Markets block and a symbol's Calendar section — and
// a per-instance `useState` gave them a fetch each and a resident `CalendarDoc` each, two copies
// of one document that could disagree about what is coming up. `useSyncExternalStore` is how a
// component subscribes to it; there is exactly one snapshot and every reader sees it.
//
// WHEN TO ASK AGAIN IS `bookFetchDue`, and it is pure and tested. Both surfaces fire `load` on an
// EDGE — every Markets focus, every `active` false→true — so an in-flight guard alone (which is
// all this had) collapses concurrent calls and nothing else: six screen transitions were eight
// bearer-authed requests for a document filed twice a day. `useEdition`'s idiom, and the same
// figure: a settle stamp compared against a constant.
//
// The token is read for the call and gone with the frame, `PositionSheet`'s and `schedule.tsx`'s
// rule: it lives in the keychain, reaches exactly one header inside `createDeskClient`, and is in
// nothing this module keeps. Note what that costs and what it buys — the throttle can therefore
// compare the desk ADDRESS across calls but not the token, so a token swapped for a different one
// against the same address is picked up on the next window rather than at once. Settings is where
// a token is changed and Settings asks the desk itself, so the one screen that would notice
// already has its own answer.

import { useCallback, useSyncExternalStore } from 'react'
import { createDeskClient } from './desk'
import { getDeskToken } from './deskToken'
import { getDeskBaseUrl } from './store'
import { type PositionsDoc } from './positions'
import { bookFetchDue, type CalendarDoc } from './schedule'

export interface EventBook {
  /** A desk address and an operator token are both saved on this phone. `null` while storage has
   *  not answered — which is not the same as "no desk", and neither draws anything. */
  ready: boolean | null
  /** The book; `null` for a desk that answered and has none, `undefined` for a call that has not
   *  produced one. A CALL THAT THREW LEAVES THIS ALONE, which is how a failure is reported here:
   *  a first fetch that failed stays `undefined` and draws nothing, and a refresh that failed
   *  over a book keeps the book, because there is nowhere on these surfaces to say so and a
   *  block that empties itself gives the owner nothing to act on. `upcomingView` reads the three
   *  states and needs no flag beside them. */
  doc: CalendarDoc | null | undefined
  /** The positions, for naming what an event reaches. A failure of THEIRS is swallowed whole and
   *  costs a label — `schedule.tsx` says why the book must not fail over its decoration. */
  book: PositionsDoc | null
}

const IDLE: EventBook = { ready: null, doc: undefined, book: null }

// ---------------------------------------------------------------------------
// The one copy
// ---------------------------------------------------------------------------

let current: EventBook = IDLE
/** The desk the copy above came from, or `null` when there is no copy. Not a credential: it is
 *  the same string Settings prints back at the owner. */
let cachedAddress: string | null = null
/** When the last call SETTLED, success or failure. `0` when none ever has. */
let fetchedAt = 0
/** The call currently out, so two surfaces mounting together ask one question between them. */
let inFlight: Promise<void> | null = null

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): EventBook {
  return current
}

/**
 * Swap the copy and tell every subscriber.
 *
 * Iterated over a COPY of the set: a listener is free to unsubscribe while being notified — a
 * component unmounting inside a re-render does exactly that — and mutating the set under its own
 * iterator is how one of the others silently gets skipped.
 */
function publish(next: EventBook): void {
  current = next
  for (const listener of [...listeners]) listener()
}

async function fetchBook(address: string, token: string): Promise<void> {
  const client = createDeskClient({ baseUrl: address, token })
  try {
    const [calendar, positions] = await Promise.all([
      client.calendar(),
      client.positions().catch(() => null),
    ])
    publish({ ready: true, doc: calendar, book: positions })
  } catch {
    // Whatever was in hand survives; only `ready` moves, because the desk WAS asked. See `doc`.
    publish({ ...current, ready: true })
  } finally {
    // Stamped on both arms. A settled failure is throttled exactly like a settled success —
    // `bookFetchDue` says why that is deliberate.
    cachedAddress = address
    fetchedAt = Date.now()
  }
}

/**
 * Ask the desk, or answer from the copy in memory.
 *
 * Exported beside the hook so a caller that is not a component — a test, or a screen that wants
 * the book warmed before it navigates — has the same one door. Never throws: this is the silent
 * half of the feature and there is no caller equipped to catch anything.
 */
export async function loadEventBook(): Promise<void> {
  if (inFlight !== null) return inFlight

  const run = (async () => {
    const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])

    if (!address || !token) {
      // No desk on this phone. Published rather than merely not-fetched, because forgetting the
      // token in Settings must take the book off both surfaces at once — and dropping `doc` here
      // is also what stops a book outliving the credentials it was fetched with.
      cachedAddress = null
      fetchedAt = 0
      // Guarded so a repeated focus on a phone with no desk is not a re-render apiece: the
      // snapshot has to keep its identity between real changes or every subscriber re-renders.
      if (current.ready !== false || current.doc !== undefined || current.book !== null) {
        publish({ ready: false, doc: undefined, book: null })
      }
      return
    }

    const due = bookFetchDue({
      now: Date.now(),
      fetchedAt,
      address,
      cachedAddress,
      cachedReady: current.ready,
    })
    if (!due) return
    await fetchBook(address, token)
  })()

  inFlight = run
  try {
    await run
  } finally {
    inFlight = null
  }
}

export function useEventBook(): EventBook & { load: () => Promise<void> } {
  // Third argument is the server snapshot, which react-native-web's static render asks for; it is
  // the same store, so it is the same function.
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  const load = useCallback(() => loadEventBook(), [])
  return { ...state, load }
}
