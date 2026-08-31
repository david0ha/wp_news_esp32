// The dark-terminal palette this app shipped with before the newspaper redesign (plan Design —
// "paper" and "desk", two materials that never blend). Kept byte-for-byte, independent of
// src/theme/{colors,radius,spacing}.ts even where a number happens to coincide, so a future edit
// to the new scale can never silently reflow a screen this task did not touch. Migrating a screen
// onto the new tokens is later work (see plan App tasks), not this one. The `src/theme.ts` shim
// that used to re-export this file under the old `../theme` names is gone as of Task 31 — every
// screen that carried it now imports this file directly. This file itself stays, and is deleted
// only once the last screen still on the dark-terminal palette migrates onto the new tokens.

export const colors = {
  bg: '#0B0E11', // app background — near-black
  surface: '#15191E', // cards / sheets
  surfaceAlt: '#1C2127', // pressed / nested rows
  border: 'rgba(255,255,255,0.08)', // hairline dividers / input borders
  borderStrong: 'rgba(255,255,255,0.16)',

  white: '#FFFFFF',
  ink: '#0B0E11', // dark text on light buttons
  text: '#E7E9EA', // primary text
  textDim: 'rgba(231,233,234,0.62)', // secondary text
  textFaint: 'rgba(231,233,234,0.32)', // placeholders / disabled

  accent: '#5AC8FA', // brand accent (links, selection, progress)
  accentDim: 'rgba(90,200,250,0.16)',

  up: '#26C281', // gains
  upBg: 'rgba(38,194,129,0.14)',
  down: '#F6465D', // losses
  downBg: 'rgba(246,70,93,0.14)',

  warn: '#F0B90B', // econ / attention

  green: '#26C281', // status: connected / live dot
  greenBg: 'rgba(38,194,129,0.14)',
  red: '#F6465D', // status: error
  redBg: 'rgba(246,70,93,0.14)',
} as const

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
} as const

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const

// Standard phone content gutter.
export const layout = {
  gutter: 16,
} as const

// Monospace for prices/symbols (uses the platform mono so no font asset is required); the
// system sans for everything else.
export const fonts = {
  mono: 'monospace',
  monoIos: 'Menlo',
} as const
