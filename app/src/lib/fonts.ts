// Loads exactly the font weights typography.ts's paper roles reference — no more, no fewer, so
// a name added here without a role that uses it (or a role added to typography.ts without its
// weight loaded here) is a diff that stands out rather than one that hides. `FACE` re-exports
// each identifier as a constant so a screen imports a name instead of typing the family string
// by hand — a typo in a hand-typed string falls back to the platform font silently (see
// typography.ts's own warning: there is no error to catch it), a typo in an imported constant is
// a compile error.

import { useFonts } from 'expo-font'
import { PlayfairDisplay_700Bold, PlayfairDisplay_900Black } from '@expo-google-fonts/playfair-display'
import {
  SourceSerif4_400Regular,
  SourceSerif4_400Regular_Italic,
} from '@expo-google-fonts/source-serif-4'
import { LibreFranklin_500Medium, LibreFranklin_700Bold } from '@expo-google-fonts/libre-franklin'

export const FACE = {
  PlayfairDisplay_700Bold: 'PlayfairDisplay_700Bold',
  PlayfairDisplay_900Black: 'PlayfairDisplay_900Black',
  SourceSerif4_400Regular: 'SourceSerif4_400Regular',
  SourceSerif4_400Regular_Italic: 'SourceSerif4_400Regular_Italic',
  LibreFranklin_500Medium: 'LibreFranklin_500Medium',
  LibreFranklin_700Bold: 'LibreFranklin_700Bold',
} as const

// [loaded, error] — expo-font's own shape. `error` is non-null on a failed fetch (offline
// install, a flaky CDN) and is not itself fatal: the caller renders anyway and the platform's
// serif substitutes for the family that never resolved.
export function useAppFonts(): [boolean, Error | null] {
  return useFonts({
    PlayfairDisplay_700Bold,
    PlayfairDisplay_900Black,
    SourceSerif4_400Regular,
    SourceSerif4_400Regular_Italic,
    LibreFranklin_500Medium,
    LibreFranklin_700Bold,
  })
}
