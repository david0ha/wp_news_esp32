import { describe, it, expect } from '@jest/globals'

import { editionUrl, isDerived, EDITION_PATH } from './source'

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
