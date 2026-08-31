import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen } from '../../../components/Screen'
import { Button } from '../../../components/Button'
import { IconBadge } from '../../../components/IconBadge'
import { useOnboarding } from '../../../onboarding/OnboardingContext'
import { useDevice } from '../../../lib/device'
import { DEFAULT_BASE_URL } from '../../../lib/discovery'
import { colors, spacing } from '../../../theme/index'

export default function Complete() {
  const router = useRouter()
  const { deviceInfo, selectedNetwork, reset } = useOnboarding()
  const { setBaseUrl } = useDevice()
  const [busy, setBusy] = useState(false)

  const getStarted = async () => {
    if (busy) return
    setBusy(true)

    // The board has rebooted into station mode. Persist a control base URL for the Board tab:
    // prefer the station IP it reported (most reliable, no mDNS needed), else fall back to the
    // mDNS hostname. The Board tab will refine this once it can reach the device on the LAN.
    const ip = deviceInfo?.ip?.trim()
    const baseUrl = ip ? `http://${ip}` : DEFAULT_BASE_URL
    await setBaseUrl(baseUrl)
    reset()
    // Back to Settings, which is where the wizard was started from. Nothing is recorded about
    // "having onboarded": the app has no launch gate to unlock, only a board address to keep.
    router.dismissTo('/settings')
  }

  return (
    <Screen style={styles.screen}>
      <View style={styles.center}>
        <IconBadge name="checkmark-circle" size={56} />
        <Text style={styles.title}>Setup complete</Text>
        <Text style={styles.subtitle}>
          {selectedNetwork
            ? `Your board is connected to ‘${selectedNetwork}’.`
            : 'Your board is connected.'}
        </Text>
        <Text style={styles.guidance}>
          Reconnect your phone to that same Wi-Fi network, then tap Done to control your board
          over the local network.
        </Text>
      </View>

      <Button label={busy ? 'FINISHING…' : 'DONE'} onPress={getStarted} loading={busy} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  screen: {
    paddingHorizontal: spacing[16],
    paddingBottom: 8,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },
  title: {
    fontSize: 30,
    fontWeight: '700',
    color: colors.deskText,
    letterSpacing: 0.3,
  },
  subtitle: {
    fontSize: 17,
    color: colors.deskDim,
    textAlign: 'center',
  },
  guidance: {
    fontSize: 14,
    color: colors.deskFaint,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 300,
  },
})
