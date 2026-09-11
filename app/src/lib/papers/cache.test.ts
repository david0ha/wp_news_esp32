import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import React from 'react'
import { act, create as renderTestTree, type ReactTestRenderer } from 'react-test-renderer'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  MAX_CACHED_PAPERS,
  paperPageOf,
  putPaperCache,
  readPaperCache,
  usePaperPage,
  __resetPaperCacheForTests,
  type PaperPageState,
} from './cache'
import { deviceSource } from '../edition/source'
import { demoEdition, demoWire } from '../edition/demo'
import { type CachedEdition } from '../edition/store'
import { type Paper } from '../desk'
import { __resetStoreCacheForTests } from '../store'
import { __resetDeskTokenCacheForTests } from '../deskToken'

const paper = (over: Partial<Paper> = {}): Paper => ({
  symbol: 'SNDK',
  name: 'SanDisk',
  editionId: 'e-sndk',
  createdAt: 1_757_000_000_000,
  lang: 'en',
  headline: 'The guide',
  onBoard: false,
  stale: false,
  ...over,
})

const entry = (url = 'https://d/api/editions/e-sndk/news.json'): CachedEdition => ({
  url,
  etag: null,
  fetchedAt: 1_757_000_000_000,
  wire: demoWire(),
  edition: demoEdition(),
  source: deviceSource(url),
})

beforeEach(() => __resetPaperCacheForTests())

describe('paperPageOf', () => {
  it('is a placeholder for a symbol the desk has not written yet', () => {
    // Not loading and not an error: the desk has SAID, in the list, that there is no paper. A
    // spinner would promise one within the second.
    expect(paperPageOf({ paper: paper({ editionId: null }), cached: null, error: null })).toEqual({
      status: 'placeholder',
    })
  })

  it('is a placeholder even while an error is in hand, because there is nothing to fetch', () => {
    expect(
      paperPageOf({ paper: paper({ editionId: null }), cached: null, error: 'boom' }),
    ).toEqual({ status: 'placeholder' })
  })

  it('is loading for a paper with an edition and nothing fetched yet', () => {
    expect(paperPageOf({ paper: paper(), cached: null, error: null })).toEqual({
      status: 'loading',
    })
  })

  it('is ready once the payload is in hand', () => {
    const c = entry()
    expect(paperPageOf({ paper: paper(), cached: c, error: null })).toEqual({
      status: 'ready',
      cached: c,
    })
  })

  it('keeps the page on screen when a refresh failed over content it already has', () => {
    // The page is a whole newspaper. Replacing it with an error card because a later fetch failed
    // is `board.tsx`'s rule read on another screen: a failure is never grounds for taking away
    // what is already drawn.
    const c = entry()
    expect(paperPageOf({ paper: paper(), cached: c, error: 'the desk did not answer' })).toEqual({
      status: 'ready',
      cached: c,
    })
  })

  it('is an error only when there is nothing to show', () => {
    expect(
      paperPageOf({ paper: paper(), cached: null, error: 'the desk did not answer' }),
    ).toEqual({ status: 'error', error: 'the desk did not answer' })
  })
})

describe('the per-edition cache', () => {
  it('files an entry under the edition id and hands it back', () => {
    const c = entry()
    putPaperCache('e-sndk', c)
    expect(readPaperCache('e-sndk')).toBe(c)
  })

  it('answers null for an edition it has never held', () => {
    expect(readPaperCache('e-nothing')).toBeNull()
  })

  it('holds one more edition than today’s watchlist, then evicts the oldest insertion', () => {
    expect(MAX_CACHED_PAPERS).toBe(6)
    for (let i = 0; i < MAX_CACHED_PAPERS + 1; i++) putPaperCache(`e${i}`, entry(`https://d/${i}`))
    expect(readPaperCache('e0')).toBeNull()
    expect(readPaperCache('e1')).not.toBeNull()
    expect(readPaperCache(`e${MAX_CACHED_PAPERS}`)).not.toBeNull()
  })

  it('re-filing an edition does not evict a different one', () => {
    for (let i = 0; i < MAX_CACHED_PAPERS; i++) putPaperCache(`e${i}`, entry(`https://d/${i}`))
    putPaperCache('e0', entry('https://d/0-again'))
    expect(readPaperCache('e1')).not.toBeNull()
    expect(readPaperCache('e0')?.url).toBe('https://d/0-again')
  })
})

// ---------------------------------------------------------------------------
// usePaperPage
//
// This app has no `@testing-library/react-native`, so the hook is driven the way
// `list.test.ts`'s `Probe` and `useAskThread.test.ts`'s `Harness` already do: a throwaway
// component stashes the hook's return value on a plain object, read back after each `act()`.
// No desk address or token is ever saved in this file, so `usePaperPage`'s fetch branch always
// finds `getDeskBaseUrl()` / `getDeskToken()` answering `null` and returns before touching the
// network — which is exactly what lets this pin R-13 without a `createDeskClient` mock: what is
// under test is the SYNCHRONOUS state the hook shows the instant `editionId` changes, not what a
// fetch eventually resolves to.
// ---------------------------------------------------------------------------

function Harness({
  paper: p,
  active,
  out,
}: {
  paper: Paper
  active: boolean
  out: { current: PaperPageState | null }
}) {
  out.current = usePaperPage(p, active)
  return null
}

describe('usePaperPage', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(async () => {
    await AsyncStorage.clear()
    __resetStoreCacheForTests()
    __resetDeskTokenCacheForTests()
  })

  afterEach(() => {
    if (renderer !== null) {
      act(() => {
        renderer!.unmount()
      })
      renderer = null
    }
  })

  it('reads a cached entry straight from the Map on first render, with no flash of loading', () => {
    const c = entry()
    putPaperCache('e-sndk', c)
    const out: { current: PaperPageState | null } = { current: null }
    act(() => {
      renderer = renderTestTree(React.createElement(Harness, { paper: paper(), active: true, out }))
    })
    expect(out.current).toEqual({ status: 'ready', cached: c })
  })

  it('clears the cached entry when editionId changes to one it has never held — R-13', () => {
    // Page starts on SNDK with its edition already cached...
    const sndk = entry('https://d/sndk')
    putPaperCache('e-sndk', sndk)
    const out: { current: PaperPageState | null } = { current: null }
    act(() => {
      renderer = renderTestTree(
        React.createElement(Harness, { paper: paper({ editionId: 'e-sndk' }), active: true, out }),
      )
    })
    expect(out.current).toEqual({ status: 'ready', cached: sndk })

    // ...then the same hook instance is handed a DIFFERENT paper, one this cache has never held.
    // Without the fix, `usePaperPage` only calls `setCached` on a cache HIT, so SNDK's front page
    // would stay on screen under the new company's header until a fetch that never lands (no
    // desk address is saved in this test) resolves — which is never.
    act(() => {
      renderer!.update(
        React.createElement(Harness, { paper: paper({ symbol: 'AAPL', editionId: 'e-aapl' }), active: true, out }),
      )
    })
    expect(out.current).not.toEqual({ status: 'ready', cached: sndk })
    expect(out.current).toEqual({ status: 'loading' })
  })

  it('clears the cached entry when editionId changes to null — no paper, no leftover page', () => {
    const sndk = entry('https://d/sndk')
    putPaperCache('e-sndk', sndk)
    const out: { current: PaperPageState | null } = { current: null }
    act(() => {
      renderer = renderTestTree(
        React.createElement(Harness, { paper: paper({ editionId: 'e-sndk' }), active: true, out }),
      )
    })
    expect(out.current).toEqual({ status: 'ready', cached: sndk })

    act(() => {
      renderer!.update(
        React.createElement(Harness, { paper: paper({ editionId: null }), active: true, out }),
      )
    })
    expect(out.current).toEqual({ status: 'placeholder' })
  })
})
