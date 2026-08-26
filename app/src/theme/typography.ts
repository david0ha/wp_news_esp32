// Type, in the same two materials as colour — plan Design > Type. Paper roles carry one of the
// three newspaper faces (Playfair Display for heads, Source Serif 4 for running text, Libre
// Franklin for standing heads and figures); `ui`/`uiStrong` carry none, so the platform's own
// system font renders every control. That is the rule a diff can check: *the paper faces never
// appear on chrome, the system font never appears on paper*.
//
// The family names below are exactly what `@expo-google-fonts/*` exports — see
// node_modules/@expo-google-fonts/{playfair-display,source-serif-4,libre-franklin}/index.d.ts —
// and exactly what Task 16's `useAppFonts` registers. A name here that doesn't match one Expo
// actually loads falls back to the platform default silently; there is no error to catch it.

import type { TextStyle } from 'react-native'

export type TypographyRole =
  | 'masthead'
  | 'headline'
  | 'headlineSm'
  | 'deck'
  | 'body'
  | 'label'
  | 'figure'
  | 'ui'
  | 'uiStrong'

export const typography: Record<TypographyRole, TextStyle> = {
  // Playfair Display — heads. "Today only" for the masthead; heads everywhere else.
  masthead: {
    fontFamily: 'PlayfairDisplay_900Black',
    fontSize: 30,
    letterSpacing: 1.5,
  },
  headline: {
    fontFamily: 'PlayfairDisplay_700Bold',
    fontSize: 24,
    lineHeight: 28,
  },
  headlineSm: {
    fontFamily: 'PlayfairDisplay_700Bold',
    fontSize: 17,
    lineHeight: 22,
  },

  // Source Serif 4 — running text: decks (italic) and bodies (roman), thesis, dossier.
  deck: {
    fontFamily: 'SourceSerif4_400Regular_Italic',
    fontStyle: 'italic',
    fontSize: 15,
    lineHeight: 22,
  },
  body: {
    fontFamily: 'SourceSerif4_400Regular',
    fontSize: 16,
    lineHeight: 25,
  },

  // Libre Franklin — kickers, standing heads, stamps (`label`), and tabular figures (prices,
  // changes, counts) so a column of numbers lines up on its decimal point.
  label: {
    fontFamily: 'LibreFranklin_700Bold',
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  figure: {
    fontFamily: 'LibreFranklin_500Medium',
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },

  // Desk / chrome — no fontFamily. Every control renders in the platform's own system font.
  ui: {
    fontSize: 15,
  },
  uiStrong: {
    fontSize: 16,
    fontWeight: '600',
  },
}
