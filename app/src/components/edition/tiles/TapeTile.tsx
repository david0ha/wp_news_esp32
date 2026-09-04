import { StyleSheet, Text, View } from 'react-native'
import { Sparkline } from '../../Sparkline'
import { colors, fonts, type } from '../../../theme'
import {
  TILE_HEAD,
  TAPE_ROW,
  TAPE_SHOWN,
  type Tile,
} from '../../../lib/edition/tiles'
import { changeTone } from '../../../lib/edition/format'
import { Change } from '../Change'
import { toneGraphicsColor } from '../tone'
import { TAPE_CHANGE_W, TAPE_GAP, TAPE_SYMBOL_SIZE, tapeSparkWidth } from './tape'

/**
 * The tape: up to five indices, each with its own direction. The row height and the count come
 * from `lib/edition/tiles.ts`, which is what `estimateTileHeight` sized this tile with.
 *
 * The sparkline takes the graphics pair from `changeTone` and the percentage takes the text pair
 * inside `Change` — one direction, read twice from the same number, so a row's stroke and its
 * figure can never disagree about which way the market went.
 *
 * IT IS THE SPARKLINE THAT YIELDS, not the symbol. See `tape.ts`: the symbol and the change are
 * served first and the drawing takes the remainder, because a truncated symbol ("N…" for NDX)
 * loses the one thing on the row nothing else can supply. On a column too narrow for all three
 * there is no sparkline at all, and the row still says which index went which way.
 */
export function TapeTile({
  tile,
  width,
}: {
  tile: Extract<Tile, { kind: 'tape' }>
  /** The tile's OUTER width. `tape.ts` subtracts the padding, as `ChartTile` does with its own. */
  width: number
}) {
  const sparkW = tapeSparkWidth(width)
  return (
    <View style={styles.root}>
      <Text style={styles.head}>The tape</Text>
      {tile.indices.slice(0, TAPE_SHOWN).map((ix) => (
        <View key={ix.symbol} style={styles.row}>
          <Text style={styles.symbol} numberOfLines={1}>
            {ix.symbol}
          </Text>
          {sparkW > 0 ? (
            <Sparkline
              data={ix.spark}
              width={sparkW}
              height={18}
              stroke={toneGraphicsColor(changeTone(ix.changePct))}
            />
          ) : null}
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
    gap: TAPE_GAP,
  },
  // Still the flex, and still last in the arithmetic — but now it receives the residual rather
  // than surrendering it, because `tapeSparkWidth` has already reserved this column's six
  // characters. A fixed width here would overflow the row on a phone too narrow for the sum
  // instead of absorbing it.
  symbol: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: TAPE_SYMBOL_SIZE,
    color: colors.textDim,
  },
  change: {
    width: TAPE_CHANGE_W,
    textAlign: 'right',
  },
})
