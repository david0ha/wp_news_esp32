import { describe, it, expect } from '@jest/globals'
import { columnWidth, editionKey, photoBoxHeight, resolveChip, COLUMN_GAP } from './feedLayout'
import { emptyEdition } from './parse'
import { type Chip } from './tiles'
import { type CachedEdition } from './store'
import { type EditionPhoto } from './types'

const GUTTER = 16

const cached = (generatedAt: string, fetchedAt: number): CachedEdition => ({
  url: 'http://desk.local:8123/news.json',
  etag: null,
  fetchedAt,
  // `editionKey` reads `generatedAt` off the parsed edition and never touches the wire, so this
  // one is built directly rather than parsed from a body.
  wire: { generated_at: generatedAt },
  edition: { ...emptyEdition(), generatedAt },
})

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

describe('editionKey', () => {
  it('is the edition’s own stamp when it has one', () => {
    expect(editionKey(cached('2026-08-14T05:12:00Z', 1000))).toBe('2026-08-14T05:12:00Z')
  })

  it('falls back to the moment it was fetched, so an undated edition still has an identity', () => {
    expect(editionKey(cached('', 1755000000000))).toBe('1755000000000')
    // The demo's fetchedAt is 0 — a stamp of its own, and a constant one, which is right: the
    // bundled edition never changes under the tiles keyed on it.
    expect(editionKey(cached('', 0))).toBe('0')
  })

  it('changes when the edition does — which is the whole reason a photo tile is keyed on it', () => {
    // Tile ids are the producer's and repeat across days: `photo:0` is `photo:0` every edition,
    // and the lead band is 1140x320 every edition. Keyed by id alone, React reuses the mounted
    // tile, its effect sees the same url/w/h, and today's caption sits over yesterday's picture.
    expect(editionKey(cached('2026-08-14T05:12:00Z', 1000))).not.toBe(
      editionKey(cached('2026-08-15T05:12:00Z', 1000)),
    )
  })
})
