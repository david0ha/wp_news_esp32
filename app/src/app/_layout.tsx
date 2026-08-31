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
// The redesign's token set, and now the only one. `src/theme/legacy.ts` — the pre-redesign
// dark-terminal palette — is gone: this file was its last importer, for one token
// (`colors.bg`, #0B0E11) that painted the navigation container a different near-black from the
// #16151A every screen inside it paints. Two near-blacks, visible during a push transition and on
// overscroll, which is the one place the container is ever seen.
import { colors as theme } from '../theme/index'

// Module scope, before the component ever renders — the one place this call is allowed to work.
// It holds the launch image up until something explicitly hides it, which here is "the paper
// faces are ready or have given up."
SplashScreen.preventAutoHideAsync()

// The platform's native header, styled to this app's chrome — shared by every route in this stack
// that gets one: `watch/[symbol]` (Task 28) and the editions/notes routes below it (Task 30). All
// of them are reached only from a tap or a deep link, never a tab of its own, so the platform's own
// back control is the right one rather than this app's hand-built chrome header. One definition
// rather than one copy per screen, so the four never drift out of matching each other.
const NATIVE_HEADER = {
  headerShown: true,
  headerStyle: { backgroundColor: theme.desk },
  headerTintColor: theme.signal.chrome.tint,
  headerTitleStyle: { color: theme.deskText },
  headerShadowVisible: false,
} as const

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
                contentStyle: { backgroundColor: theme.desk },
              }}
            >
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              {/* Reached only from a `WatchRow` tap or a deep link, never a tab of its own, so the
                  platform's native back control (Task 28) is the right one rather than this app's
                  usual hand-built chrome header. `title` is set per-screen, dynamically, by the
                  route itself. */}
              <Stack.Screen name="watch/[symbol]" options={NATIVE_HEADER} />
              {/* The editorial history and its dossiers (Task 30) — reached from the Desk tab's
                  EDITIONS row, a StateStrip pointer, or a "The dossier" / "What came of it" link,
                  never a tab of its own. Same reasoning as `watch/[symbol]` above: the platform's
                  native header rather than this app's hand-built chrome one, and the same styling. */}
              <Stack.Screen name="editions/index" options={NATIVE_HEADER} />
              <Stack.Screen name="editions/[eid]" options={NATIVE_HEADER} />
              <Stack.Screen name="notes/[kind]/[id]" options={NATIVE_HEADER} />
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
