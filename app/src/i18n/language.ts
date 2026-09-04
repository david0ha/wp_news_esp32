// What a language *is* in this app, and how a choice becomes a catalogue. Pure, and deliberately
// a leaf: it imports nothing, not even the catalogues it decides between.
//
// It is a file of its own for one structural reason. `store.ts` persists the choice and therefore
// needs the type and the guard, while `index.tsx` needs `store.ts` to read and write it — so
// putting these three lines in `index.tsx` would close a runtime import cycle between the two.
// Everything here is re-exported from `index.tsx`, so no caller has to know this file exists.

/** What the user picked. `system` defers to the phone; the other two override it. */
export type AppLanguage = 'system' | 'en' | 'ko'

/** What that resolves to — the two catalogues that actually exist. */
export type ResolvedLanguage = 'en' | 'ko'

/** Every value `AppLanguage` admits, in the order the Settings selector offers them. */
export const APP_LANGUAGES: readonly AppLanguage[] = ['system', 'en', 'ko']

/** Whether an arbitrary value — a string read back off disk, say — is a language this build knows. */
export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === 'system' || value === 'en' || value === 'ko'
}

/**
 * The choice plus the device's locale, resolved to a catalogue. This is the one decision in the
 * i18n layer that has a wrong answer rather than a slow one, which is why it is a pure function
 * with a test of its own instead of an expression inside the provider.
 *
 * `deviceTag` is a BCP-47 tag as `expo-localization` reports it (`ko-KR`, `en-US`), or null when
 * the platform reports no locale at all. Only the **primary subtag** decides, and it is compared
 * whole: `ko-Kore-KR` is Korean, `kok-IN` (Konkani) is not, and a `startsWith('ko')` would get the
 * second one wrong. Both separators are accepted because the two platforms disagree — Android has
 * been seen reporting `ko_KR`.
 *
 * Anything this build has no catalogue for falls to English, which is also what a missing or empty
 * tag means. English is the fallback everywhere; a half-translated screen never is.
 */
export function resolveLanguage(choice: AppLanguage, deviceTag: string | null): ResolvedLanguage {
  if (choice !== 'system') return choice
  const primary = (deviceTag ?? '').toLowerCase().split(/[-_]/)[0]
  return primary === 'ko' ? 'ko' : 'en'
}
