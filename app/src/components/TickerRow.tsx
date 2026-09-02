import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, fonts, radius, space, tabular, type } from '../theme'
import { formatPrice } from '../lib/market/format'
import { DeltaText } from './DeltaText'
import { Sparkline } from './Sparkline'

// The middle slot is a fixed 64×28 — reserved even when there is nothing to draw, so a row
// never shifts layout when data lands.
const SPARK_W = 64
const SPARK_H = 28

/**
 * One watchlist row: symbol + name on the left, the fixed sparkline slot in the middle,
 * price over a DeltaText on the right. Loading and missing are distinct states: skeleton
 * blocks while a quote request is in flight, '—' only after a fetch settled without the value.
 */
export function TickerRow({
  symbol,
  name,
  price,
  delta,
  pct,
  spark,
  loading = false,
  onPress,
  last = false,
}: {
  symbol: string
  /** May be ''. */
  name: string
  /** undefined renders '—' (a fetch settled without it). */
  price?: number
  /** As DeltaText. */
  delta?: number
  pct?: number
  /** undefined leaves the fixed 64×28 slot EMPTY (reserved, never collapsed). */
  spark?: number[]
  /** Quote request in flight: price, delta and spark render skeleton blocks instead of '—'. */
  loading?: boolean
  onPress: () => void
  /** Suppresses the hairline bottom border. */
  last?: boolean
}) {
  // Graphics duty → the Bright pair; zero or unknown delta carries no color.
  const sparkStroke =
    delta !== undefined && delta > 0
      ? colors.upBright
      : delta !== undefined && delta < 0
        ? colors.downBright
        : colors.textDim

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={symbol}
      onPress={onPress}
      style={({ pressed }) => [styles.row, !last && styles.divider, pressed && styles.pressed]}
    >
      <View style={styles.left}>
        <Text style={styles.symbol} numberOfLines={1}>
          {symbol}
        </Text>
        {name !== '' ? (
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
        ) : null}
      </View>

      <View style={styles.sparkSlot}>
        {loading ? (
          <View style={styles.sparkSkeleton} />
        ) : spark !== undefined ? (
          <Sparkline data={spark} width={SPARK_W} height={SPARK_H} stroke={sparkStroke} />
        ) : null}
      </View>

      <View style={styles.right}>
        {loading ? (
          <>
            <View style={styles.priceSkeleton} />
            <View style={styles.deltaSkeleton} />
          </>
        ) : (
          <>
            <Text style={[styles.price, tabular]} numberOfLines={1}>
              {formatPrice(price)}
            </Text>
            <DeltaText delta={delta} pct={pct} size="sm" />
          </>
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 12,
    paddingHorizontal: 16,
    // Opaque so a Swipeable action panel behind the row stays hidden until swiped.
    backgroundColor: colors.surface,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pressed: {
    opacity: 0.7,
  },
  left: {
    flex: 1,
  },
  symbol: {
    ...type.headingSm,
  },
  name: {
    ...type.caption,
    marginTop: 1,
  },
  sparkSlot: {
    width: SPARK_W,
    height: SPARK_H,
  },
  sparkSkeleton: {
    width: SPARK_W,
    height: SPARK_H,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
  },
  right: {
    alignItems: 'flex-end',
    gap: 2,
  },
  price: {
    fontFamily: fonts.semibold,
    fontSize: 17,
    lineHeight: 22,
    color: colors.text,
  },
  priceSkeleton: {
    width: 76,
    height: 18,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
  },
  deltaSkeleton: {
    width: 92,
    height: 13,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
  },
})
