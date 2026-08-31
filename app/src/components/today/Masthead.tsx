import { StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { colors, spacing, typography } from '../../theme/index'
import { formatDateline } from '../../lib/format'

/**
 * "The Claude Post" — the app's own nameplate, not something printed on the sheet. `typography.
 * masthead` is flagged "Today only" in typography.ts for exactly this: the one deliberate place a
 * paper face (Playfair) renders on desk chrome rather than paper.
 *
 * The dateline row beneath pairs the wire's `dateline` (abbreviated — `formatDateline()`) with
 * `edition`, the section the producer filed under ("SEMICONDUCTORS") — never a ticking clock, per
 * CLAUDE.md's "a front page carries a date, not a clock." Either half may be absent (an empty
 * payload, or an edition still loading); the row itself disappears rather than showing a bare "·".
 */
export function Masthead({
  dateline,
  edition,
  style,
}: {
  dateline: string
  edition: string
  style?: ViewStyle
}) {
  const line = [dateline ? formatDateline(dateline) : '', edition].filter((s) => s !== '').join(' · ')
  return (
    <View style={[styles.wrap, style]}>
      <Text style={[typography.masthead, styles.title]} numberOfLines={1}>
        The Claude Post
      </Text>
      {line !== '' ? (
        <Text style={[typography.label, styles.dateline]} numberOfLines={1}>
          {line}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing[4],
  },
  title: {
    color: colors.deskText,
  },
  dateline: {
    color: colors.deskDim,
  },
})
