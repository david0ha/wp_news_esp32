import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, fonts, radius, space, tabular, type } from '../theme'
import { relativeTime } from '../lib/market/format'
import { type NewsItem } from '../lib/market/types'

/**
 * One headline row for the detail screen's News section: publisher and age over a
 * three-line title, an optional square thumbnail on the right. An absent thumbnail
 * collapses the slot — no placeholder box. The section wires onPress to Linking.
 */
export function NewsCard({
  item,
  onPress,
  last = false,
}: {
  item: NewsItem
  onPress: () => void
  last?: boolean
}) {
  const age = relativeTime(item.publishedAt)
  const meta = item.publisher !== '' ? `${item.publisher} · ${age}` : age
  return (
    <Pressable
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.row, !last && styles.bordered, pressed && styles.pressed]}
    >
      <View style={styles.textBlock}>
        <Text style={[styles.meta, tabular]} numberOfLines={1}>
          {meta}
        </Text>
        <Text style={styles.title} numberOfLines={3}>
          {item.title}
        </Text>
      </View>
      {item.thumbnail !== null ? (
        <Image source={{ uri: item.thumbnail }} style={styles.thumb} resizeMode="cover" />
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: space.lg,
  },
  bordered: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pressed: {
    opacity: 0.7,
  },
  textBlock: {
    flex: 1,
  },
  meta: {
    ...type.caption,
  },
  title: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
    marginTop: 2,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    marginLeft: space.lg,
    backgroundColor: colors.surfaceAlt,
  },
})
