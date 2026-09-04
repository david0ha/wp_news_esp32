import { StyleSheet, Text, View } from 'react-native'
import { useStrings } from '../../../i18n'
import { colors, fonts, space } from '../../../theme'
import {
  TILE_HEAD,
  PEERS_ROW,
  PEERS_SHOWN,
  type Tile,
} from '../../../lib/edition/tiles'
import { Change } from '../Change'
import { useEditionFace, useEditionType } from '../typeRamp'

/**
 * The company against its peers: a symbol and which way it went, and nothing between them.
 *
 * The row height and the count come from `lib/edition/tiles.ts`, which is what
 * `estimateTileHeight` sized this tile with — one number, one place.
 *
 * NO LAST PRICE. A row of symbol + price + change wants about 180 pt and has 145 in a tile on a
 * 390 pt phone, and the price was the elastic column: "241.55" rendered as "2." A number cut
 * after its first digit is worse than no number, and the price is not what a peer table is for —
 * the comparison is the direction. The detail page has the room and shows last, P/E and cap.
 *
 * The subject's own row is set in the extrabold face — it is the one the reader is here for, and
 * finding it by reading five symbols is work the tile can do. That emphasis is weight, not
 * colour: colour on this row would have to mean direction, and the subject being the subject is
 * not a direction.
 */
export function PeersTile({ tile }: { tile: Extract<Tile, { kind: 'peers' }> }) {
  const t = useStrings()
  const ty = useEditionType()
  const face = useEditionFace()
  return (
    <View style={styles.root}>
      <Text style={[ty.headingSm, styles.head]}>{t.today.heads.peers}</Text>
      {tile.peers.slice(0, PEERS_SHOWN).map((p) => (
        <View key={p.symbol} style={styles.row}>
          <Text
            style={[
              face(p.isSubject ? fonts.extrabold : fonts.medium),
              p.isSubject ? styles.symbolSubject : styles.symbol,
            ]}
            numberOfLines={1}
          >
            {p.symbol}
          </Text>
          <Change pct={p.changePct} style={styles.change} />
        </View>
      ))}
    </View>
  )
}

// The faces come from the edition's ramp in front of these rules — see `typeRamp.tsx`. The
// subject's emphasis is still weight and still not colour; it is asked for by face rather than
// by family so it survives a language Inter cannot set.
const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
    height: TILE_HEAD,
  },
  row: {
    height: PEERS_ROW,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  // The symbol takes the room the price used to, so a five-character ticker is not clipped; the
  // change keeps its fixed column so the arrows line up down the tile.
  symbol: {
    flex: 1,
    fontSize: 13,
    color: colors.textDim,
  },
  symbolSubject: {
    flex: 1,
    fontSize: 13,
    color: colors.text,
  },
  change: {
    width: 62,
    textAlign: 'right',
  },
})
