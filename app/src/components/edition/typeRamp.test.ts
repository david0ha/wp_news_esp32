import { describe, it, expect } from '@jest/globals'
import { faceFor, rampFor, SYSTEM_FACE_WEIGHTS } from './typeRamp'
import { fonts, type } from '../../theme'

// Every token the ramp has to answer for. Written out rather than derived from `type`, so a token
// added to the theme without a thought for Korean fails here rather than passing by construction.
const TOKENS = [
  'display',
  'headingLg',
  'heading',
  'headingSm',
  'body',
  'caption',
  'label',
  'pinHeadline',
  'pinDeck',
] as const

describe('rampFor', () => {
  it('hands a Latin edition the theme itself, not a copy of it', () => {
    // Identity and not deep equality. The ramp reaches every edition component's style array, and
    // a fresh object per call would make every one of them a new style on every render.
    expect(rampFor('en')).toBe(type)
    expect(rampFor('fr')).toBe(type)
    expect(rampFor('')).toBe(type)
  })

  it('carries weight without a family in Korean', () => {
    const ko = rampFor('ko')
    expect(ko.pinHeadline.fontFamily).toBeUndefined()
    expect(ko.pinHeadline.fontWeight).toBe('800')
    expect(ko.caption.fontFamily).toBeUndefined()
    expect(ko.caption.fontWeight).toBe('400')
  })

  it('gives every token a weight, so no Korean head comes out light', () => {
    const ko = rampFor('ko')
    for (const k of TOKENS) {
      expect(ko[k].fontFamily).toBeUndefined()
      expect(ko[k].fontWeight).toBe(SYSTEM_FACE_WEIGHTS[type[k].fontFamily as string])
      expect(ko[k].fontWeight).toBeDefined()
    }
  })

  it('changes nothing a layout was measured with', () => {
    // The estimators size every tile before anything renders, off `lineHeight` and `fontSize` read
    // from these same tokens (`metrics.ts`). A ramp that moved either would leave every box in the
    // masonry sized for the other language.
    const ko = rampFor('ko')
    for (const k of TOKENS) {
      expect(ko[k].fontSize).toBe(type[k].fontSize)
      expect(ko[k].lineHeight).toBe(type[k].lineHeight)
      expect(ko[k].letterSpacing).toBe(type[k].letterSpacing)
      expect(ko[k].color).toBe(type[k].color)
    }
  })

  it('builds one ramp per language and hands the same one back', () => {
    expect(rampFor('ko')).toBe(rampFor('ko'))
  })
})

describe('faceFor', () => {
  it('names the family in a Latin edition', () => {
    expect(faceFor('en')(fonts.semibold)).toEqual({ fontFamily: fonts.semibold })
  })

  it('turns a family into its weight in Korean', () => {
    const face = faceFor('ko')
    expect(face(fonts.semibold)).toEqual({ fontWeight: '600' })
    expect(face(fonts.extrabold)).toEqual({ fontWeight: '800' })
    // Never both. The theme's own rule: a fontWeight beside a fontFamily makes Android drop to
    // the system font, which is the very thing being asked for here — but at the wrong weight.
    expect(face(fonts.medium).fontFamily).toBeUndefined()
  })

  it('hands back the same style object for the same face', () => {
    const face = faceFor('ko')
    expect(face(fonts.bold)).toBe(face(fonts.bold))
    expect(faceFor('ko')).toBe(faceFor('ko'))
  })

  it('drops a face it has no weight for rather than drawing tofu', () => {
    // `fonts.mono` is in no ramp token, but it is a family a caller could pass. Korean in a face
    // with no Hangul is a row of empty boxes; falling to the system face at a default weight is
    // the graceful half of that failure, and the test above is the loud half.
    expect(faceFor('ko')(fonts.mono)).toEqual({})
  })
})
