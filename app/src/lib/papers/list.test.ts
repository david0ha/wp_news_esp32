import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import React from 'react'
import { act, create as renderTestTree } from 'react-test-renderer'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  PAPERS_REFRESH_AFTER_MS,
  papersFetchDue,
  loadPapers,
  usePapers,
  __resetPapersForTests,
} from './list'
import { createDeskClient, type DeskClient, type PapersDoc } from '../desk'
import { saveDeskBaseUrl, __resetStoreCacheForTests } from '../store'
import { saveDeskToken, __resetDeskTokenCacheForTests } from '../deskToken'

jest.mock('../desk', () => {
  const actual = jest.requireActual('../desk')
  // Everything real except the one call this module makes to reach the network at all — the same
  // seam `useAskThread.test.ts` uses for the same reason: `list.ts` exposes no `fetchFn`, so this
  // is the only door in from a test.
  return { ...(actual as object), createDeskClient: jest.fn() }
})

const mockCreateDeskClient = jest.mocked(createDeskClient)

const base = {
  now: 1_000_000,
  fetchedAt: 1_000_000 - 1000,
  address: 'https://desk.example.dev',
  cachedAddress: 'https://desk.example.dev',
  cachedReady: true as boolean | null,
  forced: false,
}

describe('papersFetchDue', () => {
  it('is the same five minutes Today already waits', () => {
    // Today's focus re-check is throttled to `FOCUS_REFRESH_AFTER_MS`. The list and the page it
    // frames must move on the same clock, or a header would say one thing and the sheet another.
    expect(PAPERS_REFRESH_AFTER_MS).toBe(5 * 60_000)
  })

  it('does not refetch inside the window', () => {
    expect(papersFetchDue(base)).toBe(false)
  })

  it('refetches past the window', () => {
    expect(papersFetchDue({ ...base, fetchedAt: base.now - PAPERS_REFRESH_AFTER_MS })).toBe(true)
  })

  it('refetches when the desk address moved, whatever the clock says', () => {
    expect(papersFetchDue({ ...base, cachedAddress: 'https://other.example.dev' })).toBe(true)
    expect(papersFetchDue({ ...base, cachedAddress: null })).toBe(true)
  })

  it('refetches when no desk has actually been asked yet', () => {
    expect(papersFetchDue({ ...base, cachedReady: null })).toBe(true)
    expect(papersFetchDue({ ...base, cachedReady: false })).toBe(true)
  })

  it('refetches on a mark, inside the window', () => {
    // The desk rewrote a paper and told this phone so. Waiting out four more minutes on the one
    // screen the change is about is the failure `invalidate.ts` exists to prevent.
    expect(papersFetchDue({ ...base, forced: true })).toBe(true)
  })
})

describe('loadPapers, the double driver', () => {
  const BASE_URL = 'https://desk.example.dev'
  const TOKEN = 'operator-token-for-tests'

  const doc: PapersDoc = {
    papers: [
      {
        symbol: 'ACME',
        name: 'Acme Corp',
        editionId: 'ed1',
        createdAt: 1_700_000_000_000,
        lang: 'en',
        headline: 'Acme rallies',
        onBoard: true,
        stale: false,
      },
    ],
    board: 'ed1',
  }

  beforeEach(async () => {
    await AsyncStorage.clear()
    __resetStoreCacheForTests()
    __resetDeskTokenCacheForTests()
    __resetPapersForTests()
    mockCreateDeskClient.mockReset()
    await saveDeskBaseUrl(BASE_URL)
    await saveDeskToken(TOKEN)
  })

  it('makes exactly one request when Today and the Board tab both call it at once, and both settle to the same doc', async () => {
    // Two mounted subscribers both fire `loadPapers()` from their own focus effect. Nothing about
    // this store may turn that into two `GET /api/papers` — that is the whole reason `inFlight`
    // exists, and this is the only test that would notice if a refactor quietly removed it.
    let resolvePapers!: (value: PapersDoc) => void
    const papersPromise = new Promise<PapersDoc>((resolve) => {
      resolvePapers = resolve
    })
    const papers = jest.fn(() => papersPromise)
    mockCreateDeskClient.mockReturnValue({ papers } as unknown as DeskClient)

    const first = loadPapers()
    const second = loadPapers()

    resolvePapers(doc)
    await first
    await second

    expect(mockCreateDeskClient).toHaveBeenCalledTimes(1)
    expect(papers).toHaveBeenCalledTimes(1)

    // Today's pager and the Board tab's section are two separate `usePapers()` mounts reading the
    // one snapshot this store publishes — `list.ts`'s own header comment says a `useState` apiece
    // would let them disagree about which paper is on the board. Prove they see the identical object.
    function Probe({ out }: { out: { current: ReturnType<typeof usePapers> | null } }) {
      out.current = usePapers()
      return null
    }
    const today: { current: ReturnType<typeof usePapers> | null } = { current: null }
    const board: { current: ReturnType<typeof usePapers> | null } = { current: null }
    act(() => {
      renderTestTree(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Probe, { out: today }),
          React.createElement(Probe, { out: board }),
        ),
      )
    })

    expect(today.current?.doc).toEqual(doc)
    expect(board.current?.doc).toBe(today.current?.doc)
  })
})
