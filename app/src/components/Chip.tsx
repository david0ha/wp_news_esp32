import { useState } from 'react'
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Animated, { useReducedMotion } from 'react-native-reanimated'
import { colors, pressTransition, pressedScale, radius, typography } from '../theme/index'

/**
 * A small rounded label/toggle — desk chrome, system font. With `onPress` it acts as a selectable
 * pill (the dashboard's page/econ controls); without one it's a static status chip (sensor/battery
 * readouts).
 *
 * `tone` maps onto the app's one accent hue per meaning (plan Global constraints: "on the app side
 * red/green = direction only, blue = tint") — `warn` has no hue of its own in the new palette, so
 * it reads as a dimmer neutral rather than inventing a fourth accent colour.
 */
export function Chip({
  label,
  icon,
  active = false,
  tone = 'neutral',
  onPress,
  disabled = false,
  style,
}: {
  label: string
  icon?: React.ComponentProps<typeof Ionicons>['name']
  active?: boolean
  tone?: 'neutral' | 'up' | 'down' | 'accent' | 'warn'
  onPress?: () => void
  disabled?: boolean
  style?: ViewStyle
}) {
  const [pressed, setPressed] = useState(false)
  const reducedMotion = useReducedMotion()
  const toneColor =
    tone === 'up'
      ? colors.signal.chrome.up
      : tone === 'down'
        ? colors.signal.chrome.down
        : tone === 'accent'
          ? colors.signal.chrome.tint
          : tone === 'warn'
            ? colors.deskDim
            : colors.deskText
  const labelColor = active ? colors.desk : toneColor
  const inner = (
    <>
      {icon ? <Ionicons name={icon} size={14} color={labelColor} /> : null}
      <Text style={[typography.ui, styles.label, { color: labelColor }]}>{label}</Text>
    </>
  )

  if (!onPress) {
    return (
      <View style={[styles.chip, active && styles.active, disabled && styles.disabled, style]}>
        {inner}
      </View>
    )
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={10}
      pressRetentionOffset={12}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
    >
      <Animated.View
        style={[
          styles.chip,
          pressTransition,
          active && styles.active,
          disabled && styles.disabled,
          pressed && !reducedMotion && pressedScale,
          style,
        ]}
      >
        {inner}
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 34,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderCurve: 'continuous',
    backgroundColor: colors.deskRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.deskFaint,
  },
  active: {
    backgroundColor: colors.signal.chrome.tint,
    borderColor: colors.signal.chrome.tint,
  },
  disabled: {
    opacity: 0.45,
  },
  label: {
    fontSize: 13,
  },
})
