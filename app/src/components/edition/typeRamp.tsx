// The type ramp the edition is drawn with, which is not always the theme's.
//
// Inter has no Hangul. The app ships five static Inter cuts and names them by family
// (`Inter_600SemiBold`), which is how the theme carries weight — see `theme.ts`: a family token
// and a `fontWeight` beside it makes Android drop to the system font, so the ramp sets the family
// and never the weight. That arrangement fails on the one thing it cannot draw. Asked for a
// Hangul syllable in `Inter_800ExtraBold`, both platforms fall back to the system CJK face at
// *regular* weight, and a Korean lead headline comes out the same colour as its own deck. The
// fallback is silent and looks like a design choice.
//
// So for a language Inter cannot set, the ramp DROPS the family and carries the weight as
// `fontWeight` instead. The system face is then chosen deliberately rather than fallen into, and
// both platforms honour the weight on it. No CJK font ships in the binary: a face set at six sizes
// is megabytes, and the phone already has one.
//
// WHAT THE RAMP MAY NOT TOUCH is size and line height. Every tile in the masonry is sized by
// `lib/edition/tiles.ts` before anything renders, from the `fontSize` and `lineHeight` read off
// these very tokens (`metrics.ts`), and nothing measures afterwards to notice a disagreement. A
// ramp that moved either would leave every box on the page sized for the other language, and the
// symptom would be a sliced last line rather than an error. `typeRamp.test.ts` holds it to that.
//
// It is the EDITION's language that decides, never the app's. A cached Korean edition on an
// English phone is still Korean, so the provider takes `Edition.lang` and the two settings do not
// read each other — the same split `i18n/index.tsx` opens with.

import { createContext, useContext, type ReactNode } from 'react'
import { type TextStyle } from 'react-native'
import { fonts, type } from '../../theme'

/** The theme's ramp, and the shape every language's ramp has. */
export type EditionTypeRamp = typeof type

/**
 * The languages written in a CJK script.
 *
 * A set and not a `=== 'ko'`, because the answer is a property of the SCRIPT rather than of
 * Korean: Japanese and Chinese would join it the day an edition arrives in one, and nothing else
 * in this file would change. Everything absent from it is Latin as far as Inter is concerned,
 * including the languages nobody has filed an edition in yet.
 */
const CJK_SCRIPTS = new Set(['ko'])

/**
 * Is an edition in `lang` written in one of them?
 *
 * EXPORTED, and read by `detail/tableGrid.ts` as well as by this file, because the two things a
 * CJK script decides are decided from the same list. Here it means Inter cannot draw the copy, so
 * the ramp drops the family; there it means a character is a full em rather than Inter's 0.62, so
 * a row label is estimated at nearly twice the width. Adding `ja` has to move both, and a
 * `=== 'ko'` at either site is the way one of them silently stays behind — the symptom being a
 * Japanese statement label given the 72 pt floor and then ellipsized, invisible until somebody
 * opens that page.
 */
export function isCjkScript(lang: string): boolean {
  return CJK_SCRIPTS.has(lang)
}

/**
 * Each Inter cut the theme names, as the numeric weight that asks the system face for the same
 * thing.
 *
 * `theme.ts`'s `fonts` is the only place these strings are spelled, so this maps from it rather
 * than from literals. `fonts.mono` and `fonts.monoIos` are deliberately absent: a monospace face
 * is a request for the shape of the digits, not for a weight, and no ramp token uses one.
 */
export const SYSTEM_FACE_WEIGHTS: Record<string, TextStyle['fontWeight']> = {
  [fonts.regular]: '400',
  [fonts.medium]: '500',
  [fonts.semibold]: '600',
  [fonts.bold]: '700',
  [fonts.extrabold]: '800',
}

/**
 * One token, moved off Inter: the family goes, the weight it stood for arrives.
 *
 * A family with no weight in the table loses the family and gains nothing — the system face at
 * its default. That is the graceful half of the failure; the loud half is in `typeRamp.test.ts`,
 * which asserts every token in the ramp has a weight, so a token added with an unmapped face
 * fails a test rather than quietly drawing a Korean heading light on somebody's phone.
 */
function systemFaceToken(style: TextStyle): TextStyle {
  const { fontFamily, ...rest } = style
  const weight = fontFamily === undefined ? undefined : SYSTEM_FACE_WEIGHTS[fontFamily]
  return weight === undefined ? rest : { ...rest, fontWeight: weight }
}

// Built once, on the first Korean edition to reach a phone, and shared from then on. The ramp is
// spread into style arrays all over the edition components, so a fresh object per call would make
// every one of them a new style on every render — which is also why `rampFor` hands a Latin
// edition `type` ITSELF rather than a copy of it.
//
// Memoised on whether the script is CJK rather than on the language string, because that is the
// only thing about the language this file reads. A map keyed by `lang` would grow an entry per
// tag a payload invents, to hold the same two answers.
let systemRamp: EditionTypeRamp | null = null

/** The ramp an edition in `lang` is drawn with. `type` itself for anything Inter can set. */
export function rampFor(lang: string): EditionTypeRamp {
  if (!isCjkScript(lang)) return type
  if (systemRamp === null) {
    systemRamp = Object.fromEntries(
      Object.entries(type).map(([token, style]) => [token, systemFaceToken(style)]),
    ) as EditionTypeRamp
  }
  return systemRamp
}

/**
 * The same rule for a face named on its own — the statement cells, the figure values and the
 * quoted symbols, which are sized beside the ramp rather than out of it.
 *
 * They need it for exactly the reason the ramp does: a figure's value arrives from the producer
 * already formatted, and in a Korean edition that is "578조원" in what the style asks to be
 * semibold Inter. Returns a style to spread, never a family string, because the answer is a
 * different PROPERTY in each language and a caller that had to know which would be the place the
 * rule got forgotten.
 */
export type EditionFace = (family: string) => TextStyle

function buildFace(system: boolean): EditionFace {
  // One style object per face, so a style array keeps its identity across renders.
  const cache = new Map<string, TextStyle>()
  return (family) => {
    let style = cache.get(family)
    if (style === undefined) {
      const weight = SYSTEM_FACE_WEIGHTS[family]
      style = system
        ? weight === undefined
          ? {}
          : { fontWeight: weight }
        : { fontFamily: family }
      cache.set(family, style)
    }
    return style
  }
}

const LATIN_FACE = buildFace(false)
const SYSTEM_FACE = buildFace(true)

/** How to ask for one of the theme's faces in `lang`. */
export function faceFor(lang: string): EditionFace {
  return isCjkScript(lang) ? SYSTEM_FACE : LATIN_FACE
}

// The language rather than the ramp, so the two hooks below cannot drift apart: they are the same
// answer read two ways. English by default, for the same reason `useStrings()` falls back instead
// of throwing — a component drawn outside the provider is drawn in the wrong face, which is not
// worth a red box.
const EditionLangContext = createContext<string>('en')

/** Wraps the edition — the masthead, the tiles, the opened tile. Nothing else changes ramp. */
export function EditionTypeProvider({ lang, children }: { lang: string; children: ReactNode }) {
  return <EditionLangContext.Provider value={lang}>{children}</EditionLangContext.Provider>
}

/**
 * The edition's own language tag, for the few decisions the ramp cannot carry.
 *
 * The ramp is a set of type tokens and may not touch size or line height (see the top of this
 * file), so a rule like "this one figure is set a point smaller in a script whose digits run
 * wider" has nowhere to live inside it. Those rules are pure functions keyed off the language --
 * `detail/tableGrid.ts`'s `labelEm`, `tiles/range.ts`'s `rangeStatValueSize` -- and this is how a
 * component that has no `Edition` in hand gets the argument to pass them.
 *
 * The EDITION's language, like everything else in this file: a cached Korean edition on an English
 * phone is still Korean.
 */
export function useEditionLang(): string {
  return useContext(EditionLangContext)
}

/** The ramp for the edition on screen. Replaces a direct `type.x` inside an edition component. */
export function useEditionType(): EditionTypeRamp {
  return rampFor(useContext(EditionLangContext))
}

/** The face rule for the edition on screen. Replaces a direct `fontFamily: fonts.x`. */
export function useEditionFace(): EditionFace {
  return faceFor(useContext(EditionLangContext))
}
