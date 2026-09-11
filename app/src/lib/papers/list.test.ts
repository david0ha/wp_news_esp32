import { describe, it, expect } from '@jest/globals'
import { PAPERS_REFRESH_AFTER_MS, papersFetchDue } from './list'

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
