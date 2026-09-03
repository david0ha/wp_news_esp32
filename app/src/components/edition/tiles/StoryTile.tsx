import { StyleSheet, Text, View } from 'react-native'
import { colors, space, type } from '../../../theme'
import { type Tile } from '../../../lib/edition/tiles'

/**
 * A story, with no picture — TYPE IS THE IMAGE here. The lead's headline at 22/26 is what carries
 * the weight a photograph would on a page that had one, which is why the lead tile is the only
 * one taller than it is wide.
 *
 * The kicker renders exactly as the producer wrote it, in `type.caption` and in sentence case —
 * it is CONTENT. It is not `type.label`: an all-caps eyebrow on every tile is one of the five
 * anti-patterns this design names, and it makes a feed look like a settings screen.
 *
 * Everything clamps with `numberOfLines` rather than resizing the tile. The height was decided
 * before this rendered (`estimateTileHeight`) and the body adapts to it; a tile that grew to fit
 * its text would reflow the column beside it.
 */
export function StoryTile({
  tile,
}: {
  tile: Extract<Tile, { kind: 'story' }>
  width: number
  height: number
}) {
  const { story, lead } = tile
  return (
    <View style={styles.root}>
      {story.kicker !== '' ? (
        <Text style={type.caption} numberOfLines={1}>
          {story.kicker}
        </Text>
      ) : null}
      <Text style={lead ? type.pinHeadline : styles.headlineSm} numberOfLines={lead ? 4 : 3}>
        {story.headline}
      </Text>
      {story.deck !== '' ? (
        <Text style={type.pinDeck} numberOfLines={2}>
          {story.deck}
        </Text>
      ) : null}
      {/* Only the lead has room for body copy, and `flex: 1` lets it take exactly whatever the
          estimator left over — the copy fills the tile instead of the tile shrinking to the copy. */}
      {lead && story.body !== '' ? (
        <Text style={styles.body} numberOfLines={6}>
          {story.body}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: space.xs,
  },
  headlineSm: {
    ...type.pinHeadline,
    fontSize: 17,
    lineHeight: 21,
    letterSpacing: -0.2,
  },
  body: {
    ...type.caption,
    flex: 1,
    color: colors.textDim,
  },
})
