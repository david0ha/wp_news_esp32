import { Pressable, StyleSheet, type ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '../theme/index'

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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      style={[styles.circle, style]}
    >
      <Ionicons name="arrow-back" size={20} color={colors.deskText} />
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
