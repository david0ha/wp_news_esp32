import { StyleSheet, Text, View } from 'react-native'
import { Sparkline } from '../../Sparkline'
import { colors, fonts, space, type } from '../../../theme'
import {
  TILE_HEAD,
  TAPE_ROW,
  TAPE_SHOWN,
  type Tile,
} from '../../../lib/edition/tiles'
import { changeTone } from '../../../lib/edition/format'
import { Change } from '../Change'
import { toneGraphicsColor } from '../tone'

/**
 * The tape: up to five indices, each with its own direction. The row height and the count come
 * from `lib/edition/tiles.ts`, which is what `estimateTileHeight` sized this tile with.
 *
 * The sparkline takes the graphics pair from `changeTone` and the percentage takes the text pair
 * inside `Change` — one direction, read twice from the same number, so a row's stroke and its
 * figure can never disagree about which way the market went.
 */
export function TapeTile({ tile }: { tile: Extract<Tile, { kind: 'tape' }> }) {
  return (
    <View style={styles.root}>
      <Text style={styles.head}>The tape</Text>
      {tile.indices.slice(0, TAPE_SHOWN).map((ix) => (
        <View key={ix.symbol} style={styles.row}>
          <Text style={styles.symbol} numberOfLines={1}>
            {ix.symbol}
          </Text>
          <Sparkline
            data={ix.spark}
            width={42}
            height={18}
            stroke={toneGraphicsColor(changeTone(ix.changePct))}
          />
          <Change pct={ix.changePct} style={styles.change} />
        </View>
      ))}
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
    width: 62,
    textAlign: 'right',
  },
})
