import { describe, it, expect } from '@jest/globals'
import {
  DETAIL_CELL_MIN,
  DETAIL_LABEL_EM,
  DETAIL_LABEL_EM_HANGUL,
  DETAIL_LABEL_MAX_FRACTION,
  DETAIL_LABEL_MIN,
  detailCellWidth,
  detailLabelWidth,
  labelEm,
} from './tableGrid'
import { fontSizeOf } from '../metrics'
import { type } from '../../../theme'

// A 390 pt phone: the card is the window less two 16 pt gutters and its own two 12 pt paddings.
const CARD = 390 - 2 * 16 - 2 * 12

describe('detailLabelWidth', () => {
  it('takes its width from the longest label in the statement', () => {
    const rows = ['Revenue', 'Net income', 'Net margin']
    expect(detailLabelWidth(rows, CARD, 'en')).toBe(
      Math.ceil(10 * fontSizeOf(type.caption) * DETAIL_LABEL_EM),
    )
    // A longer name asks for more room, up to the cap.
    expect(detailLabelWidth(['Cost of revenue'], CARD, 'en')).toBeGreaterThan(
      detailLabelWidth(rows, CARD, 'en'),
    )
  })

  it('never takes more than two fifths of the card', () => {
    // The contract caps a row label at 24 characters, which asks for more than the card can give
    // — and a label column past this point starves the periods it exists to be read against.
    const cap = Math.round(CARD * DETAIL_LABEL_MAX_FRACTION)
    expect(detailLabelWidth(['x'.repeat(24)], CARD, 'en')).toBe(cap)
    expect(detailLabelWidth(['x'.repeat(200)], CARD, 'en')).toBe(cap)
  })

  it('keeps a floor under a short label, so the column is a column', () => {
    expect(detailLabelWidth(['ROE'], CARD, 'en')).toBe(DETAIL_LABEL_MIN)
    expect(detailLabelWidth([], CARD, 'en')).toBe(DETAIL_LABEL_MIN)
  })

  it('lets the cap beat the floor when the card is narrower than the floor allows', () => {
    // The two bounds can cross. The cap wins, because it is the one protecting the figures.
    const narrow = 100
    expect(Math.round(narrow * DETAIL_LABEL_MAX_FRACTION)).toBeLessThan(DETAIL_LABEL_MIN)
    expect(detailLabelWidth(['Net income'], narrow, 'en')).toBe(
      Math.round(narrow * DETAIL_LABEL_MAX_FRACTION),
    )
  })

  it('is a whole number of pixels at every card a phone produces, in both languages', () => {
    for (let card = 240; card <= 700; card++) {
      for (const [labels, lang] of [
        [['Net income', 'Consumer electronics'], 'en'],
        [['순이익', '판매비와관리비'], 'ko'],
      ] as const) {
        const w = detailLabelWidth([...labels], card, lang)
        expect(Number.isInteger(w)).toBe(true)
        expect(w).toBeGreaterThan(0)
        expect(w).toBeLessThanOrEqual(Math.round(card * DETAIL_LABEL_MAX_FRACTION))
      }
    }
  })
})

describe('detailLabelWidth — Hangul', () => {
  it('estimates a Hangul label at a full em', () => {
    expect(labelEm('ko')).toBe(DETAIL_LABEL_EM_HANGUL)
    expect(labelEm('ko')).toBe(1.0)
    expect(labelEm('en')).toBe(DETAIL_LABEL_EM)
    expect(labelEm('fr')).toBe(DETAIL_LABEL_EM)
  })

  it('gives a Hangul label more room than the same count of Latin characters', () => {
    // Seven syllables — SG&A, the longest label in a Korean statement of any length. A syllable
    // is a full em where Inter's mixed case averages 0.62, so the same seven characters are half
    // again as wide, and estimating them Latin is what ellipsizes the row's name.
    const label = '판매비와관리비'
    expect(label.length).toBe(7)
    expect(detailLabelWidth([label], CARD, 'ko')).toBeGreaterThan(
      detailLabelWidth([label], CARD, 'en'),
    )
    expect(detailLabelWidth([label], CARD, 'ko')).toBe(
      Math.ceil(7 * fontSizeOf(type.caption) * DETAIL_LABEL_EM_HANGUL),
    )
  })

  it('still lands on the floor for the short labels a statement usually carries', () => {
    // '순이익률' is four syllables — 52 pt at a full em, under the 72 pt floor either way. Most
    // Korean row labels are two to four syllables, so the language only changes this number on
    // the long ones. Stated here so a reader who finds the two languages agreeing knows why.
    expect(detailLabelWidth(['순이익률'], CARD, 'ko')).toBe(DETAIL_LABEL_MIN)
    expect(detailLabelWidth(['순이익률'], CARD, 'en')).toBe(DETAIL_LABEL_MIN)
  })
})

describe('detailCellWidth', () => {
  it('holds the widest figure the statement carries, with no cap', () => {
    // No cap, because the value columns scroll: an extra twenty points costs scroll and nothing
    // else, where a value that does not fit its column wraps into a row whose height is fixed and
    // loses its second line to `overflow: 'hidden'`.
    const wide = detailCellWidth(['1Q26'], ['1,672,000,000'])
    expect(wide).toBeGreaterThan(DETAIL_CELL_MIN)
    expect(wide).toBeGreaterThan(detailCellWidth(['1Q26'], ['9,340']))
  })

  it('measures the column headings as well as the figures under them', () => {
    expect(detailCellWidth(['Nine months to June'], ['12'])).toBeGreaterThan(
      detailCellWidth(['1Q26'], ['12']),
    )
  })

  it('keeps a floor, so a statement of small numbers still reads as columns', () => {
    expect(detailCellWidth(['1Q26', '2Q26'], ['12', '(4)'])).toBe(DETAIL_CELL_MIN)
    expect(detailCellWidth([], [])).toBe(DETAIL_CELL_MIN)
  })

  it('is a whole number of pixels', () => {
    expect(Number.isInteger(detailCellWidth(['1Q26'], ['1,672,000']))).toBe(true)
  })
})

