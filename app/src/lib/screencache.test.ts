// The one-entry decode cache, and the fingerprint that keys it.
//
// Two facts force this file's shape. A decoded framebuffer is about 2.6 MB of base64 for 1.92
// million pixels, so holding two is a real cost on a phone; and /api/state carries no `news_hash`
// (device_api_json.c never emits one), so the key has to be assembled here out of the fields that
// CAN change what is on the glass. Over-invalidating costs one re-fetch. Under-invalidating shows
// a sheet that is not the one hanging on the wall, which is the failure worth being careful about.
import { describe, it, expect, beforeEach } from '@jest/globals'
import {
  screenCacheClear,
  screenCacheGet,
  screenCachePut,
  screenFingerprint,
  type ScreenIdentity,
} from './screencache'

function identity(over: Partial<{
  page: number
  valid: boolean
  demo: boolean
  edition: string
  generatedAt: string
  symbol: string
  stale: boolean
}> = {}): ScreenIdentity {
  return {
    page: over.page ?? 0,
    news: {
      valid: over.valid ?? true,
      demo: over.demo ?? false,
      edition: over.edition ?? 'SEMICONDUCTORS',
      generatedAt: over.generatedAt ?? '2026-08-14T05:12:00Z',
      subject: { symbol: over.symbol ?? 'SNDK' },
    },
    source: { stale: over.stale ?? false },
  }
}

describe('screenFingerprint', () => {
  it('is empty for a board that has not answered — an unknown glass cannot be cached', () => {
    expect(screenFingerprint(undefined)).toBe('')
  })

  it('is stable for the same board state', () => {
    expect(screenFingerprint(identity())).toBe(screenFingerprint(identity()))
  })

  it('is never empty once there IS a state, even one that has never polled successfully', () => {
    expect(screenFingerprint(identity({ valid: false, edition: '', generatedAt: '', symbol: '' })))
      .not.toBe('')
  })

  it('changes with the page — A1 and A2 are two different framebuffers', () => {
    expect(screenFingerprint(identity({ page: 0 }))).not.toBe(screenFingerprint(identity({ page: 1 })))
  })

  it('changes with a new edition', () => {
    expect(screenFingerprint(identity())).not.toBe(
      screenFingerprint(identity({ generatedAt: '2026-08-15T05:12:00Z' })),
    )
    expect(screenFingerprint(identity())).not.toBe(screenFingerprint(identity({ symbol: 'MU' })))
    expect(screenFingerprint(identity())).not.toBe(
      screenFingerprint(identity({ edition: 'MEMORY' })),
    )
  })

  it('changes when the STALE badge goes up — the badge is ink on the sheet, not chrome', () => {
    expect(screenFingerprint(identity())).not.toBe(screenFingerprint(identity({ stale: true })))
  })

  it('changes between the demo edition and a real one', () => {
    expect(screenFingerprint(identity())).not.toBe(screenFingerprint(identity({ demo: true })))
  })

  it('changes when a board that never had a good poll finally gets one', () => {
    expect(screenFingerprint(identity({ valid: false }))).not.toBe(screenFingerprint(identity()))
  })

  it('separates fields, so two states cannot collide by running their values together', () => {
    const a = screenFingerprint(identity({ edition: 'AB', generatedAt: 'C' }))
    const b = screenFingerprint(identity({ edition: 'A', generatedAt: 'BC' }))
    expect(a).not.toBe(b)
  })
})

describe('the one-entry cache', () => {
  beforeEach(() => screenCacheClear())

  it('gives back exactly what it was handed', () => {
    screenCachePut('k', 'PNG')
    expect(screenCacheGet('k')).toBe('PNG')
  })

  it('misses on a different key rather than returning the sheet it has', () => {
    screenCachePut('k', 'PNG')
    expect(screenCacheGet('other')).toBeNull()
  })

  it('holds ONE entry — a second put evicts the first, so 2.6 MB never becomes 5.2', () => {
    screenCachePut('a', 'FIRST')
    screenCachePut('b', 'SECOND')
    expect(screenCacheGet('a')).toBeNull()
    expect(screenCacheGet('b')).toBe('SECOND')
  })

  it('refuses to store under the empty key — an unknown glass must always re-read', () => {
    screenCachePut('', 'PNG')
    expect(screenCacheGet('')).toBeNull()
  })

  it('is empty after a clear', () => {
    screenCachePut('k', 'PNG')
    screenCacheClear()
    expect(screenCacheGet('k')).toBeNull()
  })
})
