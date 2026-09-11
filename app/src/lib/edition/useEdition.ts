// The Today tab's data loop: React state and effects wrapped around `nextEditionState`
// (./editionState), the pure function that actually decides what the screen shows. Every branch
// worth arguing about lives there and has a test; the effects below are deliberately dull,
// because there is no component test runner in this app to hold them to anything.
//
// ONE LOOP, TWO TRIGGERS. `load()` is the whole of it — read the address in force, adopt it when
// it moved (or when this is the first run), otherwise ask `refresh()` for its silent, throttled
// re-check. It is not a mount effect: `useFocusEffect` fires on mount as well as on every later
// return to the tab, so a separate mount effect would be a second driver for the same event and
// the two would have to be serialised by hand. The version this replaces did that with a
// `bootedRef` the focus callback checked before doing anything, which meant every focus DURING the
// first fetch was dropped rather than deferred: a URL saved in Settings while the old address was
// still burning its fifteen-second timeout was picked up only on the tab switch AFTER the one the
// user made, with nothing on screen to say why the save had no effect.
//
// The second trigger is the app returning to the FOREGROUND, which is a different event and was
// missing. A reader who leaves the app standing on Today and opens it again the next morning never
// changes tabs, so the focus callback does not fire and the page stays on yesterday's paper —
// exactly the failure this tab exists to avoid. Both triggers call the same `load()`.
//
// THERE IS NO INTERVAL. The edition changes about once a day and the desk answers a conditional
// GET with a 304 for the rest of it, so a poll loop here would be a request every thirty seconds
// to be told nothing for twenty-three hours. A focus refresh older than five minutes, plus
// pull-to-refresh, is the whole cadence.

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { getDeskBaseUrl, getNewsUrl } from '../store'
import { deviceSource, editionUrl } from './source'
import { editionClient, humanEditionError } from './client'
import { takeEditionStale } from './invalidate'
import {
  demoCache,
  FOCUS_REFRESH_AFTER_MS,
  INITIAL_EDITION_MACHINE,
  nextEditionState,
  type EditionState,
} from './editionState'
import { clearTilePngCache } from './photo'
import {
  readCachedEdition,
  setCurrentEdition,
  touchCachedEdition,
  writeCachedEdition,
  type CachedEdition,
} from './store'

// A screen built on this hook reads the state shape from here rather than reaching into
// ./editionState directly, so this re-export is the one that matters; the reducer, the event
// union and the rest of the machine stay ./editionState's own surface.
export type { EditionState }

export function useEdition(): {
  state: EditionState
  refresh: (opts?: { fresh?: boolean }) => Promise<void>
} {
  const [machine, dispatch] = useReducer(nextEditionState, INITIAL_EDITION_MACHINE)

  // A synchronous mirror, because the async passes below have to read the current URL and ETag
  // and a closed-over `machine` would be the one from the render that started them.
  const machineRef = useRef(machine)
  machineRef.current = machine

  // Discards a response that lands after the URL changed. The reducer refuses it too; this stops
  // the write to disk, which the reducer cannot.
  const seqRef = useRef(0)

  const runFetch = useCallback(async (url: string, etag: string | null) => {
    const seq = ++seqRef.current
    try {
      const result = await editionClient.fetch(url, etag)
      if (seqRef.current !== seq) return
      const fetchedAt = Date.now()
      if (result.status === 'ok') {
        const before = machineRef.current.state
        const previous = before.status === 'ready' ? before.cached.edition : null
        // Tile ids are the producer's and are not unique across days, so a picture cache that
        // outlived its edition could hand today's page yesterday's photograph under the same id.
        if (previous === null || previous.generatedAt !== result.edition.generatedAt) {
          clearTilePngCache()
        }
        // STARTED, NOT AWAITED, BEFORE THE DISPATCH. `writeCachedEdition` sets the in-memory copy
        // synchronously — before its own await — so the detail route sees the new edition either
        // way, and the reducer's URL guard is what actually keeps a stale response off the screen.
        // Awaiting the disk first held a fetched edition behind a spinner for the length of an
        // AsyncStorage round trip, buying nothing.
        const written = writeCachedEdition({
          url,
          etag: result.etag,
          fetchedAt,
          wire: result.wire,
          edition: result.edition,
          source: deviceSource(url),
        })
        dispatch({ type: 'fetched', result, url, fetchedAt })
        await written
        return
      }
      // A 304 moves only the timestamp, and it moves it in memory: there is no content to write,
      // and re-serialising a twenty-kilobyte edition to carry one integer to disk is the most
      // expensive possible answer to the poll that found nothing new. Synchronous, so nothing
      // between the guard above and the dispatch below can go stale.
      touchCachedEdition(fetchedAt)
      dispatch({ type: 'fetched', result, url, fetchedAt })
    } catch (e) {
      if (seqRef.current !== seq) return
      dispatch({ type: 'failed', url, error: humanEditionError(e) })
    }
  }, [])

  /**
   * Take up a URL: the one read on the first focus, or one saved in Settings since the last.
   *
   * THE SEQUENCE IS BUMPED HERE, at the moment the `url` event is dispatched and before the first
   * await. A fetch already in flight for the OLD address settles somewhere inside that await —
   * fifteen seconds is a long window — and until the bump it still passed `runFetch`'s guard: on
   * a failure it turned the new URL's `loading` into an error card, and on a success it wrote the
   * old desk's edition to disk and to `current` while the screen said loading for the new one.
   *
   * `prefetched` is `undefined` when the cache has not been read yet and `null` when it was read
   * and there was nothing there — the first focus reads it alongside the URL and passes it in,
   * every later adoption reads it here.
   */
  const adopt = useCallback(
    async (url: string, prefetched?: CachedEdition | null) => {
      seqRef.current++
      dispatch({ type: 'url', url })
      if (url === '') {
        // The detail route reads the current edition out of the store rather than off a prop, so
        // the demo has to be published there too or a tap opens nothing.
        setCurrentEdition(demoCache())
        return
      }
      const cached = prefetched === undefined ? await readCachedEdition() : prefetched
      dispatch({ type: 'cache', cached })
      await runFetch(url, cached !== null && cached.url === url ? cached.etag : null)
    },
    [runFetch],
  )

  const refresh = useCallback(
    async (opts: { fresh?: boolean } = {}) => {
      const current = machineRef.current
      const url = current.url
      if (url === null) return
      if (url === '') {
        // There is nothing to fetch against the bundled demo — but the gesture must not be dead.
        // A reader who has just saved an address in Settings and pulled down here got no request,
        // no spinner outcome and no change, on the one screen whose date is months old; the only
        // thing that picked the address up was a tab switch, which is not what they did. So an
        // explicit pull re-reads the stored address and adopts it if it has moved. A silent,
        // throttled focus re-check still does nothing: the focus callback already re-reads the
        // address itself, and doing it twice per focus buys a second disk read and no fact.
        if (!opts.fresh) return
        const stored = editionUrl(await getNewsUrl(), await getDeskBaseUrl())
        if (stored !== '' && stored !== machineRef.current.url) await adopt(stored)
        return
      }
      const state = current.state
      // The one rule: any call with `fresh: true` fetches, unconditionally; a silent call needs
      // a ready screen AND a `fetchedAt` older than the throttle.
      if (opts.fresh) {
        // An explicit pull-to-refresh — or a tap on Retry from the error screen — always goes,
        // and raises the spinner a ready screen shows while it runs. Retrying from `error` has
        // no `refreshing` to set (the reducer's `refreshing` event is a no-op off a ready
        // screen), but the fetch itself must still run, which is why this branch does not also
        // require `state.status === 'ready'` the way the silent branch below does.
        dispatch({ type: 'refreshing' })
      } else {
        // A silent call — the focus callback's quiet re-check — only ever applies to a screen
        // that already has something on it, and only past the five-minute throttle; there is
        // nothing to silently re-check from a loading or an error screen, and no spinner to
        // raise. The throttle lives here, once, rather than as a second copy in the focus
        // callback that could drift from this one.
        if (state.status !== 'ready') return
        if (Date.now() - state.cached.fetchedAt < FOCUS_REFRESH_AFTER_MS) return
      }
      // The ETag goes either way: a 304 is the honest answer to "is this still current", and it
      // costs one round trip instead of twenty KB even on an explicit refresh.
      await runFetch(url, state.status === 'ready' ? state.cached.etag : null)
    },
    [adopt, runFetch],
  )

  /**
   * The whole loop: read the address in force, adopt it if it moved, otherwise ask `refresh()` for
   * its silent, throttled re-check.
   *
   * THE ADDRESS IS TWO SETTINGS, NOT ONE. `editionUrl` prefers the edition address the reader
   * typed and falls back to the desk's own — `news.json` sits on the desk's host, unauthenticated,
   * so a phone that has been given a desk already knows where the paper is. Reading both here
   * rather than in the reducer keeps the machine's `url` what it has always been: the one address
   * being fetched, whatever decided it.
   */
  const load = useCallback(async (alive: () => boolean) => {
    // THE FIRST RUN READS THE DISK CACHE ALONGSIDE THE URL. The cache is not filed under the
    // URL on disk, so nothing here needs the URL to arrive before the other read can start,
    // and doing them one after another would cost a second AsyncStorage round trip on every
    // cold launch. Later runs skip it: `adopt` reads the cache itself on the rare one that
    // finds the address changed, and the common one does not need it at all.
    const cold = machineRef.current.url === null
    const [stored, desk, cached] = await Promise.all([
      getNewsUrl(),
      getDeskBaseUrl(),
      cold ? readCachedEdition() : Promise.resolve(null),
    ])
    if (!alive()) return
    // TAKEN BEFORE THE BRANCH, not inside it. `adopt` fetches unconditionally, so consuming the
    // flag on that path costs nothing and leaving it set would spend an unconditional fetch on
    // the next focus as well — a mark is one refetch, whichever way the address went.
    const forced = takeEditionStale()
    const url = editionUrl(stored, desk)
    if (url !== machineRef.current.url) {
      await adopt(url, cold ? cached : undefined)
      return
    }
    // `fresh` when the desk has just rewritten the paper: the five-minute throttle would
    // otherwise hold a revision the owner asked for and was told about, on the one screen it is
    // about, for up to five minutes.
    await refresh(forced ? { fresh: true } : {})
  }, [adopt, refresh])

  // On every focus, including the mount.
  useFocusEffect(
    useCallback(() => {
      let alive = true
      void load(() => alive)
      return () => {
        alive = false
      }
    }, [load]),
  )

  // AND ON EVERY RETURN TO THE FOREGROUND, which is not the same event and was the gap.
  // `useFocusEffect` fires when this SCREEN becomes focused; a reader who leaves the app standing
  // on Today and comes back the next morning never changes tabs, so nothing re-fired and the page
  // stayed on yesterday's paper until they pulled it down by hand. The throttle inside `refresh()`
  // is what keeps this from being a request every time the app is glanced at.
  //
  // Not gated on focus: `load` reads the address and either adopts or defers to that throttle, so
  // running it while another tab is on top costs one storage read and, past five minutes, one
  // conditional GET the desk answers with a 304.
  useEffect(() => {
    let alive = true
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void load(() => alive)
    })
    return () => {
      alive = false
      sub.remove()
    }
  }, [load])

  return { state: machine.state, refresh }
}
