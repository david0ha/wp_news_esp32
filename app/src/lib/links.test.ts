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

  it('drops a scheme that is not http, https or mailto — the desk’s markdown is worker-authored, and a scheme it names must not become an app launch', async () => {
    const open = jest.fn(async () => undefined)
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'tel:+15551234567',
      'sms:+15551234567',
      'itms-apps://apps.apple.com/app/id1',
      'shortcuts://run-shortcut?name=Wipe',
      'claudepost://settings',
    ]) {
      expect(await openMdLink(href, open)).toBe(false)
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('opens the three schemes a filed source URL legitimately uses', async () => {
    const open = jest.fn(async () => undefined)
    for (const href of [
      'https://sec.gov/filing',
      'http://192.168.1.50/news.json',
      'mailto:desk@example.com',
      'HTTPS://SEC.GOV/FILING',
    ]) {
      expect(await openMdLink(href, open)).toBe(true)
    }
    expect(open).toHaveBeenCalledTimes(4)
  })

  it('drops an href with no scheme at all rather than handing the opener something it will reject', async () => {
    const open = jest.fn(async () => undefined)
    expect(await openMdLink('example.com/wiki', open)).toBe(false)
    expect(await openMdLink('//example.com/wiki', open)).toBe(false)
    expect(await openMdLink('/api/editions', open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('is not fooled by a host that looks like a scheme — the check is anchored, and an authority is not one', async () => {
    const open = jest.fn(async () => undefined)
    // `example.com` is a syntactically valid RFC 3986 scheme, so this parses as scheme
    // `example.com` rather than as a host, and fails closed.
    expect(await openMdLink('example.com:8080/path', open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
