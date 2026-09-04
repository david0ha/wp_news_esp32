import { afterEach, describe, it, expect } from '@jest/globals'
import { MarketError, marketHumanError, num, str } from './types'
import { setActiveLanguage } from '../../i18n'

// `marketHumanError` is the market tab's whole failure vocabulary: six codes, six sentences, and
// one for anything that reached the catch block without being a `MarketError` at all. It had no
// test of its own until the catalogue arrived — the codes are separate precisely because they
// send the reader to different places, and nothing was holding them apart.

describe('marketHumanError', () => {
  const CODES = ['transport', 'http', 'rate_limited', 'crumb', 'parse', 'not_found'] as const

  it('says something different for every code', () => {
    const seen = new Set(CODES.map((c) => marketHumanError(new MarketError(c, 'x'))))
    expect(seen.size).toBe(CODES.length)
    for (const msg of seen) expect(msg.length).toBeGreaterThan(0)
  })

  it('is gentle about a missing crumb, which is a normal outcome and not an outage', () => {
    // From EU IPs the cookie bootstrap never succeeds, and the chart, watchlist and news all
    // keep working without one. A sentence that reads as a failure would send the reader
    // looking for a fault that is not there.
    const msg = marketHumanError(new MarketError('crumb', 'x'))
    expect(msg).toMatch(/Prices and news still work/)
  })

  it('has a sentence for something that is not a MarketError at all', () => {
    expect(marketHumanError(new Error('nope'))).toBe(
      'Something went wrong talking to Yahoo Finance.',
    )
    expect(marketHumanError(undefined)).toBe('Something went wrong talking to Yahoo Finance.')
  })

  describe('in Korean', () => {
    afterEach(() => setActiveLanguage('en'))

    it('translates every sentence but not the service’s name', () => {
      setActiveLanguage('ko')
      for (const c of CODES) {
        expect(marketHumanError(new MarketError(c, 'x'))).toMatch(/[가-힣]/)
      }
      // "Yahoo Finance" is a company, not copy — the same rule the masthead follows.
      expect(marketHumanError(new MarketError('transport', 'x'))).toMatch(/Yahoo Finance/)
      expect(marketHumanError(undefined)).toMatch(/[가-힣]/)
    })
  })
})

describe('the two coercers', () => {
  it('takes a finite number, or Yahoo’s { raw } wrapper, and nothing else', () => {
    expect(num(4)).toBe(4)
    expect(num({ raw: 4, fmt: '4.00' })).toBe(4)
    // A numeric string is a field this app misread, not a number.
    expect(num('4')).toBeNull()
    expect(num(NaN)).toBeNull()
    expect(num({ raw: 'x' })).toBeNull()
    expect(num([1])).toBeNull()
    expect(num(null)).toBeNull()
  })

  it('takes a string, and calls everything else the empty one', () => {
    expect(str('AAPL')).toBe('AAPL')
    expect(str(4)).toBe('')
    expect(str(null)).toBe('')
  })
})
