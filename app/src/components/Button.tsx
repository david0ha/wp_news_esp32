import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native'
import Animated, { useReducedMotion } from 'react-native-reanimated'
import { colors, motion, radius, typography } from '../theme/index'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

/**
 * The app's main button — desk chrome, system font (typography.ts's "every control" row).
 * `primary` is the filled tint CTA; `secondary` is a raised desk surface; `ghost` is borderless
 * text; `danger` is the destructive (down-red) variant. Shows a spinner and blocks taps while
 * `loading`.
 *
 * Press feedback is a `scale 0.97` Reanimated CSS transition over `motion.press` ms, applied
 * directly in the style object rather than through a shared value — the animation gate says
 * nothing else here animates, so there is no worklet to write.
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
  const [pressed, setPressed] = useState(false)
  const reducedMotion = useReducedMotion()
  const isDisabled = disabled || loading
  const fill =
    variant === 'primary'
      ? styles.primary
      : variant === 'danger'
        ? styles.danger
        : variant === 'ghost'
          ? styles.ghost
          : styles.secondary
  // The tint fill is light enough that `desk` (near-black) reads as the label, the same way the
  // old primary used `ink` on the accent blue — neither variant puts a paper colour on chrome.
  const labelColor =
    variant === 'primary'
      ? colors.desk
      : variant === 'danger'
        ? colors.signal.chrome.down
        : isDisabled
          ? colors.deskFaint
          : colors.deskText

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      hitSlop={8}
      pressRetentionOffset={12}
    >
      <Animated.View
        style={[
          styles.base,
          transition,
          fill,
          isDisabled && styles.disabled,
          pressed && !reducedMotion && pressedScale,
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={labelColor} />
        ) : (
          <Text style={[typography.uiStrong, styles.label, { color: labelColor }]}>{label}</Text>
        )}
      </Animated.View>
    </Pressable>
  )
}

// Reanimated's CSS transition keys (`transitionProperty`/`transitionDuration`) aren't part of
// RN's own `ViewStyle`, so they live outside `StyleSheet.create` — its generic constraint rejects
// them as unknown properties even though `Animated.View`'s own style prop accepts them fine.
const transition = {
  transform: [{ scale: 1 }],
  transitionProperty: 'transform' as const,
  transitionDuration: `${motion.press}ms`,
}
const pressedScale = { transform: [{ scale: 0.97 }] }

const styles = StyleSheet.create({
  base: {
    height: 52,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: colors.signal.chrome.tint,
  },
  secondary: {
    backgroundColor: colors.deskRaised,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  // 16% opacity of the chrome down-red, built by appending a hex alpha channel to the token
  // rather than a literal — `zero hex literals outside src/theme/` holds even for a translucent
  // fill this way.
  danger: {
    backgroundColor: `${colors.signal.chrome.down}29`,
  },
  disabled: {
    opacity: 0.5,
  },
  label: {
    letterSpacing: 0.3,
  },
})
