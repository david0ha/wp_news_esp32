import { describe, expect, it, jest } from '@jest/globals'
import { openMdLink } from './links'

describe('openMdLink', () => {
  it('opens a non-empty href through the injected opener', async () => {
    const open = jest.fn(async () => undefined)
    const ok = await openMdLink('https://example.com/wiki', open)
    expect(open).toHaveBeenCalledWith('https://example.com/wiki')
    expect(ok).toBe(true)
  })

  it('trims the href before handing it to the opener', async () => {
    const open = jest.fn(async () => undefined)
    await openMdLink('  https://example.com  ', open)
    expect(open).toHaveBeenCalledWith('https://example.com')
  })

  it('swallows a rejection from the opener rather than throwing — a bad or unsupported URL must not crash the tap that opened it', async () => {
    const open = jest.fn(async () => {
      throw new Error('no handler for this scheme')
    })
    await expect(openMdLink('mailto:nobody@example.com', open)).resolves.toBe(false)
  })

  it('does not attempt to open an empty or blank href', async () => {
    const open = jest.fn(async () => undefined)
    expect(await openMdLink('', open)).toBe(false)
    expect(await openMdLink('   ', open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
