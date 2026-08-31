import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native'
import Animated from 'react-native-reanimated'
import { colors, radius, typography, usePressedScale } from '../theme/index'

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
  const [press, pressStyle] = usePressedScale()
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
      {...press}
      hitSlop={8}
      pressRetentionOffset={12}
    >
      <Animated.View
        style={[
          styles.base,
          fill,
          isDisabled && styles.disabled,
          pressStyle,
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
  // A hairline border, so `secondary` still reads as a button on a raised surface — `<Card>`'s own
  // fill IS `deskRaised`, and a fill-only button the same colour as the card under it is a label.
  // Every current call site sits on the desk ground rather than a card (`DirectiveList`'s own
  // comment names this reason for choosing `primary` there instead), but the border is harmless on
  // that ground too, and the fix has to be here rather than at each call site to hold everywhere.
  secondary: {
    backgroundColor: colors.deskRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.deskFaint,
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
