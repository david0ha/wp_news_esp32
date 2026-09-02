import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, fonts, radius } from '../theme'

/**
 * A small pill label/toggle. With `onPress` it acts as a selectable pill (page/econ
 * controls, expiry selectors); without one it's a static status chip. Active takes the
 * accentDim-wash treatment — the app-wide selection idiom.
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
  const toneColor =
    tone === 'up'
      ? colors.up
      : tone === 'down'
        ? colors.down
        : tone === 'warn'
          ? colors.warn
          : tone === 'accent'
            ? colors.accent
            : colors.textDim
  const contentColor = active ? colors.accent : toneColor
  const content = (
    <View
      style={[
        styles.chip,
        active && styles.active,
        disabled && styles.disabled,
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={14} color={contentColor} /> : null}
      <Text style={[styles.label, { color: contentColor }]}>{label}</Text>
    </View>
  )

  if (!onPress) return content
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => (pressed && !disabled ? styles.pressed : undefined)}
    >
      {content}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  active: {
    backgroundColor: colors.accentDim,
    borderColor: colors.accentDim,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.7,
  },
  label: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    letterSpacing: 0.2,
  },
})
