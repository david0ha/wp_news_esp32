// The Today tab's data loop: React state and effects wrapped around `nextEditionState`
// (./editionState), the pure function that actually decides what the screen shows. Every branch
// worth arguing about lives there and has a test; the effects below are deliberately dull,
// because there is no component test runner in this app to hold them to anything.
//
// ONE DRIVER, AND IT IS THE FOCUS CALLBACK. `useFocusEffect` fires on mount — the screen starts
// focused — as well as on every later return to the tab, so a separate mount effect is a second
// driver for the same event, and the two then have to be serialised by hand. The version this
// replaces did that with a `bootedRef` the focus callback checked before doing anything, which
// meant every focus DURING the first fetch was dropped rather than deferred: a URL saved in
// Settings while the old address was still burning its fifteen-second timeout was picked up only
// on the tab switch AFTER the one the user made, with nothing on screen to say why the save had
// no effect. Now the focus callback is the whole loop — read the stored URL, adopt it when it
// moved (or when this is the first run), otherwise ask `refresh()` for its silent, throttled
// re-check — and a save is adopted on the very next focus, always.
//
// THERE IS NO INTERVAL. The edition changes about once a day and the desk answers a conditional
// GET with a 304 for the rest of it, so a poll loop here would be a request every thirty seconds
// to be told nothing for twenty-three hours. A focus refresh older than five minutes, plus
// pull-to-refresh, is the whole cadence.

import { useCallback, useReducer, useRef } from 'react'
import { useFocusEffect } from 'expo-router'
import { getNewsUrl } from '../store'
import { editionClient, humanEditionError } from './client'
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

// Task 9 (and anyone else building a screen on this hook) reads the state shape from here rather
// than reaching into ./editionState directly, so this re-export is the one that matters; the
// reducer, the event union and the rest of the machine stay ./editionState's own surface.
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
          edition: result.edition,
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
      // Nothing to refresh against the demo; the bundled edition is the whole of it.
      if (url === null || url === '') return
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
    [runFetch],
  )

  // The whole loop, on every focus including the mount. Either the stored address is not the one
  // this hook is showing — a cold start, or a save made in Settings — and it is adopted, or it is
  // and `refresh()` applies its own silent, throttled re-check, the same rule a bare `refresh()`
  // call gets from anywhere.
  useFocusEffect(
    useCallback(() => {
      let alive = true
      void (async () => {
        // THE FIRST RUN READS THE DISK CACHE ALONGSIDE THE URL. The cache is not filed under the
        // URL on disk, so nothing here needs the URL to arrive before the other read can start,
        // and doing them one after another would cost a second AsyncStorage round trip on every
        // cold launch. Later focuses skip it: `adopt` reads the cache itself on the rare one that
        // finds the address changed, and the common focus does not need it at all.
        const cold = machineRef.current.url === null
        const [stored, cached] = await Promise.all([
          getNewsUrl(),
          cold ? readCachedEdition() : Promise.resolve(null),
        ])
        if (!alive) return
        const url = stored ?? ''
        if (url !== machineRef.current.url) {
          await adopt(url, cold ? cached : undefined)
          return
        }
        await refresh()
      })()
      return () => {
        alive = false
      }
    }, [adopt, refresh]),
  )

  return { state: machine.state, refresh }
}
