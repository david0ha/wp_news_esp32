import { Children, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, space, tabular, type } from '../theme'

/**
 * One hairline stat line for the detail screen's Stats card. Deliberately distinct from
 * `InfoRow`: no horizontal padding (it sits inside an already-padded Card) and a tighter
 * vertical rhythm, because twelve of these share one card with another column beside them.
 */
export function StatRow({
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
  return (
    <View style={[styles.row, !last && styles.bordered]}>
      <Text style={styles.label}>{label}</Text>
      <Text
        style={[styles.value, tabular, tone === 'up' && styles.up, tone === 'down' && styles.down]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  )
}

/**
 * Two-column wrapper for StatRows. Each direct child becomes a `flex: 1` column, so the
 * screen passes exactly two children — the fixed left/right row assignment lives at the
 * call site (spec §6.4), not in an even/odd-index rule here.
 */
export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <View style={styles.grid}>
      {Children.map(children, (child) => (
        <View style={styles.col}>{child}</View>
      ))}
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
  label: {
    ...type.caption,
  },
  value: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: space.sm,
  },
  up: {
    color: colors.up,
  },
  down: {
    color: colors.down,
  },
  grid: {
    flexDirection: 'row',
    gap: space.xl,
  },
  col: {
    flex: 1,
  },
})
