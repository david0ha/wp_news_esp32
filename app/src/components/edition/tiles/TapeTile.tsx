import { StyleSheet, Text, View } from 'react-native'
import { Sparkline } from '../../Sparkline'
import { colors, fonts, space, tabular, type } from '../../../theme'
import {
  TILE_HEAD,
  TAPE_ROW,
  TAPE_SHOWN,
  type Tile,
} from '../../../lib/edition/tiles'
import { changeArrow, changeTone, formatPct } from '../../../lib/edition/format'
import { toneGraphicsColor, toneTextColor } from '../tone'

/**
 * The tape: up to five indices, each with its own direction. The row height and the count come
 * from `lib/edition/tiles.ts`, which is what `estimateTileHeight` sized this tile with.
 *
 * The sparkline takes the graphics pair and the percentage takes the text pair, from the same
 * `changeTone` — so a row's stroke and its number can never disagree about which way the market
 * went.
 */
export function TapeTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'tape' }>
  width: number
  height: number
}) {
  return (
    <View style={styles.root}>
      <Text style={styles.head}>The tape</Text>
      {tile.indices.slice(0, TAPE_SHOWN).map((ix) => {
        const tone = changeTone(ix.changePct)
        const arrow = changeArrow(ix.changePct)
        return (
          <View key={ix.symbol} style={styles.row}>
            <Text style={styles.symbol} numberOfLines={1}>
              {ix.symbol}
            </Text>
            <Sparkline data={ix.spark} width={42} height={18} stroke={toneGraphicsColor(tone)} />
            <Text style={[styles.change, tabular, { color: toneTextColor(tone) }]} numberOfLines={1}>
              {arrow !== '' ? `${arrow} ` : ''}
              {formatPct(ix.changePct)}
            </Text>
          </View>
        )
      })}
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
    height: TAPE_ROW,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  symbol: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textDim,
  },
  change: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    width: 62,
    textAlign: 'right',
  },
})
