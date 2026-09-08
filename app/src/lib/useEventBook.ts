// The event book, fetched for a surface that is only allowed to ADD.
//
// `/schedule` reads the book with its own effects, and reads it loudly: it has a spinner, three
// empty states and an error with a retry, because somebody who opened that screen asked a
// question and is owed an answer. The two surfaces this hook exists for — the block at the top of
// Markets and a symbol's slice inside its Calendar section — asked nothing. They were complete
// before this feature and must stay complete after it, so every failure here is silent by design
// and `upcomingView` turns all of them into the same `hidden`.
//
// THE ONE RULE THAT IS NOT ABOUT RENDERING: a phone with no desk address and no operator token
// never calls `calendar()` at all. Not "calls it and hides the failure" — never calls it. There
// is nothing to call, and a request built out of a missing address is a request to somebody.
//
// The token is read for the call and gone with the frame, `PositionSheet`'s and `schedule.tsx`'s
// rule: it lives in the keychain, reaches exactly one header inside `createDeskClient`, and is in
// no state this hook holds. Nothing rendered can carry what nothing rendered holds.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createDeskClient } from './desk'
import { getDeskToken } from './deskToken'
import { getDeskBaseUrl } from './store'
import { type PositionsDoc } from './positions'
import { type CalendarDoc } from './schedule'

export interface EventBook {
  /** A desk address and an operator token are both saved on this phone. `null` while storage has
   *  not answered — which is not the same as "no desk", and neither draws anything. */
  ready: boolean | null
  /** `undefined` until a call has settled; `null` for a desk that answered and has no book. */
  doc: CalendarDoc | null | undefined
  /** The positions, for naming what an event reaches. A failure of THEIRS is swallowed whole and
   *  costs a label — `schedule.tsx` says why the book must not fail over its decoration. */
  book: PositionsDoc | null
  /** The last `calendar()` threw. Never rendered as an error on these surfaces; it is here so
   *  `upcomingView` can say what it means, which is "hide, unless a book is already in hand". */
  failed: boolean
}

const IDLE: EventBook = { ready: null, doc: undefined, book: null, failed: false }

export function useEventBook(): EventBook & { load: () => Promise<void> } {
  const [state, setState] = useState<EventBook>(IDLE)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // These surfaces fire `load` from a focus callback and from an `active` prop, both of which can
  // repeat while a call is still out. One at a time: the desk is somebody's own small server and
  // a screen re-entered three times is not three questions.
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const [address, token] = await Promise.all([getDeskBaseUrl(), getDeskToken()])
      if (!alive.current) return
      if (!address || !token) {
        setState({ ready: false, doc: undefined, book: null, failed: false })
        return
      }
      const client = createDeskClient({ baseUrl: address, token })
      try {
        const [calendar, positions] = await Promise.all([
          client.calendar(),
          client.positions().catch(() => null),
        ])
        if (!alive.current) return
        setState({ ready: true, doc: calendar, book: positions, failed: false })
      } catch {
        // The book already in hand survives a refresh that failed. There is nowhere on these two
        // surfaces to say a fetch failed — that sentence belongs to `/schedule` — so the choice
        // is between the last thing the desk actually said and a block that empties itself for
        // no visible reason the owner can act on.
        if (!alive.current) return
        setState((prev) => ({ ...prev, ready: true, failed: true }))
      }
    } finally {
      inFlight.current = false
    }
  }, [])

  return { ...state, load }
}
