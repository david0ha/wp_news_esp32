import { StyleSheet, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, radius } from '../theme/index'

/** A rounded badge holding a single accent glyph, used by the onboarding hero steps. */
export function IconBadge({
  name,
  size = 48,
}: {
  name: React.ComponentProps<typeof Ionicons>['name']
  size?: number
}) {
  return (
    <View style={styles.badge}>
      <Ionicons name={name} size={size} color={colors.signal.chrome.tint} />
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    width: 96,
    height: 96,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    // 16% tint fill — the same technique Button.tsx's `danger` variant uses for a translucent
    // surface, so this stays inside "zero hex literals outside src/theme/" even as an alpha blend.
    backgroundColor: `${colors.signal.chrome.tint}29`,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
