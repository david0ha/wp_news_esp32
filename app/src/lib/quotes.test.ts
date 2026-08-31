import { describe, it, expect } from '@jest/globals'
import { changeBpFrom } from './quotes'

describe('changeBpFrom', () => {
  it('is the change from prevClose to last, in basis points', () => {
    // (24160 - 23184) * 10000 / 23184 = 421.005... -> rounds to 421, docs/desk-server.md § Quotes
    expect(changeBpFrom(24160, 23184)).toBe(421)
  })

  it('is negative on a loss', () => {
    expect(changeBpFrom(23184, 24160)).toBe(Math.round(((23184 - 24160) * 10000) / 24160))
    expect(changeBpFrom(23184, 24160)).toBeLessThan(0)
  })

  it('is null when prevClose is zero — a listing with nothing to compare against', () => {
    expect(changeBpFrom(100, 0)).toBeNull()
    expect(changeBpFrom(0, 0)).toBeNull()
  })

  it('is zero when last equals prevClose', () => {
    expect(changeBpFrom(24160, 24160)).toBe(0)
  })

  it('always returns an integer, never a float', () => {
    const bp = changeBpFrom(24161, 23184)
    expect(bp).not.toBeNull()
    expect(Number.isInteger(bp)).toBe(true)
  })
})
