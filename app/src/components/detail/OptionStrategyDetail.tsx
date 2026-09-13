import { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Svg, { Line, Polyline, Text as SvgText } from 'react-native-svg'
import { useStrings } from '../../i18n'
import { colors, fonts, space, type } from '../../theme'
import { buildStrategy, type Strategy, type OptionStrategy } from '../../lib/market/optionStrategy'
import { type OptionContract } from '../../lib/market/types'
import { formatIv, formatPrice, formatCompact } from '../../lib/market/format'
import { Cell, greek } from '../OptionChainRow'

export const optionExpiryLabel = (expiration: number) => new Date(expiration * 1000).toISOString().slice(0, 10)

const GREEKS = ['delta', 'gamma', 'theta', 'vega', 'rho'] as const

function timestamp(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—'
}

export function OptionStrategyDetail({
  strategy,
  contracts,
  expiration,
  feed,
  onClose,
}: {
  strategy: Strategy
  contracts: OptionContract[]
  expiration: number
  feed?: string
  onClose: () => void
}) {
  const t = useStrings().marketDetail.options
  const [entry, setEntry] = useState('')
  const parsed = entry.trim() === '' ? undefined : Number(entry.replace(',', '.'))
  const result = buildStrategy(strategy, contracts[0], contracts[1], parsed)
  const money = (value: number | null) =>
    value === Infinity ? t.unlimited : value === null ? '—' : `$${formatPrice(value)}`
  const premiumDirection = result.premium === null ? '' : ` · ${result.premium < 0 ? t.credit : t.debit}`

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>{t.detailTitle}</Text>
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={10}>
            <Text style={styles.link}>{t.closeDetail}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>{t[strategy]} · {optionExpiryLabel(expiration)}</Text>
          <Text style={type.caption}>
            {feed === 'opra' ? t.opra : feed === 'indicative' ? t.indicative : t.unknownFeed}
          </Text>
          <Text style={type.caption}>{t.entryHint}</Text>
          {contracts.some(contract => contract.multiplier !== 100) ? (
            <Text style={type.caption}>{t.unsupportedDeliverable}</Text>
          ) : null}
          <Text style={type.label}>{t.entryPremium}</Text>
          <TextInput
            accessibilityLabel={t.entryPremium}
            value={entry}
            onChangeText={setEntry}
            keyboardType="numbers-and-punctuation"
            placeholder={result.premium === null ? '—' : result.premium.toFixed(2)}
            style={styles.input}
          />
          <View style={styles.grid}>
            <Cell
              label={`${t.premium}${premiumDirection}`}
              value={money(result.premium === null ? null : Math.abs(result.premium))}
            />
            <Cell
              label={contracts.length === 2 ? t.strategyTotal : t.contractTotal}
              value={money(result.premiumTotal === null ? null : Math.abs(result.premiumTotal))}
            />
            <Cell label={t.breakEven} value={money(result.breakEven)} />
            <Cell label={t.maxProfit} value={money(result.maxProfit)} />
            <Cell label={t.maxLoss} value={money(result.maxLoss)} />
            <Cell label={contracts.length === 2 ? t.netBid : t.bid} value={money(result.totalBid)} />
            <Cell label={contracts.length === 2 ? t.netAsk : t.ask} value={money(result.totalAsk)} />
            {GREEKS.map(key => <Cell key={key} label={t[key]} value={greek(result[key])} />)}
          </View>
          <Text style={styles.title}>{t.payoffTitle}</Text>
          <PayoffChart result={result} />
          <Text style={type.caption}>{t.payoffNote}</Text>
          {result.legs.map(({ contract, side }) => (
            <View key={contract.strike} style={styles.leg}>
              <Text style={styles.title}>{t[side]} · {t.strike} ${formatPrice(contract.strike)}</Text>
              {contract.symbol ? <Text selectable style={type.caption}>{contract.symbol}</Text> : null}
              <View style={styles.grid}>
                <Cell label={t.bid} value={money(contract.bid)} />
                <Cell label={t.ask} value={money(contract.ask)} />
                <Cell label={t.lastPrice} value={money(contract.lastPrice)} />
                <Cell label={t.iv} value={formatIv(contract.impliedVolatility)} />
                {GREEKS.map(key => <Cell key={key} label={t[key]} value={greek(contract[key])} />)}
                <Cell label={t.volume} value={formatCompact(contract.volume)} />
                <Cell label={t.openInterest} value={formatCompact(contract.openInterest)} />
              </View>
              <Text style={type.caption}>{t.quoteTime}: {timestamp(contract.quoteTimestamp)}</Text>
              <Text style={type.caption}>{t.tradeTime}: {timestamp(contract.tradeTimestamp)}</Text>
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  )
}

function PayoffChart({ result }: { result: OptionStrategy }) {
  const t = useStrings().marketDetail.options
  const strikes = result.legs.map(leg => leg.contract.strike)
  const lo = Math.max(0, Math.min(...strikes, result.breakEven ?? Infinity) * 0.8)
  const hi = Math.max(...strikes, result.breakEven ?? 0) * 1.2
  // Include exact strike and break-even vertices so the line retains its payoff corners.
  const spots = Array.from({ length: 61 }, (_, i) => lo + (hi - lo) * i / 60)
    .concat(strikes, result.breakEven === null ? [] : [result.breakEven])
    .sort((a, b) => a - b)
  const values = spots.map(spot => result.payoff(spot))
  if (values.some(value => value === null)) return <Text style={type.caption}>—</Text>

  const lower = Math.min(0, ...values as number[])
  const upper = Math.max(0, ...values as number[])
  const y = (value: number) => 160 - (value - lower) / (upper - lower || 1) * 130
  const x = (spot: number) => 58 + (spot - lo) / (hi - lo || 1) * 235

  return (
    <Svg width="100%" height={200} viewBox="0 0 320 200" accessibilityLabel={t.payoffTitle}>
      <Line x1={58} x2={293} y1={y(0)} y2={y(0)} stroke={colors.borderStrong} />
      <Polyline
        points={spots.map((spot, i) => `${x(spot)},${y(values[i]!)}`).join(' ')}
        fill="none"
        stroke={colors.accent}
        strokeWidth={2}
      />
      <SvgText x={54} y={32} textAnchor="end" fontSize={10} fill={colors.textDim}>
        {formatPrice(upper)}
      </SvgText>
      <SvgText x={54} y={164} textAnchor="end" fontSize={10} fill={colors.textDim}>
        {formatPrice(lower)}
      </SvgText>
      <SvgText x={58} y={188} fontSize={11} fill={colors.textDim}>
        {`$${formatPrice(lo)}`}
      </SvgText>
      <SvgText x={293} y={188} textAnchor="end" fontSize={11} fill={colors.textDim}>
        {`$${formatPrice(hi)}`}
      </SvgText>
    </Svg>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.surface },
  header: {
    padding: space.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  content: { padding: space.lg, gap: space.lg, paddingBottom: 48 },
  title: { fontFamily: fonts.semibold, fontSize: 17, color: colors.text, flexShrink: 1 },
  link: { fontFamily: fonts.semibold, fontSize: 14, color: colors.accent },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  leg: { gap: space.md, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: colors.border },
  input: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 8,
    padding: 12,
    color: colors.text,
    fontSize: 16,
  },
})
