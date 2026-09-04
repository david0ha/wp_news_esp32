// AsyncStorage has no native module under Jest; use the library's official mock so any module
// that persists to AsyncStorage (src/lib/store.ts) doesn't throw at import/use time.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
)

// expo-localization reads the device's locale from a native module, which under Jest would either
// throw or — worse — answer with whatever the machine running the tests is set to. Pin it to
// en-US so the language a test resolves is a property of the test and not of the developer's
// laptop. `resolveLanguage` is pure and tested directly against every tag that matters, so nothing
// is lost by fixing the device's answer here.
jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-US', languageCode: 'en' }],
}))
