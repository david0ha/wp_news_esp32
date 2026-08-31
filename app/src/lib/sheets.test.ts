// Which of an edition's proof sheets is A1 and which is A2.
//
// The names are NOT a constant this app gets to choose: they are whatever the typesetting gate
// left on disk (`tools/edition/render-check.sh` writes `01_a1_full.png` / `02_a2_full.png`), and
// desk.ts is explicit that a BMP appears where the render died before conversion. So this is a
// resolver over `getEdition(eid).sheets`, and every case below is a shape the desk can really
// hand over.
import { describe, it, expect } from '@jest/globals'
import { sheetForPage } from './sheets'

describe('sheetForPage — by name first, by position second', () => {
  it('finds the gate’s own names', () => {
    const sheets = ['01_a1_full.png', '02_a2_full.png']
    expect(sheetForPage(sheets, 0)).toBe('01_a1_full.png')
    expect(sheetForPage(sheets, 1)).toBe('02_a2_full.png')
  })

  it('finds the bare names an older desk wrote', () => {
    const sheets = ['A1.png', 'A2.png']
    expect(sheetForPage(sheets, 0)).toBe('A1.png')
    expect(sheetForPage(sheets, 1)).toBe('A2.png')
  })

  it('takes a BMP as readily as a PNG — that is the render that died, and it is still the sheet', () => {
    const sheets = ['01_a1_full.bmp', '02_a2_full.bmp']
    expect(sheetForPage(sheets, 0)).toBe('01_a1_full.bmp')
    expect(sheetForPage(sheets, 1)).toBe('02_a2_full.bmp')
  })

  it('does not read a digit out of the middle of a word', () => {
    // "data1" and "media2" contain the characters but name nothing about a page; falling through
    // to position is the right answer, not matching them.
    const sheets = ['data1_full.png', 'media2_full.png']
    expect(sheetForPage(sheets, 0)).toBe('data1_full.png')
    expect(sheetForPage(sheets, 1)).toBe('media2_full.png')
  })

  it('falls back to position when the names say nothing about a page', () => {
    const sheets = ['front.png', 'accounts.png']
    expect(sheetForPage(sheets, 0)).toBe('front.png')
    expect(sheetForPage(sheets, 1)).toBe('accounts.png')
  })

  it('prefers the name over the position when the desk lists them out of order', () => {
    const sheets = ['02_a2_full.png', '01_a1_full.png']
    expect(sheetForPage(sheets, 0)).toBe('01_a1_full.png')
    expect(sheetForPage(sheets, 1)).toBe('02_a2_full.png')
  })

  it('ignores a name that is not one of the two pages', () => {
    // A gate that also left a thumbnail must not push A2 out of position 1.
    const sheets = ['01_a1_full.png', '02_a2_full.png', 'thumb.png']
    expect(sheetForPage(sheets, 1)).toBe('02_a2_full.png')
  })

  it('returns null rather than a wrong sheet when there is nothing to return', () => {
    expect(sheetForPage([], 0)).toBeNull()
    expect(sheetForPage([], 1)).toBeNull()
    expect(sheetForPage(['01_a1_full.png'], 1)).toBeNull()
  })

  it('returns null for a page this paper does not have', () => {
    const sheets = ['01_a1_full.png', '02_a2_full.png']
    expect(sheetForPage(sheets, 2)).toBeNull()
    expect(sheetForPage(sheets, -1)).toBeNull()
  })

  it('takes the one sheet that makes no claim, when the other sheets claim the other page', () => {
    // "This one is A1" is a statement about ONE sheet. A sheet that names no page has made no
    // claim at all, and treating the presence of a name anywhere in the list as a reason to
    // discard it orphans a perfectly good sheet.
    expect(sheetForPage(['01_a1_full.png', 'accounts.png'], 1)).toBe('accounts.png')
    expect(sheetForPage(['thumb.png', '02_a2_full.png'], 0)).toBe('thumb.png')
  })

  it('refuses to guess when more than one sheet could be the unclaimed page', () => {
    // Two candidates and nothing to separate them: null beats a coin toss, because the cost of
    // being wrong is printing the front page under an "accounts" heading.
    expect(sheetForPage(['01_a1_full.png', 'x.png', 'y.png'], 1)).toBeNull()
  })

  it('never hands back an A1 sheet for page 1 just because it is first', () => {
    // One sheet, named A1, and a caller asking for A2: position would say "the only one there is".
    // A named A1 is positive evidence that it is NOT A2, which is the whole reason names beat
    // positions here.
    expect(sheetForPage(['01_a1_full.png'], 1)).toBeNull()
  })
})
