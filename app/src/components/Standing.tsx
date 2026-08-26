import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/index'

/**
 * A caps standing head with a hairline rule under it — "ON THE GLASS", "THE DOSSIER", "QUEUE"
 * (plan Design > Copy's standing-head list). `tone` names the material it sits on: `paper` reads
 * in ink with an ink rule; `chrome` reads in deskText with a fainter rule, because an ink-coloured
 * hairline would vanish against the desk's near-black.
 */
export function Standing({ label, tone = 'paper' }: { label: string; tone?: 'paper' | 'chrome' }) {
  const textColor = tone === 'paper' ? colors.ink : colors.deskText
  const ruleColor = tone === 'paper' ? colors.ink : colors.deskFaint
  return (
    <View style={styles.wrap}>
      <Text style={[typography.label, { color: textColor }]}>{label}</Text>
      <View style={[styles.rule, { backgroundColor: ruleColor }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing[4],
  },
  rule: {
    height: StyleSheet.hairlineWidth,
  },
})
