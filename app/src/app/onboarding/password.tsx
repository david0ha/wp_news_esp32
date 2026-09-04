import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Screen } from '../../components/Screen'
import { BackButton } from '../../components/BackButton'
import { Button } from '../../components/Button'
import { useOnboarding } from '../../onboarding/OnboardingContext'
import { parseOnboardingFlow, wizardStepHref } from '../../onboarding/flow'
import { esp32, Esp32Error } from '../../lib/esp32'
import { validateNewsUrl, newsUrlErrorMessage } from '../../lib/newsurl'
import { clearNewsUrlPending, saveNewsUrl } from '../../lib/store'
import { fill, strings, useStrings } from '../../i18n'
import { colors, fonts, layout, radius } from '../../theme'

// Map a provisioning failure to a short, user-facing reason.
//
// It reads the catalogue through `strings()` rather than a hook because it is a plain function
// outside the component, and it reads it *inside* the call rather than capturing a table at module
// scope: the language can change between this module being imported and this function being run,
// and a captured table would go on answering in the language the app started in.
function failureMessage(e: unknown): string {
  const errors = strings().onboarding.password.errors
  if (e instanceof Esp32Error) {
    switch (e.code) {
      case 'network_error':
        return errors.network
      case 'pass_too_long':
        return errors.passTooLong
      case 'ssid_empty':
      case 'ssid_too_long':
        return errors.ssid
      case 'news_url_invalid':
        return errors.newsUrl
      case 'too_large':
        return errors.tooLarge
      default:
        return errors.provision
    }
  }
  return errors.unknown
}

export default function Password() {
  const router = useRouter()
  const s = useStrings()
  // Read only to be handed onward — this screen hand-rolls its chrome and offers no flow-dependent
  // control (see the plan's "explicitly out of scope": no SKIP here, Back already reaches wifi-list,
  // which has one). It still carries the flow into complete, because the rule is every forward move
  // between steps rather than every step that reads one; see wizardStepHref in
  // src/onboarding/flow.ts for why the narrower rule is the one that broke.
  const flow = parseOnboardingFlow(useLocalSearchParams<{ flow?: string }>().flow)
  const { selectedNetwork, setSelectedNetwork, selectedSecured, password, setPassword, newsUrl, setDeviceInfo } =
    useOnboarding()
  // "Other…" leaves selectedNetwork null; the user types the SSID here.
  const isManualSsid = selectedNetwork === null
  const [manualSsid, setManualSsid] = useState('')
  const ssid = isManualSsid ? manualSsid.trim() : selectedNetwork

  const [reveal, setReveal] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The provision + poll can run up to ~45s; if the user leaves, don't run setState or fire a
  // router.replace from an unmounted screen.
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
  }, [])

  const passwordOk = selectedSecured === false || password.trim().length > 0
  const ssidOk = !!ssid && ssid.length > 0
  const enabled = ssidOk && passwordOk && !pending

  const join = async () => {
    if (!enabled || !ssid) return

    // Re-validate the snapshot URL here, not only on the step that collected it. This is the last
    // point before a ~45s join, and the board's own rejection would land on the far side of it.
    const vu = validateNewsUrl(newsUrl)
    if (!vu.ok) {
      setError(newsUrlErrorMessage(vu))
      return
    }

    setError(null)
    setPending(true)
    if (isManualSsid) setSelectedNetwork(ssid) // remember it for the completion screen copy
    try {
      // '' is meaningful and is sent as such: it puts the board on its built-in demo snapshot.
      await esp32.provision(ssid, password, vu.value ?? '')
    } catch (e) {
      if (!mounted.current) return
      setPending(false)
      setError(failureMessage(e))
      return
    }

    // The board accepted the address along with the credentials, so the phone's own copy is
    // brought level with it: saved, and marked delivered in the same breath. Without this the two
    // would disagree from the first minute — the board on the wizard's address, the phone on
    // whatever Settings last saved, with nothing pending to reconcile them.
    await saveNewsUrl(vu.value ?? '')
    await clearNewsUrlPending()

    // Credentials accepted; the board verifies them with a live join while its SoftAP stays up.
    // Poll until it reports the outcome (tolerating the brief AP drop during the channel hop).
    const result = await esp32.waitForConnected()
    if (!mounted.current) return
    setPending(false)
    if (result.outcome === 'connected') {
      // Refresh identity (now includes the STA ip/fw if the board re-reports it).
      esp32
        .getInfo()
        .then(setDeviceInfo)
        .catch((e) => console.warn('[onboarding] device info refresh failed', e))
      router.replace(wizardStepHref('complete', flow))
    } else if (result.outcome === 'failed') {
      setError(
        result.reason === 'auth_failed'
          ? s.onboarding.password.errors.authFailed
          : s.onboarding.password.errors.joinFailed,
      )
    } else {
      // 'timeout': on a single-radio board a SUCCESSFUL join hops the SoftAP onto the home AP's
      // channel, so the phone loses the setup AP and never reads 'connected'. A genuine failure
      // (e.g. bad password) is instead reported reliably as 'failed' above (the board restores its
      // own channel first). So a timeout almost always means success — proceed to completion,
      // which has the user rejoin home Wi-Fi and re-confirms the board over the LAN (mDNS / IP).
      router.replace(wizardStepHref('complete', flow))
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.titleRow}>
          <BackButton onPress={() => router.back()} />
          <Text style={styles.title}>{s.onboarding.password.title}</Text>
          <View style={styles.backSpacer} />
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {isManualSsid ? (
            <View style={styles.field}>
              <Text style={styles.label}>{s.onboarding.password.ssidLabel}</Text>
              <View style={styles.inputRow}>
                <TextInput
                  value={manualSsid}
                  onChangeText={setManualSsid}
                  placeholder={s.onboarding.password.ssidPlaceholder}
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!pending}
                  style={styles.input}
                />
              </View>
            </View>
          ) : (
            <Text style={styles.kicker}>
              {fill(s.onboarding.password.kicker, { ssid: selectedNetwork })}
            </Text>
          )}

          <View style={styles.field}>
            <Text style={styles.label}>{s.onboarding.password.passwordLabel}</Text>
            <View style={styles.inputRow}>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder={
                  selectedSecured === false
                    ? s.onboarding.password.openNetwork
                    : s.onboarding.password.passwordPlaceholder
                }
                placeholderTextColor={colors.textFaint}
                secureTextEntry={!reveal}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!pending}
                style={styles.input}
              />
              <Pressable
                accessibilityLabel={s.onboarding.password.toggleReveal}
                onPress={() => setReveal((r) => !r)}
                hitSlop={8}
              >
                <Ionicons name={reveal ? 'eye-outline' : 'eye-off-outline'} size={22} color={colors.textDim} />
              </Pressable>
            </View>
          </View>

          {/* What the board will do once it is on the network — shown here because this screen is
              the last chance to go back and change it. */}
          <Text style={styles.hint}>
            {newsUrl.trim()
              ? fill(s.onboarding.password.fetchHint, { url: newsUrl.trim() })
              : s.onboarding.password.noUrlHint}
          </Text>

          {pending ? (
            <Text style={styles.status}>
              <ActivityIndicator color={colors.accent} />{' '}
              {fill(s.onboarding.password.connecting, { ssid: ssid ?? '' })}
            </Text>
          ) : error ? (
            <Text style={styles.error}>{error}</Text>
          ) : null}
        </ScrollView>

        <View style={styles.ctaWrap}>
          <Button label={s.onboarding.password.join} onPress={join} disabled={!enabled} loading={pending} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.gutter,
    height: 56,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.text,
  },
  backSpacer: {
    width: 42,
  },
  body: {
    paddingHorizontal: layout.gutter,
    paddingTop: 16,
    gap: 20,
  },
  kicker: {
    fontSize: 14,
    color: colors.textDim,
  },
  field: {
    gap: 8,
  },
  label: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  inputRow: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    paddingVertical: 12,
  },
  hint: {
    fontSize: 12,
    color: colors.textFaint,
    lineHeight: 16,
  },
  status: {
    fontSize: 13,
    color: colors.textDim,
    lineHeight: 18,
  },
  error: {
    fontSize: 13,
    color: colors.down,
    lineHeight: 18,
  },
  ctaWrap: {
    paddingHorizontal: layout.gutter,
    paddingBottom: 8,
    paddingTop: 8,
  },
})
