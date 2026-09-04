import { describe, it, expect } from '@jest/globals'
import {
  DETAIL_CELL_MIN,
  DETAIL_LABEL_EM,
  DETAIL_LABEL_MAX_FRACTION,
  DETAIL_LABEL_MIN,
  detailCellWidth,
  detailLabelWidth,
} from './tableGrid'
import { fontSizeOf } from '../metrics'
import { type } from '../../../theme'

// A 390 pt phone: the card is the window less two 16 pt gutters and its own two 12 pt paddings.
const CARD = 390 - 2 * 16 - 2 * 12

describe('detailLabelWidth', () => {
  it('takes its width from the longest label in the statement', () => {
    const rows = ['Revenue', 'Net income', 'Net margin']
    expect(detailLabelWidth(rows, CARD)).toBe(
      Math.ceil(10 * fontSizeOf(type.caption) * DETAIL_LABEL_EM),
    )
    // A longer name asks for more room, up to the cap.
    expect(detailLabelWidth(['Cost of revenue'], CARD)).toBeGreaterThan(
      detailLabelWidth(rows, CARD),
    )
  })

  it('never takes more than two fifths of the card', () => {
    // The contract caps a row label at 24 characters, which asks for more than the card can give
    // — and a label column past this point starves the periods it exists to be read against.
    const cap = Math.round(CARD * DETAIL_LABEL_MAX_FRACTION)
    expect(detailLabelWidth(['x'.repeat(24)], CARD)).toBe(cap)
    expect(detailLabelWidth(['x'.repeat(200)], CARD)).toBe(cap)
  })

  it('keeps a floor under a short label, so the column is a column', () => {
    expect(detailLabelWidth(['ROE'], CARD)).toBe(DETAIL_LABEL_MIN)
    expect(detailLabelWidth([], CARD)).toBe(DETAIL_LABEL_MIN)
  })

  it('lets the cap beat the floor when the card is narrower than the floor allows', () => {
    // The two bounds can cross. The cap wins, because it is the one protecting the figures.
    const narrow = 100
    expect(Math.round(narrow * DETAIL_LABEL_MAX_FRACTION)).toBeLessThan(DETAIL_LABEL_MIN)
    expect(detailLabelWidth(['Net income'], narrow)).toBe(
      Math.round(narrow * DETAIL_LABEL_MAX_FRACTION),
    )
  })

  it('is a whole number of pixels at every card a phone produces', () => {
    for (let card = 240; card <= 700; card++) {
      const w = detailLabelWidth(['Net income', 'Consumer electronics'], card)
      expect(Number.isInteger(w)).toBe(true)
      expect(w).toBeGreaterThan(0)
      expect(w).toBeLessThanOrEqual(Math.round(card * DETAIL_LABEL_MAX_FRACTION))
    }
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

