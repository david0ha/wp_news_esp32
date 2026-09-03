// The Today tab's data loop: React state and effects wrapped around `nextEditionState`
// (./editionState), the pure function that actually decides what the screen shows. Every branch
// worth arguing about lives there and has a test; the effects below are deliberately dull,
// because there is no component test runner in this app to hold them to anything.
//
// THERE IS NO INTERVAL. The edition changes about once a day and the desk answers a conditional
// GET with a 304 for the rest of it, so a poll loop here would be a request every thirty seconds
// to be told nothing for twenty-three hours. A focus refresh older than five minutes, plus
// pull-to-refresh, is the whole cadence.

import { useCallback, useEffect, useReducer, useRef } from 'react'
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
        await writeCachedEdition({ url, etag: result.etag, fetchedAt, edition: result.edition })
      } else {
        await touchCachedEdition(fetchedAt)
      }
      if (seqRef.current !== seq) return
      dispatch({ type: 'fetched', result, url, fetchedAt })
    } catch (e) {
      if (seqRef.current !== seq) return
      dispatch({ type: 'failed', error: humanEditionError(e) })
    }
  }, [])

  /** After the URL is known: publish the demo, or react to whatever cache (if any) goes with it. */
  const settle = useCallback(
    async (url: string, cached: CachedEdition | null) => {
      if (url === '') {
        // The detail route reads the current edition out of the store rather than off a prop, so
        // the demo has to be published there too or a tap opens nothing.
        setCurrentEdition(demoCache())
        return
      }
      dispatch({ type: 'cache', cached })
      await runFetch(url, cached !== null && cached.url === url ? cached.etag : null)
    },
    [runFetch],
  )

  /** Adopt a URL read after mount — a Settings change picked up on focus. */
  const adopt = useCallback(
    async (url: string) => {
      dispatch({ type: 'url', url })
      const cached = url === '' ? null : await readCachedEdition()
      await settle(url, cached)
    },
    [settle],
  )

  // Set once the cold-start effect below has fully settled — not merely started — so the focus
  // effect can tell "still booting" apart from "booted, and now looking at a real focus event".
  // See that effect for why this exists.
  const bootedRef = useRef(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      // The stored URL and the disk cache are two independent reads — the cache is not filed
      // under the URL on disk, so nothing here needs the URL to arrive before the other read can
      // start. Doing them one after another would cost a second AsyncStorage round trip on every
      // cold launch for nothing.
      const [url, cached] = await Promise.all([getNewsUrl(), readCachedEdition()])
      if (!alive) return
      const u = url ?? ''
      dispatch({ type: 'url', url: u })
      await settle(u, u === '' ? null : cached)
      bootedRef.current = true
    })()
    return () => {
      alive = false
    }
  }, [settle])

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
        // A silent call — the focus-effect's quiet re-check — only ever applies to a screen that
        // already has something on it, and only past the five-minute throttle; there is nothing
        // to silently re-check from a loading or an error screen, and no spinner to raise. The
        // throttle lives here, once, rather than as a second copy in the focus effect that could
        // drift from this one.
        if (state.status !== 'ready') return
        if (Date.now() - state.cached.fetchedAt < FOCUS_REFRESH_AFTER_MS) return
      }
      // The ETag goes either way: a 304 is the honest answer to "is this still current", and it
      // costs one round trip instead of twenty KB even on an explicit refresh.
      await runFetch(url, state.status === 'ready' ? state.cached.etag : null)
    },
    [runFetch],
  )

  // On return to the tab: pick up a URL changed in Settings, or otherwise defer to `refresh()`'s
  // own silent, throttled re-check — the same rule a bare `refresh()` call gets from anywhere.
  //
  // `useFocusEffect` fires once on mount (the screen starts focused) in addition to every later
  // return to the tab, and it fires from its own effect independently of the plain `useEffect`
  // above — so on a cold mount both run at nearly the same instant. This one would then read
  // `machineRef.current.url` while it is still `null` (the mount effect's first `dispatch` has
  // not landed yet), see a mismatch against the real URL, and call `adopt()` — a second disk read
  // and a second network request racing the mount effect's own. Skipping this callback until the
  // mount effect has fully settled makes the cold start one path; every later focus (by which
  // time `bootedRef.current` is long since true) runs exactly as before.
  useFocusEffect(
    useCallback(() => {
      if (!bootedRef.current) return
      void (async () => {
        const url = (await getNewsUrl()) ?? ''
        if (url !== machineRef.current.url) {
          await adopt(url)
          return
        }
        await refresh()
      })()
    }, [adopt, refresh]),
  )

  return { state: machine.state, refresh }
}
