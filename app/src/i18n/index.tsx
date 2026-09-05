// The app's own language: which of the two catalogues its chrome is drawn from, who decides, and
// where the answer is kept.
//
// This is NOT the edition's language. An edition arrives with a `lang` field and is drawn in that
// language whatever the phone is set to, because the field describes text that is already in the
// payload; a cached Korean edition on an English phone is still Korean. The two settings are
// deliberately separate and neither reads the other.
//
// The choice is three-valued — `system | en | ko` — and `system` is the default because the right
// first guess is the one the phone already made. It resolves through `expo-localization`, which is
// bundled in Expo Go, so no development build is needed to try this.
//
// TWO WAYS TO READ THE CATALOGUE, and they exist for different callers:
//
//   - `useStrings()` inside a component. It subscribes: change the language and the screen redraws.
//   - `strings()` anywhere else — the pure sentence catalogues in `src/lib/**` that return copy
//     from a switch and have no hook to hang a subscription on. It reads a module-level table the
//     provider keeps current, which is why those functions must read it *at call time* rather than
//     capturing it at module scope. Their tests set the table directly through `setActiveLanguage`.
//
// The module-level table is a mutable global, which is worth naming as such. It is safe here for a
// narrow reason: exactly one writer (the provider, or a test), and every reader is either a
// component that re-renders on the same state change or a pure function called fresh each time. It
// would stop being safe the moment something cached its result.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import * as Localization from 'expo-localization'
import { en, type Strings } from './en'
import { ko } from './ko'
import { resolveLanguage, type AppLanguage, type ResolvedLanguage } from './language'
import { getLanguage, saveLanguage } from '../lib/store'

// The whole i18n surface is imported from this module, `language.ts`'s share of it included — that
// file is split out to break an import cycle with `store.ts`, which is nobody else's business.
export { type Strings } from './en'
export {
  APP_LANGUAGES,
  isAppLanguage,
  resolveLanguage,
  type AppLanguage,
  type ResolvedLanguage,
} from './language'

const TABLES: Record<ResolvedLanguage, Strings> = { en, ko }

/**
 * Substitute `{name}` placeholders. Every occurrence is replaced; a placeholder with no value is
 * left standing, on purpose — a visible `{host}` in a screenshot says which value went missing,
 * where an empty string produces "Found your board at ." and nothing to go on.
 */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  )
}

// The table every non-component caller reads. English until the provider says otherwise, which is
// also the right answer for a test that never sets one.
let current: Strings = en

/** The current catalogue, read fresh at call time. For pure functions; components use `useStrings`. */
export function strings(): Strings {
  return current
}

/**
 * Point `strings()` at a catalogue. The provider calls this as it renders; tests call it to assert
 * a sentence in a chosen language. Nothing else should — a component that wants a different
 * language wants the provider's `set`, which also persists the choice.
 */
export function setActiveLanguage(resolved: ResolvedLanguage): void {
  current = TABLES[resolved]
}

interface LanguageContextValue {
  /** What the user picked, including `system`. This is what the Settings selector highlights. */
  choice: AppLanguage
  /** What that came out as. This is what decides the copy. */
  resolved: ResolvedLanguage
  /** The catalogue for `resolved`, so `useStrings` costs no lookup. */
  table: Strings
  /** Record a new choice and persist it. */
  set: (choice: AppLanguage) => Promise<void>
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

/**
 * Holds the choice for the app and keeps `strings()` level with it.
 *
 * Children render on the first frame rather than being held back until AsyncStorage answers, and
 * that is a decision rather than an oversight. Holding them would blank the whole app for the
 * length of one disk read — this provider sits *inside* the root layout's font gate, so the read
 * has not even started when the splash comes down. What it would buy is avoiding one frame of the
 * wrong language, and only on a phone whose explicit choice differs from its own locale; every
 * phone on `system` (the default, and the majority) resolves correctly on frame one because the
 * device tag needs no disk at all. A blank app is a worse first frame than a correct-in-a-moment
 * one.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<AppLanguage>('system')

  useEffect(() => {
    let active = true
    void (async () => {
      const stored = await getLanguage()
      if (active) setChoice(stored)
    })()
    return () => {
      active = false
    }
  }, [])

  // Read once per mount. The platform restarts the app when the system language changes, so a tag
  // that goes stale takes the whole process with it; re-reading on every render would be a native
  // call per frame to learn the same thing.
  const deviceTag = useMemo(() => Localization.getLocales()[0]?.languageTag ?? null, [])

  const resolved = resolveLanguage(choice, deviceTag)

  // Set during render, not in an effect. A pure function called by a child on this same render —
  // `humanError`, a freshness sentence — reads `strings()` before any effect has run, and an
  // effect would hand it the previous language for exactly one frame after every change. The write
  // is idempotent, so React re-rendering this component twice costs nothing.
  setActiveLanguage(resolved)

  const set = useCallback(async (next: AppLanguage) => {
    setChoice(next)
    await saveLanguage(next)
  }, [])

  const value = useMemo<LanguageContextValue>(
    () => ({ choice, resolved, table: TABLES[resolved], set }),
    [choice, resolved, set],
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

/**
 * The catalogue, for a component. Falls back to the module-level table when there is no provider
 * above rather than throwing, unlike `useDevice`: a missing provider there means the screen cannot
 * do its job, while here it means the screen is drawn in English. Copy is never worth a red box.
 */
export function useStrings(): Strings {
  return useContext(LanguageContext)?.table ?? current
}

/** The choice, and how to change it. Settings is the only screen that needs this. */
export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used inside LanguageProvider')
  return ctx
}
