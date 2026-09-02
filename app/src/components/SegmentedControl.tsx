import { StyleSheet, Pressable, Text, View } from 'react-native'
import { colors, fonts, radius, shadow } from '../theme'

/**
 * A horizontal segmented selector — the iOS-style pill track with a lifted white thumb.
 * Used to switch the page on the panel (A1 / A2) and Calls/Puts in the options chain.
 * The selected segment is highlighted; `onChange` fires the index. `disabled` blocks
 * interaction while a command is in flight.
 */
export function SegmentedControl({
  segments,
  selectedIndex,
  onChange,
  disabled = false,
}: {
  segments: string[]
  selectedIndex: number
  onChange: (index: number) => void
  disabled?: boolean
}) {
  return (
    <View style={[styles.track, disabled && styles.disabled]}>
      {segments.map((label, i) => {
        const selected = i === selectedIndex
        return (
          <Pressable
            key={label}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(i)}
            style={[styles.segment, selected && styles.segmentActive]}
          >
            <Text style={[styles.label, selected && styles.labelActive]}>{label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    padding: 4,
    gap: 4,
  },
  disabled: {
    opacity: 0.6,
  },
  segment: {
    flex: 1,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: {
    backgroundColor: colors.surface,
    ...shadow.soft,
  },
  label: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.textDim,
  },
  labelActive: {
    color: colors.text,
  },
})
