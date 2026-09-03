import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, space, tabular, type } from '../../../theme'
import {
  TILE_HEAD,
  PEERS_ROW,
  PEERS_SHOWN,
  type Tile,
} from '../../../lib/edition/tiles'
import { formatPrice } from '../../../lib/edition/format'
import { Change } from '../Change'

/**
 * The company against its peers. The row height and the count come from `lib/edition/tiles.ts`,
 * which is what `estimateTileHeight` sized this tile with — one number, one place.
 * The subject's own row is set in the extrabold face — it is the
 * one the reader is here for, and finding it by reading five symbols is work the tile can do.
 * That emphasis is weight, not colour: colour on this row would have to mean direction, and the
 * subject being the subject is not a direction.
 */
export function PeersTile({ tile }: { tile: Extract<Tile, { kind: 'peers' }> }) {
  return (
    <View style={styles.root}>
      <Text style={styles.head}>Peers</Text>
      {tile.peers.slice(0, PEERS_SHOWN).map((p) => (
        <View key={p.symbol} style={styles.row}>
          <Text style={p.isSubject ? styles.symbolSubject : styles.symbol} numberOfLines={1}>
            {p.symbol}
          </Text>
          <Text style={[styles.last, tabular]} numberOfLines={1}>
            {formatPrice(p.last)}
          </Text>
          <Change pct={p.changePct} style={styles.change} />
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
    height: PEERS_ROW,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  symbol: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textDim,
    width: 56,
  },
  symbolSubject: {
    fontFamily: fonts.extrabold,
    fontSize: 13,
    color: colors.text,
    width: 56,
  },
  last: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text,
    textAlign: 'right',
  },
  change: {
    width: 62,
    textAlign: 'right',
  },
})
