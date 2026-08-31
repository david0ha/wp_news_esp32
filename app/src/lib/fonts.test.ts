// Pure check, no native: FACE is the contract between fonts.ts (what gets loaded) and
// typography.ts (what the paper roles ask for). A mismatch in either direction is a bug —
// typography.ts referencing a family fonts.ts never loads renders in the platform fallback with
// no error, and fonts.ts loading a family nothing uses is dead weight on every boot.
import { describe, it, expect } from '@jest/globals'
import { FACE } from './fonts'
import { typography } from '../theme/typography'

describe('FACE — exactly the family names typography.ts references, no more', () => {
  it('covers every fontFamily used across typography.ts roles, and nothing else', () => {
    const used = new Set(
      Object.values(typography)
        .map((style) => style.fontFamily)
        .filter((f): f is string => typeof f === 'string'),
    )
    const declared = new Set(Object.values(FACE))
    expect(declared).toEqual(used)
  })

  it('every FACE key names the exact family string it points at, so a screen never re-types one', () => {
    for (const [key, value] of Object.entries(FACE)) {
      expect(value).toBe(key)
    }
  })
})
