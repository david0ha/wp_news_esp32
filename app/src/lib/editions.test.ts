import { describe, expect, it } from '@jest/globals'
import { editionPointer, editionWhen, promoteResultLine } from './editions'
import type { CommitResult, EditionMeta } from './desk'

function edition(overrides: Partial<EditionMeta> = {}): EditionMeta {
  return {
    id: 'abc123',
    created_at: 1000,
    published_at: null,
    tile_count: 4,
    bytes: 2048,
    dropped_producer_policy: false,
    sheets: [],
    has_notes: false,
    ...overrides,
  }
}

const DAY = 86400

describe('editionWhen', () => {
  it('reads "published <time>" once an edition has reached the glass, off published_at', () => {
    const e = edition({ created_at: DAY, published_at: DAY + 3600 * 6 })
    expect(editionWhen(e, DAY + 3600 * 6)).toBe('published 06:00')
  })

  it('reads "filed <time>" off created_at while nothing has been published yet', () => {
    const e = edition({ created_at: DAY + 3600 * 22, published_at: null })
    expect(editionWhen(e, DAY + 3600 * 22)).toBe('filed 22:00')
  })

  it('prefers published_at over created_at once both exist', () => {
    const e = edition({ created_at: DAY, published_at: DAY + 60 })
    const when = editionWhen(e, DAY + 60)
    expect(when.startsWith('published')).toBe(true)
  })

  it('carries the date when the instant falls on a different UTC day than now', () => {
    const e = edition({ created_at: DAY, published_at: DAY })
    expect(editionWhen(e, DAY + DAY * 3)).toBe('published JAN 2, 00:00')
  })

  it('is empty for an edition with no usable instant at all', () => {
    const e = edition({ created_at: 0, published_at: null })
    expect(editionWhen(e, 0)).toBe('')
  })
})

describe('editionPointer', () => {
  it('names "current" when the id matches the current pointer', () => {
    expect(editionPointer('a', 'a', 'b')).toBe('current')
  })

  it('names "staged" when the id matches the staged pointer', () => {
    expect(editionPointer('b', 'a', 'b')).toBe('staged')
  })

  it('is null when the id matches neither pointer', () => {
    expect(editionPointer('c', 'a', 'b')).toBeNull()
  })

  it('is null when both pointers are null', () => {
    expect(editionPointer('a', null, null)).toBeNull()
  })

  it('current wins when (somehow) both pointers name the same id', () => {
    expect(editionPointer('a', 'a', 'a')).toBe('current')
  })
})

describe('promoteResultLine', () => {
  function result(state: CommitResult['state']): CommitResult {
    return { edition_id: 'abc123', state, reason: 'whatever the desk said' }
  }

  it('says the edition is current now on "published"', () => {
    expect(promoteResultLine(result('published'))).toBe('Promoted — this edition is current now.')
  })

  it('says it is staged, not yet up, on "staged" — a promote inside a quiet window', () => {
    expect(promoteResultLine(result('staged'))).toBe('Staged. It reaches the glass at the next boundary.')
  })

  it('says honestly that nothing changed on "unchanged" — promoting what is already current', () => {
    expect(promoteResultLine(result('unchanged'))).toBe('Already current. Nothing changed.')
  })
})
