import { useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen } from '../components/Screen'
import { entryRouteFor, type EntryRoute } from '../onboarding/flow'
import {
  READ_RETRY_DELAYS_MS,
  isOnboardingComplete,
  isSetupSkipped,
  peekDeviceBaseUrl,
} from '../lib/store'
import { colors, type } from '../theme'

// Entry splash. It reads the three persisted bits and hands them to `entryRouteFor` — which is
// where the decision itself lives, and why this screen no longer contains one. It used to route on
// `isOnboardingComplete()` alone, a single flag standing in for both "is this person past the front
// door?" and "is there a board?"; anyone who owned no hardware answered no to the second forever
// and was walled at /onboarding/turn-on with no way past it. Splitting the bits meant the branch
// stopped fitting in a ternary and started deserving a test, so it moved to src/onboarding/flow.ts
// and this file kept only the reading and the navigating.
//
// An explicit base URL (a mock, or a dev board on the desk) counts as owning one — that is the
// whole reason `entryRouteFor` takes `envBaseUrl`: it has to outrank the persisted bits without
// writing any of them, because a dev build must not leave a board behind on the tester's phone.
const ENV_BASE_URL = process.env.EXPO_PUBLIC_ESP32_BASE_URL

export default function Index() {
  const router = useRouter()
  const [target, setTarget] = useState<EntryRoute | null>(null)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    ;(async () => {
      // All three reads are one AsyncStorage round-trip at worst and free thereafter — store.ts
      // caches them for the session — so they go in parallel and none of them is short-circuited,
      // ENV_BASE_URL included. Skipping a read to save it would put a second, subtly different copy
      // of the precedence rule here beside the one in `entryRouteFor`, which is exactly the split
      // that produced the wall this screen used to be.
      //
      // The base URL is read three-valued and retried, for the same reason `DeviceProvider` does
      // it: `getDeviceBaseUrl` answers `null` both for "no board is saved" and for "the disk did
      // not answer", and this screen commits its answer exactly once. One rejected read at launch
      // would otherwise hand `entryRouteFor` a `hasBoard: false` it never earned, and a phone with
      // a board on the shelf would open on the markets — or, if the two flags stumbled with it,
      // on the setup wizard, which is the precise wall this feature exists to remove.
      //
      // The two flags stay two-valued deliberately. Their failure direction is "ask again", and
      // being asked again is their whole cost; the base URL is the only bit here that, read wrong,
      // makes the app say something false about hardware the user is holding.
      for (let attempt = 0; ; attempt++) {
        const [saved, onboarded, skipped] = await Promise.all([
          peekDeviceBaseUrl(),
          isOnboardingComplete(),
          isSetupSkipped(),
        ])
        if (!active) return
        if (saved !== undefined) {
          setTarget(
            entryRouteFor({
              hasBoard: !!saved,
              onboarded,
              skipped,
              envBaseUrl: !!ENV_BASE_URL,
            }),
          )
          return
        }
        if (attempt >= READ_RETRY_DELAYS_MS.length) {
          // The disk never answered. Unlike `DeviceProvider`, this screen cannot hold "not known
          // yet" — it is a splash, and staying on it forever is the one outcome worse than being
          // in the wrong place. So it goes to the markets: the only destination that claims
          // nothing about a board. It never says "you have no board" (that sentence belongs to
          // `hasDevice`, which is still null and drawing a loading state), it strands nobody, and
          // a board owner is one tab away from theirs. Sending them to the wizard instead would
          // rebuild the wall out of a millisecond of bad luck.
          setTarget('/markets')
          return
        }
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt])
        })
        if (!active) return
      }
    })()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (target) router.replace(target)
  }, [target, router])

  return (
    <Screen aurora>
      <View style={styles.center}>
        <Text style={styles.brand}>Claude Post</Text>
        <ActivityIndicator color={colors.accent} />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  brand: {
    ...type.headingLg,
  },
})
