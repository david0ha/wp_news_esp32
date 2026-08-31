import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../../theme/index'
import type { NewsBrief } from '../../lib/desk'

/** The briefs list — up to eight (`desk.ts`'s `NEWS_BRIEFS_MAX`), each a date, a kicker, and one line. */
export function Briefs({ briefs }: { briefs: NewsBrief[] }) {
  return (
    <View style={styles.wrap}>
      {briefs.map((brief, i) => (
        <View key={`${i}-${brief.date}`}>
          <Text style={[typography.label, styles.meta]} numberOfLines={1}>
            {[brief.date, brief.kicker].filter((s) => s !== '').join(' · ')}
          </Text>
          <Text style={[typography.body, styles.text]}>{brief.text}</Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing[16],
  },
  meta: {
    color: colors.inkMuted,
    marginBottom: spacing[4],
  },
  text: {
    color: colors.ink,
  },
})
