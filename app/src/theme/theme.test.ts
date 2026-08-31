// The desk imposes one WCAG rule on this file, mirrored from tools/contrast.py rather than
// re-derived: sRGB channel -> linearised -> relative luminance -> (hi+0.05)/(lo+0.05). Two
// grounds, two tiers, forced by measurement — the measured Spectra red (#62201E) is 1.56:1 on
// `desk`, so a raw panel ink used as a UI accent on dark chrome is a legibility bug, not a style
// choice. See CLAUDE.md's colour policy and plan Design > Colour.
import { describe, it, expect } from '@jest/globals'
import { colors } from './colors'
import { typography } from './typography'

function toLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

describe('signal colours — two tiers, forced by measurement', () => {
  it('signal.paper.{up,down,tint} clear 4.5:1 on paper', () => {
    expect(contrast(colors.signal.paper.up, colors.paper)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(colors.signal.paper.down, colors.paper)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(colors.signal.paper.tint, colors.paper)).toBeGreaterThanOrEqual(4.5)
  })

  it('signal.chrome.{up,down,tint} clear 4.5:1 on desk', () => {
    expect(contrast(colors.signal.chrome.up, colors.desk)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(colors.signal.chrome.down, colors.desk)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(colors.signal.chrome.tint, colors.desk)).toBeGreaterThanOrEqual(4.5)
  })

  it('deskText on desk clears 12:1 — the desk is chrome, not a UI that merely resembles one', () => {
    expect(contrast(colors.deskText, colors.desk)).toBeGreaterThanOrEqual(12)
  })

  it('no hex value appears in both signal tiers — paper carries the panel hue, chrome the lifted one', () => {
    const paperHexes = new Set<string>(Object.values(colors.signal.paper))
    const chromeHexes = new Set<string>(Object.values(colors.signal.chrome))
    for (const hex of paperHexes) {
      expect(chromeHexes.has(hex)).toBe(false)
    }
  })
})

describe('grade.yellow — a small piece of paper on the desk, never bare', () => {
  it('the measured yellow fill is under 3:1 on paper — that low ratio is why the keyline exists', () => {
    expect(contrast(colors.grade.yellow.fill, colors.paper)).toBeLessThan(3)
  })

  it('grade.yellow is exported as exactly {fill, keyline} — a bare fill cannot be drawn', () => {
    expect(Object.keys(colors.grade.yellow).sort()).toEqual(['fill', 'keyline'])
  })

  it('the measured yellow is the exact ink from tools/make_tile.py', () => {
    expect(colors.grade.yellow.fill).toBe('#C1BB1E')
  })
})

describe('typography — two materials, two type systems', () => {
  const paperRoles = [
    'masthead',
    'headline',
    'headlineSm',
    'deck',
    'body',
    'label',
    'figure',
  ] as const
  const chromeRoles = ['ui', 'uiStrong', 'note'] as const

  it('every paper role carries a fontFamily — the paper faces never appear on chrome, and vice versa', () => {
    for (const role of paperRoles) {
      expect(typeof typography[role].fontFamily).toBe('string')
      expect(typography[role].fontFamily!.length).toBeGreaterThan(0)
    }
  })

  it('the chrome roles carry no fontFamily — every control is the system font', () => {
    for (const role of chromeRoles) {
      expect(typography[role].fontFamily).toBeUndefined()
    }
  })

  it('every role is on one list or the other — a role that is on neither dodges the rule silently', () => {
    const named = new Set<string>([...paperRoles, ...chromeRoles])
    for (const role of Object.keys(typography)) {
      expect(named.has(role)).toBe(true)
    }
  })
})
