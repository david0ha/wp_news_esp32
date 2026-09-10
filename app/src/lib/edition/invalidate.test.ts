import { describe, it, expect, beforeEach } from '@jest/globals'
import {
  __resetEditionStaleForTests,
  markEditionStale,
  takeEditionStale,
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
