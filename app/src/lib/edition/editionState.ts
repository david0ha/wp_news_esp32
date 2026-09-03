// The Today tab's decision: what the screen shows, given the URL, the disk cache and each
// fetch's outcome.
//
// THE DECISION IS A PURE FUNCTION. `nextEditionState(prev, event)` takes the whole question —
// URL, cache, fetch outcome — and answers it with no clock, no storage and no React, so it has a
// test. There is no component test runner in this app, so anything left inside `useEdition.ts`'s
// hook body is untested by construction; every branch worth arguing about lives here instead.
//
// THIS MODULE IMPORTS NOTHING FROM REACT NATIVE OR EXPO-ROUTER, ON PURPOSE. `useEdition.ts` is
// the only thing that wraps this in React state and effects; keeping the decision itself free of
// that dependency means its test runs under a plain Jest transform, with nothing to allowlist.
//
// THE LOAD ORDER: read the stored news URL and the cache in parallel -> if the cache belongs to
// that URL, put it on screen at once and mark it refreshing -> fetch with the cached ETag. A
// success replaces the edition, a 304 moves only the timestamp, a failure keeps what is on
// screen and raises a banner. With no cache the screen is `loading` until the fetch settles.
// With no URL at all the demo goes up and no request is made.

import { type EditionFetch } from './client'
import { demoEdition } from './demo'
import { type CachedEdition } from './store'

/** How stale the thing on screen has to be before a return to the tab quietly re-checks it. */
export const FOCUS_REFRESH_AFTER_MS = 5 * 60_000

export type EditionState =
  | { status: 'loading' }
  | {
      status: 'ready'
      cached: CachedEdition
      /** The bundled edition is on screen because this phone has no URL. */
      demo: boolean
      refreshing: boolean
      /** A failed refresh, with content still showing. The banner, never the whole screen. */
      error: string | null
    }
  | { status: 'error'; error: string }

/**
 * The state plus the URL it is about.
 *
 * The URL is not part of `EditionState` because the screen never renders it, but both of the
 * reducer's guards are questions about it — "is this cache this desk's?" and "is this response
 * still the one we asked for?" — and answering them anywhere else means answering them twice.
 */
export interface EditionMachine {
  /** `null` = the disk has not answered yet. `''` = there is no URL, which means the demo. */
  url: string | null
  state: EditionState
}

export type EditionEvent =
  | { type: 'url'; url: string }
  | { type: 'cache'; cached: CachedEdition | null }
  | { type: 'fetched'; result: EditionFetch; url: string; fetchedAt: number }
  | { type: 'failed'; url: string; error: string }
  | { type: 'refreshing' }

export const INITIAL_EDITION_MACHINE: EditionMachine = { url: null, state: { status: 'loading' } }

/**
 * The demo, dressed as a cache entry so every consumer sees one shape.
 *
 * `fetchedAt: 0` is load-bearing: `freshnessLabel` answers null for it, so the demo carries no
 * "Updated 3h ago" line about a fetch that never happened.
 */
export function demoCache(): CachedEdition {
  return { url: '', etag: null, fetchedAt: 0, edition: demoEdition() }
}

export function nextEditionState(prev: EditionMachine, event: EditionEvent): EditionMachine {
  switch (event.type) {
    case 'url': {
      if (event.url === prev.url) return prev
      // No URL means the demo, at once and with no request. An unconfigured phone is a complete
      // configuration, exactly as an unconfigured board is.
      if (event.url === '') {
        return {
          url: '',
          state: { status: 'ready', cached: demoCache(), demo: true, refreshing: false, error: null },
        }
      }
      // A different desk. Whatever is on screen belongs to the old one and is not today's paper
      // for the new one.
      return { url: event.url, state: { status: 'loading' } }
    }

    case 'cache': {
      // Only ever fills an empty screen. A cache that lands after a fetch already did would put
      // older content over newer.
      if (prev.state.status !== 'loading') return prev
      if (event.cached === null || prev.url === null || event.cached.url !== prev.url) return prev
      return {
        ...prev,
        state: {
          status: 'ready',
          cached: event.cached,
          demo: false,
          refreshing: true,
          error: null,
        },
      }
    }

    case 'fetched': {
      // The URL moved while this was in flight.
      if (event.url !== prev.url) return prev
      if (event.result.status === 'ok') {
        return {
          ...prev,
          state: {
            status: 'ready',
            cached: {
              url: event.url,
              etag: event.result.etag,
              fetchedAt: event.fetchedAt,
              edition: event.result.edition,
            },
            demo: false,
            refreshing: false,
            error: null,
          },
        }
      }
      // A 304 confirms content. With nothing on screen there is nothing to confirm — and this
      // cannot happen anyway, because no ETag is sent without a cache behind it.
      if (prev.state.status !== 'ready') return prev
      return {
        ...prev,
        state: {
          ...prev.state,
          cached: { ...prev.state.cached, fetchedAt: event.fetchedAt },
          refreshing: false,
          error: null,
        },
      }
    }

    case 'failed': {
      // The URL moved while this was in flight — the same guard `fetched` carries, and for a
      // sharper reason. A failure has no content behind it to be checked later: an old desk's
      // 15-second timeout landing after Settings changed the address would put an error card up
      // about a desk the reader has just left, AND swallow the new URL's `cache` event behind it,
      // because that one only ever fills a `loading` screen.
      if (event.url !== prev.url) return prev
      // Content beats an error card: a stale front page is still the company's day, and the
      // banner says the refresh failed. Only a first load with nothing behind it takes the screen.
      if (prev.state.status === 'ready') {
        return { ...prev, state: { ...prev.state, refreshing: false, error: event.error } }
      }
      return { ...prev, state: { status: 'error', error: event.error } }
    }

    case 'refreshing': {
      if (prev.state.status !== 'ready') return prev
      // A standing banner stays up while the retry runs. Clearing it here would blink it out and
      // straight back in on a retry that fails the same way.
      return { ...prev, state: { ...prev.state, refreshing: true } }
    }
  }
}
