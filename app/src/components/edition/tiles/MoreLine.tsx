import { StyleSheet, Text } from 'react-native'
import { fill, useStrings } from '../../../i18n'
import { colors, fonts } from '../../../theme'
import { TILE_MORE } from '../../../lib/edition/tiles'
import { useEditionFace } from '../typeRamp'

/**
 * The "+N more" line a truncated tile ends on, and nothing at all when nothing was cut.
 *
 * Two tiles show a fixed number of rows and count the rest — the briefs and the figures — and
 * before this they carried the same nine lines, the same catalogue key, the same face and the
 * same three style properties each. That is a lot to keep in step by hand against an estimator
 * that assumes they are one line: `lib/edition/tiles.ts` adds exactly `TILE_MORE` to a tile that
 * has a remainder, and nothing measures afterwards to notice that one of the two had drifted.
 * So the line box lives here with the sentence that fills it, and `TILE_MORE` has a single
 * element to be the height of.
 *
 * The accent colour is what makes it read as a count rather than as a truncated brief.
 */
export function MoreLine({ n }: { n: number }) {
  const t = useStrings()
  const face = useEditionFace()
  if (n <= 0) return null
  return (
    <Text style={[face(fonts.semibold), styles.more]}>{fill(t.today.andMore, { n: String(n) })}</Text>
  )
}

// The face comes from the edition's ramp in front of this rule — see `typeRamp.tsx`.
const styles = StyleSheet.create({
  more: {
    fontSize: 12,
    // The estimator adds exactly this for the "+N more" line; it is not a look choice.
    lineHeight: TILE_MORE,
    color: colors.accent,
  },
})
