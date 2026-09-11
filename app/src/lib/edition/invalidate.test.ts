import { describe, it, expect, beforeEach } from '@jest/globals'
import {
  __resetEditionStaleForTests,
  markEditionStale,
  takeEditionStale,
  takePapersStale,
} from './invalidate'

beforeEach(() => {
  __resetEditionStaleForTests()
})

describe('the edition invalidation flag', () => {
  it('is clear until something marks it', () => {
    expect(takeEditionStale()).toBe(false)
  })

  it('is taken exactly once', () => {
    // The Today tab consumes it on the load that follows. A flag that stayed set would turn every
    // later focus into an unconditional fetch, which is the throttle it exists to defeat once.
    markEditionStale()
    expect(takeEditionStale()).toBe(true)
    expect(takeEditionStale()).toBe(false)
  })

  it('two marks before one take are still one fetch', () => {
    markEditionStale()
    markEditionStale()
    expect(takeEditionStale()).toBe(true)
    expect(takeEditionStale()).toBe(false)
  })
})

describe('one mark, two readers', () => {
  it('marks the paper list as well as the edition on screen', () => {
    // A `revised` rewrote an edition. That is also a new `created_at` for that company's paper and
    // possibly a new `edition_id` on the board, so both readers have stale answers.
    markEditionStale()
    expect(takeEditionStale()).toBe(true)
    expect(takePapersStale()).toBe(true)
  })

  it('gives each reader its own bit, so one taking it does not rob the other', () => {
    markEditionStale()
    expect(takeEditionStale()).toBe(true)
    expect(takeEditionStale()).toBe(false)
    // Today's pager may not even be mounted when the edition reader takes its bit.
    expect(takePapersStale()).toBe(true)
    expect(takePapersStale()).toBe(false)
  })
})
