// A test of ONE thing in `useEdition`: what a fetch that lands after the hook is gone is allowed
// to do. Everything else about this hook is a property of `nextEditionState`, which is pure and
// tested next door in `editionState.test.ts`; the effects here are deliberately dull. This file
// exists because the one defect a task-level diff could never show lives exactly in the gap
// between them — the write to the module-wide current-edition slot, which the reducer cannot see
// and which a dead component used to be able to make.
//
// THE FAILURE THIS PINS. On a phone with a desk token, Today draws the preserved single-page
// reader (`TodayEdition`) for the first frames, because the paper list has not arrived yet. That
// mounts this hook, which adopts `editionUrl(newsUrl, deskBaseUrl)` and starts a `/news.json`
// fetch. When the list lands the pager takes over and `TodayEdition` unmounts — but nothing
// cancelled the fetch, so its response still called `writeCachedEdition`, which sets `current`
// synchronously. `PaperPage` had already published its own settled entry into that slot and its
// effect's deps (`[active, settled]`) never fire again, so a tile tapped on page three opened the
// board paper's story. `seqRef` did not catch it: it is per-instance and nothing bumps it on
// unmount.
//
// THE HARNESS is `useAskThread.test.ts`'s — this app has no `@testing-library/react-native` and
// `react-test-renderer` is what is already in `node_modules`. A throwaway component renders the
// hook and stashes its return on a plain object; `expo-router`'s `useFocusEffect` is stubbed to a
// real `useEffect` so its callback and cleanup run under normal React semantics.
//
// THE FETCH IS DEFERRED BY HAND rather than by a timer. The point of the test is the ORDER of two
// events — the unmount and the resolution — and a promise this file resolves itself is the only
// way to put the unmount strictly between the request and its answer. Resolving before the unmount
// would test nothing: that is the ordinary path, and it passes with or without the fix.

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import React from 'react'
import { act, create as renderTestTree, type ReactTestRenderer } from 'react-test-renderer'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEdition, type EditionState } from './useEdition'
import { type EditionFetch } from './client'
import { demoEdition, demoWire } from './demo'
import { deviceSource } from './source'
import {
  __resetEditionStoreForTests,
  getCurrentEdition,
  setCurrentEdition,
  type CachedEdition,
} from './store'
import { __resetEditionStaleForTests } from './invalidate'

jest.mock('expo-router', () => {
  // `require`d inside the factory: Jest hoists `jest.mock` above the module's own imports and
  // refuses to close over anything from outside it.
  const ReactActual = require('react')
  return {
    useFocusEffect: (cb: () => void | (() => void)) => {
      ReactActual.useEffect(() => cb(), [cb])
    },
  }
})

// The address is read from `lib/store.ts`, which caches in memory and normalises what it is given.
// Answering the two questions directly is both shorter and immune to that cache.
jest.mock('../store', () => {
  const actual = jest.requireActual('../store')
  return { ...(actual as object), getNewsUrl: jest.fn(), getDeskBaseUrl: jest.fn() }
})

// Everything real except the one call that reaches the network. `client.test.ts` owns the request
// this replaces; what is under test here is when the hook is allowed to ACT on the answer.
jest.mock('./client', () => {
  const actual = jest.requireActual('./client')
  return {
    ...(actual as object),
    editionClient: { fetch: jest.fn(), fetchTile: jest.fn() },
  }
})

const { getNewsUrl, getDeskBaseUrl } = jest.requireMock('../store') as {
  getNewsUrl: jest.Mock<() => Promise<string | null>>
  getDeskBaseUrl: jest.Mock<() => Promise<string | null>>
}
const { editionClient } = jest.requireMock('./client') as {
  editionClient: { fetch: jest.Mock<() => Promise<EditionFetch>> }
}

const URL = 'http://desk.local:8123/news.json'

/** A sentinel entry, so "the slot was not touched" is an identity check and not a shape one. */
const SENTINEL: CachedEdition = {
  url: 'http://elsewhere.invalid/papers/SNDK/news.json',
  etag: null,
  fetchedAt: 1_700_000_000_000,
  wire: demoWire(),
  edition: demoEdition(),
  source: deviceSource('http://elsewhere.invalid/papers/SNDK/news.json'),
}

function okResult(): EditionFetch {
  return { status: 'ok', edition: demoEdition(), wire: demoWire(), etag: 'W/"late"' }
}

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function Harness({ out }: { out: { current: EditionState | null } }) {
  out.current = useEdition().state
  return null
}

let renderer: ReactTestRenderer | null = null

async function mount(): Promise<{ current: EditionState | null }> {
  const out: { current: EditionState | null } = { current: null }
  await act(async () => {
    renderer = renderTestTree(React.createElement(Harness, { out }))
    await settle()
  })
  return out
}

beforeEach(async () => {
  await AsyncStorage.clear()
  __resetEditionStoreForTests()
  __resetEditionStaleForTests()
  getNewsUrl.mockResolvedValue(URL)
  getDeskBaseUrl.mockResolvedValue(null)
  editionClient.fetch.mockReset()
})

afterEach(() => {
  if (renderer) {
    act(() => {
      renderer!.unmount()
    })
    renderer = null
  }
})

describe('useEdition and the current-edition slot', () => {
  it('does not write the current-edition slot from a fetch that resolves after unmount', async () => {
    // A fetch this file holds open, so the unmount lands strictly between the request and its
    // answer — which is the whole of the defect.
    let answer: ((r: EditionFetch) => void) | null = null
    editionClient.fetch.mockImplementation(
      () =>
        new Promise<EditionFetch>((resolve) => {
          answer = resolve
        }),
    )

    await mount()
    // The request really is in flight. Without this the rest of the test could pass against a hook
    // that never fetched at all.
    expect(editionClient.fetch).toHaveBeenCalledTimes(1)
    expect(answer).not.toBeNull()

    await act(async () => {
      renderer!.unmount()
      await settle()
    })
    renderer = null

    // Stands in for the pager's own page publishing the entry it rendered (`PaperPage` →
    // `setCurrentEdition`). This is the value the late response used to destroy.
    setCurrentEdition(SENTINEL)

    await act(async () => {
      answer!(okResult())
      await settle()
    })

    // The slot still holds what the live screen put there, and the dead hook's edition never
    // reached the disk either.
    expect(getCurrentEdition()).toBe(SENTINEL)
    expect(await AsyncStorage.getItem('claudepost.edition')).toBeNull()
  })

  it('still writes the slot when the hook is alive, which is the whole of the demo path', async () => {
    // THE CONTROL. The guard added for the test above must change exactly one thing — what an
    // UNMOUNTED hook does — and nothing about a mounted one. Without this, a guard that was simply
    // always false would pass the first test.
    editionClient.fetch.mockResolvedValue(okResult())
    setCurrentEdition(SENTINEL)

    await mount()
    await act(async () => {
      await settle()
    })

    const now = getCurrentEdition()
    expect(now).not.toBe(SENTINEL)
    expect(now?.url).toBe(URL)
    expect(now?.etag).toBe('W/"late"')
  })
})
