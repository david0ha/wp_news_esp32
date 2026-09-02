import { type ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { colors, radius, shadow, space } from '../theme'

/**
 * A padded white surface panel — the building block for card sections. `floating` lifts
 * it with the three-layer-approximating shadow and the larger 22px radius; the hairline
 * border is the card's only border in both modes.
 */
export function Card({
  children,
  style,
  floating = false,
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  floating?: boolean
}) {
  return <View style={[styles.card, floating && styles.floating, style]}>{children}</View>
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: space.lg,
  },
  floating: {
    borderRadius: radius.float,
    ...shadow.float,
  },
})
