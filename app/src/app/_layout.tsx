import { useEffect } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter'
import * as SplashScreen from 'expo-splash-screen'
import { DeviceProvider } from '../lib/device'
import { addNotificationTapListener } from '../lib/notify'
import { LanguageProvider } from '../i18n'
import { colors } from '../theme'

// Hold the native splash until the five Inter faces are in, so no screen ever flashes the
// system font. On a font *error* the app proceeds anyway — RN falls back per-Text, which is
// the design's stated fallback. Never block the app on a font.
SplashScreen.preventAutoHideAsync().catch(() => {})

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  })
  const router = useRouter()

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync().catch(() => {})
  }, [fontsLoaded, fontError])

  // A tap on the desk's "your answer is ready" opens the conversation it is about. Mounted at the
  // ROOT and not on a screen: the tap that matters most is the one on a cold process, where no
  // screen is mounted yet and the notification is the reason the app is starting at all —
  // `addNotificationTapListener` covers exactly that case by also checking the library's
  // last-response snapshot, not just the live event.
  useEffect(() => addNotificationTapListener((route) => router.push(route)), [router])

  if (!fontsLoaded && !fontError) return null

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* LanguageProvider is outermost of the two because it decides the words every screen
            under it draws with — including the sentences DeviceProvider's readers say about a
            board — and it keeps the module-level table `strings()` reads current, which the pure
            copy catalogues in src/lib depend on. It does not gate rendering: see the provider. */}
        <LanguageProvider>
          {/* DeviceProvider resolves the control-API base URL once and shares a client app-wide. */}
          <DeviceProvider>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="onboarding" />
              {/* Full-screen pushes over the tab bar. */}
              <Stack.Screen name="preview" />
              <Stack.Screen name="market/[symbol]" />
              {/* The event book, opened from the Markets tab's next-three block. */}
              <Stack.Screen name="schedule" />
              {/* A message to the desk and its answer. Opened from Today's header, or by a tap on
                  the push that says an answer arrived. */}
              <Stack.Screen name="ask" />
              {/* One tile of today's edition, opened. Named `tile` and not `edition` so it does
                  not share a URL prefix with the Today tab, which is `(tabs)/edition.tsx`. */}
              <Stack.Screen name="tile/[id]" />
              <Stack.Screen name="add-ticker" options={{ presentation: 'modal' }} />
            </Stack>
          </DeviceProvider>
        </LanguageProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
