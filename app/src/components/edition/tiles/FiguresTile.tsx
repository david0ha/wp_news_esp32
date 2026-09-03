import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, space, tabular, type } from '../../../theme'
import {
  TILE_HEAD,
  TILE_MORE,
  FIGURES_ROW,
  FIGURES_SHOWN,
  type Tile,
} from '../../../lib/edition/tiles'
import { Change } from '../Change'

/**
 * One group of figures — VALUATION, PER SHARE, THE STREET — as label/value rows.
 *
 * The row height and the count come from `lib/edition/tiles.ts`, which is also what
 * `estimateTileHeight` sized this tile with. One number, one place.
 *
 * The value is rendered VERBATIM. The producer already formatted it ("$241.6B", "22.38x"), and
 * re-deriving it here would give the phone and the sheet two different-looking answers to the
 * same question. It still gets `tabular`, because a figure that changes tomorrow should not
 * shift the column it sits in.
 */
export function FiguresTile({ tile }: { tile: Extract<Tile, { kind: 'figures' }> }) {
  const rest = tile.figures.length - FIGURES_SHOWN
  return (
    <View style={styles.root}>
      <Text style={styles.head} numberOfLines={1}>
        {tile.group !== '' ? tile.group : 'Figures'}
      </Text>
      {tile.figures.slice(0, FIGURES_SHOWN).map((f, i) => (
        <View key={`${f.label}:${i}`} style={styles.row}>
          <Text style={styles.label} numberOfLines={1}>
            {f.label}
          </Text>
          <View style={styles.valueBox}>
            <Text style={[f.emph ? styles.valueEmph : styles.value, tabular]} numberOfLines={1}>
              {f.value}
            </Text>
            {f.changePct !== null ? <Change pct={f.changePct} /> : null}
          </View>
        </View>
      ))}
      {rest > 0 ? <Text style={styles.more}>{`+${rest} more`}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
    ...type.headingSm,
    height: TILE_HEAD,
  },
  row: {
    height: FIGURES_ROW,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  label: {
    ...type.caption,
    flexShrink: 1,
  },
  valueBox: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  value: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  valueEmph: {
    fontFamily: fonts.extrabold,
    fontSize: 15,
    color: colors.text,
  },
  more: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    // The estimator adds exactly this for the "+N more" line; it is not a look choice.
    lineHeight: TILE_MORE,
    color: colors.accent,
  },
})
