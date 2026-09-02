import { type ComponentProps } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, fonts, radius, space, tabular, type } from '../theme'

/**
 * One calendar-event row: an icon in a Silver Lining well, a title with an optional
 * caption under it, and a right-aligned value (a date, a date window, an EPS pair).
 * Tone colors the value only — a beat/miss is direction, so it takes the green/red pair.
 */
export function EventRow({
  icon,
  title,
  subtitle,
  value,
  tone = 'neutral',
  last = false,
}: {
  icon: ComponentProps<typeof Ionicons>['name']
  title: string
  subtitle?: string
  value: string
  tone?: 'neutral' | 'up' | 'down'
  last?: boolean
}) {
  const valueColor = tone === 'up' ? colors.up : tone === 'down' ? colors.down : colors.text
  return (
    <View style={[styles.row, !last && styles.bordered]}>
      <View style={styles.iconWell}>
        <Ionicons name={icon} size={18} color={colors.accent} />
      </View>
      <View style={styles.titleBlock}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle !== undefined ? (
          <Text style={type.caption} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.value, tabular, { color: valueColor }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 12,
    paddingHorizontal: space.lg,
  },
  bordered: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  iconWell: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.iconWell,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleBlock: {
    flex: 1,
  },
  title: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
  value: {
    fontFamily: fonts.medium,
    fontSize: 14,
    textAlign: 'right',
  },
})
