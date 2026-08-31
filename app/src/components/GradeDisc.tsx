import { StyleSheet, View, type ViewStyle } from 'react-native'
import { colors, radius } from '../theme/index'

export type Grade = 'red' | 'green' | 'yellow' | 'none'

/**
 * A grade disc — a small paper-white pill holding a filled disc (plan Design > Colour). Grades are
 * drawn on the desk but are never bare chrome accents: red/green use the plain grade hues, yellow
 * is the measured Spectra ink and is illegal without its black keyline (CLAUDE.md's "yellow is
 * legal only enclosed by a black keyline" — the same rule that keeps it off the panel unkeylined),
 * and `none` is an empty ring rather than a colour, because "no grade yet" is a fact, not a fourth
 * hue.
 */
export function GradeDisc({
  grade,
  size = 14,
  style,
}: {
  grade: Grade
  size?: number
  style?: ViewStyle
}) {
  const strokeWidth = Math.max(1, size * 0.12)
  const disc: ViewStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    borderCurve: 'continuous',
  }
  if (grade === 'red') {
    disc.backgroundColor = colors.grade.red
  } else if (grade === 'green') {
    disc.backgroundColor = colors.grade.green
  } else if (grade === 'yellow') {
    disc.backgroundColor = colors.grade.yellow.fill
    disc.borderWidth = strokeWidth
    disc.borderColor = colors.grade.yellow.keyline
  } else {
    disc.backgroundColor = 'transparent'
    disc.borderWidth = strokeWidth
    disc.borderColor = colors.inkMuted
  }
  return (
    <View style={[styles.pill, style]}>
      <View style={disc} />
    </View>
  )
}

const styles = StyleSheet.create({
  pill: {
    backgroundColor: colors.paper,
    borderRadius: radius.pill,
    borderCurve: 'continuous',
    padding: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
