import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, fonts, radius } from '../theme'

/**
 * The section-tab strip for the detail screen (Info / News / Calendar / Options). One
 * selection idiom app-wide: the accentDim-wash pill — the same language as
 * `TimeframePills` and the active `Chip`, not an underline.
 */
export function SectionTabs({
  tabs,
  selected,
  onChange,
}: {
  tabs: string[]
  selected: number
  onChange: (i: number) => void
}) {
  return (
    <View style={styles.strip}>
      {tabs.map((label, i) => {
        const active = i === selected
        return (
          <Pressable
            key={label}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(i)}
            style={[styles.tab, active && styles.tabActive]}
          >
            <Text style={[styles.label, active && styles.labelActive]}>{label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: radius.pill,
  },
  tabActive: {
    backgroundColor: colors.accentDim,
  },
  label: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.textDim,
  },
  labelActive: {
    color: colors.accent,
  },
})
