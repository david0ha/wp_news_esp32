import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Card } from '../Card'
import { Chip } from '../Chip'
import { OptionChainRow } from '../OptionChainRow'
import { OptionsSummary } from '../OptionsSummary'
import { OptionStrategyDetail, optionExpiryLabel } from './OptionStrategyDetail'
import { buildStrategy, type Strategy } from '../../lib/market/optionStrategy'
import { fill, useStrings } from '../../i18n'
import { colors, fonts, radius, space, type } from '../../theme'
import { analyzeChain } from '../../lib/market/analysis'
import { marketHumanError, type OptionChain, type OptionContract } from '../../lib/market/types'
import { alpacaOptions } from '../../lib/market/alpaca'

interface DetailSectionProps {
  symbol: string
  active: boolean
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; chain: OptionChain; switching: boolean; switchError: string | null }

export function OptionsSection({ symbol, active }: DetailSectionProps) {
  const t = useStrings()
  const [state, setState] = useState<LoadState>({ status: 'idle' })
  const [strategy, setStrategy] = useState<Strategy>('long_call')
  const [selected, setSelected] = useState<OptionContract[]>([])
  const [detailOpen, setDetailOpen] = useState(false)
  const side = strategy.includes('put') ? 1 : 0
  const spread = strategy.endsWith('spread')
  const [showAll, setShowAll] = useState(false)
  const seqRef = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state
  const retryExpiryRef = useRef<number | undefined>(undefined)

  const load = useCallback(
    async (expiration?: number, fresh = false) => {
      setSelected([])
      setDetailOpen(false)
      const seq = ++seqRef.current
      retryExpiryRef.current = expiration
      const cur = stateRef.current
      if (cur.status === 'ready') {
        setState({ status: 'ready', chain: cur.chain, switching: true, switchError: null })
      } else {
        setState({ status: 'loading' })
      }
      try {
        const chain = await alpacaOptions(symbol, expiration, { fresh })
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
    seqRef.current++
    stateRef.current = { status: 'idle' }
    setState({ status: 'idle' })
    setSelected([])
    setDetailOpen(false)
    setShowAll(false)
    retryExpiryRef.current = undefined
    return () => { seqRef.current++ }
  }, [symbol])

  useEffect(() => {
    if (active && stateRef.current.status === 'idle') void load()
  }, [active, load])

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
            <Text style={styles.degradedTitle}>{t.marketDetail.options.unavailable}</Text>
            <Text style={type.caption}>{marketHumanError(state.error)}</Text>
            <Pressable onPress={() => void load(retryExpiryRef.current)} hitSlop={8}>
              <Text style={styles.ghost}>{t.common.tryAgain}</Text>
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
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.expiryRow}>
        {(['long_call', 'long_put', 'long_call_spread', 'short_call_spread', 'long_put_spread', 'short_put_spread'] as Strategy[]).map(value =>
          <Chip key={value} label={t.marketDetail.options[value]} active={strategy === value} onPress={() => {
            setStrategy(value); setSelected([]); setDetailOpen(false); setShowAll(false)
          }} />)}
      </ScrollView>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.expiryRow}
      >
        {loadedChain.expirationDates.map((exp) => (
          <Chip
            key={exp}
            label={optionExpiryLabel(exp)}
            active={exp === loadedChain.expiration}
            onPress={() => {
              if (switching || exp === loadedChain.expiration) return
              void load(exp)
            }}
          />
        ))}
      </ScrollView>
      {state.switchError !== null ? (
        <Text style={styles.switchError}>
          {fill(t.marketDetail.options.switchError, {
            date: optionExpiryLabel(loadedChain.expiration),
            reason: state.switchError,
          })}
        </Text>
      ) : null}
      {analysis !== null ? <OptionsSummary analysis={analysis} /> : null}
      <Text style={type.caption}>{loadedChain.feed === 'opra' ? t.marketDetail.options.opra : loadedChain.feed === 'indicative' ? t.marketDetail.options.indicative : t.marketDetail.options.unknownFeed}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t.marketDetail.options.refresh} onPress={() => void load(loadedChain.expiration, true)} disabled={switching}><Text style={styles.ghost}>{t.marketDetail.options.refresh}</Text></Pressable>
      <Text style={type.caption}>{spread ? selected.length > 0 ? t.marketDetail.options.comparePairs : t.marketDetail.options.selectTwo : t.marketDetail.options.selectOne}</Text>
      {selected.length === 1 && spread ? <Text style={styles.ghost}>{t.marketDetail.options.selectedStrike}: {selected[0].strike}</Text> : null}
      {detailOpen && selected.length > 0 ? <OptionStrategyDetail strategy={strategy} contracts={selected} expiration={loadedChain.expiration} feed={loadedChain.feed} onClose={() => setDetailOpen(false)} /> : null}
      <Card style={styles.chainCard}>
        {switching ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : rows.length === 0 ? (
          // Two whole sentences rather than one with the side dropped into it: "No calls for this
          // expiry" is not a Korean sentence with a word swapped, it is a different sentence.
          <Text style={styles.empty}>
            {side === 0 ? t.marketDetail.options.emptyCalls : t.marketDetail.options.emptyPuts}
          </Text>
        ) : (
          <>
            {rows.map((c, i) => (
              <OptionChainRow key={`${c.strike}:${i}`} contract={c} last={i === rows.length - 1}
                pair={spread && selected[0] && selected[0].strike !== c.strike ? buildStrategy(strategy, selected[0], c) : undefined}
                selected={selected.some(item => item.strike === c.strike)} onPress={() => {
                  if (!spread) { setSelected([c]); setDetailOpen(true); return }
                  if (selected.length === 0) { setSelected([c]); setDetailOpen(false); return }
                  if (selected[0].strike === c.strike) { setSelected([]); setDetailOpen(false); return }
                  setSelected([selected[0], c]); setDetailOpen(true)
                }} />
            ))}
            {canToggle ? (
              <Pressable style={styles.foot} onPress={() => setShowAll(!showAll)} hitSlop={8}>
                <Text style={styles.ghost}>
                  {showAll ? t.marketDetail.options.showFewer : t.marketDetail.options.showAll}
                </Text>
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
