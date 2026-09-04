import { StyleSheet, Text, View } from 'react-native'
import { fill, useStrings } from '../../../i18n'
import { colors, fonts } from '../../../theme'
import {
  TILE_HEAD,
  TILE_MORE,
  BRIEFS_ROW,
  BRIEFS_SHOWN,
  type Tile,
} from '../../../lib/edition/tiles'
import { useEditionFace, useEditionType } from '../typeRamp'

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
export function BriefsTile({ tile }: { tile: Extract<Tile, { kind: 'briefs' }> }) {
  const t = useStrings()
  const ty = useEditionType()
  const face = useEditionFace()
  const rest = tile.briefs.length - BRIEFS_SHOWN
  return (
    <View style={styles.root}>
      <Text style={[ty.headingSm, styles.head]}>{t.today.heads.briefs}</Text>
      {tile.briefs.slice(0, BRIEFS_SHOWN).map((b, i) => (
        <View key={`${b.date}:${i}`} style={styles.row}>
          <View style={styles.meta}>
            {b.date !== '' ? (
              <Text style={ty.caption} numberOfLines={1}>
                {b.date}
              </Text>
            ) : null}
            {b.kicker !== '' ? (
              <Text style={ty.caption} numberOfLines={1}>
                {b.kicker}
              </Text>
            ) : null}
          </View>
          <Text style={[ty.caption, styles.text]} numberOfLines={2}>
            {b.text}
          </Text>
        </View>
      ))}
      {rest > 0 ? (
        <Text style={[face(fonts.semibold), styles.more]}>
          {fill(t.today.andMore, { n: String(rest) })}
        </Text>
      ) : null}
    </View>
  )
}

// The faces come from the edition's ramp in front of these rules — see `typeRamp.tsx`.
const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
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
    color: colors.text,
  },
  more: {
    fontSize: 12,
    // The estimator adds exactly this for the "+N more" line; it is not a look choice.
    lineHeight: TILE_MORE,
    color: colors.accent,
  },
})
