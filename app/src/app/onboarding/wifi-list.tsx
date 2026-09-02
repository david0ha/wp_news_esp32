import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { StepScaffold } from '../../components/StepScaffold'
import { IconBadge } from '../../components/IconBadge'
import { useOnboarding } from '../../onboarding/OnboardingContext'
import {
  canProceed,
  parseOnboardingFlow,
  progressFor,
  wizardOffersSkip,
  wizardStepHref,
} from '../../onboarding/flow'
import { skipSetup } from '../../onboarding/skip'
import { esp32, type ScanNetwork } from '../../lib/esp32'
import { colors, fonts, radius } from '../../theme'

export default function WifiList() {
  const router = useRouter()
  // Why the wizard opened, and therefore whether the top-right control is an exit. Back is
  // unconditional here — wifi-list is never the first screen, so there is always a turn-on behind
  // it — but SET UP LATER only makes sense on a first run: a re-entry from Settings already has
  // somewhere to go back to, and "not now" is not a thing to say twice to somebody who came here
  // on purpose. See src/onboarding/flow.ts for the argument.
  const flow = parseOnboardingFlow(useLocalSearchParams<{ flow?: string }>().flow)
  const { selectedNetwork, setSelectedNetwork, setSelectedSecured, password, newsUrl } =
    useOnboarding()
  const [networks, setNetworks] = useState<ScanNetwork[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [other, setOther] = useState(false)

  const scan = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      setNetworks(await esp32.scanNetworks())
    } catch (e) {
      console.warn('[onboarding] Wi-Fi scan failed', e)
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    scan()
  }, [scan])

  // The device scan often returns the same SSID more than once (dual-band radios, mesh nodes,
  // repeated scan hits). Collapse to one row per SSID — keeping the strongest signal.
  const uniqueNetworks = useMemo(() => {
    const strongest = new Map<string, ScanNetwork>()
    for (const net of networks) {
      const prev = strongest.get(net.ssid)
      if (!prev || net.rssi > prev.rssi) strongest.set(net.ssid, net)
    }
    return Array.from(strongest.values()).sort((a, b) => b.rssi - a.rssi)
  }, [networks])

  // When "Other…" is chosen the SSID is entered on the password step, so we don't yet have one.
  // Treat it as secured so the password field is required.
  const proceed = other || canProceed('wifi-list', { selectedNetwork, password, newsUrl })

  // Whether the "Other…" row draws its top border. It is a divider, so it needs something above
  // it to divide from — the error block, or at least one network row. A scan that succeeds and
  // finds nothing gives it neither, and a lone hairline across the top of an otherwise empty card
  // reads as the top edge of a list that is not there. The comment this replaces asserted the
  // border "always shows" because an empty placeholder held that position; no such placeholder is
  // in this file, so the claim was already one branch out of date before the error branch grew a
  // row of its own.
  const otherDivided = error || uniqueNetworks.length > 0

  return (
    <StepScaffold
      progress={progressFor('wifi-list')}
      onBack={() => router.back()}
      onSkip={wizardOffersSkip(flow) ? () => void skipSetup(router) : undefined}
      skipLabel="SET UP LATER"
      ctaLabel="NEXT"
      ctaVariant="secondary"
      canProceed={proceed}
      // news is the first step that does not read the flow — its own SKIP means "leave the URL
      // blank and go on", not "leave the wizard". It carries the param anyway: the rule is every
      // forward move, not every reader, because a reader added later lands in a different file
      // from the push that feeds it. See wizardStepHref.
      onNext={() => router.push(wizardStepHref('news', flow))}
    >
      <View style={styles.header}>
        <IconBadge name="wifi" size={44} />
        <Text style={styles.caption}>Choose the Wi-Fi the board should join.</Text>
      </View>

      <View style={styles.sectionRow}>
        <Text style={styles.sectionLabel}>NETWORKS</Text>
        <Pressable accessibilityLabel="Rescan networks" onPress={scan} hitSlop={8} disabled={loading}>
          <Ionicons name="refresh" size={18} color={loading ? colors.textFaint : colors.text} />
        </Pressable>
      </View>

      <ScrollView style={styles.card} contentContainerStyle={styles.cardContent} showsVerticalScrollIndicator={false}>
        {loading ? (
          <View style={styles.state}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.stateText}>Scanning…</Text>
          </View>
        ) : (
          <>
            {error ? (
              <Pressable style={styles.state} onPress={scan} accessibilityRole="button">
                <Text style={styles.stateText}>Couldn’t reach the board. Make sure you’re on its setup Wi-Fi.</Text>
                <Text style={styles.retry}>TAP TO RETRY</Text>
              </Pressable>
            ) : (
              uniqueNetworks.map((net, i) => {
                const selected = !other && net.ssid === selectedNetwork
                return (
                  <Pressable
                    key={net.ssid}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={[styles.row, i > 0 && styles.rowBordered]}
                    onPress={() => {
                      setOther(false)
                      setSelectedNetwork(net.ssid)
                      setSelectedSecured(net.secured)
                    }}
                  >
                    <Text style={[styles.ssid, selected && styles.ssidSelected]} numberOfLines={1}>
                      {net.ssid}
                    </Text>
                    <View style={styles.icons}>
                      {selected ? <Ionicons name="checkmark" size={20} color={colors.accent} /> : null}
                      {net.secured ? <Ionicons name="lock-closed" size={16} color={colors.textDim} /> : null}
                      <Ionicons name="wifi" size={18} color={colors.text} />
                    </View>
                  </Pressable>
                )
              })
            )}

            {/* Manual / hidden SSID entry — the name itself is typed on the next step. It lives
                outside the error branch on purpose. A board that answers /api/info but fails
                /api/scan used to hide this row along with the list, which put the one way past a
                scan that had just proved it would not come back — typing the SSID by hand —
                behind the failure itself: a disabled NEXT and nothing to press but TAP TO RETRY.
                The scan is the board's opinion about the air around it, not a precondition for the
                user knowing the name of their own network. */}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: other }}
              style={[styles.row, otherDivided && styles.rowBordered]}
              onPress={() => {
                setOther(true)
                setSelectedNetwork(null)
                setSelectedSecured(true)
              }}
            >
              <Text style={[styles.ssid, other && styles.ssidSelected]}>Other…</Text>
              {other ? <Ionicons name="checkmark" size={20} color={colors.accent} /> : null}
            </Pressable>
          </>
        )}
      </ScrollView>
    </StepScaffold>
  )
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    gap: 14,
    paddingTop: 16,
  },
  caption: {
    fontSize: 14,
    color: colors.textDim,
    textAlign: 'center',
    lineHeight: 20,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 24,
    marginBottom: 12,
  },
  sectionLabel: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.textDim,
    letterSpacing: 1,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  cardContent: {
    paddingHorizontal: 16,
  },
  state: {
    paddingVertical: 32,
    alignItems: 'center',
    gap: 12,
  },
  stateText: {
    fontSize: 14,
    color: colors.textDim,
    textAlign: 'center',
    lineHeight: 20,
  },
  retry: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.accent,
    letterSpacing: 0.5,
  },
  row: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowBordered: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  ssid: {
    fontSize: 16,
    color: colors.text,
    flexShrink: 1,
  },
  ssidSelected: {
    fontFamily: fonts.semibold,
    color: colors.accent,
  },
  icons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
})
