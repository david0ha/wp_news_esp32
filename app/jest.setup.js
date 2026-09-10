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

// expo-notifications talks to APNs and FCM through a native module, and there is neither under
// Jest. The stand-in answers the two questions `notify.ts`'s wrappers ask and REFUSES to issue a
// push token, which is the honest answer for a machine that has no device to issue one for.
//
// Nothing in this suite exercises delivery, and nothing in it could: every test of the
// notification flow drives `turnOnNotifications` with its own fakes, so what is asserted is which
// call was made and what the switch did with the answer — never that a notification arrived.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: async () => ({
    status: 'undetermined',
    granted: false,
    canAskAgain: true,
    expires: 'never',
  }),
  requestPermissionsAsync: async () => ({
    status: 'undetermined',
    granted: false,
    canAskAgain: true,
    expires: 'never',
  }),
  getExpoPushTokenAsync: async () => {
    throw new Error('no device to issue a push token for')
  },
  setNotificationChannelAsync: async () => undefined,
  // The response listener the ask feature mounts. Nothing in this suite exercises delivery — a tap
  // cannot happen under Jest — so this hands back a subscription that removes cleanly and never
  // fires, which is what `_layout.tsx`'s effect needs to mount and unmount.
  addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
  IosAuthorizationStatus: {
    NOT_DETERMINED: 0,
    DENIED: 1,
    AUTHORIZED: 2,
    PROVISIONAL: 3,
    EPHEMERAL: 4,
  },
  AndroidImportance: { DEFAULT: 3, HIGH: 4, MAX: 5 },
}))
