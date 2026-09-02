import { StyleSheet, Text, View } from 'react-native'
import { Card } from './Card'
import { colors, fonts, tabular, type } from '../theme'
import { formatIv, formatPrice, formatRatio } from '../lib/market/format'
import { type OptionsAnalysis } from '../lib/market/analysis'

/**
 * The floating analysis card above the options chain: put/call ratio (OI), max pain,
 * and the near-the-money IV overview. The rows deliberately duplicate StatRow's visual
 * spec instead of importing it — file ownership across the parallel agents is disjoint.
 */
export function OptionsSummary({ analysis }: { analysis: OptionsAnalysis }) {
  const ratio = analysis.putCallRatioOi
  const ratioTone: 'neutral' | 'up' | 'down' =
    ratio === null ? 'neutral' : ratio > 1 ? 'down' : ratio < 0.7 ? 'up' : 'neutral'
  return (
    <Card floating>
      <SummaryRow label="Put/Call ratio (OI)" value={formatRatio(ratio)} tone={ratioTone} />
      <SummaryRow label="Max pain" value={formatPrice(analysis.maxPain)} />
      <SummaryRow
        label="Implied volatility"
        value={`calls ${formatIv(analysis.callIv)} · puts ${formatIv(analysis.putIv)}`}
        last
      />
    </Card>
  )
}

function SummaryRow({
  label,
  value,
  tone = 'neutral',
  last = false,
}: {
  label: string
  value: string
  tone?: 'neutral' | 'up' | 'down'
  last?: boolean
}) {
  const valueColor = tone === 'up' ? colors.up : tone === 'down' ? colors.down : colors.text
  return (
    <View style={[styles.row, !last && styles.bordered]}>
      <Text style={type.caption}>{label}</Text>
      <Text style={[styles.value, tabular, { color: valueColor }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  bordered: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  value: {
    fontFamily: fonts.medium,
    fontSize: 14,
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: 16,
  },
})
