import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Card } from '../Card'
import { Chip } from '../Chip'
import { OptionChainHeader, OptionChainRow } from '../OptionChainRow'
import { OptionsSummary } from '../OptionsSummary'
import { SegmentedControl } from '../SegmentedControl'
import { colors, fonts, radius, space, type } from '../../theme'
import { analyzeChain } from '../../lib/market/analysis'
import { formatDateShort } from '../../lib/market/format'
import { marketHumanError, type OptionChain, type OptionContract } from '../../lib/market/types'
import { yahoo } from '../../lib/market/yahoo'

interface DetailSectionProps {
  symbol: string
  active: boolean
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; chain: OptionChain; switching: boolean; switchError: string | null }

/**
 * The detail screen's Options tab: expiry pill selector, the floating analysis card,
 * a Calls/Puts toggle and the four-column chain, fed by the crumb-gated
 * yahoo.options(symbol[, expiry]). Fetched lazily on first activation (front expiry);
 * a failed crumb bootstrap lands in the friendly degraded card with its own retry.
 * While an expiry switch is in flight the selector stays (active on the loaded chain)
 * and only the chain area shows a spinner; a switch that FAILS keeps the loaded chain on
 * screen (stale beats blank) with an inline notice near the pills — the degraded card is
 * only ever a first load's failure. The chain is windowed to the 20 strikes nearest spot,
 * with a ghost show-all/show-fewer toggle at the foot.
 */
export function OptionsSection({ symbol, active }: DetailSectionProps) {
  const [state, setState] = useState<LoadState>({ status: 'idle' })
  const [side, setSide] = useState(0) // 0 calls, 1 puts
  const [showAll, setShowAll] = useState(false)
  const seqRef = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state
  const retryExpiryRef = useRef<number | undefined>(undefined)

  const load = useCallback(
    async (expiration?: number) => {
      const seq = ++seqRef.current
      retryExpiryRef.current = expiration
      const cur = stateRef.current
      if (cur.status === 'ready') {
        setState({ status: 'ready', chain: cur.chain, switching: true, switchError: null })
      } else {
        setState({ status: 'loading' })
      }
      try {
        const chain = await yahoo.options(symbol, expiration)
        if (seqRef.current !== seq) return
        setState({ status: 'ready', chain, switching: false, switchError: null })
      } catch (e) {
        if (seqRef.current !== seq) return
        const prev = stateRef.current
        if (prev.status === 'ready') {
          // A failed expiry switch keeps the perfectly renderable chain already on screen
          // (the stale-beats-blank rule NewsSection and the chart already follow) and says so
          // inline near the pills; the section-level degraded card is reserved for a first
          // load with nothing to show.
          setState({ status: 'ready', chain: prev.chain, switching: false, switchError: marketHumanError(e) })
        } else {
          setState({ status: 'error', error: e })
        }
      }
    },
    [symbol],
  )

  useEffect(() => {
    if (active && state.status === 'idle') void load()
  }, [active, state.status, load])

  const chain = state.status === 'ready' ? state.chain : null
  const analysis = useMemo(() => (chain === null ? null : analyzeChain(chain)), [chain])

  if (!active) return null

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <View style={styles.section}>
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </View>
    )
  }

  if (state.status === 'error') {
    return (
      <View style={styles.section}>
        <Card style={styles.degraded}>
          <View style={styles.degradedIcon}>
            <Ionicons name="options-outline" size={20} color={colors.accent} />
          </View>
          <View style={styles.degradedText}>
            <Text style={styles.degradedTitle}>Options unavailable</Text>
            <Text style={type.caption}>{marketHumanError(state.error)}</Text>
            <Pressable onPress={() => void load(retryExpiryRef.current)} hitSlop={8}>
              <Text style={styles.ghost}>Try again</Text>
            </Pressable>
          </View>
        </Card>
      </View>
    )
  }

  const { switching } = state
  const loadedChain = state.chain
  const contracts = side === 0 ? loadedChain.calls : loadedChain.puts
  const { rows, canToggle } = windowRows(contracts, loadedChain.spot, showAll)

  return (
    <View style={styles.section}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.expiryRow}
      >
        {loadedChain.expirationDates.map((exp) => (
          <Chip
            key={exp}
            label={formatDateShort(exp)}
            active={exp === loadedChain.expiration}
            onPress={() => {
              if (switching || exp === loadedChain.expiration) return
              void load(exp)
            }}
          />
        ))}
      </ScrollView>
      {state.switchError !== null ? (
        <Text style={styles.switchError}>{`Couldn’t load that expiry — still showing ${formatDateShort(loadedChain.expiration)}. ${state.switchError}`}</Text>
      ) : null}
      {analysis !== null ? <OptionsSummary analysis={analysis} /> : null}
      <View style={styles.toggleWrap}>
        <SegmentedControl segments={['Calls', 'Puts']} selectedIndex={side} onChange={setSide} />
      </View>
      <Card style={styles.chainCard}>
        <OptionChainHeader />
        {switching ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : rows.length === 0 ? (
          <Text style={styles.empty}>No {side === 0 ? 'calls' : 'puts'} for this expiry.</Text>
        ) : (
          <>
            {rows.map((c, i) => (
              <OptionChainRow key={`${c.strike}:${i}`} contract={c} last={i === rows.length - 1} />
            ))}
            {canToggle ? (
              <Pressable style={styles.foot} onPress={() => setShowAll(!showAll)} hitSlop={8}>
                <Text style={styles.ghost}>{showAll ? 'Show fewer' : 'Show all strikes'}</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </Card>
    </View>
  )
}

/**
 * The 20 strikes nearest spot — 10 below, 10 above, shifted to stay in range at the
 * chain's edges. Everything when spot is unknown or the side has ≤ 20 strikes;
 * `canToggle` says whether a show-all/show-fewer foot belongs under the list.
 */
function windowRows(
  contracts: OptionContract[],
  spot: number | null,
  showAll: boolean,
): { rows: OptionContract[]; canToggle: boolean } {
  if (spot === null || !Number.isFinite(spot) || contracts.length <= 20) {
    return { rows: contracts, canToggle: false }
  }
  if (showAll) return { rows: contracts, canToggle: true }
  let below = 0
  while (below < contracts.length && contracts[below].strike < spot) below++
  let start = below - 10
  if (start < 0) start = 0
  if (start + 20 > contracts.length) start = contracts.length - 20
  return { rows: contracts.slice(start, start + 20), canToggle: true }
}

const styles = StyleSheet.create({
  section: {
    paddingTop: space.lg,
    paddingBottom: space.xl,
    gap: space.lg,
  },
  loadingBox: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  expiryRow: {
    gap: space.sm,
    paddingVertical: 2, // room for the chip hairline; the pills own their height
  },
  toggleWrap: {
    // SegmentedControl stretches; give it the full row like the board's A1/A2 toggle
    alignSelf: 'stretch',
  },
  chainCard: {
    padding: 0,
    overflow: 'hidden', // the ITM wash must not poke past the card's rounded corners
  },
  foot: {
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  ghost: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.accent,
  },
  empty: {
    ...type.caption,
    textAlign: 'center',
    paddingVertical: space.xl,
  },
  switchError: {
    ...type.caption,
    color: colors.warn,
  },
  degraded: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  degradedIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.iconWell,
    alignItems: 'center',
    justifyContent: 'center',
  },
  degradedText: {
    flex: 1,
    gap: space.sm,
  },
  degradedTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
})
