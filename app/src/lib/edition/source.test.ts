import { describe, it, expect } from '@jest/globals'

import {
  deviceSource,
  deviceTileUrl,
  editionUrl,
  isDerived,
  EDITION_PATH,
  NO_SOURCE,
  paperSource,
} from './source'

const DESK = 'https://desk.example'
const NEWS = 'https://elsewhere.example/paper.json'

describe('editionUrl', () => {
  it('takes the edition address the reader typed', () => {
    expect(editionUrl(NEWS, DESK)).toBe(NEWS)
  })

  it('falls back to the desk’s own document when no edition address was typed', () => {
    // The point of the whole module: `news.json` sits on the desk's host, unauthenticated, so a
    // phone that has a desk address already knows where the paper is.
    expect(editionUrl('', DESK)).toBe(`${DESK}${EDITION_PATH}`)
    expect(editionUrl(null, DESK)).toBe(`${DESK}${EDITION_PATH}`)
  })

  it('answers the empty string when there is neither, which is the demo', () => {
    expect(editionUrl('', '')).toBe('')
    expect(editionUrl(null, null)).toBe('')
  })

  it('treats whitespace as nothing on both sides', () => {
    expect(editionUrl('   ', DESK)).toBe(`${DESK}${EDITION_PATH}`)
    expect(editionUrl('  ', '   ')).toBe('')
  })

  it('does not double the slash on a desk address that carries one', () => {
    // `saveDeskBaseUrl` normalises the trailing slash away, so this is about a value written by an
    // older build or by hand — still a string somebody typed.
    expect(editionUrl('', 'https://desk.example/')).toBe(`${DESK}${EDITION_PATH}`)
    expect(editionUrl('', 'https://desk.example///')).toBe(`${DESK}${EDITION_PATH}`)
  })

  it('keeps the typed address even when a desk is configured, because the reader meant it', () => {
    // The edition address is also the only thing the BOARD is ever told, and it may point
    // somewhere other than the desk.
    expect(editionUrl(NEWS, DESK)).not.toContain('desk.example')
  })

  it('carries an http desk address through unchanged', () => {
    // A desk on the LAN keeps its scheme; `deskScheme` already decided that when it was saved.
    expect(editionUrl('', 'http://claudepost.local:8791')).toBe(
      `http://claudepost.local:8791${EDITION_PATH}`,
    )
  })
})

describe('isDerived', () => {
  it('is true only when the field is empty and a desk filled the gap', () => {
    expect(isDerived('', DESK)).toBe(true)
    expect(isDerived(null, DESK)).toBe(true)
  })

  it('is false when the reader typed an address', () => {
    expect(isDerived(NEWS, DESK)).toBe(false)
  })

  it('is false when there is nothing at all — that is the demo, not a derivation', () => {
    expect(isDerived('', '')).toBe(false)
    expect(isDerived(null, null)).toBe(false)
  })
})

describe('deviceTileUrl', () => {
  it('resolves beside the payload', () => {
    expect(deviceTileUrl('http://desk.local:8123/news.json', 'sndk_fab')).toBe(
      'http://desk.local:8123/tiles/sndk_fab.bin',
    )
    expect(deviceTileUrl('https://claudepost.example.dev/edition/news.json', 'x')).toBe(
      'https://claudepost.example.dev/edition/tiles/x.bin',
    )
  })

  it('drops the query and the fragment', () => {
    expect(deviceTileUrl('http://d/news.json?v=2#top', 'a')).toBe('http://d/tiles/a.bin')
    expect(deviceTileUrl('http://d/sub/news.json#frag', 'a')).toBe('http://d/sub/tiles/a.bin')
  })

  it('percent-encodes an id that would otherwise change the path', () => {
    expect(deviceTileUrl('http://d/news.json', '../secret')).toBe('http://d/tiles/..%2Fsecret.bin')
  })

  it('answers the empty string for a URL it cannot resolve beside', () => {
    expect(deviceTileUrl('', 'a')).toBe('')
    expect(deviceTileUrl('news.json', 'a')).toBe('')
  })

  // A bare authority — no path at all — has slashes of its own: the scheme's `//`. Naively
  // cutting at the LAST slash finds one of those and drops the host, producing
  // `http://tiles/x.bin`. The directory of a URL with no path is the authority itself.
  it('resolves against a bare authority with no path (the scheme-slash trap)', () => {
    expect(deviceTileUrl('http://host.local:8123', 'x')).toBe('http://host.local:8123/tiles/x.bin')
    expect(deviceTileUrl('https://claudepost.example', 'x')).toBe(
      'https://claudepost.example/tiles/x.bin',
    )
  })

  it('drops the query and the fragment on a bare authority too', () => {
    expect(deviceTileUrl('http://host?a=1#f', 'x')).toBe('http://host/tiles/x.bin')
  })
})

describe('deviceSource', () => {
  it('is the device plane: the URL as given, tiles beside it, and NO credential', () => {
    // The whole point of the device plane is that it carries none. A header here would send the
    // operator's token to whatever host the reader typed into the edition field.
    const s = deviceSource('http://desk.local:8123/news.json')
    expect(s.payloadUrl).toBe('http://desk.local:8123/news.json')
    expect(s.tileUrl('sndk_fab')).toBe('http://desk.local:8123/tiles/sndk_fab.bin')
    expect(s.headers).toEqual({})
  })

  it('folds an empty address to a source that can fetch nothing', () => {
    const s = deviceSource('')
    expect(s.payloadUrl).toBe('')
    expect(s.tileUrl('a')).toBe('')
  })
})

describe('paperSource', () => {
  it('addresses one edition on the control plane, with the bearer on both halves', () => {
    const s = paperSource({
      deskBaseUrl: 'https://desk.example.dev/',
      editionId: 'a1b2c3d4e5f60718',
      token: 'operator-token',
    })
    expect(s.payloadUrl).toBe('https://desk.example.dev/api/editions/a1b2c3d4e5f60718/news.json')
    expect(s.tileUrl('sndk_fab')).toBe(
      'https://desk.example.dev/api/editions/a1b2c3d4e5f60718/tiles/sndk_fab.bin',
    )
    expect(s.headers).toEqual({ Authorization: 'Bearer operator-token' })
  })

  it('percent-encodes both segments', () => {
    const s = paperSource({ deskBaseUrl: 'https://d', editionId: 'a/b', token: 't' })
    expect(s.payloadUrl).toBe('https://d/api/editions/a%2Fb/news.json')
    expect(s.tileUrl('x/y')).toBe('https://d/api/editions/a%2Fb/tiles/x%2Fy.bin')
  })
})

describe('NO_SOURCE', () => {
  it('fetches nothing and says nothing — the default a mount outside a provider gets', () => {
    expect(NO_SOURCE.payloadUrl).toBe('')
    expect(NO_SOURCE.tileUrl('a')).toBe('')
    expect(NO_SOURCE.headers).toEqual({})
  })
})
