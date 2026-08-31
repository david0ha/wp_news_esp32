import { StyleSheet, Text, View } from 'react-native'
import { colors, typography } from '../theme/index'

/**
 * A label on the left, a value on the right, with a hairline under it unless it is the last row.
 * Used by the dashboard's source/panel cards and by the settings device card. Desk chrome, system
 * font (typography.ts's "every control" row) — an info row is read, not written to, but it lives
 * inside the same chrome cards as the controls around it.
 *
 * The value is allowed to shrink and ellipsize; the label is not. A long snapshot URL should cut
 * itself off rather than push "URL" out of the card.
 */
export function InfoRow({
  label,
  value,
  tone = 'neutral',
  last = false,
}: {
  label: string
  value: string
  tone?: 'neutral' | 'up' | 'down' | 'warn' | 'dim'
  last?: boolean
}) {
  return (
    <View style={[styles.row, !last && styles.bordered]}>
      <Text style={[typography.ui, styles.label]}>{label}</Text>
      <Text style={[typography.ui, styles.value, toneStyle(tone)]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

function toneStyle(tone: 'neutral' | 'up' | 'down' | 'warn' | 'dim') {
  switch (tone) {
    case 'up':
      return { color: colors.signal.chrome.up }
    case 'down':
      return { color: colors.signal.chrome.down }
    case 'warn':
      return { color: colors.deskDim }
    case 'dim':
      return { color: colors.deskFaint }
    default:
      return undefined
  }
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  bordered: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.deskFaint,
  },
  label: {
    fontSize: 14,
    color: colors.deskDim,
  },
  value: {
    fontSize: 14,
    color: colors.deskText,
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: 16,
  },
})
