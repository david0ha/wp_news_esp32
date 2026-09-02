import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, fonts, radius, space } from '../theme'

// Declared locally to keep this component free of a cross-module race; the canonical
// type lives in lib/market/timeframes.ts and the two must stay textually identical.
export type Timeframe = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL'

/** The chart's timeframe row — a centered run of accentDim-wash pills. */
export function TimeframePills({
  selected,
  onChange,
  options = ['1D', '1W', '1M', '3M', '1Y', 'ALL'],
}: {
  selected: Timeframe
  onChange: (t: Timeframe) => void
  options?: Timeframe[]
}) {
  return (
    <View style={styles.row}>
      {options.map((tf) => {
        const active = tf === selected
        return (
          <Pressable
            key={tf}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(tf)}
            hitSlop={6}
            style={[styles.pill, active && styles.pillActive]}
          >
            <Text style={[styles.label, active && styles.labelActive]}>{tf}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.sm,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: 'transparent',
  },
  pillActive: {
    backgroundColor: colors.accentDim,
  },
  label: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.textDim,
  },
  labelActive: {
    color: colors.accent,
  },
})
