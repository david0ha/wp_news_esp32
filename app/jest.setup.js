// AsyncStorage has no native module under Jest; use the library's official mock so any module
// that persists to AsyncStorage (src/lib/store.ts) doesn't throw at import/use time.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
)

// expo-secure-store is the iOS keychain and Android's EncryptedSharedPreferences, neither of which
// exists under Jest. An in-memory Map is the right stand-in: `deskToken.ts` only ever asks it to
// hold, hand back and forget one string, and the tests that matter are about what happens when it
// REFUSES — which they arrange with `jest.spyOn` over these three, so the functions have to be
// plain writable properties rather than a frozen native module.
jest.mock('expo-secure-store', () => {
  const items = new Map()
  return {
    getItemAsync: async (key) => (items.has(key) ? items.get(key) : null),
    setItemAsync: async (key, value) => {
      items.set(key, value)
    },
    deleteItemAsync: async (key) => {
      items.delete(key)
    },
  }
})

// expo-localization reads the device's locale from a native module, which under Jest would either
// throw or — worse — answer with whatever the machine running the tests is set to. Pin it to
// en-US so the language a test resolves is a property of the test and not of the developer's
// laptop. `resolveLanguage` is pure and tested directly against every tag that matters, so nothing
// is lost by fixing the device's answer here.
jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-US', languageCode: 'en' }],
}))
