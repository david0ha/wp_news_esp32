import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useStrings } from '../i18n'
import { colors, fonts, space, tabular, type } from '../theme'
import { formatPrice } from '../lib/market/format'
import { type OptionStrategy } from '../lib/market/optionStrategy'
import { type OptionContract } from '../lib/market/types'

export const greek = (n: number | null | undefined) => n == null ? '—' : n.toFixed(4)

/** A two-column strike card keeps premium and Greeks readable at phone widths. */
export function OptionChainRow({
  contract,
  last = false,
  selected = false,
  onPress,
  pair,
}: {
  contract: OptionContract
  last?: boolean
  selected?: boolean
  onPress?: () => void
  pair?: OptionStrategy
}) {
  const t = useStrings().marketDetail.options
  const legPremium = contract.bid !== null && contract.ask !== null
    && contract.bid >= 0 && contract.ask > 0 && contract.ask >= contract.bid
    ? contract.ask : null
  const premium = pair ? pair.premium : legPremium
  const total = pair ? pair.premiumTotal : premium === null || contract.multiplier !== 100
    ? null : premium * contract.multiplier

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.row,
        contract.inTheMoney && styles.itm,
        selected && styles.selected,
        !last && styles.bordered,
      ]}
    >
      {pair ? pair.legs.map(leg => (
        <Text key={leg.contract.strike} style={styles.title}>
          {t[leg.side]} · {t.strike} {formatPrice(leg.contract.strike)}
        </Text>
      )) : (
        <Text style={styles.title}>
          {t.strike} {formatPrice(contract.strike)}{selected ? ' ✓' : ''}
        </Text>
      )}
      <View style={styles.grid}>
        <Cell label={pair && premium !== null ? `${t.premium} · ${premium < 0 ? t.credit : t.debit}` : t.premium} value={formatPrice(premium)} />
        <Cell label={pair ? t.strategyTotal : t.contractTotal} value={formatPrice(total)} />
        <Cell label={pair ? t.netBid : t.bid} value={formatPrice(pair ? pair.totalBid : contract.bid)} />
        <Cell label={pair ? t.netAsk : t.ask} value={formatPrice(pair ? pair.totalAsk : contract.ask)} />
        <Cell label={t.delta} value={greek(pair ? pair.delta : contract.delta)} />
        <Cell label={t.gamma} value={greek(pair ? pair.gamma : contract.gamma)} />
      </View>
    </Pressable>
  )
}

export function Cell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.cell}>
      <Text style={type.caption}>{label}</Text>
      <Text style={[styles.value, tabular]}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { padding: space.lg, gap: space.sm },
  itm: { backgroundColor: colors.itm },
  selected: { backgroundColor: colors.accentDim },
  bordered: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  title: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  cell: { width: '47%', gap: 3 },
  value: { fontFamily: fonts.medium, fontSize: 15, color: colors.text },
})
