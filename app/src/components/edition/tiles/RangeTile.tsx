import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, radius, space, tabular, type } from '../../../theme'
import { TILE_HEAD, type Tile } from '../../../lib/edition/tiles'
import { DASH, formatPrice } from '../../../lib/edition/format'

/**
 * Where today's price sits in the year's range, with the day's four numbers under it.
 *
 * The position mark is `colors.text` on a `surfaceAlt` track — INK, not green or red. A position
 * inside a range is neither a direction nor a series, so it takes neither colour; that is the
 * firmware's rule for a hero figure's range bar, carried over unchanged.
 */
export function RangeTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'range' }>
  width: number
  height: number
}) {
  const s = tile.subject
  return (
    <View style={styles.root}>
      <Text style={styles.head}>Range</Text>

      <Track low={s.wk52Low} high={s.wk52High} at={s.last} caption="52 weeks" />

      <View style={styles.grid}>
        <Stat label="Open" value={s.open} />
        <Stat label="Prev close" value={s.prevClose} />
        <Stat label="High" value={s.high} />
        <Stat label="Low" value={s.low} />
      </View>
    </View>
  )
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <View style={styles.stat}>
      <Text style={type.caption} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.statValue, tabular]} numberOfLines={1}>
        {formatPrice(value)}
      </Text>
    </View>
  )
}

/**
 * A percentage as a style value. RN's `DimensionValue` accepts a number or the literal
 * `${number}%`, and a plain template expression widens to `string` — so the type lives on this
 * function rather than on a cast at the call site.
 */
function percentLeft(fraction: number): `${number}%` {
  return `${fraction * 100}%`
}

function Track({
  low,
  high,
  at,
  caption,
}: {
  low: number | null
  high: number | null
  at: number | null
  caption: string
}) {
  // Without both ends and a position there is no track to draw — the row keeps its height and
  // says what is missing, so the tile does not change shape when a field is absent.
  const drawable = low !== null && high !== null && at !== null && high > low
  const pct = drawable ? Math.min(1, Math.max(0, (at - low) / (high - low))) : 0
  return (
    <View style={styles.trackBox}>
      <View style={styles.trackRow}>
        <Text style={[styles.end, tabular]} numberOfLines={1}>
          {formatPrice(low)}
        </Text>
        <View style={styles.track}>
          {drawable ? <View style={[styles.mark, { left: percentLeft(pct) }]} /> : null}
        </View>
        <Text style={[styles.end, tabular]} numberOfLines={1}>
          {formatPrice(high)}
        </Text>
      </View>
      <Text style={type.caption}>{drawable ? caption : `${caption} ${DASH}`}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
    ...type.headingSm,
    height: TILE_HEAD,
  },
  trackBox: {
    gap: 4,
    paddingVertical: space.xs,
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  track: {
    flex: 1,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    justifyContent: 'center',
  },
  mark: {
    position: 'absolute',
    width: 3,
    height: 12,
    marginLeft: -1.5,
    borderRadius: 2,
    backgroundColor: colors.text,
  },
  end: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textDim,
  },
  grid: {
    // The four day numbers sit at the FOOT of whatever the estimator left, so the track keeps
    // its place under the heading whether the tile is 170 px or 200 px tall.
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'flex-end',
  },
  stat: {
    width: '50%',
    paddingVertical: 4,
  },
  statValue: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
})
