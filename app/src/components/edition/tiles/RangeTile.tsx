import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, radius, space, tabular, type } from '../../../theme'
import {
  RANGE_STAT_ROW_H,
  RANGE_TRACK_H,
  TILE_HEAD,
  type Tile,
} from '../../../lib/edition/tiles'
import { DASH, formatPrice } from '../../../lib/edition/format'
import { lineHeightOf } from '../metrics'

// ---------------------------------------------------------------------------------------------
// THE VERTICAL SUM. This tile's body is fixed furniture — a track box and four numbers, none of
// it elastic — so unlike a story it cannot adapt to whatever box it is handed, and the box has
// to be big enough. The two blocks are therefore `tiles.ts`'s constants, IMPORTED, and the same
// two terms `estimateTileHeight` floors this kind at:
//
//   heading                                                       24   (TILE_HEAD)
//   track box   4 pad + 14 track row + 4 gap + 18 caption + 4 pad = 44   (RANGE_TRACK_H)
//   stat grid   2 wrapped rows of 37                             = 74   (2 * RANGE_STAT_ROW_H)
//                                                               ----
//                                                                 142   + 2*14 padding = 170
//
// So the tile fits at 170 and at every width above it, and below it the estimator returns the
// 170 floor rather than the column — which is the bug this pair of imports closes. A 360 dp
// Android phone gives a 158 px column, the grid was handed 62 px for the 74 it draws, and the
// second row (High and Low) was sliced by the tile's `overflow: 'hidden'`.
//
// The two text rows inside a stat carry EXPLICIT line heights so the sum is not at the mercy of
// a font's intrinsic metrics. An earlier version left both implicit, needed about 86 px for the
// grid where 75 were free, and — because the grid packed its wrapped rows with
// `alignContent: 'flex-end'` — spilled the overflow past the TOP edge, landing Open and Prev
// close on top of the "52 weeks" caption.
// ---------------------------------------------------------------------------------------------

/** The price at each end of the track: 11 px type, given a line height so the row is measurable. */
const END_LINE = 14
/** The track row is the taller of its text and the 6 px rail. */
export const RANGE_TRACK_ROW_H = END_LINE
/**
 * The caption under the track, read off the token it is drawn with.
 *
 * Exported so `metrics.test.ts` can hold `RANGE_TRACK_H`'s 44 to it: `tiles.ts` may not import
 * the theme, so its 44 is a literal, and a retuned `type.caption` would leave the estimator
 * sizing a box for the old ramp while this draws the new one.
 */
export const RANGE_CAPTION_LINE = lineHeightOf(type.caption)
/** The label and the value inside one stat. They and the gap around them make RANGE_STAT_ROW_H. */
const STAT_LABEL_LINE = 16
const STAT_VALUE_LINE = 17

/**
 * Where today's price sits in the year's range, with the day's four numbers under it.
 *
 * The position mark is `colors.text` on a `surfaceAlt` track — INK, not green or red. A position
 * inside a range is neither a direction nor a series, so it takes neither colour; that is the
 * firmware's rule for a hero figure's range bar, carried over unchanged.
 */
export function RangeTile({ tile }: { tile: Extract<Tile, { kind: 'range' }> }) {
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
      <Text style={styles.statLabel} numberOfLines={1}>
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
      <Text style={styles.caption} numberOfLines={1}>
        {drawable ? caption : `${caption} ${DASH}`}
      </Text>
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
    // The estimator's own term, not a number that happens to match one: 4 + 14 + 4 + 18 + 4.
    height: RANGE_TRACK_H,
    gap: space.xs,
    paddingVertical: space.xs,
  },
  trackRow: {
    height: RANGE_TRACK_ROW_H,
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
    lineHeight: END_LINE,
    color: colors.textDim,
  },
  caption: {
    ...type.caption,
    lineHeight: RANGE_CAPTION_LINE,
  },
  grid: {
    // Takes whatever the heading and the track box left, and clips DOWNWARD if a narrow phone
    // leaves less than two rows. That direction is the whole fix: packing toward the bottom made
    // a shortfall overflow upward, over the caption above it.
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'flex-start',
    overflow: 'hidden',
  },
  stat: {
    width: '50%',
    height: RANGE_STAT_ROW_H,
    justifyContent: 'center',
  },
  statLabel: {
    ...type.caption,
    lineHeight: STAT_LABEL_LINE,
  },
  statValue: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    lineHeight: STAT_VALUE_LINE,
    color: colors.text,
  },
})
