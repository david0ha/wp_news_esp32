// AsyncStorage has no native module under Jest; use the library's official mock so any module
// that persists to AsyncStorage (src/lib/store.ts) doesn't throw at import/use time.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
)

// expo-secure-store has no native module under Jest either, and ships no official mock (unlike
// AsyncStorage above): under the jest-expo preset its native calls resolve `undefined` rather
// than throwing, which can't exercise a real get-after-set round trip or a locked-device failure.
// A minimal in-memory fake stands in so src/lib/settings.ts's token storage behaves like the real
// thing; a test that needs the "locked device" case overrides one call with jest.spyOn(...).
jest.mock('expo-secure-store', () => {
  const store = new Map()
  return {
    getItemAsync: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    setItemAsync: jest.fn(async (key, value) => {
      store.set(key, value)
    }),
    deleteItemAsync: jest.fn(async (key) => {
      store.delete(key)
    }),
  }
})
