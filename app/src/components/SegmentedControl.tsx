import { useState } from 'react'
import { StyleSheet, Pressable, Text, View } from 'react-native'
import Animated, { useReducedMotion } from 'react-native-reanimated'
import { colors, pressTransition, pressedScale, radius, typography } from '../theme/index'

/**
 * A horizontal segmented selector — used by the dashboard to switch the page on the panel
 * (A1, the front page / A2, the accounts). The selected segment is highlighted; `onChange` fires
 * the index. `disabled` blocks interaction while a command is in flight. Desk chrome, system font.
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
      {segments.map((label, i) => (
        <Segment
          key={label}
          label={label}
          selected={i === selectedIndex}
          disabled={disabled}
          onPress={() => onChange(i)}
        />
      ))}
    </View>
  )
}

function Segment({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string
  selected: boolean
  disabled: boolean
  onPress: () => void
}) {
  const [pressed, setPressed] = useState(false)
  const reducedMotion = useReducedMotion()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={styles.segmentWrap}
    >
      <Animated.View
        style={[
          styles.segment,
          pressTransition,
          selected && styles.segmentActive,
          pressed && !reducedMotion && pressedScale,
        ]}
      >
        <Text style={[typography.ui, styles.label, selected && styles.labelActive]}>{label}</Text>
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    backgroundColor: colors.deskRaised,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    padding: 4,
    gap: 4,
  },
  disabled: {
    opacity: 0.6,
  },
  segmentWrap: {
    flex: 1,
  },
  segment: {
    height: 44,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: {
    backgroundColor: colors.signal.chrome.tint,
  },
  label: {
    fontSize: 13,
    color: colors.deskDim,
  },
  labelActive: {
    color: colors.desk,
  },
})
