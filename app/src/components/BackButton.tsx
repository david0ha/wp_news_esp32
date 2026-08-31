import { Pressable, StyleSheet, type ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Animated from 'react-native-reanimated'
import { colors, usePressedScale } from '../theme/index'

/** The circular back control used across onboarding/settings screens. */
export function BackButton({
  onPress,
  label = 'Back',
  style,
}: {
  onPress: () => void
  label?: string
  style?: ViewStyle
}) {
  const [press, pressStyle] = usePressedScale()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...press}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
    >
      <Animated.View
        style={[styles.circle, pressStyle, style]}
      >
        <Ionicons name="arrow-back" size={20} color={colors.deskText} />
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  circle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: colors.deskFaint,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
