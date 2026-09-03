import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, type } from '../../../theme'
import {
  TILE_HEAD,
  BRIEFS_ROW,
  BRIEFS_SHOWN,
  type Tile,
} from '../../../lib/edition/tiles'

/**
 * Up to three briefs, then a count of the rest.
 *
 * The row height and the count come from `lib/edition/tiles.ts` and are not restated here: the
 * estimator sized this tile from those exact numbers and nothing measures afterwards, so a local
 * copy that drifted would clip the last brief with no test to catch it.
 *
 * The date and the kicker sit at opposite ends of one row rather than being joined with a middle
 * dot: "AUG 13 · GUIDANCE" is the dot-separated meta line this design bans, and two facts pushed
 * apart read faster than two facts glued together.
 */
export function BriefsTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'briefs' }>
  width: number
  height: number
}) {
  const rest = tile.briefs.length - BRIEFS_SHOWN
  return (
    <View style={styles.root}>
      <Text style={styles.head}>Briefs</Text>
      {tile.briefs.slice(0, BRIEFS_SHOWN).map((b, i) => (
        <View key={`${b.date}:${i}`} style={styles.row}>
          <View style={styles.meta}>
            {b.date !== '' ? <Text style={type.caption}>{b.date}</Text> : null}
            {b.kicker !== '' ? (
              <Text style={type.caption} numberOfLines={1}>
                {b.kicker}
              </Text>
            ) : null}
          </View>
          <Text style={styles.text} numberOfLines={2}>
            {b.text}
          </Text>
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
    height: BRIEFS_ROW,
    justifyContent: 'center',
  },
  meta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  text: {
    ...type.caption,
    color: colors.text,
  },
  more: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    lineHeight: 20,
    color: colors.accent,
  },
})
