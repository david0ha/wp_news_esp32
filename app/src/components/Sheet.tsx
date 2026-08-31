import { type ReactNode } from 'react'
import { StyleSheet, View, type ViewStyle } from 'react-native'
import { colors, radius, spacing } from '../theme/index'

/**
 * A sheet of paper — the reader's own white, square-cut, hairline-bordered surface (plan Design >
 * Direction: "paper... white square-cut sheet... black hairline rules — white in dark mode too").
 * Radius `0`, never rounded — the diff a reviewer can check is exactly this: paper is square-cut,
 * chrome is rounded, and the two never blend.
 */
export function Sheet({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.sheet, style]}>{children}</View>
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.paper,
    borderRadius: radius.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.ink,
    padding: spacing[24],
  },
})
