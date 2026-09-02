import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native'
import { colors, fonts, radius } from '../theme'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

/**
 * The app's main button — always a full pill. `primary` is the navy filled CTA (pressed
 * swaps to a darker fill); `secondary` is a 1px outline ghost; `ghost` is borderless
 * accent text; `danger` is the destructive (red) variant. Shows a spinner and blocks
 * taps while `loading`.
 */
export function Button({
  label,
  onPress,
  disabled = false,
  loading = false,
  variant = 'primary',
  style,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  loading?: boolean
  variant?: Variant
  style?: ViewStyle
}) {
  const isDisabled = disabled || loading
  const fill =
    variant === 'primary'
      ? styles.primary
      : variant === 'danger'
        ? styles.danger
        : variant === 'ghost'
          ? styles.ghost
          : styles.secondary
  const labelColor =
    variant === 'primary'
      ? colors.ink
      : variant === 'danger'
        ? colors.down
        : variant === 'ghost'
          ? colors.accent
          : colors.text

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        fill,
        isDisabled && styles.disabled,
        pressed && !isDisabled && (variant === 'primary' ? styles.primaryPressed : styles.pressed),
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.ink : colors.text} />
      ) : (
        <Text style={[styles.label, { color: labelColor }]}>{label}</Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    height: 52,
    borderRadius: radius.pill,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: colors.navy,
  },
  primaryPressed: {
    backgroundColor: colors.navyPressed,
  },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.textDim,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  danger: {
    backgroundColor: colors.downBg,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.8,
  },
  label: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    letterSpacing: 0.2,
  },
})
