import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { Button } from '../../components/Button'
import { IconBadge } from '../../components/IconBadge'
import { useOnboarding } from '../../onboarding/OnboardingContext'
import { useDevice } from '../../lib/device'
import { markOnboardingComplete } from '../../lib/store'
import { DEFAULT_BASE_URL } from '../../lib/discovery'
import { colors, fonts, layout } from '../../theme'

export default function Complete() {
  const router = useRouter()
  const { deviceInfo, selectedNetwork, reset } = useOnboarding()
  const { setBaseUrl } = useDevice()
  const [busy, setBusy] = useState(false)

  const getStarted = async () => {
    if (busy) return
    setBusy(true)

    try {
      // The board has rebooted into station mode. Persist a control base URL for the Board tab:
      // prefer the station IP it reported (most reliable, no mDNS needed), else fall back to the
      // mDNS hostname. The Board tab will refine this once it can reach the device on the LAN.
      const ip = deviceInfo?.ip?.trim()
      const reported = ip ? `http://${ip}` : DEFAULT_BASE_URL

      // setBaseUrl answers false when normalizeBaseUrl rejects the URL, and the only input here
      // that can be rejected is the board's own reported `ip` — firmware that answers /api/info
      // with a truncated or otherwise malformed address. Letting that false go unread is precisely
      // how an "onboarded with no URL" install gets made: this screen is the only writer of the
      // onboarding mark, so the wizard would never run again and the base URL would stay missing
      // for the life of the install, with every screen pointed at a device that was never saved.
      // The retry is safe by construction — DEFAULT_BASE_URL is the constant this same line
      // already uses when the board reports no ip at all, so it normalizes and cannot be rejected
      // in turn.
      const ok = await setBaseUrl(reported)
      if (!ok) await setBaseUrl(DEFAULT_BASE_URL)

      await markOnboardingComplete()
      reset()

      // `dismissTo`, not `replace`, and the difference is an entire second copy of the app.
      //
      // This screen is reached two ways. On a first run the wizard *is* the root stack:
      // index.tsx replaced the splash with `/onboarding/turn-on`, so the app's root stack holds
      // `[onboarding]` and nothing else. But Settings and the Board tab's no-board card open the
      // same wizard with `router.push(wizardEntryHref('setup'))`, which leaves the root stack
      // holding `[(tabs), onboarding]` — the tabs the user came from, with the wizard on top.
      //
      // A `replace` resolves its target identically in both cases and is only right in one.
      // expo-router walks the action state for `/board` against the live tree (`findDivergentState`),
      // diverges at `(tabs)` vs `onboarding`, and so aims the REPLACE at the *root* stack; React
      // Navigation's StackRouter then swaps the route at that stack's `index` — the wizard — for a
      // freshly built `(tabs)`. On a first run `[onboarding]` becomes `[(tabs)]`, exactly right.
      // On a re-entry `[(tabs), onboarding]` becomes `[(tabs)#a, (tabs)#b]`: two Tabs navigators
      // on one stack. Board is on screen and everything looks finished, but the tabs group the
      // user opened Settings from is still mounted underneath, one iOS edge-swipe or one Android
      // back away — a stale duplicate of the whole app, sitting on Settings, that never updates
      // again.
      //
      // `dismissTo` pops rather than swaps: it looks *down* the stack for `(tabs)` and, finding
      // it, drops every route above it and hands it `{ screen: 'board' }`, so the tabs group that
      // already exists jumps to Board and the wizard is gone. When it is not there — the first run
      // — its documented fallback is to replace the current screen, which is the old behaviour
      // unchanged. One call, correct in both flows, with no branch left to get backwards.
      //
      // The branch that suggests itself, `canDismiss() ? dismissAll() : replace('/board')`, is
      // worse than the bug it means to fix. Both of those answer about the *closest* stack, and
      // the closest stack here is the onboarding stack itself — five screens deep by the time
      // anybody reaches this one — not the root stack the duplicate lives on. So `canDismiss()` is
      // true on a first run too, and `dismissAll()` pops the wizard back to `turn-on`: the user
      // finishes setup and lands on step one of setup, with the onboarding context already reset
      // out from under them.
      router.dismissTo('/board')
    } finally {
      // Cleared in a finally, not after the navigate: setBusy(true) with no matching clear is a
      // one-way door on this particular screen. It carries a single control and no Back, so one
      // rejected write leaves "OPENING…" spinning at somebody whose board is already on their
      // Wi-Fi, and the only way out is killing the app — which throws away the in-memory
      // onboarding context that got it there.
      setBusy(false)
    }
  }

  return (
    <Screen aurora style={styles.screen}>
      <View style={styles.center}>
        <IconBadge name="checkmark-circle" size={56} />
        <Text style={styles.title}>Setup complete</Text>
        <Text style={styles.subtitle}>
          {selectedNetwork
            ? `Your board is connected to ‘${selectedNetwork}’.`
            : 'Your board is connected.'}
        </Text>
        <Text style={styles.guidance}>
          Reconnect your phone to that same Wi-Fi network, then tap Open the Board to control your
          board over the local network.
        </Text>
      </View>

      <Button label={busy ? 'OPENING…' : 'OPEN THE BOARD'} onPress={getStarted} loading={busy} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  screen: {
    paddingHorizontal: layout.gutter,
    paddingBottom: 8,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 30,
    color: colors.text,
    letterSpacing: -0.4,
  },
  subtitle: {
    fontSize: 17,
    color: colors.textDim,
    textAlign: 'center',
  },
  guidance: {
    fontSize: 14,
    color: colors.textFaint,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 300,
  },
})
