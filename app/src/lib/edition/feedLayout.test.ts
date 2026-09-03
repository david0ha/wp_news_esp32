import { describe, it, expect } from '@jest/globals'
import { columnWidth, photoBoxHeight, resolveChip, COLUMN_GAP } from './feedLayout'
import { type Chip } from './tiles'
import { type EditionPhoto } from './types'

const GUTTER = 16

function photo(w: number, h: number): EditionPhoto {
  return { id: 'p', w, h, caption: '', credit: '' }
}

describe('columnWidth', () => {
  it('splits the window less both margins and the gap between the columns', () => {
    // 390 (iPhone 14) - 32 - 12 = 346, halved = 173.
    expect(columnWidth(390, GUTTER)).toBe(173)
  })

  it('floors rather than rounding, so both columns land on the same pixel boundary', () => {
    // 393 - 32 - 12 = 349, halved = 174.5.
    expect(columnWidth(393, GUTTER)).toBe(174)
  })

  it('takes one gap per boundary, not one per column', () => {
    expect(columnWidth(400, GUTTER, COLUMN_GAP, 3)).toBe(114)
  })

  it('never returns a width a height could be derived from as zero', () => {
    expect(columnWidth(0, GUTTER)).toBe(1)
    expect(columnWidth(20, GUTTER)).toBe(1)
  })
})

describe('resolveChip', () => {
  const chips: Chip[] = ['all', 'stories', 'numbers']

  it('keeps a chip the edition still has content for', () => {
    expect(resolveChip(chips, 'numbers')).toBe('numbers')
  })

  it('falls back to all when new content emptied the selected chip', () => {
    // Yesterday had photographs and today does not: showing an empty Photos page with no
    // explanation is worse than showing the whole edition.
    expect(resolveChip(chips, 'photos')).toBe('all')
  })

  it('is a no-op on all', () => {
    expect(resolveChip(chips, 'all')).toBe('all')
  })
})

describe('photoBoxHeight', () => {
  it('uses the photograph’s own aspect inside the clamp', () => {
    expect(photoBoxHeight(photo(1000, 500), 300)).toBe(150)
  })

  it('clamps a tower so one picture cannot own ten screens', () => {
    expect(photoBoxHeight(photo(100, 1000), 300)).toBe(450)
  })

  it('gives the producer’s own lead cut its own aspect, uncropped', () => {
    // 1140 x 320 is the cut `tools/edition/PROMPT.md` specifies for the lead photograph, and it
    // is the band on every edition. A floor on the aspect would make the box taller than the
    // picture and `cover` would take the difference off both sides.
    // 358 * 320 / 1140 = 100.49 -> 100.
    expect(photoBoxHeight(photo(1140, 320), 358)).toBe(100)
  })

  it('does not clamp a wide strip at all — width is the point of a band', () => {
    expect(photoBoxHeight(photo(1200, 60), 300)).toBe(15)
  })

  it('survives a zero width instead of dividing by it', () => {
    expect(photoBoxHeight(photo(0, 400), 300)).toBe(300)
  })
})
