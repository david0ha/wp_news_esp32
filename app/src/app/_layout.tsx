import { useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { QueryClientProvider } from '@tanstack/react-query'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { DeviceProvider } from '../lib/device'
import { onAppStateChange, queryClient } from '../lib/queries'
import { useAppFonts } from '../lib/fonts'
import { colors } from '../theme'

// Module scope, before the component ever renders — the one place this call is allowed to work.
// It holds the launch image up until something explicitly hides it, which here is "the paper
// faces are ready or have given up."
SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const [loaded, error] = useAppFonts()

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync()
    }
  }, [loaded, error])

  // react-query's `refetchInterval` skips a backgrounded app once `focusManager` knows about it
  // (the default `refetchIntervalInBackground: false`), which is the whole mechanism behind every
  // "N seconds while focused" hook in src/lib/queries.ts — this is the one line that wires it up.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (status: AppStateStatus) =>
      onAppStateChange(status),
    )
    return () => sub.remove()
  }, [])

  // Keep the splash up only while still genuinely loading. On error, render anyway: a platform
  // serif fallback (typography.ts's own fallback path, since a family that never resolved is
  // silently substituted) is a legible paper printed on the wrong day, which beats a blank app
  // stuck behind a launch image that will never hide itself for any other reason.
  if (!loaded && !error) {
    return null
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* One QueryClient for the desk and the board both — src/lib/queries.ts is the only
            module that touches either client's methods; every screen reads through its hooks. */}
        <QueryClientProvider client={queryClient}>
          {/* DeviceProvider resolves the control-API base URL once and shares a client app-wide. */}
          <DeviceProvider>
            {/* The root stack holds four things and no launch gate — plan Decisions D7. `(tabs)`
                is the app; `settings` is pushed over it from the gear each tab carries, so it
                covers the tab bar and comes back to the tab you were on; the two form sheets are
                raised over whatever is underneath and dismissed by dragging down. The pairing
                wizard is not here: it lives under `settings/pair`, reached from Settings. */}
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
              }}
            >
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              {/* `settings/index`, not `settings`: there is no `settings/_layout.tsx`, so the
                  directory is flattened into this stack rather than becoming a navigator of its
                  own. `settings/pair` *is* one — its `_layout` carries the wizard's state across
                  the five steps — so it appears here as a single screen. */}
              <Stack.Screen name="settings/index" />
              <Stack.Screen name="settings/pair" />
              {/* A sheet of paper, full size and zoomable, and the composer that files an order.
                  `formSheet` is the platform's own: it keeps what raised it visible behind, which
                  is the point — you are looking *at* a sheet, not navigating away to one. */}
              <Stack.Screen name="sheet/[source]" options={{ presentation: 'formSheet' }} />
              <Stack.Screen name="compose" options={{ presentation: 'formSheet' }} />
            </Stack>
          </DeviceProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
